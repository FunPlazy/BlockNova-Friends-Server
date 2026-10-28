'use strict';
// BlockNova friends & chat server. Run: `npm install && npm start` (PORT env, default 8787).
// Protocol: JSON messages over WebSocket.
//   client -> {t:'hello', name, key, badge} | {t:'friends', names} | {t:'presence', status, game} | {t:'chat', to, text}
//   server -> {t:'welcome', name, lobby} | {t:'presence', name, online, status, game, badge, mutual} | {t:'chat', from, to, text, ts}
//             | {t:'requests', names} (who added you but you have not added back) | {t:'error', code}
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'claims.json');
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const CLAIM_TTL = 30 * 864e5;

// nickname (lowercase) -> { key, seen, name, friends } — a nickname belongs to the install that used it first.
// Friend lists are kept so a friend request reaches someone who was offline when it was sent.
let claims = {};
try { claims = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (_) { /* first start */ }
let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const now = Date.now();
  for (const [k, v] of Object.entries(claims)) if (now - v.seen > CLAIM_TTL) delete claims[k];
  fs.writeFile(DATA, JSON.stringify(claims), () => {});
}, 10000);

const clients = new Map(); // lowercase name -> state
const lobby = [];

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const clean = s => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const lc = s => String(s).toLowerCase();

function isMutual(a, b) {
  return a.friends.has(lc(b.name)) && b.friends.has(lc(a.name));
}

/** What `viewer` may see about `subject` (game details only for mutual friends). */
function presenceFor(subject, viewer, online = true) {
  const mutual = !!subject && isMutual(subject, viewer);
  return {
    t: 'presence', name: subject ? subject.name : null, online,
    status: online ? subject.status : 'offline',
    badge: online ? subject.badge : null,
    game: online && mutual ? subject.game : null,
    mutual
  };
}

/** Display names of everyone who added `nameLc` while `nameLc` has not added them back. */
function requestsFor(nameLc) {
  const mine = new Set((claims[nameLc] && claims[nameLc].friends) || []);
  return Object.entries(claims)
    .filter(([k, v]) => k !== nameLc && !mine.has(k) && Array.isArray(v.friends) && v.friends.includes(nameLc))
    .map(([k, v]) => v.name || k);
}
function sendRequests(nameLc) {
  const st = clients.get(nameLc);
  if (st) send(st.ws, { t: 'requests', names: requestsFor(nameLc) });
}

function broadcastPresence(st, online = true) {
  for (const other of clients.values()) {
    if (other === st || !other.friends.has(lc(st.name))) continue;
    send(other.ws, online ? presenceFor(st, other) : { t: 'presence', name: st.name, online: false, status: 'offline', mutual: isMutual(st, other) });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`BlockNova friends server · online: ${clients.size}\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', ws => {
  let st = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }

    if (m.t === 'hello') {
      const name = clean(m.name);
      const key = clean(m.key);
      if (!NAME_RE.test(name) || key.length < 16) return send(ws, { t: 'error', code: 'bad_hello' });
      const claim = claims[lc(name)];
      if (claim && claim.key !== key) return send(ws, { t: 'error', code: 'name_taken' });
      claims[lc(name)] = { ...claim, key, seen: Date.now(), name };
      dirty = true;
      const prev = clients.get(lc(name));
      if (prev) { send(prev.ws, { t: 'error', code: 'replaced' }); prev.ws.close(); }
      st = { ws, name, friends: new Set(), status: 'online', game: null, badge: clean(m.badge).slice(0, 8), lastChat: 0 };
      clients.set(lc(name), st);
      send(ws, { t: 'welcome', name, lobby: lobby.slice(-50), online: clients.size });
      sendRequests(lc(name));
      broadcastPresence(st);
      return;
    }
    if (!st) return send(ws, { t: 'error', code: 'no_hello' });

    if (m.t === 'friends') {
      const before = st.friends;
      st.friends = new Set((Array.isArray(m.names) ? m.names : []).slice(0, 200).map(clean).filter(n => NAME_RE.test(n)).map(lc));
      const own = claims[lc(st.name)];
      if (own) { own.friends = [...st.friends]; own.seen = Date.now(); }
      dirty = true;
      // added or removed people see their incoming requests change; accepting clears ours
      for (const n of new Set([...before, ...st.friends])) if (before.has(n) !== st.friends.has(n)) sendRequests(n);
      sendRequests(lc(st.name));
      for (const n of st.friends) {
        const other = clients.get(n);
        send(ws, other ? presenceFor(other, st) : { t: 'presence', name: n, online: false, status: 'offline', mutual: false });
        // the other side may now be mutual -> refresh what they see about us
        if (other && other.friends.has(lc(st.name))) send(other.ws, presenceFor(st, other));
      }
      return;
    }

    if (m.t === 'presence') {
      st.status = m.status === 'playing' ? 'playing' : 'online';
      const g = m.game && typeof m.game === 'object' ? m.game : null;
      st.game = g ? {
        title: clean(g.title).slice(0, 60), version: clean(g.version).slice(0, 40), loader: clean(g.loader).slice(0, 12),
        pack: clean(g.pack).slice(0, 60), since: Number(g.since) || Date.now(),
        server: g.server ? clean(g.server).slice(0, 80) : null,
        lan: g.lan && g.lan.ip ? { ip: clean(g.lan.ip).slice(0, 45), port: Number(g.lan.port) || 0 } : null
      } : null;
      broadcastPresence(st);
      return;
    }

    if (m.t === 'chat') {
      const text = clean(m.text).slice(0, 300);
      if (!text) return;
      const now = Date.now();
      if (now - st.lastChat < 1200) return send(ws, { t: 'error', code: 'slow_down' });
      st.lastChat = now;
      const msg = { t: 'chat', from: st.name, to: m.to === '#lobby' ? '#lobby' : clean(m.to), text, ts: now, badge: st.badge };
      if (msg.to === '#lobby') {
        lobby.push(msg);
        if (lobby.length > 100) lobby.shift();
        for (const c of clients.values()) send(c.ws, msg);
      } else {
        const other = clients.get(lc(msg.to));
        if (!other || !isMutual(st, other)) return send(ws, { t: 'error', code: 'not_friends' });
        send(other.ws, msg);
        send(ws, msg);
      }
    }
  });

  ws.on('close', () => {
    if (st && clients.get(lc(st.name)) === st) {
      clients.delete(lc(st.name));
      broadcastPresence(st, false);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`BlockNova friends server on :${PORT}`));
module.exports = { server };
