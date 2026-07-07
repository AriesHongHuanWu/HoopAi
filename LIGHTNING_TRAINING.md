# Train the Hoopilot detector on Lightning.ai (free T4)

Runs your ready **YOLOX-Tiny** training (the 35-dataset merge) on a Lightning.ai
GPU Studio — free, long-running, and **resumes across the ~4h Studio restarts**
because Lightning's disk persists. This is the same Studio you trained EfficientDet
in.

Output lands in `/teamspace/studios/this_studio/yolox_work/`:
- `yolox_tiny_hoop.pth` — trained weights (always)
- `hoopai-yolox.tflite` — the mobile model to send me (best-effort)
- `hoopai-yolox.onnx`, `hoopai-yolox.meta.json`

---

## Before you start
1. **Rotate the old Roboflow key** (it's exposed in git history) → copy a new Private API key.
2. In Lightning.ai, open your Studio → set the machine to **GPU (T4)**.

---

## Run it (Studio Terminal)

```bash
# 1) get the script (the repo is your Studio working dir; or paste the file in)
cd ~/hoop-ai && git pull        # or: git clone <your repo> && cd hoop-ai

# 2) one-time venv (conda is blocked on Lightning; uv is the way)
uv venv ~/yolox-env --python 3.11 && source ~/yolox-env/bin/activate

# 3) your NEW rotated key (not saved anywhere)
export ROBOFLOW_KEY="rf_xxxxxxxxxxxxxxxx"

# 4) launch DETACHED — survives closing the browser tab
nohup python -u hoopai_train_lightning.py > ~/yolox_train.log 2>&1 &

# 5) watch it
tail -f ~/yolox_train.log
```

Healthy log milestones: `env OK` → `MERGED train=… val=…` → per-epoch
`best_ckpt.pth` + a COCO `AP` line → finally `DONE -- artifacts in …`.

---

## When the Studio restarts (~every 4h) — just resume
Re-open the Terminal and run the **same** launch again:
```bash
source ~/yolox-env/bin/activate
export ROBOFLOW_KEY="rf_xxxxxxxxxxxxxxxx"
nohup python -u hoopai_train_lightning.py > ~/yolox_train.log 2>&1 &
tail -f ~/yolox_train.log
```
It **skips the download+merge** (dataset persisted) and **resumes training** from
the newest checkpoint (`MODE: RESUME …` in the log — it continues the epoch
count, does not restart). A full ~12h run finishes over ~2–3 of these windows,
well inside the free ~80 GPU-h/month.

---

## Knobs (set before step 4, optional)
```bash
export HOOPAI_MAX_EPOCH=12     # default 12; lower = faster, slightly less accurate
export HOOPAI_BATCH=16         # lower to 8 if you hit CUDA out-of-memory on the T4
export HOOPAI_NEG_DIR=/path/to/background_jpgs   # optional hard-negatives folder
```

---

## When done
Download `hoopai-yolox.tflite` (+ `.meta.json`) from the Studio file browser and
send it to me — I'll validate it offline and wire it into the app via the
existing YOLOX parser (output `[1,3549,9]` = cx,cy,w,h,obj,cls0..3, decode baked
into the graph). Same integration path as the current model.

**Don't want to babysit the 4h restarts?** RunPod on-demand (RTX A6000 ~$0.21/h or
4090 ~$0.34/h, ~$10 free credit) runs the whole thing in **one unbroken session**
for ~$3 total, on a GPU much faster than the T4 — the same script runs there via
SSH. Say the word and I'll write the RunPod runbook too.
