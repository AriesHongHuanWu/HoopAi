# HoopAI detector training - runs on Kaggle cloud GPU (not the user's laptop).
# Merges two CC BY 4.0 Roboflow basketball datasets into a unified 4-class
# scheme [ball, rim, ball_in_basket, person], trains YOLO11n, exports TFLite.
# Datasets download to /tmp (NOT /kaggle/working) so the kernel output stays
# small and the log is easy to read.
import subprocess, sys, traceback


def main():
    # Kaggle serves Tesla P100 (CUDA capability sm_60) but ships torch
    # 2.10+cu128 which dropped sm_60, giving "CUDA error: no kernel image
    # available". Install torch 2.5.1+cu121, which supports sm_50..sm_90 (P100
    # AND T4), so training runs on whatever GPU Kaggle assigns. Then ultralytics
    # with --no-deps so it doesn't pull a newer torch back in.
    subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                    "torch==2.5.1", "torchvision==0.20.1",
                    "--index-url", "https://download.pytorch.org/whl/cu121"])
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "roboflow"])
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-deps",
                    "ultralytics", "ultralytics-thop", "py-cpuinfo"])
    import torch
    print("TORCH", torch.__version__, "CUDA_OK", torch.cuda.is_available(),
          "DEV", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-",
          "CAP", torch.cuda.get_device_capability(0) if torch.cuda.is_available() else "-",
          flush=True)
    import os, glob, shutil, pathlib, yaml
    from roboflow import Roboflow

    RF_KEY = "4wYE6hxRLYRBQWE7DEkz"
    TARGET = ["ball", "rim", "ball_in_basket", "person"]
    NAME2TGT = {
        "basketball": 0, "ball": 0,
        "hoop": 1, "rim": 1, "basket": 1,
        "ball-in-basket": 2, "ball_in_basket": 2, "ball in basket": 2, "made": 2,
        "player": 3, "person": 3,
    }
    DATASETS = [
        ("basketball-detection-b977c", "basketball-detection-sskux", 7, "/tmp/ds0"),
        ("roboflow-jvuqo", "basketball-player-detection-3-ycjdo", 18, "/tmp/ds1"),
    ]
    WORK = "/kaggle/working"

    rf = Roboflow(api_key=RF_KEY)
    locs = []
    for ws, proj, ver, loc in DATASETS:
        rf.workspace(ws).project(proj).version(ver).download("yolov11", location=loc)
        n = len(glob.glob(os.path.join(loc, "**", "*.jpg"), recursive=True))
        print(f"DOWNLOADED {loc}  images={n}", flush=True)
        locs.append(loc)

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
        remap(loc)

    def imgs(loc, split):
        p = os.path.join(loc, split, "images")
        return p if os.path.isdir(p) else None

    train_dirs = [d for d in (imgs(l, "train") for l in locs) if d]
    val_dirs = [d for d in (imgs(l, "valid") for l in locs) if d]
    data = {"names": TARGET, "nc": len(TARGET), "train": train_dirs, "val": val_dirs}
    yaml.safe_dump(data, open(f"{WORK}/data.yaml", "w"))
    print("DATA.YAML", data, flush=True)

    from ultralytics import YOLO
    m = YOLO("yolo11n.pt")
    m.train(data=f"{WORK}/data.yaml", epochs=80, imgsz=640, batch=16,
            patience=20, project=f"{WORK}/runs", name="hoopai", exist_ok=True)

    best = f"{WORK}/runs/hoopai/weights/best.pt"
    mm = YOLO(best)
    metrics = mm.val(data=f"{WORK}/data.yaml")
    print("mAP50=", float(metrics.box.map50), "mAP50-95=", float(metrics.box.map), flush=True)

    out = mm.export(format="tflite", imgsz=640, nms=False)
    print("EXPORT RETURNED", out, flush=True)
    cands = []
    p = pathlib.Path(str(out))
    if p.is_file() and p.suffix == ".tflite":
        cands = [str(p)]
    elif p.is_dir():
        cands = [str(x) for x in p.rglob("*.tflite")]
    if not cands:
        cands = glob.glob(f"{WORK}/**/*.tflite", recursive=True) + glob.glob("**/*.tflite", recursive=True)
    cands.sort(key=lambda c: (0 if "float32" in c else 1 if "float16" in c else 2))
    assert cands, "no tflite produced"
    shutil.copy(cands[0], f"{WORK}/hoopai-det.tflite")
    shutil.copy(best, f"{WORK}/best.pt")
    open(f"{WORK}/classes.txt", "w").write(",".join(TARGET))
    print("SAVED", os.path.getsize(f"{WORK}/hoopai-det.tflite") // 1024, "KB", flush=True)
    print("HOOPAI_DONE", flush=True)


try:
    main()
except Exception:
    traceback.print_exc()
    raise
