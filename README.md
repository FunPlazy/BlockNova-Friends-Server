# BlockNova friends server

Friends list, online status ("playing modpack X on server Y"), "Join friend" and chat for BlockNova Launcher.

## Run

```
cd server
npm install
npm start            # listens on PORT (default 8787)
```

In the launcher: **Settings → Friends & chat → Friends server address**, e.g. `wss://friends.example.com` (or `ws://IP:8787` without TLS).

## Free hosting

- **Render.com**: New → Web Service → this repo, Root Directory `server`, Build `npm install`, Start `npm start`. Address: `wss://<name>.onrender.com`.
- **Railway / Fly.io**: same commands, or use the `Dockerfile`.
- **VPS**: `npm start` behind nginx/Caddy with TLS (WebSocket proxy).

## Privacy & rules

- A nickname belongs to the first launcher install that used it (secret key per install), so others can't pretend to be you on this network. Claims expire after 30 days of inactivity (`claims.json`).
- What you play and the server address are shared **only with mutual friends**; others only see online/offline.
- Direct messages work only between mutual friends. Global chat: 300 characters, 1 message per 1.2 s, last 100 messages kept in memory.
