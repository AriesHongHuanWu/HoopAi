# HoopAI ULTRA-MAX detector training - Kaggle cloud GPU (not the user's laptop).
# Merges 26 CC BY 4.0 Roboflow basketball datasets (~70-80k images) into the
# unified 4-class scheme [ball, rim, ball_in_basket, person], trains YOLO11n
# (fast enough for iPhone XR/11) with heavy augmentation (hue-invariant for any
# ball color + mixup for small fast objects), capped at 7h to fit the 9h wall.
# Datasets go to /tmp so the kernel output stays small.
import subprocess, sys, traceback


def main():
    # Kaggle serves Tesla P100 (sm_60) but ships torch 2.10+cu128 which dropped
    # sm_60. Pin torch 2.5.1+cu121 (supports P100 AND T4). ultralytics --no-deps
    # so it doesn't drag a newer torch back in.
    subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                    "torch==2.5.1", "torchvision==0.20.1",
                    "--index-url", "https://download.pytorch.org/whl/cu121"])
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "roboflow", "albumentations"])
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-deps",
                    "ultralytics", "ultralytics-thop", "py-cpuinfo"])
    import torch
    print("TORCH", torch.__version__, "CUDA_OK", torch.cuda.is_available(),
          "DEV", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-",
          flush=True)
    import os, glob, shutil, pathlib, yaml
    from roboflow import Roboflow

    RF_KEY = os.environ.get("ROBOFLOW_API_KEY", "")  # export ROBOFLOW_API_KEY before running
    TARGET = ["ball", "rim", "ball_in_basket", "person"]
    # Comprehensive class-name -> target mapping across all 26 datasets. Anything
    # NOT listed here (referee, number, court, net, backboard, "0", scoreboard,
    # key-circle, etc.) is dropped as noise. Backboard/net deliberately excluded:
    # their boxes are NOT rim boxes and would hurt rim precision.
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
    # (workspace, project, version, location)
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
    WORK = "/kaggle/working"

    rf = Roboflow(api_key=RF_KEY)

    def dl(ws, proj, ver, loc):
        # One flaky/renamed dataset must not kill the whole run. Try yolov11
        # export then yolov8 (identical label format), skip on failure.
        for fmt in ("yolov11", "yolov8"):
            try:
                rf.workspace(ws).project(proj).version(ver).download(fmt, location=loc)
                n = len(glob.glob(os.path.join(loc, "**", "*.jpg"), recursive=True))
                if n > 0:
                    print(f"OK  {ws}/{proj} v{ver} imgs={n} fmt={fmt}", flush=True)
                    return loc
            except Exception as e:
                print(f"..  {ws}/{proj} fmt={fmt} failed: {str(e)[:90]}", flush=True)
        print(f"SKIP {ws}/{proj}", flush=True)
        return None

    locs = []
    for ws, proj, ver, loc in DATASETS:
        got = dl(ws, proj, ver, loc)
        if got:
            locs.append(got)
    print(f"DATASETS OK: {len(locs)}/{len(DATASETS)}", flush=True)

    def remap(loc):
        d = yaml.safe_load(open(os.path.join(loc, "data.yaml")))
        names = d["names"]
        if isinstance(names, dict):
            names = [names[i] for i in sorted(names)]
        m = {}
        for i, n in enumerate(names):
            t = NAME2TGT.get(str(n).strip().lower())
            if t is not None:
                m[i] = t
        print("MAP", loc, {names[i]: TARGET[t] for i, t in m.items()}, flush=True)
        for split in ["train", "valid", "test"]:
            ld = os.path.join(loc, split, "labels")
            if not os.path.isdir(ld):
                continue
            for fn in glob.glob(os.path.join(ld, "*.txt")):
                out = []
                for line in open(fn):
                    p = line.split()
                    if not p:
                        continue
                    s = int(float(p[0]))
                    if s in m:
                        out.append(" ".join([str(m[s])] + p[1:]))
                open(fn, "w").write("\n".join(out) + ("\n" if out else ""))

    for loc in locs:
        try:
            remap(loc)
        except Exception as e:
            print("REMAP FAIL", loc, str(e)[:90], flush=True)

    def imgs(loc, split):
        p = os.path.join(loc, split, "images")
        return p if os.path.isdir(p) else None

    train_dirs = [d for d in (imgs(l, "train") for l in locs) if d]
    val_dirs = [d for d in (imgs(l, "valid") for l in locs) if d]
    total = sum(len(glob.glob(os.path.join(d, "*.jpg"))) for d in train_dirs)
    data = {"names": TARGET, "nc": len(TARGET), "train": train_dirs, "val": val_dirs}
    yaml.safe_dump(data, open(f"{WORK}/data.yaml", "w"))
    print(f"TRAIN IMAGES ~{total} across {len(train_dirs)} dirs", flush=True)

    from ultralytics import YOLO
    m = YOLO("yolo11n.pt")
    # NANO keeps it fast on iPhone XR/11. `time=7.0` HARD-caps training at 7
    # hours so the 9h Kaggle wall is never hit regardless of the ~70-80k image
    # count (best.pt is saved continuously). epochs=40 is just the ceiling.
    # Augmentation: hsv_h=0.3 (any ball color) + mixup (blends images, strong
    # for small/fast objects) + copy_paste (harmless no-op without masks).
    m.train(data=f"{WORK}/data.yaml", epochs=40, time=7.0, imgsz=640, batch=-1,
            patience=12, cos_lr=True, hsv_h=0.3, mixup=0.15, copy_paste=0.1,
            project=f"{WORK}/runs", name="hoopai", exist_ok=True)

    best = f"{WORK}/runs/hoopai/weights/best.pt"
    # Copy best.pt to the output root FIRST, before the risky tflite export.
    shutil.copy(best, f"{WORK}/best.pt")
    open(f"{WORK}/classes.txt", "w").write(",".join(TARGET))
    try:
        mm = YOLO(best)
        metrics = mm.val(data=f"{WORK}/data.yaml")
        print("mAP50=", float(metrics.box.map50), "mAP50-95=", float(metrics.box.map), flush=True)
    except Exception as e:
        print("VAL skipped:", str(e)[:90], flush=True)
    try:
        out = mm.export(format="tflite", imgsz=640, nms=False)
        cands = glob.glob(f"{WORK}/**/*.tflite", recursive=True)
        cands.sort(key=lambda c: (0 if "float32" in c else 1))
        if cands:
            shutil.copy(cands[0], f"{WORK}/hoopai-det.tflite")
            print("SAVED tflite", os.path.getsize(f"{WORK}/hoopai-det.tflite") // 1024, "KB", flush=True)
    except Exception as e:
        # Expected: Kaggle's pinned torch breaks litert export. best.pt is saved;
        # convert to tflite on CPU via GitHub Actions export-trained.yml.
        print("EXPORT_FAILED (expected; convert best.pt via CI):", str(e)[:120], flush=True)
    print("HOOPAI_DONE", flush=True)


try:
    main()
except Exception:
    traceback.print_exc()
    raise
