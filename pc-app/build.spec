# Build standalone Windows .exes: pyinstaller build.spec
# Produces dist\PhoneWebcam.exe (main app) and dist\camera_worker.exe
# (helper subprocess main.py spawns to talk to the OBS virtual camera —
# kept as a separate process/exe deliberately, see main.py's CameraSink).
# Neither needs a config file — the app shows its own address/QR/room code.
#
# main.py's UI is built with customtkinter, whose theme JSON/font assets
# live inside the package and aren't picked up by PyInstaller's default
# import scan — collect_data_files('customtkinter') below bundles them.

from PyInstaller.utils.hooks import collect_data_files

block_cipher = None

app_a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=collect_data_files('customtkinter'),
    hiddenimports=['av', 'aiortc', 'cv2'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    cipher=block_cipher,
)
app_pyz = PYZ(app_a.pure, app_a.zipped_data, cipher=block_cipher)
app_exe = EXE(
    app_pyz,
    app_a.scripts,
    app_a.binaries,
    app_a.datas,
    [],
    name='PhoneWebcam',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
)

worker_a = Analysis(
    ['camera_worker.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=['pyvirtualcam', 'pyvirtualcam._native_windows_obs', 'pyvirtualcam._native_windows_unity_capture'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    cipher=block_cipher,
)
worker_pyz = PYZ(worker_a.pure, worker_a.zipped_data, cipher=block_cipher)
worker_exe = EXE(
    worker_pyz,
    worker_a.scripts,
    worker_a.binaries,
    worker_a.datas,
    [],
    name='camera_worker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
)
