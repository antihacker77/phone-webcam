# Phone Webcam — PC app (Windows)

Receives the phone's camera over WebRTC (same Wi-Fi network, no external
server needed) and exposes it as a virtual camera named **"OBS Virtual
Camera"**, selectable in Zoom/Teams/Discord/browsers/OBS/etc.

The installer bundles everything needed — installing just it is enough, no
separate driver or app to install first.

## Run from source

```bash
pip install -r requirements.txt
python main.py
```

The first run needs the virtual camera driver registered once (see
"Register the virtual camera driver" below) — the prebuilt installer does
this automatically, but running from source doesn't.

A window shows a QR code — scan it from the mobile app to connect (its
address `ws://192.168.x.x:8765` and 6-digit room code are also shown as
text, for manual entry if scanning isn't possible). The PC and phone must be
on the **same Wi-Fi network**. Once the phone connects, "OBS Virtual Camera"
becomes available as a camera source in any app (you may need to reopen the
other app's camera picker), and the window switches to a live view: a
preview of the stream, real bitrate/packet-loss/connection-quality stats, and
camera controls —

- **Mirror** / **Rotate 90°** — flip or rotate the feed before it reaches
  the virtual camera, the preview and any recording.
- **Output resolution** — resize the feed to 720p/1080p/4K (or leave it at
  the phone's source resolution) regardless of what the phone sends.
- **Snapshot** (camera icon) — saves the current frame as a PNG to
  `Pictures\Phone Webcam\`.
- **Record Video** — records the (already mirrored/rotated/resized) stream
  to an MP4 file in `Videos\Phone Webcam\`, named by timestamp.
- **Disconnect** — ends the current session from the PC side.

If Windows Firewall prompts on first run, allow access on private networks.

### Register the virtual camera driver (source runs only)

`vendor/obs-virtualcam/` bundles the OBS Virtual Camera DirectShow filter
(see `NOTICE.md` there) — the same component the installer registers
automatically. To register it manually, from an elevated (Administrator)
terminal:

```bash
regsvr32 /s vendor\obs-virtualcam\obs-virtualcam-module64.dll
regsvr32 /s vendor\obs-virtualcam\obs-virtualcam-module32.dll
```

## Build a standalone .exe

```bash
pip install pyinstaller
pyinstaller build.spec
```

Produces two files in `dist/`:
- `PhoneWebcam.exe` — the main app.
- `camera_worker.exe` — a helper `main.py` spawns as a subprocess to talk to
  the virtual camera (kept as a separate process deliberately — see the
  comment on `CameraSink` in `main.py`).

Both are needed side by side; neither needs a config file.

## Build a Windows installer

Requires [Inno Setup 6](https://jrsoftware.org/isdl.php) (`winget install JRSoftware.InnoSetup`).
Build the exes first (previous step), then:

```bash
"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer.iss
```

`dist_installer\PhoneWebcam-Setup.exe` is produced — a normal Windows
installer: Start Menu shortcut, optional desktop shortcut, listed in
"Add or remove programs" with an uninstaller. **Requires admin rights**
during install (only to register the virtual camera driver into
`HKEY_LOCAL_MACHINE`) — the app itself runs as a regular user afterward.
