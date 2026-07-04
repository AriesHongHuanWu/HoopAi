# Hoopilot CLEAN-LICENSE detector — EfficientDet-Lite via MediaPipe Model Maker.
# License: Apache-2.0 (NO AGPL). Run in a Lightning.ai GPU Studio (T4).
#
# Uses the SAME 26 Roboflow datasets as the YOLO Ultra-Max (~70-80k images),
# just downloaded in COCO format (Model Maker needs COCO, not YOLO txt). Merged
# into the unified 4-class scheme [ball, rim, ball_in_basket, person].
#
# HOW TO RUN (in the Studio's Terminal):
#   pip install --upgrade pip
#   pip install "mediapipe-model-maker" roboflow
#   python train_effdet.py
#
# EfficientDet-Lite's tflite output format differs from YOLO, so the app needs a
# matching parser after this — that's a separate step. On ~70-80k images this
# trains for SEVERAL HOURS on a T4 (accuracy costs time — that's expected).
import os, glob, json, shutil, traceback


def main():
    from roboflow import Roboflow

    RF_KEY = os.environ.get("ROBOFLOW_API_KEY", "")  # export ROBOFLOW_API_KEY before running
    TARGET = ["ball", "rim", "ball_in_basket", "person"]  # COCO category ids 1..4
    # Same comprehensive mapping as Ultra-Max. Anything not listed (referee, net,
    # backboard, court, scoreboard, "0", ...) is dropped as noise. Backboard/net
    # deliberately excluded — their boxes are NOT rim boxes and hurt rim precision.
    NAME2TGT = {
        "basketball": 0, "ball": 0, "iball": 0,
        "hoop": 1, "rim": 1, "basket": 1,
        "ball-in-basket": 2, "ball_in_basket": 2, "ball in basket": 2,
        "made": 2, "made-basket": 2, "made_basket": 2, "hit": 2, "goal": 2, "inbasket": 2,
        "player": 3, "person": 3, "people": 3, "players": 3,
        "guest_player": 3, "home_player": 3, "team1": 3, "team2": 3,
        "non-shooting-player": 3, "shooting-player": 3,
        "ball-handler": 3, "ball_handler": 3,
    }
    # (workspace, project, version, location) — identical set to Ultra-Max.
    DATASETS = [
        ("basketball-detection-b977c", "basketball-detection-sskux", 7, "/tmp/ds0"),
        ("roboflow-jvuqo", "basketball-player-detection-3-ycjdo", 18, "/tmp/ds1"),
        ("sc-xqmxu", "basketball-and-net-detection", 7, "/tmp/ds2"),
        ("computer-vision-project-v2zmg", "basketball-video-analysis", 8, "/tmp/ds3"),
        ("finalprojectteam16", "automatic-basketball-scoring-system", 7, "/tmp/ds4"),
        ("yolo-bvles", "basketball-detection-1mtj3-4ad5o-c7dos-zmo1g-p9npw-bo5ez", 2, "/tmp/ds5"),
        ("computer-vision-d5fjh", "basketball-detection-dn6fg", 4, "/tmp/ds6"),
        ("basketball-hoop-tsdku", "basketball-hoop-images", 4, "/tmp/ds7"),
        ("ball101", "rim-detection", 1, "/tmp/ds8"),
        ("roboflow-jvuqo", "basketball-player-detection-2", 20, "/tmp/ds9"),
        ("rohit-krishnan-xr6xf", "basketball_and_hoops", 3, "/tmp/ds10"),
        ("basketballcv", "basketball-cv", 9, "/tmp/ds11"),
        ("ownprojects", "basketball-w2xcw", 2, "/tmp/ds12"),
        ("zaki-b86c6", "basketball-jagmz", 74, "/tmp/ds13"),
        ("mytem", "people_basketball_hoops", 6, "/tmp/ds14"),
        ("loganwork", "basketball-rdtyv", 6, "/tmp/ds15"),
        ("lokesh-podipireddy-eocdt", "basketball-player-detection-6y9yj", 14, "/tmp/ds16"),
        ("piebasket", "only_ball_handler", 5, "/tmp/ds17"),
        ("zeeshan-public-projects", "basket-ball-tracking-xkyu5", 5, "/tmp/ds18"),
        ("basketball-z8lzd", "basketball-6phla", 21, "/tmp/ds19"),
        ("basketballv1", "basketball-ikdxt", 22, "/tmp/ds20"),
        ("roboflow-universe-projects", "basketball-players-fy4c2", 25, "/tmp/ds21"),
        ("dataset-baketball", "baskball", 5, "/tmp/ds22"),
        ("public-0stx0", "made-baskets", 3, "/tmp/ds23"),
        ("tickstrike", "basketball-players-and-ball1", 4, "/tmp/ds24"),
        ("ntu-nw2om", "tracking-players-and-balls", 3, "/tmp/ds25"),
    ]

    rf = Roboflow(api_key=RF_KEY)
    locs = []
    for ws, proj, ver, loc in DATASETS:
        try:
            rf.workspace(ws).project(proj).version(ver).download("coco", location=loc)
            n = len(glob.glob(os.path.join(loc, "**", "*.jpg"), recursive=True))
            print(f"OK  {ws}/{proj} v{ver} imgs={n}", flush=True)
            if n > 0:
                locs.append(loc)
        except Exception as e:
            print(f"SKIP {ws}/{proj}: {str(e)[:90]}", flush=True)
    print(f"DATASETS OK: {len(locs)}/{len(DATASETS)}", flush=True)

    # Merge every dataset's COCO split into ONE 4-class COCO folder per split.
    # Roboflow COCO export: <loc>/<split>/_annotations.coco.json + images in <split>/.
    out_root = "/tmp/merged"
    counts = {}
    for split in ("train", "valid"):
        img_out = os.path.join(out_root, split)
        os.makedirs(img_out, exist_ok=True)
        images, annotations = [], []
        img_id, ann_id = 1, 1
        for loc in locs:
            sdir = os.path.join(loc, split)
            ann_path = os.path.join(sdir, "_annotations.coco.json")
            if not os.path.isfile(ann_path):
                continue
            try:
                coco = json.load(open(ann_path, encoding="utf-8"))
            except Exception as e:
                print("BAD json", ann_path, str(e)[:60], flush=True)
                continue
            cat_map = {c["id"]: NAME2TGT.get(str(c["name"]).strip().lower())
                       for c in coco.get("categories", [])}
            old2new_img = {}
            for im in coco.get("images", []):
                src = os.path.join(sdir, im["file_name"])
                if not os.path.isfile(src):
                    continue
                newname = f"d{locs.index(loc)}_{img_id}_{os.path.basename(im['file_name'])}"
                shutil.copy(src, os.path.join(img_out, newname))
                old2new_img[im["id"]] = img_id
                images.append({"id": img_id, "file_name": newname,
                               "width": im.get("width", 0), "height": im.get("height", 0)})
                img_id += 1
            for a in coco.get("annotations", []):
                tgt = cat_map.get(a["category_id"])
                if tgt is None or a["image_id"] not in old2new_img:
                    continue
                b = a["bbox"]
                annotations.append({
                    "id": ann_id, "image_id": old2new_img[a["image_id"]],
                    "category_id": tgt + 1,  # COCO categories are 1-indexed
                    "bbox": b, "area": a.get("area", b[2] * b[3]),
                    "iscrowd": a.get("iscrowd", 0),
                })
                ann_id += 1
        counts[split] = (len(images), len(annotations))
        categories = [{"id": i + 1, "name": n} for i, n in enumerate(TARGET)]
        merged = {"info": {}, "licenses": [], "images": images,
                  "annotations": annotations, "categories": categories}
        json.dump(merged, open(os.path.join(img_out, "_annotations.coco.json"), "w"))
        print(f"MERGED {split}: {len(images)} imgs, {len(annotations)} boxes", flush=True)

    # Safety: if very few valid images, carve ~5% off train into valid so
    # Model Maker has something to evaluate on.
    if counts["valid"][0] < 50 and counts["train"][0] > 0:
        _carve_val(out_root, TARGET, frac=0.05)

    # Train EfficientDet-Lite (Apache-2.0). Lite0 = fastest for mobile; bump to
    # LITE2 for more accuracy at a higher on-device cost.
    from mediapipe_model_maker import object_detector
    train_data = object_detector.Dataset.from_coco_folder(
        os.path.join(out_root, "train"), cache_dir="/tmp/cache_train")
    val_data = object_detector.Dataset.from_coco_folder(
        os.path.join(out_root, "valid"), cache_dir="/tmp/cache_val")
    print("train size", train_data.size, "val size", val_data.size, flush=True)

    spec = object_detector.SupportedModels.EFFICIENTDET_LITE0
    hparams = object_detector.HParams(epochs=30, batch_size=32, export_dir="/tmp/exported")
    options = object_detector.ObjectDetectorOptions(supported_model=spec, hparams=hparams)
    model = object_detector.ObjectDetector.create(
        train_data=train_data, validation_data=val_data, options=options)

    loss, coco_metrics = model.evaluate(val_data)
    print("EVAL loss", loss, "COCO metrics:", coco_metrics, flush=True)  # <-- mAP here
    model.export_model("hoopai-effdet.tflite")
    shutil.copy("/tmp/exported/hoopai-effdet.tflite", "hoopai-effdet.tflite")
    print("SAVED hoopai-effdet.tflite — download this from the Studio.", flush=True)


