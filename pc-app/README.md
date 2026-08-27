# Phone Webcam — PC app (Windows)

Receives the phone's camera over WebRTC (same Wi-Fi network, no external
server needed) and exposes it as a virtual camera named **"Phone Webcam"**,
selectable in Zoom/Teams/Discord/OBS/etc.

## One-time setup

1. Install the **Unity Capture** virtual camera driver (no OBS required):
   - Download: https://github.com/schellingb/UnityCapture
   - Extract it anywhere permanent, then run `Install.bat` inside the
     `Install` folder **as Administrator**. This registers a DirectShow
     virtual camera device that `pyvirtualcam` will drive.
2. `pip install -r requirements.txt`

## Run

```bash
python main.py
```

A window shows the PC's local address (`ws://192.168.x.x:8765`) and a
6-digit room code — enter both in the mobile app. The PC and phone must be
on the **same Wi-Fi network**. Once the phone connects, "Phone Webcam"
becomes available as a camera source in any app (you may need to reopen the
other app's camera picker). If Windows Firewall prompts on first run, allow
access on private networks.

## Build a standalone .exe

```bash
pip install pyinstaller
pyinstaller build.spec
```

`dist/PhoneWebcam.exe` is produced — no config file needed, just run it.

## Build a Windows installer

Requires [Inno Setup 6](https://jrsoftware.org/isdl.php) (`winget install JRSoftware.InnoSetup`).
Build the exe first (previous step), then:

```bash
"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer.iss
```

`dist_installer\PhoneWebcam-Setup.exe` is produced — a normal Windows
installer: Start Menu shortcut, optional desktop shortcut, listed in
"Add or remove programs" with an uninstaller. No admin rights required
(installs per-user by default).
