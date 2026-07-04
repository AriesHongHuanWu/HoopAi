#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hoopai-train-yolox.py  —  Kaggle GPU kernel (FINAL, launch-ready)

Trains YOLOX-Nano (4 classes: ball, rim, ball_in_basket, person) on a merged
26-dataset basketball corpus pulled from Roboflow in COCO format, then exports:
    /kaggle/working/yolox_nano_hoop.pth   (best/latest checkpoint, always saved)
    /kaggle/working/hoopai-yolox.onnx     (ONNX, best-effort)
    /kaggle/working/hoopai-yolox.tflite   (tflite via onnx2tf, best-effort)

Design mirrors the proven Ultra-Max YOLO kernel's data pipeline (same DATASETS
list + NAME2TGT remap) but swaps the download FORMAT to COCO and the trainer to
YOLOX.  Weights are saved FIRST; ONNX/tflite are strictly best-effort so a
conversion failure never loses the trained model.  One bad dataset never kills
the run.

Kaggle env: Tesla P100 (sm_60) or T4.  We PIN torch 2.5.1+cu121 which supports
both AND is load-bearing for YOLOX: yolox/core/trainer.py uses the deprecated
`torch.cuda.amp.GradScaler/autocast` and calls `torch.load(...)` WITHOUT
`weights_only`.  On torch>=2.6 the torch.load default flips to weights_only=True,
which BREAKS loading the pickled yolox_nano.pth / checkpoints.  DO NOT bump torch
past 2.5.x without patching trainer.py (weights_only=False + torch.amp).

Datasets live in /tmp; only final artifacts go to /kaggle/working.

Robustness architecture (why this survives an 8-12h Kaggle SIGKILL cutoff):
  * A hard fail-fast env assertion runs in <1 min BEFORE the ~30 min download,
    so a broken GPU / clobbered numpy aborts immediately instead of after the
    expensive steps.
  * self.output_dir points INTO /kaggle/working, so checkpoints persist even if
    the kernel is SIGKILLed (Kaggle does NOT raise a Python exception on the
    wall-clock cutoff; the __main__ salvage only fires on exceptions).
  * A background "checkpoint promoter" thread continuously copies the newest
    *ckpt.pth to /kaggle/working/yolox_nano_hoop.pth WHILE training runs, so the
    documented deliverable exists even if train.py is killed mid-run.
  * eval_interval=1 so best_ckpt.pth appears after the first epoch, not hours in.
  * Fixed 416 training resolution (random_size pinned) so batch-fit + time
    estimates hold on P100 (no multiscale blow-up to 640px).
