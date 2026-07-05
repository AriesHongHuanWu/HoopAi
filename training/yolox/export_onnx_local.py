#!/usr/bin/env python3
"""Export the recovered YOLOX-Nano hoop checkpoint to ONNX (decode folded in).

Standalone so we control weights_only (torch 2.12 defaults to True, which trips
on the full trainer checkpoint) and decode_in_inference (True => the graph emits
final pixel-space boxes [1, N, 4+1+nc], simplest for the on-device parser).
"""
import os
import sys

import torch
import torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
YOLOX_DIR = os.path.join(HERE, "YOLOX")
sys.path.insert(0, YOLOX_DIR)

from yolox.exp import Exp as BaseExp  # noqa: E402
from yolox.models import YOLOX, YOLOPAFPN, YOLOXHead  # noqa: E402

CKPT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "yolox_nano_hoop.pth")
ONNX_OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "hoopai-yolox.onnx")
INPUT = 416
NUM_CLASSES = 4


class HoopExp(BaseExp):
    def __init__(self):
        super().__init__()
        self.depth = 0.33
        self.width = 0.25
        self.num_classes = NUM_CLASSES
        self.input_size = (INPUT, INPUT)
        self.test_size = (INPUT, INPUT)

    def get_model(self):
        def init_yolo(M):
            for m in M.modules():
                if isinstance(m, nn.BatchNorm2d):
                    m.eps = 1e-3
                    m.momentum = 0.03
        in_channels = [256, 512, 1024]
        backbone = YOLOPAFPN(self.depth, self.width, in_channels=in_channels,
                             act=self.act, depthwise=True)
        head = YOLOXHead(self.num_classes, self.width, in_channels=in_channels,
                         act=self.act, depthwise=True)
        model = YOLOX(backbone, head)
        model.apply(init_yolo)
        model.head.initialize_biases(1e-2)
        return model


class NormWrapper(nn.Module):
    """Accept 0..1 input (what the app's frame resizer produces) and rescale to
    the 0..255 range YOLOX was trained on, so no per-frame scaling is needed in
    the app worklet. One fused Mul folded into the graph."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x):
        return self.model(x * 255.0)


def main():
    exp = HoopExp()
    model = exp.get_model()
    ckpt = torch.load(CKPT, map_location="cpu", weights_only=False)
    state = ckpt["model"] if isinstance(ckpt, dict) and "model" in ckpt else ckpt
    model.load_state_dict(state, strict=True)
    model.eval()
    # Fold decode into the graph -> output is final [1, N, 4+1+nc] in px space.
    model.head.decode_in_inference = True
    wrapped = NormWrapper(model).eval()

    dummy = torch.zeros(1, 3, INPUT, INPUT)
    with torch.no_grad():
        out = wrapped(dummy)
    print("EAGER OUTPUT SHAPE:", tuple(out.shape), flush=True)

    torch.onnx.export(
        wrapped, dummy, ONNX_OUT,
        input_names=["images"], output_names=["output"],
        opset_version=12, do_constant_folding=True,
        dynamo=False,  # legacy TorchScript exporter -> clean static graph for onnx2tf
    )
    sz = os.path.getsize(ONNX_OUT)
    print("SAVED %s (%d bytes)" % (ONNX_OUT, sz), flush=True)


if __name__ == "__main__":
    main()