def _carve_val(out_root, TARGET, frac):
    import random
    tdir = os.path.join(out_root, "train")
    vdir = os.path.join(out_root, "valid")
    tj = json.load(open(os.path.join(tdir, "_annotations.coco.json")))
    imgs = tj["images"]
    k = max(20, int(len(imgs) * frac))
    move = set(im["id"] for im in imgs[:k])  # deterministic slice (no RNG needed)
    v_imgs = [im for im in imgs if im["id"] in move]
    t_imgs = [im for im in imgs if im["id"] not in move]
    v_ann = [a for a in tj["annotations"] if a["image_id"] in move]
    t_ann = [a for a in tj["annotations"] if a["image_id"] not in move]
    for im in v_imgs:
        shutil.move(os.path.join(tdir, im["file_name"]), os.path.join(vdir, im["file_name"]))
    cats = [{"id": i + 1, "name": n} for i, n in enumerate(TARGET)]
    json.dump({"info": {}, "licenses": [], "images": t_imgs, "annotations": t_ann, "categories": cats},
              open(os.path.join(tdir, "_annotations.coco.json"), "w"))
    json.dump({"info": {}, "licenses": [], "images": v_imgs, "annotations": v_ann, "categories": cats},
              open(os.path.join(vdir, "_annotations.coco.json"), "w"))
    print(f"CARVED {len(v_imgs)} imgs into valid", flush=True)


try:
    main()
except Exception:
    traceback.print_exc()
    raise
