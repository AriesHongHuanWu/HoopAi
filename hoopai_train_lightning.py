#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hoopai_train_lightning.py  --  Lightning.ai GPU Studio YOLOX-Tiny training

Lightning.ai port of the proven Kaggle kernel (hoopai-train-yolox.py). Trains
YOLOX-Tiny (4 classes: ball, rim, ball_in_basket, person) on the merged
35-dataset Roboflow corpus, then exports:
    <WORK>/yolox_tiny_hoop.pth   (best/latest checkpoint, always)
    <WORK>/hoopai-yolox.onnx     (ONNX, best-effort)
    <WORK>/hoopai-yolox.tflite   (tflite via onnx2tf, best-effort)
where WORK defaults to the Studio's PERSISTENT disk (/teamspace/studios/this_studio).

WHY LIGHTNING (vs Kaggle/Colab): Kaggle's 30h/week quota can run dry and caps a
session at a hard ~12h wall with no resume; Colab free disconnects on idle. A
Lightning free Studio gives ~80 GPU-h/month on a T4 with NO idle timeout, and
background (nohup) execution survives closing the browser. The one quirk is that
a Studio auto-restarts roughly every 4h, so a ~12h run spans a few restarts --
handled cleanly here because:
  * WORK is on the Studio's PERSISTENT disk, so the merged dataset AND every
    checkpoint survive a restart (no re-download, no lost training).
  * On (re)launch, if a training checkpoint already exists under WORK, training
    RESUMES from it (YOLOX --resume: continues the epoch count + optimizer
    state) instead of restarting. Just re-run the SAME launch command after a
    restart and it picks up.

HOW TO RUN (in the Studio Terminal, T4 machine selected):
    # one-time: Python 3.11 venv (conda is blocked; 1-env limit)
    uv venv ~/yolox-env --python 3.11 && source ~/yolox-env/bin/activate
    export ROBOFLOW_KEY="<your NEW rotated Roboflow key>"
    # launch detached; survives closing the browser:
    nohup python -u hoopai_train_lightning.py > ~/yolox_train.log 2>&1 &
    tail -f ~/yolox_train.log        # watch progress
    # after a ~4h Studio restart: re-open terminal, re-activate, re-export key,
    # and re-run the SAME nohup line -- it resumes from the newest checkpoint.

Load-bearing torch pin (unchanged): torch==2.5.1+cu121. YOLOX trainer.py uses the
deprecated torch.cuda.amp.* and torch.load WITHOUT weights_only; torch>=2.6 flips
that default and breaks loading the pickled checkpoints. T4 is sm_75 -> cu121 is
fine, and unlike the P100 the kernel was tuned for, T4 has Tensor Cores so --fp16
genuinely speeds it up.