"""

import os
import re
import sys
import json
import glob
import time
import shutil
import threading
import subprocess
import traceback

# --------------------------------------------------------------------------- #
#  Paths / constants
# --------------------------------------------------------------------------- #
WORK          = "/kaggle/working"
TMP           = "/tmp"
RAW_DIR       = os.path.join(TMP, "hoop_raw")        # raw roboflow downloads
COCO_DIR      = os.path.join(TMP, "hoopcoco")        # merged YOLOX/COCO dataset
YOLOX_DIR     = os.path.join(TMP, "YOLOX")           # cloned repo
EXP_FILE      = os.path.join(TMP, "hoop_exp.py")     # generated custom Exp
OUT_ROOT      = os.path.join(WORK, "YOLOX_outputs")  # YOLOX checkpoint root
EXP_NAME      = "hoop_yolox_nano"

TRAIN_IMG_DIR = os.path.join(COCO_DIR, "train2017")
VAL_IMG_DIR   = os.path.join(COCO_DIR, "val2017")
ANN_DIR       = os.path.join(COCO_DIR, "annotations")
TRAIN_ANN     = "instances_train2017.json"
VAL_ANN       = "instances_val2017.json"

# The predictable checkpoint dir YOLOX writes to (output_dir/exp_name).
CKPT_OUT_DIR  = os.path.join(OUT_ROOT, EXP_NAME)
PROMOTED_PTH  = os.path.join(WORK, "yolox_nano_hoop.pth")

ROBOFLOW_KEY  = "4wYE6hxRLYRBQWE7DEkz"

# Wall-clock friendly.  Checkpointing is continuous (latest every epoch,
# best every eval) so a SIGKILL cutoff still yields a usable checkpoint that the
# background promoter will already have copied to yolox_nano_hoop.pth.
# 40 epochs of YOLOX-Nano at FIXED 416 on P100 over the merged corpus is a far
# safer fit for a single 8-12h session than the original 80 (which, combined
# with multiscale-to-640, plausibly needed 15-30h).
MAX_EPOCH     = 40
BATCH_SIZE    = 24            # fits P100 16GB / T4 15GB at 416x416 nano+fp16
INPUT_SIZE    = (416, 416)

# Unified target classes.  index -> name.  COCO category ids are index+1 (1..4).
TARGET_NAMES  = ["ball", "rim", "ball_in_basket", "person"]

# class-name (lowercased) -> target index.  Anything not here is DROPPED.
# Extended vs the draft: covers 'net'->rim (that dataset is included FOR its
# net/rim boxes), and more made-basket synonyms so class 2 is not starved.
NAME2TGT = {
    # ---- 0: ball ----
    "basketball": 0, "ball": 0, "iball": 0, "b-ball": 0, "bball": 0,
    "ball-basketball": 0,
    # ---- 1: rim / hoop / basket / net (rim structure) ----
    "hoop": 1, "rim": 1, "basket": 1, "net": 1, "hoops": 1, "rims": 1,
    "basketball-hoop": 1, "basketball_hoop": 1, "basket-ball-hoop": 1,
    "backboard-hoop": 1,
    # ---- 2: made basket / ball_in_basket ----
    "ball-in-basket": 2, "ball_in_basket": 2, "ball in basket": 2,
    "made": 2, "made-basket": 2, "made_basket": 2, "made basket": 2,
    "hit": 2, "goal": 2, "inbasket": 2, "in-basket": 2,
    "score": 2, "scored": 2, "make": 2, "makes": 2, "swish": 2,
    "basket-made": 2, "basket_made": 2, "shot-made": 2, "shot_made": 2,
    "made-shot": 2, "successful-shot": 2, "points": 2,
    # ---- 3: person / player ----
    "player": 3, "person": 3, "people": 3, "players": 3, "persons": 3,
    "guest_player": 3, "home_player": 3, "guest-player": 3, "home-player": 3,
    "team1": 3, "team2": 3, "team-1": 3, "team-2": 3,
    "non-shooting-player": 3, "shooting-player": 3,
    "non_shooting_player": 3, "shooting_player": 3,
    "ball-handler": 3, "ball_handler": 3, "ballhandler": 3,
    "referee": 3,  # a person; keep as generic person (was previously noise)
}


# (workspace, project, version) — 26 Roboflow datasets.
DATASETS = [
    ("basketball-detection-b977c", "basketball-detection-sskux", 7),
    ("roboflow-jvuqo", "basketball-player-detection-3-ycjdo", 18),
    ("sc-xqmxu", "basketball-and-net-detection", 7),
    ("computer-vision-project-v2zmg", "basketball-video-analysis", 8),
    ("finalprojectteam16", "automatic-basketball-scoring-system", 7),
    ("yolo-bvles", "basketball-detection-1mtj3-4ad5o-c7dos-zmo1g-p9npw-bo5ez", 2),
    ("computer-vision-d5fjh", "basketball-detection-dn6fg", 4),
    ("basketball-hoop-tsdku", "basketball-hoop-images", 4),
    ("ball101", "rim-detection", 1),
    ("roboflow-jvuqo", "basketball-player-detection-2", 20),
    ("rohit-krishnan-xr6xf", "basketball_and_hoops", 3),
    ("basketballcv", "basketball-cv", 9),
    ("ownprojects", "basketball-w2xcw", 2),
    ("zaki-b86c6", "basketball-jagmz", 74),
    ("mytem", "people_basketball_hoops", 6),
    ("loganwork", "basketball-rdtyv", 6),
    ("lokesh-podipireddy-eocdt", "basketball-player-detection-6y9yj", 14),
    ("piebasket", "only_ball_handler", 5),
    ("zeeshan-public-projects", "basket-ball-tracking-xkyu5", 5),
    ("basketball-z8lzd", "basketball-6phla", 21),
    ("basketballv1", "basketball-ikdxt", 22),
    ("roboflow-universe-projects", "basketball-players-fy4c2", 25),
    ("dataset-baketball", "baskball", 5),
    ("public-0stx0", "made-baskets", 3),
    ("tickstrike", "basketball-players-and-ball1", 4),
    ("ntu-nw2om", "tracking-players-and-balls", 3),
]


# --------------------------------------------------------------------------- #
#  Shell helper
# --------------------------------------------------------------------------- #
def sh(cmd, check=True, env=None):
    """Run a shell command, streaming output."""
    print("  $ " + cmd, flush=True)
    r = subprocess.run(cmd, shell=True, env=env)
    if check and r.returncode != 0:
        raise RuntimeError("command failed (%d): %s" % (r.returncode, cmd))
    return r.returncode


# --------------------------------------------------------------------------- #
#  Step 1 — environment: P100-safe torch, YOLOX, deps
# --------------------------------------------------------------------------- #
def setup_env():
    print("=== STEP 1: environment setup ===", flush=True)

    # P100 (sm_60) + T4 safe torch. Kaggle default may drop sm_60.
    # LOAD-BEARING PIN — see module docstring. Do NOT bump past 2.5.x.
    sh("pip install -q torch==2.5.1 torchvision==0.20.1 "
       "--index-url https://download.pytorch.org/whl/cu121")

    # Core deps YOLOX + export need. Pin numpy<2 (pycocotools/opencv/onnx ABI).
    sh("pip install -q pycocotools onnx onnxruntime loguru tabulate thop ninja "
       "'numpy<2' opencv-python-headless roboflow psutil 'Pillow'")

    # Clone YOLOX and install editable.
    if not os.path.isdir(YOLOX_DIR):
        sh("git clone --depth 1 https://github.com/Megvii-BaseDetection/YOLOX "
           + YOLOX_DIR)

    # YOLOX requirements.txt lists UNPINNED `numpy` and the NON-headless
    # `opencv_python`; a naive install can upgrade numpy>=2 (breaks pycocotools
    # at first `import`) and pull a conflicting opencv. Strip those two lines,
    # install the rest, then RE-ASSERT our pins afterwards.
    req_in = os.path.join(YOLOX_DIR, "requirements.txt")
    req_out = os.path.join(TMP, "yolox_requirements_filtered.txt")
    try:
        with open(req_in, "r", encoding="utf-8") as f:
            lines = f.readlines()
        kept = []
        for ln in lines:
            base = re.split(r"[<>=!~ ]", ln.strip().lower(), 1)[0]
            if base in ("numpy", "opencv_python", "opencv-python"):
                continue
            kept.append(ln)
        with open(req_out, "w", encoding="utf-8") as f:
            f.writelines(kept)
        sh("pip install -q -r %s || true" % req_out, check=False)
    except Exception as e:
        print("  !! could not filter YOLOX requirements (%r) — installing raw"
              % e, flush=True)
        sh("pip install -q -r %s || true" % req_in, check=False)

    # Install YOLOX itself (editable).
    sh("pip install -q -v -e %s" % YOLOX_DIR)

    # RE-ASSERT the numpy<2 + headless-opencv pins AFTER YOLOX's requirements,
    # in case anything above nudged them.
    sh("pip install -q 'numpy<2' opencv-python-headless")

    # NOTE: onnx2tf / tensorflow are deliberately NOT installed here. They can
    # drag numpy>=2 and heavy TF wheels into the env that TRAINING depends on.
    # We install that toolchain LAZILY inside save_and_export(), only when an
    # ONNX actually exists — so it can never destabilise training.

    fail_fast_env_check()


def fail_fast_env_check():
    """Hard-assert a usable environment in <1 min, BEFORE the expensive
    download+merge. A broken GPU / clobbered numpy / wrong CUDA aborts NOW
    (triggering the __main__ salvage/exit) instead of 30-60 min later."""
    print("--- fail-fast env check ---", flush=True)
    import numpy
    assert numpy.__version__.split(".")[0] == "1", \
        "numpy must be <2 (got %s) — pycocotools/opencv ABI break" % numpy.__version__
    import cv2  # noqa: F401  (must import cleanly against numpy 1.x)
    import torch
    print("torch:", torch.__version__, "| torch.version.cuda:",
          torch.version.cuda, "| cuda avail:", torch.cuda.is_available(),
          flush=True)
    assert torch.cuda.is_available(), \
        "no CUDA GPU visible — refusing to burn the session on CPU training"
    cc = torch.cuda.get_device_capability(0)
    print("GPU:", torch.cuda.get_device_name(0), "| capability:", cc, flush=True)
    # P100 = sm_60, T4 = sm_75. Anything in (6, 7) is the expected Kaggle GPU.
    assert cc[0] in (6, 7), \
        "unexpected GPU capability %s (want sm_6x/sm_7x P100/T4)" % (cc,)
    # torch.version.cuda should be 12.1 for our cu121 wheels; warn (don't die)
    # if Kaggle silently swapped the wheel.
    if not (torch.version.cuda or "").startswith("12.1"):
        print("  !! WARNING: torch.version.cuda=%r (expected 12.1)"
              % torch.version.cuda, flush=True)
    # YOLOX must import.
    import yolox  # noqa: F401
    from yolox.exp import Exp  # noqa: F401
    print("  env OK (numpy<2, cv2, torch+cuda, yolox)", flush=True)


# --------------------------------------------------------------------------- #
#  Step 2 — download 26 datasets (COCO), merge into one COCO dataset
# --------------------------------------------------------------------------- #
def _has_coco_json(loc):
    """True if a COCO export exists under loc in EITHER the nested split layout
    OR the flat root layout."""
    if glob.glob(os.path.join(loc, "*", "_annotations.coco.json")):
        return True
    if glob.glob(os.path.join(loc, "*", "*.json")):
        return True
    if os.path.isfile(os.path.join(loc, "_annotations.coco.json")):
        return True
    return False


def download_datasets():
    """Download each dataset in COCO format under RAW_DIR/<idx>_<proj>.
    Returns list of (loc, tag) for successfully downloaded datasets."""
    print("=== STEP 2a: downloading %d datasets (COCO) ===" % len(DATASETS),
          flush=True)
    from roboflow import Roboflow
    rf = Roboflow(api_key=ROBOFLOW_KEY)

    os.makedirs(RAW_DIR, exist_ok=True)
    ok = []
    for i, (ws, proj, ver) in enumerate(DATASETS):
        tag = "%02d_%s" % (i, proj)
        loc = os.path.join(RAW_DIR, tag)
        # Cache probe now matches BOTH nested-split and flat-root layouts, so a
        # fully-downloaded root-layout dataset is not needlessly re-downloaded.
        if os.path.isdir(loc) and _has_coco_json(loc):
            print("[%d/%d] cached %s" % (i + 1, len(DATASETS), tag), flush=True)
            ok.append((loc, tag))
            continue
        try:
            print("[%d/%d] downloading %s/%s v%d ..."
                  % (i + 1, len(DATASETS), ws, proj, ver), flush=True)
            project = rf.workspace(ws).project(proj)
            project.version(ver).download("coco", location=loc)
            ok.append((loc, tag))
        except Exception as e:
            print("  !! SKIP %s/%s v%d : %r" % (ws, proj, ver, e), flush=True)
            continue
    print("DATASETS OK %d/%d" % (len(ok), len(DATASETS)), flush=True)
    return ok


def _find_split_dirs(loc):
    """Roboflow COCO export -> {train,valid,test}/ each with images +
    _annotations.coco.json.  Return dict split->dir for those that exist and
    actually contain the annotation file."""
    out = {}
    for split in ("train", "valid", "test"):
        d = os.path.join(loc, split)
        if os.path.isfile(os.path.join(d, "_annotations.coco.json")):
            out[split] = d
    # Some exports place the json at the root with images alongside.
    if not out and os.path.isfile(os.path.join(loc, "_annotations.coco.json")):
        out["train"] = loc
    return out


def _read_wh(path):
    """Return (w, h) of an image on disk, or (0, 0) if unreadable."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return int(im.width), int(im.height)
    except Exception:
        try:
            import cv2
            a = cv2.imread(path)
            if a is not None:
                return int(a.shape[1]), int(a.shape[0])
        except Exception:
            pass
    return 0, 0


