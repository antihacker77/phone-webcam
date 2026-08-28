"""Standalone virtual-camera writer, run as a subprocess by main.py.

Runs in its own process so it never shares aiortc's process-wide COM/media
state, which otherwise prevents the OBS virtual camera backend from starting.
Reads raw RGB24 frames from stdin and forwards them to pyvirtualcam.
"""

import sys

import numpy as np
import pyvirtualcam


def main():
    width = int(sys.argv[1])
    height = int(sys.argv[2])
    fps = int(sys.argv[3])
    frame_size = width * height * 3
    stdin = sys.stdin.buffer

    with pyvirtualcam.Camera(
        width=width, height=height, fps=fps,
        fmt=pyvirtualcam.PixelFormat.RGB, backend='obs',
    ) as cam:
        while True:
            data = stdin.read(frame_size)
            if len(data) < frame_size:
                break
            frame = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
            cam.send(frame)


if __name__ == "__main__":
    main()
