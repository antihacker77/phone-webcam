"""Phone Webcam — PC side.

Runs its own local WebSocket server (no external signaling needed), waits
for the phone to join on the same network, answers its WebRTC offer, and
pipes the received video into a virtual camera so it shows up as a normal
webcam in Zoom/Teams/OBS/Discord/etc. Also previews the stream, lets you
mirror/rotate/resize it, and can record it to an MP4 file.
"""

import asyncio
import json
import os
import queue
import random
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime

import customtkinter as ctk
import cv2
import numpy as np
import qrcode
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from PIL import Image

APP_VERSION = "1.0.0"
CAM_FPS = 30
PORT = 8765
STATS_INTERVAL = 1.0
PREVIEW_EVERY_N_FRAMES = 3  # ~10fps preview from a 30fps stream — plenty for a monitor view

OUTPUT_PRESETS = {
    "Source (no resize)": None,
    "720p (HD)": (1280, 720),
    "1080p (Full HD)": (1920, 1080),
    "4K (Ultra HD)": (3840, 2160),
}

COLORS = {
    "bg_deep": "#05070d",
    "bg_panel": "#0b1020",
    "bg_panel_alt": "#0e1526",
    "line": "#182036",
    "text": "#eef1f8",
    "text_muted": "#9aa3b8",
    "text_faint": "#5c6478",
    "blue": "#2f6fed",
    "cyan": "#22d3ee",
    "green": "#34d399",
    "amber": "#f5a524",
    "danger": "#ef4444",
    "danger_dark": "#b91c1c",
}


def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def make_code() -> str:
    return f"{random.randint(0, 999999):06d}"


def connection_payload(address: str, code: str) -> str:
    return json.dumps({"s": address, "c": code})


def human_resolution(w: int, h: int) -> str:
    return {(1280, 720): "720p", (1920, 1080): "1080p", (3840, 2160): "4K"}.get((w, h), f"{w}×{h}")


def quality_label(loss_pct) -> str:
    if loss_pct is None:
        return "—"
    if loss_pct < 1:
        return "Excellent"
    if loss_pct < 5:
        return "Good"
    return "Fair"


def output_dir(kind: str) -> str:
    d = os.path.join(os.path.expanduser("~"), kind, "Phone Webcam")
    os.makedirs(d, exist_ok=True)
    return d


class FrameTransformer:
    """Mirror / rotate / resize applied uniformly before a frame reaches the
    virtual camera, the recorder and the live preview, so all three always
    show exactly the same picture."""

    def __init__(self):
        self.mirror = False
        self.rotation = 0  # degrees, one of 0/90/180/270
        self.output_size = None  # (w, h) or None to keep the source size

    _ROTATE_FLAG = {
        90: cv2.ROTATE_90_CLOCKWISE,
        180: cv2.ROTATE_180,
        270: cv2.ROTATE_90_COUNTERCLOCKWISE,
    }

    def apply(self, frame: np.ndarray) -> np.ndarray:
        # cv2.flip/cv2.rotate, not numpy slicing + np.rot90 — those build a
        # reversed/transposed *view*, and the ascontiguousarray() copy that
        # then has to follow it walks memory in a scattered, cache-hostile
        # pattern. Measured on this machine: ~17-21ms/frame for a 1080p
        # mirror or rotate that way, near the entire 33ms budget for 30fps,
        # vs. ~3-8ms for the equivalent cv2 call (which returns an already-
        # contiguous array, so there's nothing left to copy afterward).
        if self.mirror:
            frame = cv2.flip(frame, 1)
        if self.rotation:
            frame = cv2.rotate(frame, self._ROTATE_FLAG[self.rotation])
        if self.output_size and (frame.shape[1], frame.shape[0]) != self.output_size:
            frame = cv2.resize(frame, self.output_size, interpolation=cv2.INTER_AREA)
        return frame


