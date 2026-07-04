# Resume-only: train EfficientDet-Lite on the ALREADY-merged /tmp/merged data
# (26 datasets, 82k imgs) — skips re-download. Run after fixing pkg_resources.
import os, shutil, traceback


def main():
    from mediapipe_model_maker import object_detector
    train_data = object_detector.Dataset.from_coco_folder(
        "/tmp/merged/train", cache_dir="/tmp/cache_train")
    val_data = object_detector.Dataset.from_coco_folder(
        "/tmp/merged/valid", cache_dir="/tmp/cache_val")
    print("train size", train_data.size, "val size", val_data.size, flush=True)

    # MediaPipe Model Maker object_detector does NOT support EfficientDet — the
    # only options are MobileNet SSD variants (all Apache-2.0, still clean license).
    # MULTI_AVG_I384 = most accurate of the four (384px helps small/far balls).
    spec = object_detector.SupportedModels.MOBILENET_MULTI_AVG_I384
    hparams = object_detector.HParams(epochs=15, batch_size=16, export_dir="/tmp/exported")
    options = object_detector.ObjectDetectorOptions(supported_model=spec, hparams=hparams)
    model = object_detector.ObjectDetector.create(
        train_data=train_data, validation_data=val_data, options=options)

    loss, coco_metrics = model.evaluate(val_data)
    print("EVAL loss", loss, "COCO metrics:", coco_metrics, flush=True)
    model.export_model("hoopai-effdet.tflite")
    shutil.copy("/tmp/exported/hoopai-effdet.tflite",
                os.path.expanduser("~/hoopai-effdet.tflite"))
    print("SAVED hoopai-effdet.tflite", flush=True)


try:
    main()
except Exception:
    traceback.print_exc()
    raise
