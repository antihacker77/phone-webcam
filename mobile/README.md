# Phone Webcam — mobile app (iOS)

Streams this phone's camera over WebRTC directly to the PC app, over the
same Wi-Fi network — no external server needed. Uses `react-native-webrtc`,
which needs native code, so this project **cannot run in Expo Go** — it
requires a dev-client build (`expo prebuild` + Xcode, or the CI workflow
below).

## 1. Install deps

```bash
npm install
npx expo install --fix   # reconciles native module versions against SDK 57
```

## 2. Run on a physical iPhone

Camera capture does not work in the iOS Simulator — you need a real device.

```bash
npx expo prebuild -p ios
npx expo run:ios --device
```

## 3. Or build in CI

`.github/workflows/build-ios-ipa.yml` (copied from the `my-app` repo's
working pattern) builds an **unsigned** `.ipa` via `workflow_dispatch`. Since
it's unsigned, you'll still need to re-sign/sideload it (e.g. via your usual
AltStore/ad-hoc signing flow) to install it on a device — this mirrors
whatever process you already use for `my-app`.

## Using the app

1. Make sure the phone and the PC are on the **same Wi-Fi network**.
2. Start the PC app first — it shows a QR code (and, as a fallback, its
   address `ws://192.168.x.x:8765` and a 6-digit room code as text).
3. Open this app and tap **Scan QR to connect**, then point the camera at
   the QR code on the PC screen — it connects automatically. If scanning
   isn't possible, tap **Enter address manually** and type in the address
   and code shown on the PC instead.
4. Once paired, the PC app's "Phone Webcam" virtual camera goes live.
5. **Flip camera** toggles front/back; **Disconnect** ends the session (the
   PC app will show a fresh QR code/room code for the next connection).
