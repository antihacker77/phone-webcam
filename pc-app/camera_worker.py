"""Standalone virtual-camera writer, run as a subprocess by main.py.

Runs in its own process so it never shares aiortc's process-wide COM/media
state, which otherwise prevents the OBS virtual camera backend from starting.
Reads raw RGB24 frames from stdin and forwards them to pyvirtualcam.

Every frame goes to two virtual cameras:
- "OBS Virtual Camera" — the one browsers/Zoom/Teams/Discord see.
- "Phone Webcam" (Unity Capture) — for OBS Studio itself: the OBS filter
  deliberately outputs nothing when loaded inside obs64.exe (feedback-loop
  guard), so OBS can't use "OBS Virtual Camera" as a source.
Either one missing (driver not registered) is fine as long as the other works.
"""

import contextlib
import os
import sys
from datetime import datetime

import numpy as np
import pyvirtualcam

UNITY_CAPTURE_NAME = "Phone Webcam"


def log(msg):
    # Built with console=False: there is no usable stderr (writing to it
    # raises OSError and kills the process), so messages go to a file.
    try:
        d = os.path.join(os.environ.get("LOCALAPPDATA", "."), "Phone Webcam")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "camera_worker.log"), "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")
    except OSError:
        pass


def open_cameras(stack, width, height, fps):
    cams = []
    for backend, device in (("obs", None), ("unitycapture", UNITY_CAPTURE_NAME)):
        try:
            cams.append(stack.enter_context(pyvirtualcam.Camera(
                width=width, height=height, fps=fps,
                fmt=pyvirtualcam.PixelFormat.RGB, backend=backend, device=device,
            )))
        except Exception as e:
            log(f"{backend} unavailable: {e}")
    return cams


def main():
    width = int(sys.argv[1])
    height = int(sys.argv[2])
    fps = int(sys.argv[3])
    frame_size = width * height * 3
    stdin = sys.stdin.buffer

    with contextlib.ExitStack() as stack:
        cams = open_cameras(stack, width, height, fps)
        if not cams:
            log("no virtual camera backend could be started")
            return
        while True:
            data = stdin.read(frame_size)
            if len(data) < frame_size:
                break
            frame = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
            for cam in cams:
                cam.send(frame)


if __name__ == "__main__":
    main()
