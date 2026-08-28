"""Phone Webcam — PC side.

Runs its own local WebSocket server (no external signaling needed), waits
for the phone to join on the same network, answers its WebRTC offer, and
pipes the received video into a virtual camera so it shows up as a normal
webcam in Zoom/Teams/OBS/Discord/etc.
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
import tkinter as tk

import qrcode
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from PIL import ImageTk

CAM_FPS = 30
PORT = 8765


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


class App:
    """Thread-safe bridge between the asyncio worker and the Tkinter UI."""

    def __init__(self):
        self.events: "queue.Queue[tuple[str, str]]" = queue.Queue()
        self.root = tk.Tk()
        self.root.title("Phone Webcam")
        self.root.geometry("360x480")
        self.root.resizable(False, False)

        self.address_var = tk.StringVar(value="")
        self.code_var = tk.StringVar(value="——————")
        self.status_var = tk.StringVar(value="Starting…")
        self._qr_photo = None  # keep a reference so Tkinter doesn't garbage-collect it

        tk.Label(self.root, text="Scan with the phone app:", font=("Segoe UI", 10)).pack(pady=(16, 6))
        self.qr_label = tk.Label(self.root)
        self.qr_label.pack()
        tk.Label(self.root, text="or enter manually — address:", font=("Segoe UI", 9), fg="#555").pack(pady=(14, 0))
        tk.Label(self.root, textvariable=self.address_var, font=("Consolas", 12, "bold")).pack()
        tk.Label(self.root, text="code:", font=("Segoe UI", 9), fg="#555").pack(pady=(6, 0))
        tk.Label(self.root, textvariable=self.code_var, font=("Segoe UI", 20, "bold")).pack()
        tk.Label(self.root, textvariable=self.status_var, font=("Segoe UI", 10), fg="#555").pack(pady=12)

    def set_status(self, text: str):
        self.events.put(("status", text))

    def set_connection(self, address: str, code: str):
        self.events.put(("address", address))
        self.events.put(("code", code or "——————"))
        if address and code:
            self.events.put(("qr", connection_payload(address, code)))

    def _poll(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "status":
                    self.status_var.set(value)
                elif kind == "code":
                    self.code_var.set(value)
                elif kind == "address":
                    self.address_var.set(value)
                elif kind == "qr":
                    qr = qrcode.QRCode(border=2, box_size=6)
                    qr.add_data(value)
                    qr.make(fit=True)
                    img = qr.make_image(fill_color="black", back_color="white")
                    self._qr_photo = ImageTk.PhotoImage(img)
                    self.qr_label.configure(image=self._qr_photo)
        except queue.Empty:
            pass
        self.root.after(100, self._poll)

    def run(self):
        self._poll()
        self.root.mainloop()


CAMERA_WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "camera_worker.py")


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
                [sys.executable, CAMERA_WORKER, str(w), str(h), str(CAM_FPS)],
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


async def consume_video(track, sink: CameraSink, app: App):
    app.set_status("Receiving video…")
    try:
        while True:
            frame = await track.recv()
            img = frame.to_ndarray(format="rgb24")
            sink.send(img)
    except MediaStreamError:
        pass
    finally:
        sink.close()


class Signaling:
    """Handles one phone connection at a time; a fresh code is issued after each session."""

    def __init__(self, app: App, address: str):
        self.app = app
        self.address = address
        self.code = make_code()
        self.busy = False

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
        self.app.set_status("Phone connected, negotiating…")
        pc = RTCPeerConnection()
        pc.addTransceiver("video", direction="recvonly")
        sink = CameraSink()

        @pc.on("track")
        def on_track(track):
            if track.kind == "video":
                asyncio.ensure_future(consume_video(track, sink, self.app))

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
            sink.close()
            await pc.close()
            self.busy = False
            self.code = make_code()
            self.app.set_connection(self.address, self.code)
            self.app.set_status("Waiting for phone to connect…")


async def run_server(app: App):
    address = f"ws://{local_ip()}:{PORT}"
    signaling = Signaling(app, address)
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
