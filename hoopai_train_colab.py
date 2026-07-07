#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hoopai_train_colab.py  --  Google Colab (free T4) YOLOX-Tiny training, launch-ready

Colab port of the proven Kaggle kernel (hoopai-train-yolox.py). Trains YOLOX-Tiny
(4 classes: ball, rim, ball_in_basket, person) on the merged 35-dataset basketball
corpus pulled from Roboflow in COCO format, then exports:
    <DRIVE>/hoopai_train/yolox_tiny_hoop.pth   (best/latest checkpoint, always)
    <DRIVE>/hoopai_train/hoopai-yolox.onnx     (ONNX, best-effort)
    <DRIVE>/hoopai_train/hoopai-yolox.tflite   (tflite via onnx2tf, best-effort)

WHY A COLAB PORT (vs Kaggle): Kaggle's 30h/week GPU quota can run dry. Colab free
has its own separate T4 allowance. The two platform realities this port handles:

  1) COLAB DISCONNECTS. Free Colab drops the runtime (idle ~90 min, or dynamically).
     A ~12h full run will NOT finish in one session. So EVERYTHING durable lives on
     Google Drive and the run is RESUMABLE:
       * The merged COCO dataset is tarred to Drive after the first build, so a
         reconnect SKIPS the ~30-60 min download+merge (just extracts the tar).
       * A background promoter mirrors the newest training checkpoint to Drive.
       * On (re)start, if a Drive checkpoint exists, training RESUMES from it
         (YOLOX --resume: continues the epoch count + optimizer state) instead of
         restarting. Re-run the Colab cell after a disconnect and it picks up.
     Training READS data from fast local /content and only WRITES checkpoints to
     Drive periodically, so Drive's slow FUSE never governs per-iter speed.

  2) NO HARDCODED SECRET. The Roboflow API key is read from the ROBOFLOW_KEY env
     var (set it in the Colab cell via getpass -- see COLAB_TRAINING.md). The key
     that was hardcoded in the Kaggle kernel is exposed in git history and MUST be
     rotated in the Roboflow dashboard; do not reuse it.

Load-bearing torch pin (unchanged from Kaggle): torch==2.5.1+cu121. YOLOX's
trainer.py uses the deprecated torch.cuda.amp.* and calls torch.load WITHOUT
weights_only; torch>=2.6 flips weights_only's default to True and BREAKS loading
the pickled yolox_tiny.pth / checkpoints. Do NOT bump torch past 2.5.x without
patching trainer.py (weights_only=False + torch.amp). T4 is sm_75 -- cu121 is fine.

Run it (in a Colab cell, after mounting Drive + setting ROBOFLOW_KEY):
    !python hoopai_train_colab.py
Override defaults via env if you want a lighter single-session run:
    HOOPAI_MAX_EPOCH (default 12), HOOPAI_BATCH (default 16),
    HOOPAI_DRIVE_DIR (default /content/drive/MyDrive/hoopai_train).
