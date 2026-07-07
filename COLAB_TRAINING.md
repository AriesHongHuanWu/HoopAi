# Train the Hoopilot detector on free Google Colab

This retrains **YOLOX-Tiny** (4 classes: ball, rim, ball_in_basket, person) on the
merged 35-dataset basketball corpus, entirely on Colab's **free T4 GPU** — no
Kaggle quota needed. It writes everything durable to your **Google Drive** and
**resumes across sessions**, so a Colab disconnect never loses progress.

Output lands in `Drive / MyDrive / hoopai_train /`:
- `yolox_tiny_hoop.pth` — the trained weights (always saved)
- `hoopai-yolox.tflite` — the mobile model to drop into the app (best-effort)
- `hoopai-yolox.onnx`, `hoopai-yolox.meta.json`

---

## Before you start (one-time, 2 min)

1. **Rotate the old Roboflow key.** The previous key was hardcoded and is exposed
   in this repo's git history. In the Roboflow dashboard → Settings → revoke it and
   copy a **new** Private API key. You'll paste the new one below (it's never
   written to disk or committed).
2. Open <https://colab.research.google.com> → **New notebook**.
3. **Runtime → Change runtime type → Hardware accelerator = T4 GPU → Save.**

---

## The 3 cells

Paste each into its own cell and run in order.

**Cell 1 — mount Drive** (a popup asks you to authorize; it's your own Drive):
```python
from google.colab import drive
drive.mount('/content/drive')
```

**Cell 2 — enter your (new) Roboflow key** (hidden input, not saved):
```python
import os, getpass
os.environ['ROBOFLOW_KEY'] = getpass.getpass('Roboflow API key: ')
```

**Cell 3 — fetch the training script from the repo and run it:**
```python
!wget -q -O hoopai_train_colab.py https://raw.githubusercontent.com/AriesHongHuanWu/HoopAi/main/hoopai_train_colab.py
!python hoopai_train_colab.py
```

That's it. Cell 3 downloads the 35 datasets (~30–60 min the first time), merges
them, and starts training. Leave the tab open and the browser awake.

---

## If Colab disconnects (it will, on free tier)

The full run is ~12h; free Colab won't hold that in one sitting. **That's fine** —
just re-run **Cell 1** and **Cell 3** when you reconnect. The script:
- **skips the download+merge** (restores the dataset tar cached on Drive), and
- **resumes training** from the last checkpoint mirrored to Drive (continues the
  epoch count — it does *not* start over).

So over 2–4 reconnects it accumulates the full 12 epochs. The best checkpoint so
far is always saved as `yolox_tiny_hoop.pth`, so you're never worse off.

**Tip:** to stop Colab idle-disconnecting while you're away, keep the tab focused,
or run training when you can check back every ~90 min.

---

## Optional knobs (set in Cell 2 before Cell 3)

```python
# Lighter, single-session run (less accurate, but finishes faster):
os.environ['HOOPAI_MAX_EPOCH'] = '6'      # default 12
os.environ['HOOPAI_BATCH']     = '16'     # lower to 8 if you hit out-of-memory

# Fewer false positives on court clutter (optional): point this at a folder of
# non-basketball background .jpgs on your Drive to use as hard negatives.
os.environ['HOOPAI_NEG_DIR'] = '/content/drive/MyDrive/backgrounds'
```

---

## When it finishes

`hoopai-yolox.tflite` is in `Drive/MyDrive/hoopai_train/`. Send me that file (or
tell me it's there) and I'll validate it offline and wire it into the app with a
matching parser — same integration path as the current YOLOX model.

The `.meta.json` records the classes / input size (416) / arch so the parser
config is unambiguous.
