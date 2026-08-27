# Signaling + TURN server

Pairs the iOS app and the Windows app and relays WebRTC SDP/ICE messages
between them. Video itself never passes through this server, except when a
TURN relay is required for NAT traversal — that traffic goes through `coturn`,
not through the Node signaling process.

## 1. Expose `signal.<domain>` via your existing Cloudflare Tunnel

If the host already runs `cloudflared` as a systemd service (check with
`systemctl status cloudflared` and `cat /etc/cloudflared/config.yml`), reuse
that tunnel instead of opening ports 80/443 — the tunnel already terminates
TLS at Cloudflare's edge and handles WebSocket upgrades transparently.

Add an ingress rule to `/etc/cloudflared/config.yml` **above** the final
`service: http_status:404` catch-all line:

```yaml
ingress:
  - hostname: signal.<domain>
    service: http://localhost:8080
  - service: http_status:404   # must stay last
```

Then route DNS for it to the tunnel (replace `<tunnel-name>` with the name
shown by `cloudflared tunnel list`) and restart:

```bash
cloudflared tunnel route dns <tunnel-name> signal.<domain>
systemctl restart cloudflared
```

`docker-compose.yml` publishes the signaling container on `127.0.0.1:8080`
only — it's never reachable from outside the box except through the tunnel.

*(If you don't already have a tunnel, the alternative is a plain DNS A record
for `signal.<domain>` proxied through Cloudflare, with a reverse proxy like
Caddy handling TLS and forwarding to the container — not needed here since a
tunnel is already running.)*

## 1b. DNS for TURN (separate — cannot go through the tunnel)

`coturn` needs raw UDP, which Cloudflare Tunnels/proxying do not forward.
Create one more DNS record directly (not part of the tunnel):

| Record | Type | Proxy status | Why |
|---|---|---|---|
| `turn.<domain>` | A → VPS public IP | **DNS only (grey cloud)** | TURN uses raw UDP; must reach the VPS directly. |

## 2. Configure

```bash
cp .env.example .env
# edit .env: set a long random SHARED_SECRET
```

Edit `turnserver.conf` and replace:
- `CHANGE_ME_TURN_PASSWORD` — a long random password
- `CHANGE_ME_TURN_DOMAIN` — `turn.<domain>` (must match the DNS record above)
- `CHANGE_ME_PUBLIC_IP` — the VPS's public IPv4 address

## 3. Firewall

Signaling needs no inbound ports open — it's only reachable through the
Cloudflare Tunnel. Open on the VPS just for coturn:
- `3478/udp`, `3478/tcp` — coturn control
- `49160-49200/udp` — coturn relay range (matches `min-port`/`max-port` above)

## 4. Run

```bash
docker compose up -d --build
```

## 5. Verify TURN works

Open https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
and add a server:
```
turn:turn.<domain>:3478
username: phonecam
credential: <the password you set in turnserver.conf>
```
Click "Gather candidates" — you should see one or more `relay` candidates.
If you only see `host`/`srflx` candidates, coturn isn't reachable (check the
firewall ports above).

The PC app and mobile app both need the same TURN host/username/password and
the same `SHARED_SECRET` configured — see their respective READMEs.