"""

import os
import re
import sys
import json
import glob
import time
import shutil
import tarfile
import threading
import subprocess
import traceback

# --------------------------------------------------------------------------- #
#  Paths / constants  (Colab: durable state on Drive, fast scratch on /content)
# --------------------------------------------------------------------------- #
DRIVE_DIR = os.environ.get("HOOPAI_DRIVE_DIR", "/content/drive/MyDrive/hoopai_train")
CONTENT   = "/content"
RAW_DIR   = os.path.join(CONTENT, "hoop_raw")     # raw roboflow downloads (local)
COCO_DIR  = os.path.join(CONTENT, "hoopcoco")     # merged YOLOX/COCO dataset (local)
YOLOX_DIR = os.path.join(CONTENT, "YOLOX")        # cloned repo (local)
EXP_FILE  = os.path.join(CONTENT, "hoop_exp.py")  # generated custom Exp (local)
OUT_ROOT  = os.path.join(CONTENT, "YOLOX_outputs")  # YOLOX checkpoint root (local, FAST)
EXP_NAME  = "hoop_yolox_tiny"

# Durable Drive artifacts (survive a Colab disconnect).
DRIVE_CKPT_DIR   = os.path.join(DRIVE_DIR, "ckpt")            # mirrored training ckpts
DRIVE_DATA_TAR   = os.path.join(DRIVE_DIR, "hoopcoco.tar")    # cached merged dataset
PROMOTED_PTH     = os.path.join(DRIVE_DIR, "yolox_tiny_hoop.pth")  # deliverable weight

TRAIN_IMG_DIR = os.path.join(COCO_DIR, "train2017")
VAL_IMG_DIR   = os.path.join(COCO_DIR, "val2017")
ANN_DIR       = os.path.join(COCO_DIR, "annotations")
TRAIN_ANN     = "instances_train2017.json"
VAL_ANN       = "instances_val2017.json"

# The predictable checkpoint dir YOLOX writes to (output_dir/exp_name).
CKPT_OUT_DIR  = os.path.join(OUT_ROOT, EXP_NAME)

# SECURITY: no hardcoded key. Read from env (set via getpass in the Colab cell).
# The Kaggle kernel's hardcoded key is in git history and must be ROTATED.
ROBOFLOW_KEY  = os.environ.get("ROBOFLOW_KEY", "").strip()

# Overridable via env for a lighter single-session Colab run.
MAX_EPOCH  = int(os.environ.get("HOOPAI_MAX_EPOCH", "12"))
BATCH_SIZE = int(os.environ.get("HOOPAI_BATCH", "16"))
INPUT_SIZE = (416, 416)

# Unified target classes.  index -> name.  COCO category ids are index+1 (1..4).
TARGET_NAMES  = ["ball", "rim", "ball_in_basket", "person"]

# class-name (lowercased) -> target index.  Anything not here is DROPPED.
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
    "referee": 3,
}

# (workspace, project, version) -- FULL 35-dataset corpus (what made the nano
# generalize on real footage; curating to 12 GENERALIZED WORSE despite higher
# in-distribution AP). Variety > epochs-to-converge for a heavier model.
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
    ("the-university-of-arizona-th1yv", "basketball-shooting-robot", 1),
    ("test-datset", "player_detect-0spfb", 1),
    ("devin-ross-g0rqc", "basketball-ls818", 71),
    ("queenmary", "basketball-poeple-rin", 1),
    ("woo-lgxdg", "final-aops8", 3),
    ("hotshot", "basketball-detection-tqwcs", 7),
    ("abc-bvosr", "automated-basketball-scoreboard", 2),
    ("amrita-hlhw6", "basketball-and-hoop-detection", 1),
    ("cv-8scak", "cv-cnfd4", 1),
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


def _atomic_put(src, dst):
    """Copy src -> dst crash-safely: write a sibling .tmp, then rename. A crash
    mid-copy leaves only the .tmp (ignored), never a truncated dst that a size
    check would trust. Falls back to a direct copy if the Drive FUSE mount does
    not support rename (os.replace)."""
    tmp = dst + ".tmp"
    shutil.copyfile(src, tmp)
    try:
        os.replace(tmp, dst)              # atomic where supported (local, most FUSE)
    except OSError:
        shutil.copyfile(tmp, dst)         # FUSE without rename: best-effort overwrite
        try:
            os.remove(tmp)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
#  Step 0 -- Colab preflight: Drive mounted + key present
# --------------------------------------------------------------------------- #
def preflight():
    print("=== STEP 0: Colab preflight ===", flush=True)
    drive_root = "/content/drive"
    if not os.path.isdir(drive_root):
        raise RuntimeError(
            "Google Drive is not mounted. In a Colab cell run FIRST:\n"
            "    from google.colab import drive; drive.mount('/content/drive')")
    os.makedirs(DRIVE_DIR, exist_ok=True)
    os.makedirs(DRIVE_CKPT_DIR, exist_ok=True)
    # The Roboflow key is ONLY needed to DOWNLOAD the datasets. After the first
    # session caches the merged dataset to Drive, every RESUME skips the download
    # -- so don't force the key then. Hard-require it only when there's no cached
    # dataset to fall back on (a true first run).
    dataset_cached = os.path.isfile(DRIVE_DATA_TAR) or _dataset_ready()
    if not ROBOFLOW_KEY and not dataset_cached:
        raise RuntimeError(
            "ROBOFLOW_KEY env var is empty and no cached dataset on Drive yet. In "
            "a Colab cell run BEFORE this script:\n"
            "    import os, getpass\n"
            "    os.environ['ROBOFLOW_KEY'] = getpass.getpass('Roboflow key: ')\n"
            "(Rotate the old exposed key first.)")
    if not ROBOFLOW_KEY:
        print("  RESUME: no key set, but a cached dataset exists on Drive -- the "
              "download is skipped, so the key is not needed.", flush=True)
    print("  Drive OK -> %s | key %s"
          % (DRIVE_DIR,
             ("present (%d chars)" % len(ROBOFLOW_KEY)) if ROBOFLOW_KEY
             else "not set (resuming from cache)"),
          flush=True)


# --------------------------------------------------------------------------- #
#  Step 1 -- environment: T4-safe torch, YOLOX, deps
# --------------------------------------------------------------------------- #
def setup_env():
    print("=== STEP 1: environment setup ===", flush=True)

    # T4 (sm_75) safe torch. LOAD-BEARING PIN -- see module docstring. Do NOT
    # bump past 2.5.x. Colab has NOT imported torch yet in this fresh subprocess,
    # so installing then importing below picks up the pinned build cleanly.
    sh("pip install -q torch==2.5.1 torchvision==0.20.1 "
       "--index-url https://download.pytorch.org/whl/cu121")

    # Core deps YOLOX + export need. Pin numpy<2 (pycocotools/opencv/onnx ABI).
    sh("pip install -q pycocotools onnx onnxruntime loguru tabulate thop ninja "
       "'numpy<2' opencv-python-headless roboflow psutil 'Pillow'")

    if not os.path.isdir(YOLOX_DIR):
        sh("git clone --depth 1 https://github.com/Megvii-BaseDetection/YOLOX "
           + YOLOX_DIR)

    # Filter YOLOX's requirements.txt: it lists UNPINNED numpy + non-headless
    # opencv (which would upgrade numpy>=2 and break pycocotools) and pins
    # onnx-simplifier==0.4.10 (fails to build on new Python). Strip those, install
    # the rest, then re-assert our pins.
    req_in = os.path.join(YOLOX_DIR, "requirements.txt")
    req_out = os.path.join(CONTENT, "yolox_requirements_filtered.txt")
    try:
        with open(req_in, "r", encoding="utf-8") as f:
            lines = f.readlines()
        kept = []
        for ln in lines:
            base = re.split(r"[<>=!~ ]", ln.strip().lower(), 1)[0]
            if base in ("numpy", "opencv_python", "opencv-python",
                        "onnx-simplifier", "onnx_simplifier", "onnxsim"):
                continue
            kept.append(ln)
        with open(req_out, "w", encoding="utf-8") as f:
            f.writelines(kept)
        sh("pip install -q -r %s || true" % req_out, check=False)
    except Exception as e:
        print("  !! could not filter YOLOX requirements (%r) -- installing raw"
              % e, flush=True)
        sh("pip install -q -r %s || true" % req_in, check=False)

    # Run YOLOX FROM SOURCE via PYTHONPATH (pure-Python, no build needed).
    if YOLOX_DIR not in sys.path:
        sys.path.insert(0, YOLOX_DIR)
    sh("pip install -q --no-deps --no-build-isolation %s" % YOLOX_DIR, check=False)

    # RE-ASSERT numpy<2 + headless-opencv AFTER YOLOX's requirements.
    sh("pip install -q 'numpy<2' opencv-python-headless")

    # onnx2tf / tensorflow are installed LAZILY in save_and_export (they can drag
    # numpy>=2 + heavy TF wheels that would destabilise the training env).

    fail_fast_env_check()


def fail_fast_env_check():
    """Hard-assert a usable environment in <1 min, BEFORE the expensive
    download+merge, so a broken GPU / clobbered numpy aborts NOW."""
    print("--- fail-fast env check ---", flush=True)
    import numpy
    assert numpy.__version__.split(".")[0] == "1", \
        "numpy must be <2 (got %s) -- pycocotools/opencv ABI break" % numpy.__version__
    import cv2  # noqa: F401
    import torch
    print("torch:", torch.__version__, "| torch.version.cuda:",
          torch.version.cuda, "| cuda avail:", torch.cuda.is_available(),
          flush=True)
    assert torch.cuda.is_available(), (
        "no CUDA GPU visible. In Colab: Runtime > Change runtime type > "
        "Hardware accelerator = GPU (T4). Refusing to burn a session on CPU.")
    cc = torch.cuda.get_device_capability(0)
    print("GPU:", torch.cuda.get_device_name(0), "| capability:", cc, flush=True)
    # Colab free = T4 (sm_75). WARN (don't die) on anything else so a Pro A100
    # (sm_80) still runs.
    if cc[0] not in (6, 7, 8, 9):
        print("  !! WARNING: unusual GPU capability %s" % (cc,), flush=True)
    if not (torch.version.cuda or "").startswith("12.1"):
        print("  !! WARNING: torch.version.cuda=%r (expected 12.1)"
              % torch.version.cuda, flush=True)
    import yolox  # noqa: F401
    from yolox.exp import Exp  # noqa: F401
    print("  env OK (numpy<2, cv2, torch+cuda, yolox)", flush=True)


# --------------------------------------------------------------------------- #
#  Step 2 -- dataset: restore from Drive cache OR download+merge, then cache
# --------------------------------------------------------------------------- #
def _dataset_ready():
    """True if the merged COCO dataset already exists on local /content."""
    return (os.path.isfile(os.path.join(ANN_DIR, TRAIN_ANN))
            and os.path.isdir(TRAIN_IMG_DIR)
            and len(os.listdir(TRAIN_IMG_DIR)) > 0)


def restore_dataset_cache():
    """If a merged-dataset tar exists on Drive, extract it to /content so a
    reconnect skips the ~30-60 min download+merge. Returns True on success."""
    if _dataset_ready():
        print("  merged dataset already present on /content -- skipping restore",
              flush=True)
        return True
    if not os.path.isfile(DRIVE_DATA_TAR):
        return False
    try:
        print("=== STEP 2: restoring merged dataset from Drive cache (%s) ==="
              % DRIVE_DATA_TAR, flush=True)
        os.makedirs(COCO_DIR, exist_ok=True)
        with tarfile.open(DRIVE_DATA_TAR, "r") as tf:
            tf.extractall(CONTENT)
        ok = _dataset_ready()
        print("  restore %s" % ("OK" if ok else "INCOMPLETE -- will rebuild"),
              flush=True)
        return ok
    except Exception as e:
        print("  !! dataset cache restore failed (%r) -- will rebuild" % e,
              flush=True)
        return False


def save_dataset_cache():
    """Tar the merged COCO dataset to Drive so future sessions skip the rebuild.
    Tar LOCALLY first (fast), then copy the finished tar to Drive -- writing a tar
    stream directly through the Drive FUSE mount is slow, and os.replace across
    that mount is not reliably atomic."""
    try:
        print("=== caching merged dataset to Drive (%s) ===" % DRIVE_DATA_TAR,
              flush=True)
        local_tar = os.path.join(CONTENT, "hoopcoco.tar")
        with tarfile.open(local_tar, "w") as tf:
            # store paths RELATIVE to /content so extractall(CONTENT) restores them
            tf.add(COCO_DIR, arcname=os.path.relpath(COCO_DIR, CONTENT))
        _atomic_put(local_tar, DRIVE_DATA_TAR)  # crash-safe copy onto Drive
        print("  cached dataset (%.0f MB)"
              % (os.path.getsize(DRIVE_DATA_TAR) / 1e6), flush=True)
    except Exception as e:
        print("  !! dataset cache save failed (non-fatal): %r" % e, flush=True)


def _has_coco_json(loc):
    if glob.glob(os.path.join(loc, "*", "_annotations.coco.json")):
        return True
    if glob.glob(os.path.join(loc, "*", "*.json")):
        return True
    if os.path.isfile(os.path.join(loc, "_annotations.coco.json")):
        return True
    return False


def download_datasets():
    print("=== STEP 2a: downloading %d datasets (COCO) ===" % len(DATASETS),
          flush=True)
    from roboflow import Roboflow
    rf = Roboflow(api_key=ROBOFLOW_KEY)

    os.makedirs(RAW_DIR, exist_ok=True)
    ok = []
    for i, (ws, proj, ver) in enumerate(DATASETS):
        tag = "%02d_%s" % (i, proj)
        loc = os.path.join(RAW_DIR, tag)
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
    out = {}
    for split in ("train", "valid", "test"):
        d = os.path.join(loc, split)
        if os.path.isfile(os.path.join(d, "_annotations.coco.json")):
            out[split] = d
    if not out and os.path.isfile(os.path.join(loc, "_annotations.coco.json")):
        out["train"] = loc
    return out


def _read_wh(path):
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
    """Merge all downloaded COCO datasets into one YOLOX/COCO dataset at COCO_DIR.
    (Identical remap/filter/id-offset logic to the proven Kaggle kernel.)"""
    print("=== STEP 2b: merging into COCO at %s ===" % COCO_DIR, flush=True)

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
    img_id_ctr = 1
    ann_id_ctr = 1
    copied = {"train": 0, "val": 0}
    kept_anns = 0
    dropped_anns = 0
    per_ds_kept = {}

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

            src_cat_map = {}
            src_names = []
            for c in coco.get("categories", []):
                cid = c.get("id")
                nm = str(c.get("name", "")).strip().lower()
                supercat = str(c.get("supercategory", "")).strip().lower()
                src_names.append("%s:%s" % (cid, nm))
                if cid == 0 or supercat == "none":
                    src_cat_map[cid] = None
                    continue
                tgt = NAME2TGT.get(nm)
                src_cat_map[cid] = (tgt + 1) if tgt is not None else None
                if tgt is None:
                    ds_unmapped_names.add("%s(id%s)" % (nm, cid))

            anns_by_img = {}
            for a in coco.get("annotations", []):
                anns_by_img.setdefault(a["image_id"], []).append(a)

            for im in coco.get("images", []):
                src_iid = im["id"]
                raw_anns = anns_by_img.get(src_iid, [])
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

                if raw_anns and not keep:
                    dropped_anns += len(raw_anns)
                    continue

                fn = im.get("file_name")
                if not fn:
                    continue
                src_img = os.path.join(sdir, fn)
                if not os.path.isfile(src_img):
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

                img_id_ctr += 1
                w = im.get("width") or 0
                h = im.get("height") or 0
                if not w or not h:
                    w, h = _read_wh(dst_path)

                merged[target]["images"].append({
                    "id": new_iid, "file_name": new_name,
                    "width": int(w), "height": int(h),
                })
                copied[target] += 1
                dropped_anns += (len(raw_anns) - len(keep))

                for a, ucat in keep:
                    bx = [float(x) for x in a["bbox"]]
                    merged[target]["annotations"].append({
                        "id": ann_id_ctr, "image_id": new_iid,
                        "category_id": ucat, "bbox": bx,
                        "area": float(a.get("area", bx[2] * bx[3])),
                        "iscrowd": int(a.get("iscrowd", 0)),
                        "segmentation": a.get("segmentation", []),
                    })
                    ann_id_ctr += 1
                    kept_anns += 1
                    ds_kept += 1

        per_ds_kept[tag] = ds_kept
        msg = "  [ds %s] kept_anns=%d cats={%s}" % (
            tag, ds_kept, ", ".join(src_names[:12]))
        if ds_unmapped_names:
            msg += "  UNMAPPED={%s}" % ", ".join(sorted(ds_unmapped_names)[:12])
        print(msg, flush=True)
        if ds_kept == 0:
            print("  !! WARNING: dataset %s contributed 0 kept annotations" % tag,
                  flush=True)

    if copied["val"] == 0 and copied["train"] > 0:
        print("  !! no val images -- carving ~5%% of train into val", flush=True)
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
        for im in val_imgs:
            src = os.path.join(TRAIN_IMG_DIR, im["file_name"])
            dst = os.path.join(VAL_IMG_DIR, im["file_name"])
            if os.path.isfile(src):
                shutil.move(src, dst)
        copied["val"] = len(val_imgs)
        copied["train"] = len(merged["train"]["images"])

    for target, ann_name in (("train", TRAIN_ANN), ("val", VAL_ANN)):
        doc = {
            "info": {"description": "hoopai merged basketball (4-class)"},
            "licenses": [], "images": merged[target]["images"],
            "annotations": merged[target]["annotations"], "categories": categories,
        }
        with open(os.path.join(ANN_DIR, ann_name), "w", encoding="utf-8") as f:
            json.dump(doc, f)

    print("MERGED train=%d val=%d  (kept_anns=%d dropped_anns=%d)"
          % (copied["train"], copied["val"], kept_anns, dropped_anns), flush=True)
    if copied["train"] == 0:
        raise RuntimeError("merge produced 0 training images -- aborting")
    if kept_anns == 0:
        raise RuntimeError("merge produced 0 kept annotations -- aborting")
    return copied["train"], copied["val"]


def add_negatives():
    """Append non-basketball background images as NEGATIVES (zero-annotation
    images) to teach 'predict nothing here', cutting false positives on court
    clutter. Best-effort: point HOOPAI_NEG_DIR at a folder of .jpg backgrounds
    (e.g. an Intel-Image-Classification copy on Drive); skip cleanly if absent."""
    import glob as _glob
    from PIL import Image
    print("=== STEP 2c: adding non-basketball negatives ===", flush=True)
    neg_dir = os.environ.get("HOOPAI_NEG_DIR", "").strip()
    if not neg_dir or not os.path.isdir(neg_dir):
        print("  (no HOOPAI_NEG_DIR set / not a dir -- skipping negatives; the "
              "model still trains, just with slightly more court-clutter false "
              "positives)", flush=True)
        return
    imgs = sorted(_glob.glob(os.path.join(neg_dir, "**", "*.jpg"), recursive=True))
    imgs = imgs[:8000]
    if not imgs:
        print("  !! no .jpg under %s -- skipping" % neg_dir, flush=True)
        return
    ann_path = os.path.join(ANN_DIR, TRAIN_ANN)
    with open(ann_path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    next_id = max((im["id"] for im in doc["images"]), default=0) + 1
    added = 0
    for src in imgs:
        try:
            with Image.open(src) as im:
                w, h = im.size
            if w <= 0 or h <= 0:
                continue
            fn = "neg_%06d.jpg" % added
            shutil.copyfile(src, os.path.join(TRAIN_IMG_DIR, fn))
            doc["images"].append(
                {"id": next_id, "file_name": fn, "width": w, "height": h, "license": 0})
            next_id += 1
            added += 1
        except Exception:
            continue
    with open(ann_path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    print("  added %d negative images -- train images now %d"
          % (added, len(doc["images"])), flush=True)


# --------------------------------------------------------------------------- #
#  Step 3 -- write custom YOLOX-Tiny Exp
# --------------------------------------------------------------------------- #
def write_exp():
    print("=== STEP 3: writing custom Exp %s ===" % EXP_FILE, flush=True)
    exp_src = '''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Custom YOLOX-Tiny Exp for hoopai 4-class basketball dataset.
import os
import torch.nn as nn
from yolox.exp import Exp as MyExp


class Exp(MyExp):
    def __init__(self):
        super(Exp, self).__init__()
        # ---- tiny geometry (matches exps/default/yolox_tiny.py) ----
        self.depth = 0.33
        self.width = 0.375
        self.input_size = (416, 416)
        # PIN resolution to 416 (13*32=416) so batch-fit + time estimates hold.
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
        self.eval_interval = 1
        self.print_interval = 20
        self.warmup_epochs = 2
        self.no_aug_epochs = 3
        self.save_history_ckpt = False

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
            # TINY uses STANDARD (non-depthwise) convs -- the extra small-object
            # capacity over nano.
            backbone = YOLOPAFPN(
                self.depth, self.width, in_channels=in_channels,
                act=self.act, depthwise=False,
            )
            head = YOLOXHead(
                self.num_classes, self.width, in_channels=in_channels,
                act=self.act, depthwise=False,
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
    print("  wrote Exp (num_classes=4, max_epoch=%d, out=%s)"
          % (MAX_EPOCH, OUT_ROOT), flush=True)


# --------------------------------------------------------------------------- #
#  Step 4 -- resume-aware training with continuous Drive checkpoint mirroring
# --------------------------------------------------------------------------- #
def fetch_pretrained():
    """Download official yolox_tiny.pth to finetune from (first session only)."""
    dst = os.path.join(CONTENT, "yolox_tiny.pth")
    if os.path.isfile(dst) and os.path.getsize(dst) > 1_000_000:
        return dst
    url = ("https://github.com/Megvii-BaseDetection/YOLOX/releases/download/"
           "0.1.1rc0/yolox_tiny.pth")
    try:
        sh("wget -q -O %s %s" % (dst, url), check=False)
        if os.path.isfile(dst) and os.path.getsize(dst) > 1_000_000:
            print("  fetched pretrained yolox_tiny.pth", flush=True)
            return dst
    except Exception as e:
        print("  !! pretrained fetch failed: %r (train from scratch)" % e,
              flush=True)
    if os.path.isfile(dst):
        os.remove(dst)
    return None


def restore_ckpt_for_resume():
    """If a training checkpoint from a previous session sits on Drive, copy it to
    the canonical local path YOLOX auto-loads on `--resume`
    (<output_dir>/<exp_name>/latest_ckpt.pth) so training CONTINUES the epoch
    count instead of restarting. Returns True if a resume checkpoint was staged.

    YOLOX's latest_ckpt.pth AND best_ckpt.pth both carry model + optimizer +
    start_epoch (only the exported .onnx is weights-only), so either resumes
    correctly; latest is preferred as it's the furthest-along epoch. We normalize
    whichever we pick to latest_ckpt.pth and invoke `--resume` with NO -c, the
    canonical auto-find flow (zero ambiguity about -c interaction)."""
    os.makedirs(CKPT_OUT_DIR, exist_ok=True)
    dst = os.path.join(CKPT_OUT_DIR, "latest_ckpt.pth")
    for name in ("latest_ckpt.pth", "best_ckpt.pth"):
        drive_ck = os.path.join(DRIVE_CKPT_DIR, name)
        if os.path.isfile(drive_ck) and os.path.getsize(drive_ck) > 1_000_000:
            try:
                _atomic_put(drive_ck, dst)
                print("  RESUME: staged %s from Drive -> %s" % (name, dst),
                      flush=True)
                return True
            except Exception as e:
                print("  !! resume restore failed (%r) -- starting fresh" % e,
                      flush=True)
                return False
    return False


def _newest_ckpt():
    cands = glob.glob(os.path.join(CKPT_OUT_DIR, "*ckpt.pth"))
    if not cands:
        cands = glob.glob(os.path.join(OUT_ROOT, "**", "*ckpt.pth"), recursive=True)
    return max(cands, key=os.path.getmtime) if cands else None


def _mirror_ckpts_to_drive():
    """Crash-safely mirror the local latest/best checkpoints to Drive so a
    disconnect leaves a resumable + deliverable checkpoint. ALWAYS copies (no
    local-vs-Drive mtime skip -- Drive FUSE mtimes are unreliable and a skew
    could otherwise leave a stale checkpoint on Drive, resuming an older epoch);
    _atomic_put keeps each write crash-safe. _newest_ckpt uses LOCAL-only mtimes
    (reliable) to pick which checkpoint is furthest along. Returns True if it
    copied anything."""
    copied = False
    try:
        for name in ("latest_ckpt.pth", "best_ckpt.pth"):
            local_ck = os.path.join(CKPT_OUT_DIR, name)
            if os.path.isfile(local_ck):
                _atomic_put(local_ck, os.path.join(DRIVE_CKPT_DIR, name))
                copied = True
        # Promote the newest checkpoint to the documented deliverable name.
        src = _newest_ckpt()
        if src:
            _atomic_put(src, PROMOTED_PTH)
            copied = True
    except Exception as e:
        print("  !! drive mirror fail: %r" % e, flush=True)
    return copied


class _Promoter(threading.Thread):
    """Background: continuously mirror the newest local checkpoint to Drive, so a
    Colab disconnect still leaves a resumable + deliverable checkpoint."""
    def __init__(self, interval=120):
        super().__init__(daemon=True)
        self.interval = interval
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            if _mirror_ckpts_to_drive():
                print("  [promoter] mirrored checkpoints -> Drive", flush=True)
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


def train(resumed, pretrained):
    print("=== STEP 4: training (max_epoch=%d, batch=%d) ===" % (MAX_EPOCH, BATCH_SIZE),
          flush=True)
    os.makedirs(OUT_ROOT, exist_ok=True)

    env = dict(os.environ)
    env["PYTHONPATH"] = YOLOX_DIR + os.pathsep + env.get("PYTHONPATH", "")
    env["YOLOX_DATADIR"] = COCO_DIR

    import torch
    fp16 = "--fp16" if torch.cuda.is_available() else ""  # T4 has Tensor Cores

    train_py = os.path.join(YOLOX_DIR, "tools", "train.py")
    if resumed:
        # Canonical resume: YOLOX auto-loads CKPT_OUT_DIR/latest_ckpt.pth (which
        # restore staged) and CONTINUES the epoch count + optimizer state. No -c.
        ckpt_arg = "--resume"
        print("  MODE: RESUME from Drive checkpoint (continuing epoch count)",
              flush=True)
    elif pretrained:
        # First session: finetune from official pretrained weights.
        ckpt_arg = "-c %s" % pretrained
        print("  MODE: finetune from pretrained yolox_tiny.pth", flush=True)
    else:
        ckpt_arg = ""
        print("  MODE: training FROM SCRATCH (no resume ckpt, no pretrained "
              "weights fetched)", flush=True)
    # NO `-o <value>`: -o/--occupy is store_true (takes no arg); a value spills
    # into opts and trips exp.merge's even-length assert. Name is via -expn.
    cmd = ("python %s -f %s -d 1 -b %d %s %s -expn %s"
           % (train_py, EXP_FILE, BATCH_SIZE, fp16, ckpt_arg, EXP_NAME))

    promoter = _Promoter(interval=120)
    promoter.start()
    try:
        rc = sh(cmd, check=False, env=env)
        print("  train.py exited rc=%d" % rc, flush=True)
    finally:
        promoter.stop()
        _mirror_ckpts_to_drive()  # final mirror after train exits/errors


# --------------------------------------------------------------------------- #
#  Step 5 -- save weights, eval, export ONNX, best-effort tflite (to Drive)
# --------------------------------------------------------------------------- #
def _find_ckpt():
    for name in ("best_ckpt.pth", "latest_ckpt.pth"):
        p = os.path.join(CKPT_OUT_DIR, name)
        if os.path.isfile(p):
            return p
    hits = glob.glob(os.path.join(OUT_ROOT, "**", "*ckpt.pth"), recursive=True)
    if hits:
        return max(hits, key=os.path.getmtime)
    # Fall back to a Drive-mirrored checkpoint (e.g. exporting in a fresh session).
    for name in ("best_ckpt.pth", "latest_ckpt.pth"):
        p = os.path.join(DRIVE_CKPT_DIR, name)
        if os.path.isfile(p):
            return p
    if os.path.isfile(PROMOTED_PTH):
        return PROMOTED_PTH
    return None


def save_and_export():
    print("=== STEP 5: save / eval / export ===", flush=True)
    ckpt = _find_ckpt()
    if not ckpt:
        print("  !! no checkpoint found -- nothing to export", flush=True)
        return

    pth_out = PROMOTED_PTH
    if os.path.abspath(ckpt) != os.path.abspath(pth_out):
        shutil.copyfile(ckpt, pth_out)
    print("SAVED %s (from %s)" % (pth_out, ckpt), flush=True)

    env = dict(os.environ)
    env["PYTHONPATH"] = YOLOX_DIR + os.pathsep + env.get("PYTHONPATH", "")
    env["YOLOX_DATADIR"] = COCO_DIR

    import torch
    fp16 = "--fp16" if torch.cuda.is_available() else ""

    # 5b. Eval (COCO mAP) -- best-effort.
    try:
        eval_py = os.path.join(YOLOX_DIR, "tools", "eval.py")
        if os.path.isfile(eval_py):
            sh("python %s -f %s -c %s -b %d -d 1 %s --conf 0.001"
               % (eval_py, EXP_FILE, pth_out, BATCH_SIZE, fp16),
               check=False, env=env)
    except Exception as e:
        print("  !! eval skipped: %r" % e, flush=True)

    # 5c. Export ONNX -- best-effort.
    onnx_out = os.path.join(DRIVE_DIR, "hoopai-yolox.onnx")
    onnx_ok = False
    try:
        export_py = os.path.join(YOLOX_DIR, "tools", "export_onnx.py")
        sh("python %s -f %s -c %s --output-name %s --opset 12"
           % (export_py, EXP_FILE, pth_out, onnx_out), check=False, env=env)
        onnx_ok = os.path.isfile(onnx_out) and os.path.getsize(onnx_out) > 1000
        if onnx_ok:
            print("SAVED %s" % onnx_out, flush=True)
    except Exception as e:
        print("  !! onnx export failed: %r" % e, flush=True)

    # 5d. ONNX -> tflite via onnx2tf -- best-effort, lazy toolchain install.
    if onnx_ok:
        try:
            print("  installing onnx2tf toolchain (lazy)...", flush=True)
            sh("pip install -q onnx2tf onnxsim onnx_graphsurgeon sng4onnx "
               "'tensorflow-cpu' 'tf-keras' || true", check=False)
            tf_dir = os.path.join(CONTENT, "onnx2tf_out")
            shutil.rmtree(tf_dir, ignore_errors=True)
            rc = sh("onnx2tf -i %s -o %s -osd" % (onnx_out, tf_dir),
                    check=False, env=env)
            cands = sorted(
                glob.glob(os.path.join(tf_dir, "*float32.tflite")) +
                glob.glob(os.path.join(tf_dir, "*.tflite")))
            if cands:
                tfl_out = os.path.join(DRIVE_DIR, "hoopai-yolox.tflite")
                shutil.copyfile(cands[0], tfl_out)
                print("SAVED %s (from %s)" % (tfl_out, cands[0]), flush=True)
            else:
                print("  !! onnx2tf produced no .tflite (rc=%d)" % rc, flush=True)
        except Exception as e:
            print("  !! tflite conversion failed (kept .pth/.onnx): %r" % e,
                  flush=True)
    else:
        print("  !! no valid ONNX -- skipping tflite", flush=True)

    # 5e. Metadata.
    try:
        tfl = os.path.join(DRIVE_DIR, "hoopai-yolox.tflite")
        meta = {
            "classes": TARGET_NAMES, "num_classes": len(TARGET_NAMES),
            "input_size": list(INPUT_SIZE), "arch": "yolox_tiny",
            "artifacts": {
                "pth": os.path.basename(pth_out),
                "onnx": os.path.basename(onnx_out) if onnx_ok else None,
                "tflite": ("hoopai-yolox.tflite" if os.path.isfile(tfl) else None),
            },
        }
        with open(os.path.join(DRIVE_DIR, "hoopai-yolox.meta.json"),
                  "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        print("SAVED hoopai-yolox.meta.json", flush=True)
    except Exception as e:
        print("  !! meta write failed: %r" % e, flush=True)


# --------------------------------------------------------------------------- #
#  main
# --------------------------------------------------------------------------- #
def main():
    print("########## HOOPAI YOLOX-TINY -- COLAB TRAINING ##########", flush=True)
    preflight()
    setup_env()

    # Dataset: restore the Drive cache if present, else download+merge+cache.
    if not restore_dataset_cache():
        downloaded = download_datasets()
        if not downloaded:
            raise RuntimeError("no datasets downloaded -- cannot proceed")
        merge_datasets(downloaded)
        add_negatives()
        save_dataset_cache()

    write_exp()

    # Resume from a Drive-mirrored checkpoint if a previous session left one;
    # otherwise finetune from official pretrained weights.
    resumed = restore_ckpt_for_resume()
    pretrained = None if resumed else fetch_pretrained()
    train(resumed, pretrained)

    save_and_export()

    print("########## DONE -- artifacts in %s ##########" % DRIVE_DIR, flush=True)
    for f in sorted(os.listdir(DRIVE_DIR)):
        p = os.path.join(DRIVE_DIR, f)
        if os.path.isfile(p) and (f.startswith("hoopai") or f.startswith("yolox_tiny_hoop")):
            print("   %s  (%.1f MB)" % (f, os.path.getsize(p) / 1e6), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("!!!!!!!!!! FATAL !!!!!!!!!!", flush=True)
        traceback.print_exc()
        # Salvage: mirror whatever checkpoint exists to Drive before exiting.
        try:
            _mirror_ckpts_to_drive()
        except Exception:
            traceback.print_exc()
        sys.exit(1)