class VideoRecorder:
    """Writes the (already-transformed) frame stream to an MP4 file.

    The actual disk write happens on a dedicated background thread.
    Measured cost of cv2.cvtColor + VideoWriter.write() for a 1080p frame on
    this machine: ~23ms average, spiking past the entire 33ms/frame budget
    for 30fps. That cost must never land on the asyncio thread that's also
    feeding the virtual camera and the preview — otherwise turning on
    recording is exactly what makes the live feed stutter. write() just
    hands the frame to a small bounded queue and returns immediately; if the
    disk can't keep up, the newest frame is dropped rather than blocking the
    caller.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._writer = None
        self._size = None
        self._start = None
        self._queue = None
        self._thread = None

    @property
    def active(self) -> bool:
        return self._writer is not None

    def start(self, w: int, h: int, fps: int) -> str:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        path = os.path.join(output_dir("Videos"), f"phone-webcam-{ts}.mp4")
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(path, fourcc, fps, (w, h))
        if not writer.isOpened():
            raise RuntimeError("Could not open the video file for writing")
        frame_queue = queue.Queue(maxsize=8)
        thread = threading.Thread(target=self._writer_loop, args=(writer, frame_queue), daemon=True)
        with self._lock:
            self._writer = writer
            self._size = (w, h)
            self._start = time.monotonic()
            self._queue = frame_queue
            self._thread = thread
        thread.start()
        return path

    @staticmethod
    def _writer_loop(writer, frame_queue):
        while True:
            frame = frame_queue.get()
            if frame is None:
                break
            writer.write(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        writer.release()

    def write(self, rgb_frame: np.ndarray):
        with self._lock:
            if self._writer is None:
                return
            h, w = rgb_frame.shape[:2]
            if (w, h) != self._size:
                return  # frame size changed mid-recording — drop until stopped/restarted
            frame_queue = self._queue
        try:
            frame_queue.put_nowait(rgb_frame)
        except queue.Full:
            pass  # the writer thread is behind — drop rather than stall the live feed

    def stop(self):
        with self._lock:
            frame_queue, thread = self._queue, self._thread
            self._writer = None
            self._size = None
            self._start = None
            self._queue = None
            self._thread = None
        if frame_queue is not None:
            frame_queue.put(None)
        if thread is not None:
            thread.join(timeout=5.0)

    def elapsed_seconds(self) -> int:
        return 0 if self._start is None else int(time.monotonic() - self._start)


def camera_worker_command(w: int, h: int, fps: int) -> list:
    if getattr(sys, "frozen", False):
        # PyInstaller build: camera_worker.py is bundled as its own sibling
        # .exe (see build.spec) since a frozen main.py has no Python
        # interpreter to run a .py script with.
        worker = os.path.join(os.path.dirname(sys.executable), "camera_worker.exe")
        return [worker, str(w), str(h), str(fps)]
    worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "camera_worker.py")
    return [sys.executable, worker, str(w), str(h), str(fps)]


class CameraSink:
    """Feeds frames to the virtual camera through a subprocess.

    The OBS virtual camera backend fails to start in this process — aiortc's
    media pipeline leaves process-wide COM state that's incompatible with it.
    A fresh subprocess never inherits that state, so it works reliably there.
    """

    def __init__(self):
        self._proc: subprocess.Popen | None = None
        self._size = None

    def send(self, rgb_frame):
        h, w, _ = rgb_frame.shape
        if self._proc is None or self._size != (w, h):
            self.close()
            self._proc = subprocess.Popen(
                camera_worker_command(w, h, CAM_FPS),
                stdin=subprocess.PIPE,
            )
            self._size = (w, h)
        try:
            data = rgb_frame.tobytes()
            view = memoryview(data)
            while view:
                n = self._proc.stdin.write(view[:65536])
                view = view[n:]
        except (BrokenPipeError, OSError):
            self._proc = None

    def close(self):
        if self._proc is not None:
            try:
                self._proc.stdin.close()
            except OSError:
                pass
            self._proc.terminate()
            self._proc = None


class App:
    """Thread-safe bridge between the asyncio worker and the Tkinter UI."""

    def __init__(self):
        self.events: "queue.Queue[tuple]" = queue.Queue()
        self.transformer = FrameTransformer()
        self.recorder = VideoRecorder()
        self.last_frame_size: tuple | None = None

        # Set by run_server once the event loop and signaling object exist,
        # so button handlers on the Tk thread can schedule coroutines on it.
        self.loop: asyncio.AbstractEventLoop | None = None
        self.signaling: "Signaling | None" = None

        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self.root = ctk.CTk(fg_color=COLORS["bg_deep"])
        self.root.title("Phone Webcam")
        self.root.geometry("440x800")
        self.root.resizable(False, False)

        self._qr_image = None
        self._preview_image = None

        self.container = ctk.CTkFrame(self.root, fg_color=COLORS["bg_deep"])
        self.container.pack(fill="both", expand=True)

        self._build_disconnected_view()
        self._build_live_view()
        self._show(self.disconnected_view)

    # ---------------------------------------------------------------- views
    def _show(self, view):
        for v in (self.disconnected_view, self.live_view):
            v.place_forget()
        view.place(relx=0, rely=0, relwidth=1, relheight=1)

    def _build_disconnected_view(self):
        v = ctk.CTkFrame(self.container, fg_color=COLORS["bg_deep"])
        self.disconnected_view = v

        top = ctk.CTkFrame(v, fg_color="transparent")
        top.pack(fill="x", padx=18, pady=(16, 6))
        ctk.CTkLabel(top, text="Phone Webcam", font=ctk.CTkFont(size=15, weight="bold"),
                     text_color=COLORS["text"]).pack(side="left")
        status_row = ctk.CTkFrame(top, fg_color="transparent")
        status_row.pack(side="right")
        self.disc_status_dot = ctk.CTkLabel(status_row, text="●", text_color=COLORS["text_faint"],
                                             font=ctk.CTkFont(size=11))
        self.disc_status_dot.pack(side="left", padx=(0, 5))
        self.disc_status_label = ctk.CTkLabel(status_row, text="DISCONNECTED",
                                               font=ctk.CTkFont(size=11, weight="bold"),
                                               text_color=COLORS["text_faint"])
        self.disc_status_label.pack(side="left")

        waiting = ctk.CTkFrame(v, fg_color=COLORS["bg_panel_alt"], border_width=1,
                                border_color=COLORS["line"], corner_radius=16)
        waiting.pack(fill="x", padx=18, pady=(10, 14))
        icon_ring = ctk.CTkLabel(waiting, text="■", width=54, height=54, corner_radius=27,
                                  fg_color=COLORS["blue"], text_color="white",
                                  font=ctk.CTkFont(size=18))
        icon_ring.pack(pady=(26, 12))
        ctk.CTkLabel(waiting, text="Waiting for device…", font=ctk.CTkFont(size=14, weight="bold"),
                     text_color=COLORS["text"]).pack()
        ctk.CTkLabel(waiting, text="Open the Phone Webcam app on your phone", font=ctk.CTkFont(size=12),
                     text_color=COLORS["text_muted"]).pack(pady=(4, 26))

        card = ctk.CTkFrame(v, fg_color=COLORS["bg_panel"], border_width=1,
                             border_color=COLORS["line"], corner_radius=14)
        card.pack(fill="x", padx=18)
        ctk.CTkLabel(card, text="CONNECTION INSTRUCTIONS", font=ctk.CTkFont(size=10, weight="bold"),
                     text_color=COLORS["cyan"], anchor="w").pack(fill="x", padx=16, pady=(14, 0))
        ctk.CTkLabel(card, text="Connect to the same Wi-Fi, then scan the QR code or enter the details manually",
                     font=ctk.CTkFont(size=11), text_color=COLORS["text_muted"], anchor="w",
                     wraplength=380, justify="left").pack(fill="x", padx=16, pady=(2, 12))

        body = ctk.CTkFrame(card, fg_color="transparent")
        body.pack(fill="x", padx=16, pady=(0, 16))
        body.grid_columnconfigure(0, weight=1)

        left = ctk.CTkFrame(body, fg_color="transparent")
        left.grid(row=0, column=0, sticky="nsew")

        ctk.CTkLabel(left, text="PC ADDRESS", font=ctk.CTkFont(size=10, weight="bold"),
                     text_color=COLORS["text_faint"], anchor="w").pack(fill="x")
        addr_row = ctk.CTkFrame(left, fg_color="transparent")
        addr_row.pack(fill="x", pady=(2, 12))
        self.address_label = ctk.CTkLabel(addr_row, text="", font=ctk.CTkFont(family="Consolas", size=13),
                                           text_color=COLORS["text"], anchor="w")
        self.address_label.pack(side="left")
        ctk.CTkButton(addr_row, text="Copy", width=48, height=22, fg_color=COLORS["bg_panel_alt"],
                      hover_color=COLORS["line"], border_width=1, border_color=COLORS["line"],
                      font=ctk.CTkFont(size=10), command=self._copy_address).pack(side="right")

        ctk.CTkLabel(left, text="PASSCODE", font=ctk.CTkFont(size=10, weight="bold"),
                     text_color=COLORS["text_faint"], anchor="w").pack(fill="x")
        self.code_label = ctk.CTkLabel(left, text="——————",
                                        font=ctk.CTkFont(family="Consolas", size=26, weight="bold"),
                                        text_color=COLORS["blue"], anchor="w")
        self.code_label.pack(fill="x", pady=(2, 0))

        right = ctk.CTkFrame(body, fg_color="transparent")
        right.grid(row=0, column=1, padx=(18, 0))
        self.qr_label = ctk.CTkLabel(right, text="", width=104, height=104, fg_color="white", corner_radius=8)
        self.qr_label.pack()
        ctk.CTkLabel(right, text="SCAN TO PAIR", font=ctk.CTkFont(size=9, weight="bold"),
                     text_color=COLORS["text_faint"]).pack(pady=(6, 0))

        bottom = ctk.CTkFrame(v, fg_color="transparent")
        bottom.pack(side="bottom", fill="x", padx=18, pady=14)
        self.disc_bottom_status = ctk.CTkLabel(bottom, text="Starting…", font=ctk.CTkFont(size=11),
                                                text_color=COLORS["text_muted"])
        self.disc_bottom_status.pack(side="left")
        ctk.CTkLabel(bottom, text=f"v{APP_VERSION}", font=ctk.CTkFont(size=10),
                     text_color=COLORS["text_faint"]).pack(side="right")

    def _build_live_view(self):
        v = ctk.CTkFrame(self.container, fg_color=COLORS["bg_deep"])
        self.live_view = v

        top = ctk.CTkFrame(v, fg_color="transparent")
        top.pack(fill="x", padx=18, pady=(16, 10))
        ctk.CTkLabel(top, text="Phone Webcam", font=ctk.CTkFont(size=15, weight="bold"),
                     text_color=COLORS["text"]).pack(side="left")
        status_row = ctk.CTkFrame(top, fg_color="transparent")
        status_row.pack(side="right")
        ctk.CTkLabel(status_row, text="●", text_color=COLORS["green"],
                     font=ctk.CTkFont(size=11)).pack(side="left", padx=(0, 5))
        ctk.CTkLabel(status_row, text="CONNECTED", font=ctk.CTkFont(size=11, weight="bold"),
                     text_color=COLORS["green"]).pack(side="left")

        video_wrap = ctk.CTkFrame(v, fg_color="black", corner_radius=14, height=248)
        video_wrap.pack(fill="x", padx=18)
        video_wrap.pack_propagate(False)
        self.preview_label = ctk.CTkLabel(video_wrap, text="", fg_color="black")
        self.preview_label.place(relx=0, rely=0, relwidth=1, relheight=1)
        self.res_chip = ctk.CTkLabel(video_wrap, text="—", fg_color="gray20",
                                      corner_radius=6, font=ctk.CTkFont(family="Consolas", size=10, weight="bold"),
                                      text_color=COLORS["cyan"])
        self.res_chip.place(x=8, y=8)
        self.fps_chip = ctk.CTkLabel(video_wrap, text="— FPS", fg_color="gray20",
                                      corner_radius=6, font=ctk.CTkFont(family="Consolas", size=10),
                                      text_color=COLORS["text_muted"])
        self.fps_chip.place(relx=1.0, x=-8, y=8, anchor="ne")
        self.rec_chip = ctk.CTkLabel(video_wrap, text="", fg_color="gray20",
                                      corner_radius=6, font=ctk.CTkFont(family="Consolas", size=10),
                                      text_color=COLORS["danger"])
        self.rec_chip.place(relx=1.0, rely=1.0, x=-8, y=-8, anchor="se")

        stats = ctk.CTkFrame(v, fg_color="transparent")
        stats.pack(fill="x", padx=18, pady=12)
        stats.grid_columnconfigure((0, 1, 2), weight=1, uniform="stat")
        self.bitrate_value = self._make_stat_chip(stats, "BITRATE", 0, COLORS["cyan"])
        self.quality_value = self._make_stat_chip(stats, "CONNECTION", 1, COLORS["green"])
        self.loss_value = self._make_stat_chip(stats, "PACKET LOSS", 2, COLORS["text"])

        config = ctk.CTkFrame(v, fg_color=COLORS["bg_panel"], border_width=1,
                               border_color=COLORS["line"], corner_radius=14)
        config.pack(fill="x", padx=18)
        ctk.CTkLabel(config, text="CAMERA CONFIGURATION", font=ctk.CTkFont(size=10, weight="bold"),
                     text_color=COLORS["text_faint"], anchor="w").pack(fill="x", padx=16, pady=(14, 8))

        row1 = ctk.CTkFrame(config, fg_color="transparent")
        row1.pack(fill="x", padx=16)
        row1.grid_columnconfigure((0, 1), weight=1, uniform="cfg")
        self.mirror_btn = ctk.CTkButton(row1, text="⇋  Mirror", height=32,
                                         fg_color=COLORS["bg_panel_alt"], hover_color=COLORS["line"],
                                         border_width=1, border_color=COLORS["line"],
                                         font=ctk.CTkFont(size=12), command=self._toggle_mirror)
        self.mirror_btn.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        self.rotate_btn = ctk.CTkButton(row1, text="↻  Rotate 90°", height=32,
                                         fg_color=COLORS["bg_panel_alt"], hover_color=COLORS["line"],
                                         border_width=1, border_color=COLORS["line"],
                                         font=ctk.CTkFont(size=12), command=self._rotate)
        self.rotate_btn.grid(row=0, column=1, sticky="ew", padx=(6, 0))

        self.output_var = ctk.StringVar(value="1080p (Full HD)")
        self.output_menu = ctk.CTkOptionMenu(config, values=list(OUTPUT_PRESETS.keys()),
                                              variable=self.output_var, height=32,
                                              fg_color=COLORS["bg_panel_alt"], button_color=COLORS["line"],
                                              button_hover_color=COLORS["line"],
                                              text_color=COLORS["text"], font=ctk.CTkFont(size=12),
                                              command=self._set_output_preset)
        self.output_menu.pack(fill="x", padx=16, pady=10)
        self._set_output_preset(self.output_var.get())

        row2 = ctk.CTkFrame(config, fg_color="transparent")
        row2.pack(fill="x", padx=16, pady=(0, 16))
        ctk.CTkButton(row2, text="\U0001F4F7", width=40, height=36, fg_color=COLORS["bg_panel_alt"],
                      hover_color=COLORS["line"], border_width=1, border_color=COLORS["line"],
                      font=ctk.CTkFont(size=14), command=self._take_snapshot).pack(side="left")
        self.record_btn = ctk.CTkButton(row2, text="●  Record Video", height=36,
                                         fg_color=COLORS["bg_panel_alt"], hover_color=COLORS["line"],
                                         border_width=1, border_color=COLORS["line"],
                                         text_color=COLORS["danger"], font=ctk.CTkFont(size=12, weight="bold"),
                                         command=self._toggle_recording)
        self.record_btn.pack(side="left", fill="x", expand=True, padx=8)
        ctk.CTkButton(row2, text="✕  Disconnect", height=36, fg_color=COLORS["danger_dark"],
                      hover_color=COLORS["danger"], font=ctk.CTkFont(size=12, weight="bold"),
                      command=self._disconnect).pack(side="left")

        bottom = ctk.CTkFrame(v, fg_color="transparent")
        bottom.pack(side="bottom", fill="x", padx=18, pady=14)
        ctk.CTkLabel(bottom, text="Streaming · Live", font=ctk.CTkFont(size=11),
                     text_color=COLORS["green"]).pack(side="left")
        ctk.CTkLabel(bottom, text=f"v{APP_VERSION}", font=ctk.CTkFont(size=10),
                     text_color=COLORS["text_faint"]).pack(side="right")

    def _make_stat_chip(self, parent, label, col, value_color):
        chip = ctk.CTkFrame(parent, fg_color=COLORS["bg_panel"], border_width=1,
                             border_color=COLORS["line"], corner_radius=10)
        chip.grid(row=0, column=col, sticky="ew", padx=4)
        ctk.CTkLabel(chip, text=label, font=ctk.CTkFont(size=9, weight="bold"),
                     text_color=COLORS["text_faint"]).pack(anchor="w", padx=10, pady=(8, 0))
        value = ctk.CTkLabel(chip, text="—", font=ctk.CTkFont(family="Consolas", size=13, weight="bold"),
                              text_color=value_color)
        value.pack(anchor="w", padx=10, pady=(0, 8))
        return value

    # -------------------------------------------------------- button actions
    def _copy_address(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.address_label.cget("text"))

    def _toggle_mirror(self):
        self.transformer.mirror = not self.transformer.mirror
        self.mirror_btn.configure(
            fg_color=COLORS["bg_panel_alt"] if not self.transformer.mirror else "#0d1a22",
            border_color=COLORS["line"] if not self.transformer.mirror else COLORS["cyan"],
            text_color=COLORS["text"] if not self.transformer.mirror else COLORS["cyan"],
        )

    def _rotate(self):
        self.transformer.rotation = (self.transformer.rotation + 90) % 360
        label = "↻  Rotate 90°" if self.transformer.rotation == 0 else f"↻  {self.transformer.rotation}°"
        active = self.transformer.rotation != 0
        self.rotate_btn.configure(
            text=label,
            fg_color=COLORS["bg_panel_alt"] if not active else "#0d1a22",
            border_color=COLORS["line"] if not active else COLORS["cyan"],
            text_color=COLORS["text"] if not active else COLORS["cyan"],
        )

    def _set_output_preset(self, choice: str):
        self.transformer.output_size = OUTPUT_PRESETS.get(choice)

    def _take_snapshot(self):
        frame = self._last_preview_frame
        if frame is None:
            return
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        path = os.path.join(output_dir("Pictures"), f"phone-webcam-{ts}.png")
        cv2.imwrite(path, cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        self.rec_chip.configure(text="Saved snapshot")
        self.root.after(1500, lambda: self.rec_chip.configure(text="● REC" if self.recorder.active else ""))

    def _toggle_recording(self):
        if self.recorder.active:
            self.recorder.stop()
            self.record_btn.configure(text="●  Record Video", fg_color=COLORS["bg_panel_alt"],
                                       text_color=COLORS["danger"], border_width=1)
            self.rec_chip.configure(text="")
            return
        if self.last_frame_size is None:
            return
        w, h = self.last_frame_size
        try:
            self.recorder.start(w, h, CAM_FPS)
        except RuntimeError:
            return
        self.record_btn.configure(text="■  Stop Recording", fg_color=COLORS["danger_dark"],
                                   text_color="white")

    def _disconnect(self):
        if self.loop is not None and self.signaling is not None:
            asyncio.run_coroutine_threadsafe(self.signaling.force_disconnect(), self.loop)

    # ------------------------------------------------------------- from asyncio thread
    def set_view(self, name: str):
        self.events.put(("view", name))

    def set_status(self, text: str):
        self.events.put(("status", text))

    def set_connection(self, address: str, code: str):
        self.events.put(("address", address))
        self.events.put(("code", code or "——————"))
        if address and code:
            self.events.put(("qr", connection_payload(address, code)))

    def push_preview(self, frame: np.ndarray):
        self.events.put(("preview", frame))

    def push_video_meta(self, w: int, h: int):
        self.last_frame_size = (w, h)
        self.events.put(("video_meta", (w, h)))

    def push_fps(self, fps: float):
        self.events.put(("fps", fps))

    def push_stats(self, bitrate_kbps, loss_pct, quality):
        self.events.put(("stats", (bitrate_kbps, loss_pct, quality)))

    def push_ice_state(self, state: str):
        self.events.put(("ice_state", state))

    _last_preview_frame = None

    # --------------------------------------------------------------- polling
    def _poll(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "view":
                    self._show(self.live_view if value == "live" else self.disconnected_view)
                    if value == "live":
                        self.bitrate_value.configure(text="—")
                        self.loss_value.configure(text="—")
                        self.quality_value.configure(text="—", text_color=COLORS["green"])
                    else:
                        self.recorder.stop()
                        self.record_btn.configure(text="●  Record Video", fg_color=COLORS["bg_panel_alt"],
                                                   text_color=COLORS["danger"])
                        self.rec_chip.configure(text="")
                        self.res_chip.configure(text="—")
                        self.fps_chip.configure(text="— FPS")
                        self.preview_label.configure(image=None)
                elif kind == "status":
                    self.disc_status_label.configure(text=value.upper())
                    self.disc_bottom_status.configure(text=value)
                    color = COLORS["amber"] if "connect" in value.lower() and "wait" not in value.lower() else COLORS["text_faint"]
                    self.disc_status_dot.configure(text_color=color)
                elif kind == "address":
                    self.address_label.configure(text=value)
                elif kind == "code":
                    self.code_label.configure(text=value)
                elif kind == "qr":
                    qr = qrcode.QRCode(border=1, box_size=4)
                    qr.add_data(value)
                    qr.make(fit=True)
                    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
                    self._qr_image = ctk.CTkImage(light_image=img, dark_image=img, size=(96, 96))
                    self.qr_label.configure(image=self._qr_image, text="")
                elif kind == "preview":
                    self._last_preview_frame = value
                    img = Image.fromarray(value)
                    target_w = 404
                    target_h = int(target_w * img.height / img.width)
                    img = img.resize((target_w, target_h), Image.BILINEAR)
                    self._preview_image = ctk.CTkImage(light_image=img, dark_image=img, size=(target_w, target_h))
                    self.preview_label.configure(image=self._preview_image, text="")
                elif kind == "video_meta":
                    w, h = value
                    self.res_chip.configure(text=human_resolution(w, h))
                elif kind == "fps":
                    self.fps_chip.configure(text=f"{value:.0f} FPS")
                elif kind == "stats":
                    bitrate_kbps, loss_pct, quality = value
                    self.bitrate_value.configure(
                        text=f"{bitrate_kbps / 1000:.1f} Mbps" if bitrate_kbps is not None else "—")
                    self.loss_value.configure(text=f"{loss_pct:.1f}%" if loss_pct is not None else "—")
                    if quality is not None:
                        # A real quality reading always wins visually over
                        # whatever color an earlier ICE-state message left
                        # behind (e.g. red from a transient "failed"/
                        # "disconnected" blip before the link recovered).
                        self.quality_value.configure(text=quality, text_color=COLORS["green"])
                elif kind == "ice_state":
                    # Real inbound-rtp stats (and therefore a real quality
                    # reading) only exist once a video packet has actually
                    # arrived. Until then, this chip shows aiortc's own
                    # connection-state machine instead of a placeholder dash
                    # — "checking"/"failed"/"disconnected" here is the
                    # concrete signal that SDP succeeded but ICE never found
                    # (or lost) a working path, e.g. a firewall or AP client
                    # isolation, as opposed to a local performance problem.
                    ice_labels = {
                        "new": "Starting…", "connecting": "Connecting…",
                        "connected": "Connected (no media yet)", "completed": "Connected (no media yet)",
                        "disconnected": "ICE disconnected", "failed": "ICE failed", "closed": "Closed",
                    }
                    self.quality_value.configure(text=ice_labels.get(value, value))
                    color = COLORS["danger"] if value in ("failed", "disconnected", "closed") else (
                        COLORS["amber"] if value in ("new", "connecting") else COLORS["green"])
                    self.quality_value.configure(text_color=color)
        except queue.Empty:
            pass
        if self.recorder.active:
            m, s = divmod(self.recorder.elapsed_seconds(), 60)
            self.rec_chip.configure(text=f"● REC {m:02d}:{s:02d}")
        self.root.after(80, self._poll)

    def run(self):
        self._poll()
        self.root.mainloop()


async def consume_video(track, app: App, sink: CameraSink, activity: dict):
    app.set_status("Receiving video…")
    frame_count = 0
    fps_window_start = time.monotonic()
    fps_window_count = 0
    try:
        while True:
            frame = await track.recv()
            activity["last_frame"] = time.monotonic()
            img = app.transformer.apply(frame.to_ndarray(format="rgb24"))
            sink.send(img)
            app.recorder.write(img)

            h, w = img.shape[:2]
            app.push_video_meta(w, h)

            frame_count += 1
            fps_window_count += 1
            if frame_count % PREVIEW_EVERY_N_FRAMES == 0:
                app.push_preview(img)

            now = time.monotonic()
            if now - fps_window_start >= 1.0:
                app.push_fps(fps_window_count / (now - fps_window_start))
                fps_window_start = now
                fps_window_count = 0
    except MediaStreamError:
        pass
    finally:
        sink.close()


async def report_stats(pc: RTCPeerConnection, app: App):
    # aiortc's inbound-rtp stats don't carry bytesReceived (unlike the W3C
    # spec browsers implement) — bitrate is instead read from the transport
    # stat, which aggregates all bytes (RTP + RTCP) on our one video
    # transport. Packet loss comes straight from inbound-rtp, and stands in
    # for a "connection quality" reading — aiortc's getStats() has no
    # candidate-pair entries, so there's no RTT to read here at all.
    last_bytes = None
    last_time = None
    last_received = None
    last_lost = None
    try:
        while True:
            await asyncio.sleep(STATS_INTERVAL)
            report = await pc.getStats()
            bitrate_kbps = None
            loss_pct = None
            now = time.monotonic()
            for stat in report.values():
                if getattr(stat, "type", None) == "transport":
                    bytes_received = getattr(stat, "bytesReceived", None)
                    if bytes_received is not None and last_bytes is not None and last_time is not None:
                        delta_t = now - last_time
                        if delta_t > 0:
                            bitrate_kbps = (bytes_received - last_bytes) * 8 / delta_t / 1000
                    if bytes_received is not None:
                        last_bytes = bytes_received
                        last_time = now
                if getattr(stat, "type", None) == "inbound-rtp" and getattr(stat, "kind", None) == "video":
                    received = getattr(stat, "packetsReceived", None)
                    lost = getattr(stat, "packetsLost", None)
                    if None not in (received, lost, last_received, last_lost):
                        d_received = received - last_received
                        d_lost = lost - last_lost
                        denom = d_received + d_lost
                        if denom > 0:
                            loss_pct = 100 * d_lost / denom
                    if received is not None and lost is not None:
                        last_received, last_lost = received, lost
            app.push_stats(bitrate_kbps, loss_pct, quality_label(loss_pct) if loss_pct is not None else None)
    except asyncio.CancelledError:
        pass


FIRST_FRAME_TIMEOUT = 18.0  # ICE connectivity + first decode can legitimately take a while
STALLED_TIMEOUT = 6.0  # but going silent mid-stream this long means the link actually died


async def watch_for_stall(ws, activity: dict, connected_at: float):
    """SDP negotiation succeeding doesn't mean media is actually flowing —
    ICE can silently fail to find a working path (firewall, AP client
    isolation, a dead Wi-Fi link) and the app would otherwise sit forever on
    "Connected" with 0 FPS. Worse, the signaling server only frees up for the
    next phone once this WebSocket closes, so a session stuck like this
    blocks every future connection attempt until a TCP-level timeout (which
    can take minutes) eventually notices. Force-close once it's clearly dead
    so the phone can immediately retry against a clean session.
    """
    try:
        while True:
            await asyncio.sleep(2.0)
            last = activity.get("last_frame")
            if last is None:
                if time.monotonic() - connected_at > FIRST_FRAME_TIMEOUT:
                    await ws.close(code=1001, reason="no video arrived")
                    return
            elif time.monotonic() - last > STALLED_TIMEOUT:
                await ws.close(code=1001, reason="video stalled")
                return
    except asyncio.CancelledError:
        pass


class Signaling:
    """Handles one phone connection at a time; a fresh code is issued after each session."""

    def __init__(self, app: App, address: str):
        self.app = app
        self.address = address
        self.code = make_code()
        self.busy = False
        self._active_ws = None

    async def force_disconnect(self):
        if self._active_ws is not None:
            await self._active_ws.close()

    async def handler(self, ws):
        if self.busy:
            await ws.close(code=1013, reason="busy")
            return

        try:
            raw = await ws.recv()
        except websockets.ConnectionClosed:
            return

        msg = json.loads(raw)
        if msg.get("type") != "join" or msg.get("code") != self.code:
            await ws.send(json.dumps({"type": "error", "message": "bad code"}))
            await ws.close()
            return

        self.busy = True
        self._active_ws = ws
        self.app.set_status("Phone connected, negotiating…")
        pc = RTCPeerConnection()
        pc.addTransceiver("video", direction="recvonly")
        sink = CameraSink()
        stats_task = None
        watchdog_task = None
        activity = {"last_frame": None}

        @pc.on("connectionstatechange")
        async def on_connection_state_change():
            self.app.push_ice_state(pc.connectionState)

        @pc.on("track")
        def on_track(track):
            nonlocal stats_task, watchdog_task
            if track.kind == "video":
                asyncio.ensure_future(consume_video(track, self.app, sink, activity))
                stats_task = asyncio.ensure_future(report_stats(pc, self.app))
                watchdog_task = asyncio.ensure_future(watch_for_stall(ws, activity, time.monotonic()))
                self.app.set_view("live")

        try:
            await ws.send(json.dumps({"type": "joined"}))
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "offer":
                    payload = msg["payload"]
                    await pc.setRemoteDescription(RTCSessionDescription(sdp=payload["sdp"], type=payload["type"]))
                    answer = await pc.createAnswer()
                    await pc.setLocalDescription(answer)
                    await ws.send(json.dumps({
                        "type": "answer",
                        "payload": {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                    }))
                    self.app.set_status("Connected")
        except websockets.ConnectionClosed:
            pass
        finally:
            if stats_task is not None:
                stats_task.cancel()
            if watchdog_task is not None:
                watchdog_task.cancel()
            sink.close()
            await pc.close()
            self.busy = False
            self._active_ws = None
            self.code = make_code()
            self.app.set_view("disconnected")
            self.app.set_connection(self.address, self.code)
            self.app.set_status("Waiting for phone to connect…")


async def run_server(app: App):
    app.loop = asyncio.get_running_loop()
    address = f"ws://{local_ip()}:{PORT}"
    signaling = Signaling(app, address)
    app.signaling = signaling
    app.set_connection(address, signaling.code)
    app.set_status("Waiting for phone to connect…")
    async with websockets.serve(signaling.handler, "0.0.0.0", PORT):
        await asyncio.Future()


def main():
    app = App()
    threading.Thread(target=lambda: asyncio.run(run_server(app)), daemon=True).start()
    app.run()


if __name__ == "__main__":
    main()