SECURITY: the Roboflow key is read from the ROBOFLOW_KEY env var -- NEVER
hardcoded. The key hardcoded in the old Kaggle kernel is exposed in git history
and MUST be rotated in the Roboflow dashboard; do not reuse it.
"""

import os
import re
import sys
import json
import glob
import shutil
import threading
import subprocess
import traceback

# --------------------------------------------------------------------------- #
#  Paths / constants  (Lightning: durable state on the PERSISTENT Studio disk)
# --------------------------------------------------------------------------- #
# Everything under WORK persists across the ~4h Studio auto-restart, so the
# merged dataset + checkpoints survive and the run resumes. Overridable via env.
WORK      = os.environ.get("HOOPAI_WORK", "/teamspace/studios/this_studio/yolox_work")
TMP       = "/tmp"
RAW_DIR   = os.path.join(TMP, "hoop_raw")          # raw roboflow downloads (scratch)
COCO_DIR  = os.path.join(WORK, "hoopcoco")         # merged dataset (PERSISTENT)
YOLOX_DIR = os.path.join(WORK, "YOLOX")            # cloned repo (persist -> skip re-clone)
EXP_FILE  = os.path.join(WORK, "hoop_exp.py")      # generated custom Exp
OUT_ROOT  = os.path.join(WORK, "YOLOX_outputs")    # checkpoint root (PERSISTENT -> resume)
EXP_NAME  = "hoop_yolox_tiny"

TRAIN_IMG_DIR = os.path.join(COCO_DIR, "train2017")
VAL_IMG_DIR   = os.path.join(COCO_DIR, "val2017")
ANN_DIR       = os.path.join(COCO_DIR, "annotations")
TRAIN_ANN     = "instances_train2017.json"
VAL_ANN       = "instances_val2017.json"

CKPT_OUT_DIR  = os.path.join(OUT_ROOT, EXP_NAME)   # YOLOX writes here (output_dir/exp)
PROMOTED_PTH  = os.path.join(WORK, "yolox_tiny_hoop.pth")

# SECURITY: no hardcoded key. Set ROBOFLOW_KEY in the Studio before running.
ROBOFLOW_KEY  = os.environ.get("ROBOFLOW_KEY", "").strip()

# Overridable via env.
MAX_EPOCH  = int(os.environ.get("HOOPAI_MAX_EPOCH", "12"))
BATCH_SIZE = int(os.environ.get("HOOPAI_BATCH", "16"))
INPUT_SIZE = (416, 416)

TARGET_NAMES = ["ball", "rim", "ball_in_basket", "person"]

# class-name (lowercased) -> target index.  Anything not here is DROPPED.
NAME2TGT = {
    "basketball": 0, "ball": 0, "iball": 0, "b-ball": 0, "bball": 0,
    "ball-basketball": 0,
    "hoop": 1, "rim": 1, "basket": 1, "net": 1, "hoops": 1, "rims": 1,
    "basketball-hoop": 1, "basketball_hoop": 1, "basket-ball-hoop": 1,
    "backboard-hoop": 1,
    "ball-in-basket": 2, "ball_in_basket": 2, "ball in basket": 2,
    "made": 2, "made-basket": 2, "made_basket": 2, "made basket": 2,
    "hit": 2, "goal": 2, "inbasket": 2, "in-basket": 2,
    "score": 2, "scored": 2, "make": 2, "makes": 2, "swish": 2,
    "basket-made": 2, "basket_made": 2, "shot-made": 2, "shot_made": 2,
    "made-shot": 2, "successful-shot": 2, "points": 2,
    "player": 3, "person": 3, "people": 3, "players": 3, "persons": 3,
    "guest_player": 3, "home_player": 3, "guest-player": 3, "home-player": 3,
    "team1": 3, "team2": 3, "team-1": 3, "team-2": 3,
    "non-shooting-player": 3, "shooting-player": 3,
    "non_shooting_player": 3, "shooting_player": 3,
    "ball-handler": 3, "ball_handler": 3, "ballhandler": 3,
    "referee": 3,
}

# FULL 35-dataset corpus (variety > epochs-to-converge; curating to 12 generalized
# worse on real footage).
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


def sh(cmd, check=True, env=None):
    print("  $ " + cmd, flush=True)
    r = subprocess.run(cmd, shell=True, env=env)
    if check and r.returncode != 0:
        raise RuntimeError("command failed (%d): %s" % (r.returncode, cmd))
    return r.returncode


# --------------------------------------------------------------------------- #
#  Step 0 -- preflight: key + persistent WORK dir
# --------------------------------------------------------------------------- #
def preflight():
    print("=== STEP 0: preflight ===", flush=True)
    if not ROBOFLOW_KEY:
        raise RuntimeError(
            "ROBOFLOW_KEY env var is empty. Before launching, run:\n"
            "    export ROBOFLOW_KEY='<your NEW rotated Roboflow key>'\n"
            "(Rotate the old exposed key in the Roboflow dashboard first.)")
    os.makedirs(WORK, exist_ok=True)
    if not os.path.isdir(os.path.dirname(WORK)) and not WORK.startswith("/teamspace"):
        print("  !! WARNING: WORK=%s is not under /teamspace -- it may NOT persist "
              "across a Studio restart (resume would break). Set HOOPAI_WORK to a "
              "persistent path." % WORK, flush=True)
    print("  WORK=%s | key present (%d chars)" % (WORK, len(ROBOFLOW_KEY)), flush=True)


# --------------------------------------------------------------------------- #
#  Step 1 -- environment: T4-safe torch, YOLOX, deps
# --------------------------------------------------------------------------- #
def setup_env():
    print("=== STEP 1: environment setup ===", flush=True)
    # LOAD-BEARING PIN (see docstring). Idempotent: pip skips already-satisfied on
    # a restart, so re-running after a Studio restart is fast.
    sh("pip install -q torch==2.5.1 torchvision==0.20.1 "
       "--index-url https://download.pytorch.org/whl/cu121")
    sh("pip install -q pycocotools onnx onnxruntime loguru tabulate thop ninja "
       "'numpy<2' opencv-python-headless roboflow psutil 'Pillow'")

    if not os.path.isdir(YOLOX_DIR):
        sh("git clone --depth 1 https://github.com/Megvii-BaseDetection/YOLOX "
           + YOLOX_DIR)

    # Strip YOLOX's unpinned numpy / non-headless opencv / onnx-simplifier (the
    # last one's egg_info build fails on Python 3.12, Lightning's default).
    req_in = os.path.join(YOLOX_DIR, "requirements.txt")
    req_out = os.path.join(TMP, "yolox_requirements_filtered.txt")
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
        print("  !! could not filter YOLOX requirements (%r) -- raw install" % e,
              flush=True)
        sh("pip install -q -r %s || true" % req_in, check=False)

    if YOLOX_DIR not in sys.path:
        sys.path.insert(0, YOLOX_DIR)
    sh("pip install -q --no-deps --no-build-isolation %s" % YOLOX_DIR, check=False)
    sh("pip install -q 'numpy<2' opencv-python-headless")
    fail_fast_env_check()


def fail_fast_env_check():
    print("--- fail-fast env check ---", flush=True)
    import numpy
    assert numpy.__version__.split(".")[0] == "1", \
        "numpy must be <2 (got %s)" % numpy.__version__
    import cv2  # noqa: F401
    import torch
    print("torch:", torch.__version__, "| cuda:", torch.version.cuda,
          "| avail:", torch.cuda.is_available(), flush=True)
    assert torch.cuda.is_available(), (
        "no CUDA GPU visible. In the Lightning Studio, switch the machine to a "
        "GPU (T4) before running.")
    cc = torch.cuda.get_device_capability(0)
    print("GPU:", torch.cuda.get_device_name(0), "| capability:", cc, flush=True)
    if cc[0] not in (6, 7, 8, 9):
        print("  !! WARNING: unusual GPU capability %s" % (cc,), flush=True)
    import yolox  # noqa: F401
    from yolox.exp import Exp  # noqa: F401
    print("  env OK (numpy<2, cv2, torch+cuda, yolox)", flush=True)


# --------------------------------------------------------------------------- #
#  Step 2 -- dataset: reuse the PERSISTED merge, else download + merge
# --------------------------------------------------------------------------- #
def _dataset_ready():
    return (os.path.isfile(os.path.join(ANN_DIR, TRAIN_ANN))
            and os.path.isdir(TRAIN_IMG_DIR)
            and len(os.listdir(TRAIN_IMG_DIR)) > 0)


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
            rf.workspace(ws).project(proj).version(ver).download("coco", location=loc)
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
    print("=== STEP 2b: merging into COCO at %s ===" % COCO_DIR, flush=True)
    for d in (TRAIN_IMG_DIR, VAL_IMG_DIR, ANN_DIR):
        os.makedirs(d, exist_ok=True)
    categories = [{"id": i + 1, "name": n, "supercategory": "hoop"}
                  for i, n in enumerate(TARGET_NAMES)]
    merged = {"train": {"images": [], "annotations": []},
              "val": {"images": [], "annotations": []}}
    img_id_ctr = 1
    ann_id_ctr = 1
    copied = {"train": 0, "val": 0}
    kept_anns = 0
    dropped_anns = 0

    for loc, tag in downloaded:
        splits = _find_split_dirs(loc)
        if not splits:
            print("  !! no coco json in %s, skipping" % tag, flush=True)
            continue
        ds_kept = 0
        ds_unmapped = set()
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
                    ds_unmapped.add("%s(id%s)" % (nm, cid))
            anns_by_img = {}
            for a in coco.get("annotations", []):
                anns_by_img.setdefault(a["image_id"], []).append(a)
            for im in coco.get("images", []):
                raw_anns = anns_by_img.get(im["id"], [])
                keep = []
                for a in raw_anns:
                    ucat = src_cat_map.get(a["category_id"])
                    if ucat is None:
                        continue
                    bbox = a.get("bbox")
                    if (not bbox or len(bbox) != 4 or bbox[2] <= 0 or bbox[3] <= 0):
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
                merged[target]["images"].append(
                    {"id": new_iid, "file_name": new_name, "width": int(w), "height": int(h)})
                copied[target] += 1
                dropped_anns += (len(raw_anns) - len(keep))
                for a, ucat in keep:
                    bx = [float(x) for x in a["bbox"]]
                    merged[target]["annotations"].append({
                        "id": ann_id_ctr, "image_id": new_iid, "category_id": ucat,
                        "bbox": bx, "area": float(a.get("area", bx[2] * bx[3])),
                        "iscrowd": int(a.get("iscrowd", 0)),
                        "segmentation": a.get("segmentation", [])})
                    ann_id_ctr += 1
                    kept_anns += 1
                    ds_kept += 1
        msg = "  [ds %s] kept_anns=%d cats={%s}" % (tag, ds_kept, ", ".join(src_names[:12]))
        if ds_unmapped:
            msg += "  UNMAPPED={%s}" % ", ".join(sorted(ds_unmapped)[:12])
        print(msg, flush=True)

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
        doc = {"info": {"description": "hoopai merged basketball (4-class)"},
               "licenses": [], "images": merged[target]["images"],
               "annotations": merged[target]["annotations"], "categories": categories}
        with open(os.path.join(ANN_DIR, ann_name), "w", encoding="utf-8") as f:
            json.dump(doc, f)
    print("MERGED train=%d val=%d  (kept_anns=%d dropped_anns=%d)"
          % (copied["train"], copied["val"], kept_anns, dropped_anns), flush=True)
    if copied["train"] == 0:
        raise RuntimeError("merge produced 0 training images -- aborting")
    if kept_anns == 0:
        raise RuntimeError("merge produced 0 kept annotations -- aborting")


def add_negatives():
    import glob as _glob
    from PIL import Image
    print("=== STEP 2c: negatives ===", flush=True)
    neg_dir = os.environ.get("HOOPAI_NEG_DIR", "").strip()
    if not neg_dir or not os.path.isdir(neg_dir):
        print("  (no HOOPAI_NEG_DIR -- skipping negatives; trains fine, just a few "
              "more court-clutter false positives)", flush=True)
        return
    imgs = sorted(_glob.glob(os.path.join(neg_dir, "**", "*.jpg"), recursive=True))[:8000]
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
            doc["images"].append({"id": next_id, "file_name": fn, "width": w, "height": h, "license": 0})
            next_id += 1
            added += 1
        except Exception:
            continue
    with open(ann_path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    print("  added %d negatives -- train images now %d" % (added, len(doc["images"])),
          flush=True)


# --------------------------------------------------------------------------- #
#  Step 3 -- write custom YOLOX-Tiny Exp
# --------------------------------------------------------------------------- #
def write_exp():
    print("=== STEP 3: writing Exp %s ===" % EXP_FILE, flush=True)
    exp_src = '''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import torch.nn as nn
from yolox.exp import Exp as MyExp


class Exp(MyExp):
    def __init__(self):
        super(Exp, self).__init__()
        self.depth = 0.33
        self.width = 0.375
        self.input_size = (416, 416)
        self.random_size = (13, 13)
        self.mosaic_scale = (0.5, 1.5)
        self.test_size = (416, 416)
        self.mosaic_prob = 0.5
        self.enable_mixup = False
        self.num_classes = 4
        self.data_dir = "%(data_dir)s"
        self.train_ann = "%(train_ann)s"
        self.val_ann = "%(val_ann)s"
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
            backbone = YOLOPAFPN(self.depth, self.width, in_channels=in_channels,
                                 act=self.act, depthwise=False)
            head = YOLOXHead(self.num_classes, self.width, in_channels=in_channels,
                             act=self.act, depthwise=False)
            self.model = YOLOX(backbone, head)
        self.model.apply(init_yolo)
        self.model.head.initialize_biases(1e-2)
        return self.model
''' % {"data_dir": COCO_DIR, "train_ann": TRAIN_ANN, "val_ann": VAL_ANN,
       "max_epoch": MAX_EPOCH, "out_root": OUT_ROOT, "exp_name": EXP_NAME}
    with open(EXP_FILE, "w", encoding="utf-8") as f:
        f.write(exp_src)
    print("  wrote Exp (max_epoch=%d, out=%s)" % (MAX_EPOCH, OUT_ROOT), flush=True)


# --------------------------------------------------------------------------- #
#  Step 4 -- resume-aware training with a persistent-disk checkpoint promoter
# --------------------------------------------------------------------------- #
def fetch_pretrained():
    dst = os.path.join(WORK, "yolox_tiny.pth")
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
        print("  !! pretrained fetch failed: %r" % e, flush=True)
    if os.path.isfile(dst):
        os.remove(dst)
    return None


def can_resume():
    """A prior session left a training checkpoint on the persistent disk at the
    canonical path YOLOX --resume auto-loads (output_dir/exp_name/latest_ckpt.pth).
    No copying needed -- WORK persists across the Studio restart."""
    p = os.path.join(CKPT_OUT_DIR, "latest_ckpt.pth")
    return os.path.isfile(p) and os.path.getsize(p) > 1_000_000


def _newest_ckpt():
    cands = glob.glob(os.path.join(CKPT_OUT_DIR, "*ckpt.pth"))
    if not cands:
        cands = glob.glob(os.path.join(OUT_ROOT, "**", "*ckpt.pth"), recursive=True)
    return max(cands, key=os.path.getmtime) if cands else None


def _promote_once():
    src = _newest_ckpt()
    if not src:
        return False
    try:
        if (not os.path.isfile(PROMOTED_PTH)
                or os.path.getmtime(src) > os.path.getmtime(PROMOTED_PTH)):
            tmp = PROMOTED_PTH + ".tmp"
            shutil.copyfile(src, tmp)
            os.replace(tmp, PROMOTED_PTH)
            return True
    except Exception as e:
        print("  !! promote fail: %r" % e, flush=True)
    return False


class _Promoter(threading.Thread):
    def __init__(self, interval=120):
        super().__init__(daemon=True)
        self.interval = interval
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            if _promote_once():
                print("  [promoter] refreshed %s" % os.path.basename(PROMOTED_PTH),
                      flush=True)
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
        ckpt_arg = "--resume"  # auto-loads CKPT_OUT_DIR/latest_ckpt.pth (persisted)
        print("  MODE: RESUME from persisted checkpoint (continuing epoch count)",
              flush=True)
    elif pretrained:
        ckpt_arg = "-c %s" % pretrained
        print("  MODE: finetune from pretrained yolox_tiny.pth", flush=True)
    else:
        ckpt_arg = ""
        print("  MODE: training FROM SCRATCH", flush=True)
    cmd = ("python %s -f %s -d 1 -b %d %s %s -expn %s"
           % (train_py, EXP_FILE, BATCH_SIZE, fp16, ckpt_arg, EXP_NAME))
    promoter = _Promoter(interval=120)
    promoter.start()
    try:
        rc = sh(cmd, check=False, env=env)
        print("  train.py exited rc=%d" % rc, flush=True)
    finally:
        promoter.stop()
        _promote_once()


# --------------------------------------------------------------------------- #
#  Step 5 -- save / eval / export (ONNX + best-effort tflite)
# --------------------------------------------------------------------------- #
def _find_ckpt():
    for name in ("best_ckpt.pth", "latest_ckpt.pth"):
        p = os.path.join(CKPT_OUT_DIR, name)
        if os.path.isfile(p):
            return p
    hits = glob.glob(os.path.join(OUT_ROOT, "**", "*ckpt.pth"), recursive=True)
    if hits:
        return max(hits, key=os.path.getmtime)
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
    try:
        eval_py = os.path.join(YOLOX_DIR, "tools", "eval.py")
        if os.path.isfile(eval_py):
            sh("python %s -f %s -c %s -b %d -d 1 %s --conf 0.001"
               % (eval_py, EXP_FILE, pth_out, BATCH_SIZE, fp16), check=False, env=env)
    except Exception as e:
        print("  !! eval skipped: %r" % e, flush=True)
    onnx_out = os.path.join(WORK, "hoopai-yolox.onnx")
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
    if onnx_ok:
        try:
            print("  installing onnx2tf toolchain (lazy)...", flush=True)
            sh("pip install -q onnx2tf onnxsim onnx_graphsurgeon sng4onnx "
               "'tensorflow-cpu' 'tf-keras' || true", check=False)
            tf_dir = os.path.join(TMP, "onnx2tf_out")
            shutil.rmtree(tf_dir, ignore_errors=True)
            rc = sh("onnx2tf -i %s -o %s -osd" % (onnx_out, tf_dir), check=False, env=env)
            cands = sorted(glob.glob(os.path.join(tf_dir, "*float32.tflite")) +
                           glob.glob(os.path.join(tf_dir, "*.tflite")))
            if cands:
                tfl_out = os.path.join(WORK, "hoopai-yolox.tflite")
                shutil.copyfile(cands[0], tfl_out)
                print("SAVED %s (from %s)" % (tfl_out, cands[0]), flush=True)
            else:
                print("  !! onnx2tf produced no .tflite (rc=%d)" % rc, flush=True)
        except Exception as e:
            print("  !! tflite conversion failed (kept .pth/.onnx): %r" % e, flush=True)
    else:
        print("  !! no valid ONNX -- skipping tflite", flush=True)
    try:
        tfl = os.path.join(WORK, "hoopai-yolox.tflite")
        meta = {"classes": TARGET_NAMES, "num_classes": len(TARGET_NAMES),
                "input_size": list(INPUT_SIZE), "arch": "yolox_tiny",
                "artifacts": {"pth": os.path.basename(pth_out),
                              "onnx": os.path.basename(onnx_out) if onnx_ok else None,
                              "tflite": ("hoopai-yolox.tflite" if os.path.isfile(tfl) else None)}}
        with open(os.path.join(WORK, "hoopai-yolox.meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        print("SAVED hoopai-yolox.meta.json", flush=True)
    except Exception as e:
        print("  !! meta write failed: %r" % e, flush=True)


# --------------------------------------------------------------------------- #
#  main
# --------------------------------------------------------------------------- #
def main():
    print("########## HOOPAI YOLOX-TINY -- LIGHTNING.AI TRAINING ##########", flush=True)
    preflight()
    setup_env()
    if not _dataset_ready():
        downloaded = download_datasets()
        if not downloaded:
            raise RuntimeError("no datasets downloaded -- cannot proceed")
        merge_datasets(downloaded)
        add_negatives()
    else:
        print("=== STEP 2: merged dataset already on persistent disk -- skipping "
              "download+merge ===", flush=True)
    write_exp()
    resumed = can_resume()
    pretrained = None if resumed else fetch_pretrained()
    train(resumed, pretrained)
    save_and_export()
    print("########## DONE -- artifacts in %s ##########" % WORK, flush=True)
    for f in sorted(os.listdir(WORK)):
        p = os.path.join(WORK, f)
        if os.path.isfile(p) and (f.startswith("hoopai") or f.startswith("yolox_tiny_hoop")):
            print("   %s  (%.1f MB)" % (f, os.path.getsize(p) / 1e6), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("!!!!!!!!!! FATAL !!!!!!!!!!", flush=True)
        traceback.print_exc()
        try:
            _promote_once()
        except Exception:
            traceback.print_exc()
        sys.exit(1)
