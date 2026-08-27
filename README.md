# Phone Webcam

Use an iPhone's camera as a virtual webcam on Windows, streamed over WebRTC
— directly between the two devices on the same Wi-Fi network. No external
server, account, or internet connection required.

```
iPhone (Expo app) ──────────── same Wi-Fi ────────────▶ Windows PC (Python app)
 captures camera, connects        WebRTC P2P              runs its own local
 to the PC's local address                                signaling server,
 with the room code                                       feeds "Phone Webcam"
                                                            virtual camera device
```

## Parts

| Folder | What | Setup |
|---|---|---|
| [`pc-app/`](pc-app/README.md) | Python app: hosts local signaling, receives video, exposes it as a Windows virtual camera | Do this first |
| [`mobile/`](mobile/README.md) | Expo/iOS app: captures and streams the phone's camera | Do this second |

## Using it

1. Run the PC app — it shows its local address (`ws://192.168.x.x:8765`) and
   a 6-digit room code.
2. Open the phone app (same Wi-Fi network!), enter that address and code,
   tap Connect.
3. "Phone Webcam" appears as a virtual camera on the PC, selectable in
   Zoom/Teams/OBS/Discord/etc.

## `server/` — only needed for cross-network use

The [`server/`](server/README.md) folder (signaling relay + TURN, meant to
run on a VPS/always-on host) is **not needed** for the same-Wi-Fi setup
above. It only matters if you later want the phone and PC to connect over
the internet from different networks — that requires a real signaling
server and, in most cases, a TURN relay to get through NAT. Ignore it for
now unless you specifically need that.