def merge_datasets(downloaded):
    """Merge all downloaded COCO datasets into one YOLOX/COCO dataset at
    COCO_DIR with train2017/, val2017/, annotations/instances_{train,val}2017.json.

    - remap each source category NAME -> unified 4 categories (ids 1..4)
    - SKIP the Roboflow supercategory/group row (category id 0, whose name is the
      project label and can collide with a real class name) so genuine boxes are
      never mislabeled by the group row's name
    - drop annotations whose category isn't mapped; drop resulting empty images
      only if they had anns originally but none survived (pure unmapped content);
      keep genuine background/negative images that had zero anns
    - offset image_id / ann_id globally so ids never collide across datasets
    - copy+rename images uniquely; backfill real width/height from disk
    - LOG per-dataset the source category names + how many anns were unmapped so
      silent data loss is visible.
    Roboflow valid/ -> val2017 ; train/ (+ test/) -> train2017.
    """
    print("=== STEP 2b: merging into COCO at %s ===" % COCO_DIR, flush=True)

    # fresh output tree
    for d in (TRAIN_IMG_DIR, VAL_IMG_DIR, ANN_DIR):
        os.makedirs(d, exist_ok=True)

    categories = [
        {"id": i + 1, "name": n, "supercategory": "hoop"}
        for i, n in enumerate(TARGET_NAMES)
    ]

    merged = {
        "train": {"images": [], "annotations": []},
        "val":   {"images": [], "annotations": []},
    }

    img_id_ctr = 1          # global, monotonically increasing across everything
    ann_id_ctr = 1
    copied = {"train": 0, "val": 0}
    kept_anns = 0
    dropped_anns = 0
    per_ds_kept = {}        # tag -> kept ann count, for the zero-contribution warn

    for loc, tag in downloaded:
        splits = _find_split_dirs(loc)
        if not splits:
            print("  !! no coco json in %s, skipping" % tag, flush=True)
            continue

        ds_kept = 0
        ds_unmapped_names = set()

        for split, sdir in splits.items():
            target = "val" if split == "valid" else "train"
            jpath = os.path.join(sdir, "_annotations.coco.json")
            try:
                with open(jpath, "r", encoding="utf-8") as f:
                    coco = json.load(f)
            except Exception as e:
                print("  !! bad json %s/%s: %r" % (tag, split, e), flush=True)
                continue

            # ---- build source cat id -> unified cat id (1..4) or None ----
            # CRITICAL: skip the Roboflow group/supercategory row. That row is
            # exported with id 0 (and/or supercategory 'none') and its NAME is
            # the project label — mapping it can mislabel real boxes or nuke a
            # whole dataset. We ignore id 0 and supercategory=='none' rows.
            src_cat_map = {}
            src_names = []
            for c in coco.get("categories", []):
                cid = c.get("id")
                nm = str(c.get("name", "")).strip().lower()
                supercat = str(c.get("supercategory", "")).strip().lower()
                src_names.append("%s:%s" % (cid, nm))
                if cid == 0 or supercat == "none":
                    # group/supercategory row — never a real object class
                    src_cat_map[cid] = None
                    continue
                tgt = NAME2TGT.get(nm)
                src_cat_map[cid] = (tgt + 1) if tgt is not None else None
                if tgt is None:
                    ds_unmapped_names.add("%s(id%s)" % (nm, cid))

            # group annotations by source image id
            anns_by_img = {}
            for a in coco.get("annotations", []):
                anns_by_img.setdefault(a["image_id"], []).append(a)

            for im in coco.get("images", []):
                src_iid = im["id"]
                raw_anns = anns_by_img.get(src_iid, [])
                # remap + filter this image's annotations
                keep = []
                for a in raw_anns:
                    ucat = src_cat_map.get(a["category_id"])
                    if ucat is None:
                        continue
                    bbox = a.get("bbox")
                    if (not bbox or len(bbox) != 4
                            or bbox[2] <= 0 or bbox[3] <= 0):
                        continue
                    keep.append((a, ucat))

                # If image originally had annotations but none survived the
                # remap, it's pure unmapped-class content -> drop it (and count
                # the dropped anns). Genuine zero-ann background images (raw_anns
                # empty) are kept.
                if raw_anns and not keep:
                    dropped_anns += len(raw_anns)
                    continue

                fn = im.get("file_name")
                if not fn:
                    continue
                src_img = os.path.join(sdir, fn)
                if not os.path.isfile(src_img):
                    # Exact-name fallback. Use os.path.isfile with the literal
                    # basename — NOT glob — because Roboflow filenames often
                    # contain glob metacharacters ('[', ']', '?') that glob would
                    # misinterpret, silently dropping a present file.
                    cand = os.path.join(sdir, os.path.basename(fn))
                    if os.path.isfile(cand):
                        src_img = cand
                    else:
                        continue

                ext = os.path.splitext(fn)[1] or ".jpg"
                new_iid = img_id_ctr
                new_name = "%s_%s_%09d%s" % (tag, split, new_iid, ext)
                dst_dir = TRAIN_IMG_DIR if target == "train" else VAL_IMG_DIR
                dst_path = os.path.join(dst_dir, new_name)
                try:
                    shutil.copyfile(src_img, dst_path)
                except Exception as e:
                    print("  !! copy fail %s: %r" % (src_img, e), flush=True)
                    continue

                img_id_ctr += 1  # only advance on a successful copy

                w = im.get("width") or 0
                h = im.get("height") or 0
                if not w or not h:
                    w, h = _read_wh(dst_path)

                merged[target]["images"].append({
                    "id": new_iid,
                    "file_name": new_name,
                    "width": int(w),
                    "height": int(h),
                })
                copied[target] += 1
                # anns present but partially unmapped
                dropped_anns += (len(raw_anns) - len(keep))

                for a, ucat in keep:
                    bx = [float(x) for x in a["bbox"]]
                    new_ann = {
                        "id": ann_id_ctr,
                        "image_id": new_iid,
                        "category_id": ucat,
                        "bbox": bx,
                        "area": float(a.get("area", bx[2] * bx[3])),
                        "iscrowd": int(a.get("iscrowd", 0)),
                        "segmentation": a.get("segmentation", []),
                    }
                    ann_id_ctr += 1
                    kept_anns += 1
                    ds_kept += 1
                    merged[target]["annotations"].append(new_ann)

        per_ds_kept[tag] = ds_kept
        msg = "  [ds %s] kept_anns=%d cats={%s}" % (
            tag, ds_kept, ", ".join(src_names[:12]))
        if ds_unmapped_names:
            msg += "  UNMAPPED={%s}" % ", ".join(sorted(ds_unmapped_names)[:12])
        print(msg, flush=True)
        if ds_kept == 0:
            print("  !! WARNING: dataset %s contributed 0 kept annotations "
                  "(all classes unmapped?)" % tag, flush=True)

    # Guard: if no val images collected, carve a slice off train so eval works.
    if copied["val"] == 0 and copied["train"] > 0:
        print("  !! no val images — carving ~5%% of train into val", flush=True)
        imgs = merged["train"]["images"]
        n_val = max(1, len(imgs) // 20)
        val_imgs = imgs[:n_val]
        val_ids = {im["id"] for im in val_imgs}
        merged["val"]["images"] = val_imgs
        merged["train"]["images"] = imgs[n_val:]
        tr_anns, va_anns = [], []
        for a in merged["train"]["annotations"]:
            (va_anns if a["image_id"] in val_ids else tr_anns).append(a)
        merged["train"]["annotations"] = tr_anns
        merged["val"]["annotations"] = va_anns
        # physically move the image files train2017 -> val2017
        for im in val_imgs:
            src = os.path.join(TRAIN_IMG_DIR, im["file_name"])
            dst = os.path.join(VAL_IMG_DIR, im["file_name"])
            if os.path.isfile(src):
                shutil.move(src, dst)
        copied["val"] = len(val_imgs)
        copied["train"] = len(merged["train"]["images"])

    # write the two annotation files
    for target, ann_name in (("train", TRAIN_ANN), ("val", VAL_ANN)):
        doc = {
            "info": {"description": "hoopai merged basketball (4-class)"},
            "licenses": [],
            "images": merged[target]["images"],
            "annotations": merged[target]["annotations"],
            "categories": categories,
        }
        with open(os.path.join(ANN_DIR, ann_name), "w", encoding="utf-8") as f:
            json.dump(doc, f)

    print("MERGED train=%d val=%d  (kept_anns=%d dropped_anns=%d)"
          % (copied["train"], copied["val"], kept_anns, dropped_anns),
          flush=True)

    if copied["train"] == 0:
        raise RuntimeError("merge produced 0 training images — aborting")
    if kept_anns == 0:
        raise RuntimeError("merge produced 0 kept annotations — aborting")
    return copied["train"], copied["val"]


# --------------------------------------------------------------------------- #
#  Step 3 — write custom YOLOX-Nano Exp
# --------------------------------------------------------------------------- #
def write_exp():
    """Emit a custom Exp file matching exps/default/yolox_nano.py but for our
    4-class dataset and /tmp/hoopcoco layout, with output_dir on /kaggle/working
    so checkpoints survive a wall-clock cutoff.

    Resolution is PINNED to 416 (random_size=(13,13)) instead of the nano
    default multiscale (10,20)->320-640px, so the batch-fit + P100 time estimate
    hold and per-iter cost is not silently governed by 640px.
    eval_interval=1 so best_ckpt.pth appears after epoch 1, not hours in.
    """
    print("=== STEP 3: writing custom Exp %s ===" % EXP_FILE, flush=True)
    exp_src = '''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Custom YOLOX-Nano Exp for hoopai 4-class basketball dataset.
import os
import torch.nn as nn
from yolox.exp import Exp as MyExp


class Exp(MyExp):
    def __init__(self):
        super(Exp, self).__init__()
        # ---- nano geometry (matches exps/default/yolox_nano.py) ----
        self.depth = 0.33
        self.width = 0.25
        self.input_size = (416, 416)
        # PIN resolution to 416 (13*32=416). Nano default is (10, 20) => random
        # 320-640px multiscale, which blows up per-iter cost/memory on P100 and
        # breaks the batch-fit + wall-clock budget. Fixed 416 keeps both honest.
        self.random_size = (13, 13)
        self.mosaic_scale = (0.5, 1.5)
        self.test_size = (416, 416)
        self.mosaic_prob = 0.5
        self.enable_mixup = False

        # ---- dataset ----
        self.num_classes = 4
        self.data_dir = "%(data_dir)s"
        self.train_ann = "%(train_ann)s"
        self.val_ann = "%(val_ann)s"

        # ---- training schedule (wall-clock friendly) ----
        self.max_epoch = %(max_epoch)d
        self.data_num_workers = 2
        # eval EVERY epoch so best_ckpt.pth is produced/updated early and often,
        # guaranteeing an evaluated checkpoint well before any Kaggle cutoff.
        self.eval_interval = 1
        self.print_interval = 20
        self.warmup_epochs = 2
        self.no_aug_epochs = 10
        self.save_history_ckpt = False

        # persist checkpoints to /kaggle/working so a cutoff still yields them
        self.output_dir = "%(out_root)s"
        self.exp_name = "%(exp_name)s"

    def get_model(self, sublinear=False):
        def init_yolo(M):
            for m in M.modules():
                if isinstance(m, nn.BatchNorm2d):
                    m.eps = 1e-3
                    m.momentum = 0.03
        if "model" not in self.__dict__:
            from yolox.models import YOLOX, YOLOPAFPN, YOLOXHead
            in_channels = [256, 512, 1024]
            # NANO uses depthwise=True (the key nano difference)
            backbone = YOLOPAFPN(
                self.depth, self.width, in_channels=in_channels,
                act=self.act, depthwise=True,
            )
            head = YOLOXHead(
                self.num_classes, self.width, in_channels=in_channels,
                act=self.act, depthwise=True,
            )
            self.model = YOLOX(backbone, head)
        self.model.apply(init_yolo)
        self.model.head.initialize_biases(1e-2)
        return self.model
''' % {
        "data_dir": COCO_DIR,
        "train_ann": TRAIN_ANN,
        "val_ann": VAL_ANN,
        "max_epoch": MAX_EPOCH,
        "out_root": OUT_ROOT,
        "exp_name": EXP_NAME,
    }
    with open(EXP_FILE, "w", encoding="utf-8") as f:
        f.write(exp_src)
    print("  wrote Exp (num_classes=4, data_dir=%s, output_dir=%s)"
          % (COCO_DIR, OUT_ROOT), flush=True)


# --------------------------------------------------------------------------- #
#  Step 4 — fetch pretrained nano weights + train (with live ckpt promotion)
# --------------------------------------------------------------------------- #
def fetch_pretrained():
    """Download official yolox_nano.pth to finetune from. Best-effort — if it
    fails we train from scratch (-c omitted)."""
    dst = os.path.join(TMP, "yolox_nano.pth")
    if os.path.isfile(dst) and os.path.getsize(dst) > 1_000_000:
        return dst
    url = ("https://github.com/Megvii-BaseDetection/YOLOX/releases/download/"
           "0.1.1rc0/yolox_nano.pth")
    try:
        sh("wget -q -O %s %s" % (dst, url), check=False)
        if os.path.isfile(dst) and os.path.getsize(dst) > 1_000_000:
            print("  fetched pretrained yolox_nano.pth", flush=True)
            return dst
    except Exception as e:
        print("  !! pretrained fetch failed: %r (train from scratch)" % e,
              flush=True)
    if os.path.isfile(dst):
        os.remove(dst)
    return None


def _newest_ckpt():
    """Newest *ckpt.pth anywhere under CKPT_OUT_DIR (prefer best, then latest,
    then any, chosen by mtime)."""
    cands = glob.glob(os.path.join(CKPT_OUT_DIR, "*ckpt.pth"))
    if not cands:
        cands = glob.glob(os.path.join(OUT_ROOT, "**", "*ckpt.pth"),
                          recursive=True)
    if not cands:
        return None
    return max(cands, key=os.path.getmtime)


def _promote_once():
    """Copy the newest checkpoint to the documented deliverable path IF it is
    newer than what we already promoted. Returns True if it copied."""
    src = _newest_ckpt()
    if not src:
        return False
    try:
        if (not os.path.isfile(PROMOTED_PTH)
                or os.path.getmtime(src) > os.path.getmtime(PROMOTED_PTH)):
            tmp = PROMOTED_PTH + ".tmp"
            shutil.copyfile(src, tmp)
            os.replace(tmp, PROMOTED_PTH)  # atomic swap
            return True
    except Exception as e:
        print("  !! promote fail: %r" % e, flush=True)
    return False


class _Promoter(threading.Thread):
    """Background thread: while training runs, continuously copy the newest
    checkpoint to /kaggle/working/yolox_nano_hoop.pth. This is the key defense
    against Kaggle's SIGKILL wall-clock cutoff — the documented deliverable
    exists even if train.py is killed mid-run and save_and_export() never runs.
    """
    def __init__(self, interval=90):
        super().__init__(daemon=True)
        self.interval = interval
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            if _promote_once():
                print("  [promoter] refreshed %s <- %s"
                      % (os.path.basename(PROMOTED_PTH), _newest_ckpt()),
                      flush=True)
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


def train(ckpt):
    print("=== STEP 4: training ===", flush=True)
    os.makedirs(OUT_ROOT, exist_ok=True)

    env = dict(os.environ)
    env["YOLOX_DATADIR"] = COCO_DIR          # belt-and-suspenders w/ data_dir

    import torch
    fp16 = "--fp16" if torch.cuda.is_available() else ""
    # NOTE: P100 (sm_60) has no Tensor Cores, so --fp16 gives little/no P100
    # speedup (correct, just not faster); it DOES help T4. Kept on for T4; the
    # OOM-tolerant salvage design covers P100 if memory is ever tight.

    c = "-c %s" % ckpt if ckpt else ""
    train_py = os.path.join(YOLOX_DIR, "tools", "train.py")
    # CRITICAL FIX vs draft: NO `-o <value>`. In YOLOX, -o/--occupy is a
    # store_true flag (occupy GPU mem) that takes NO argument; passing a value
    # spills into the REMAINDER `opts` arg and trips exp.merge's
    # `assert len(cfg_list) % 2 == 0`, aborting BEFORE training starts. The
    # experiment name is supplied via -expn. We omit -o entirely.
    cmd = (
        "python %s -f %s -d 1 -b %d %s %s -expn %s"
        % (train_py, EXP_FILE, BATCH_SIZE, fp16, c, EXP_NAME)
    )

    # Start the background checkpoint promoter so a SIGKILL cutoff still leaves a
    # usable yolox_nano_hoop.pth.
    promoter = _Promoter(interval=90)
    promoter.start()
    try:
        # Training must not abort the whole kernel — a cutoff/OOM should still
        # leave the checkpoints we have on disk (already under /kaggle/working).
        rc = sh(cmd, check=False, env=env)
        print("  train.py exited rc=%d" % rc, flush=True)
    finally:
        promoter.stop()
        # one final promotion after train exits (or errors)
        _promote_once()


# --------------------------------------------------------------------------- #
#  Step 5 — save weights, eval, export ONNX, best-effort tflite
# --------------------------------------------------------------------------- #
def _find_ckpt():
    """Locate best_ckpt.pth (fallback latest_ckpt.pth) under CKPT_OUT_DIR.
    Deep-search fallback picks the NEWEST by mtime (not an arbitrary first hit),
    so a stale checkpoint from a persisted prior run isn't exported."""
    for name in ("best_ckpt.pth", "latest_ckpt.pth"):
        p = os.path.join(CKPT_OUT_DIR, name)
        if os.path.isfile(p):
            return p
    hits = glob.glob(os.path.join(OUT_ROOT, "**", "*ckpt.pth"), recursive=True)
    return max(hits, key=os.path.getmtime) if hits else None


def save_and_export():
    print("=== STEP 5: save / eval / export ===", flush=True)
    ckpt = _find_ckpt()
    if not ckpt:
        # The promoter may still have salvaged something to PROMOTED_PTH.
        if os.path.isfile(PROMOTED_PTH):
            print("  no ckpt dir hit, but promoted %s exists — exporting from it"
                  % PROMOTED_PTH, flush=True)
            ckpt = PROMOTED_PTH
        else:
            print("  !! no checkpoint found under %s — nothing to export"
                  % OUT_ROOT, flush=True)
            return

    # 5a. ALWAYS (re)save the .pth first (this is the irreplaceable artifact).
    pth_out = PROMOTED_PTH
    if os.path.abspath(ckpt) != os.path.abspath(pth_out):
        shutil.copyfile(ckpt, pth_out)
    print("SAVED %s (from %s)" % (pth_out, ckpt), flush=True)

    env = dict(os.environ)
    env["YOLOX_DATADIR"] = COCO_DIR

    import torch
    fp16 = "--fp16" if torch.cuda.is_available() else ""

    # 5b. Eval (COCO mAP) — best-effort, never fatal. (eval.py has NO -o flag.)
    try:
        eval_py = os.path.join(YOLOX_DIR, "tools", "eval.py")
        if os.path.isfile(eval_py):
            sh("python %s -f %s -c %s -b %d -d 1 %s --conf 0.001"
               % (eval_py, EXP_FILE, pth_out, BATCH_SIZE, fp16),
               check=False, env=env)
    except Exception as e:
        print("  !! eval skipped: %r" % e, flush=True)

    # 5c. Export ONNX — best-effort. export_onnx.py has NO -o flag.
    onnx_out = os.path.join(WORK, "hoopai-yolox.onnx")
    onnx_ok = False
    try:
        export_py = os.path.join(YOLOX_DIR, "tools", "export_onnx.py")
        sh("python %s -f %s -c %s --output-name %s --opset 12"
           % (export_py, EXP_FILE, pth_out, onnx_out),
           check=False, env=env)
        onnx_ok = os.path.isfile(onnx_out) and os.path.getsize(onnx_out) > 1000
        if onnx_ok:
            print("SAVED %s" % onnx_out, flush=True)
    except Exception as e:
        print("  !! onnx export failed: %r" % e, flush=True)

    # 5d. ONNX -> tflite via onnx2tf — strictly best-effort. Install the toolchain
    # LAZILY here (never during setup_env) so its heavy deps can't destabilise
    # training's numpy/opencv/torch stack. A failure never loses .pth/.onnx.
    if onnx_ok:
        try:
            print("  installing onnx2tf toolchain (lazy)...", flush=True)
            sh("pip install -q onnx2tf onnxsim onnx_graphsurgeon sng4onnx "
               "'tensorflow-cpu' 'tf-keras' || true", check=False)
            tf_dir = os.path.join(TMP, "onnx2tf_out")
            shutil.rmtree(tf_dir, ignore_errors=True)
            rc = sh("onnx2tf -i %s -o %s -osd" % (onnx_out, tf_dir),
                    check=False, env=env)
            # onnx2tf writes *_float32.tflite (and int variants) into tf_dir
            cands = sorted(
                glob.glob(os.path.join(tf_dir, "*float32.tflite")) +
                glob.glob(os.path.join(tf_dir, "*.tflite"))
            )
            if cands:
                tfl_out = os.path.join(WORK, "hoopai-yolox.tflite")
                shutil.copyfile(cands[0], tfl_out)
                print("SAVED %s (from %s)" % (tfl_out, cands[0]), flush=True)
            else:
                print("  !! onnx2tf produced no .tflite (rc=%d) — skipping" % rc,
                      flush=True)
        except Exception as e:
            print("  !! tflite conversion failed (kept .pth/.onnx): %r" % e,
                  flush=True)
    else:
        print("  !! no valid ONNX — skipping tflite", flush=True)

    # 5e. Emit a small metadata file for the app.
    try:
        tfl = os.path.join(WORK, "hoopai-yolox.tflite")
        meta = {
            "classes": TARGET_NAMES,
            "num_classes": len(TARGET_NAMES),
            "input_size": list(INPUT_SIZE),
            "arch": "yolox_nano",
            "artifacts": {
                "pth": os.path.basename(pth_out),
                "onnx": os.path.basename(onnx_out) if onnx_ok else None,
                "tflite": ("hoopai-yolox.tflite"
                           if os.path.isfile(tfl) else None),
            },
        }
        with open(os.path.join(WORK, "hoopai-yolox.meta.json"),
                  "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        print("SAVED hoopai-yolox.meta.json", flush=True)
    except Exception as e:
        print("  !! meta write failed: %r" % e, flush=True)


# --------------------------------------------------------------------------- #
#  main
# --------------------------------------------------------------------------- #
def main():
    print("########## HOOPAI YOLOX-NANO TRAINING KERNEL ##########", flush=True)
    os.makedirs(WORK, exist_ok=True)

    setup_env()   # includes fail_fast_env_check() — aborts in <1 min if broken

    downloaded = download_datasets()
    if not downloaded:
        raise RuntimeError("no datasets downloaded — cannot proceed")

    merge_datasets(downloaded)

    write_exp()

    ckpt = fetch_pretrained()
    train(ckpt)

    save_and_export()

    print("########## DONE — artifacts in %s ##########" % WORK, flush=True)
    for f in sorted(os.listdir(WORK)):
        if f.startswith("hoopai") or f.startswith("yolox_nano_hoop"):
            p = os.path.join(WORK, f)
            if os.path.isfile(p):
                print("   %s  (%.1f MB)" % (f, os.path.getsize(p) / 1e6),
                      flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("!!!!!!!!!! FATAL !!!!!!!!!!", flush=True)
        traceback.print_exc()
        # Even on fatal error, try to salvage any checkpoint already on disk.
        try:
            ck = _find_ckpt()
            if ck and os.path.abspath(ck) != os.path.abspath(PROMOTED_PTH):
                if not os.path.isfile(PROMOTED_PTH):
                    shutil.copyfile(ck, PROMOTED_PTH)
                    print("SALVAGED %s" % PROMOTED_PTH, flush=True)
        except Exception:
            traceback.print_exc()
        sys.exit(1)
