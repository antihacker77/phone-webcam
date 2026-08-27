const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const ROOM_TTL_MS = 5 * 60 * 1000; // unclaimed rooms expire after 5 minutes

if (!SHARED_SECRET) {
  console.warn('WARNING: SHARED_SECRET is not set — anyone can open rooms on this server.');
}

// code -> { pc: ws|null, phone: ws|null, expireTimer: Timeout }
const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.expireTimer);
  rooms.delete(code);
}

function otherRole(role) {
  return role === 'pc' ? 'phone' : 'pc';
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.role = null;
  ws.roomCode = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: 'error', message: 'invalid json' });
    }

    if (msg.type === 'create-room') {
      if (msg.secret !== SHARED_SECRET) {
        return send(ws, { type: 'error', message: 'bad secret' });
      }
      const code = makeRoomCode();
      const room = {
        pc: ws,
        phone: null,
        expireTimer: setTimeout(() => {
          if (!rooms.get(code)?.phone) closeRoom(code);
        }, ROOM_TTL_MS),
      };
      rooms.set(code, room);
      ws.role = 'pc';
      ws.roomCode = code;
      return send(ws, { type: 'room-created', code });
    }

    if (msg.type === 'join-room') {
      if (msg.secret !== SHARED_SECRET) {
        return send(ws, { type: 'error', message: 'bad secret' });
      }
      const room = rooms.get(msg.code);
      if (!room || room.phone) {
        return send(ws, { type: 'error', message: 'room not found' });
      }
      clearTimeout(room.expireTimer);
      room.phone = ws;
      ws.role = 'phone';
      ws.roomCode = msg.code;
      send(ws, { type: 'joined', code: msg.code });
      send(room.pc, { type: 'peer-joined' });
      return;
    }

    if (msg.type === 'signal') {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.role) return;
      const target = room[otherRole(ws.role)];
      return send(target, { type: 'signal', payload: msg.payload });
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = room[otherRole(ws.role)];
    send(peer, { type: 'peer-left' });
    closeRoom(ws.roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`signaling server listening on :${PORT}`);
});
