import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===== "БД" игроков с модом =====
//
// key: uuid
// value: {
//   uuid,
//   nickname,
//   firstSeenAt,
//   lastSeenAt,
//   status,        // "online" | "menu" | "server" | "offline"
//   currentServer, // string | null
//   modVersion,
//   build
// }
const players = new Map();

// TTL для авто-оффлайна, если клиент пропал (например, игра закрыта без "выхода")
const OFFLINE_TTL_MS = 10 * 60 * 1000; // 10 минут

function cleanupOfflineByTtl() {
  const now = Date.now();
  for (const [uuid, data] of players.entries()) {
    if (data.status === 'online' || data.status === 'menu' || data.status === 'server') {
      if (now - data.lastSeenAt > OFFLINE_TTL_MS) {
        data.status = 'offline';
        data.currentServer = null;
        players.set(uuid, data);
        console.log(
          `[TTL] Marked ${data.nickname} (${uuid}) as offline due to inactivity (lastSeenAt ${
            new Date(data.lastSeenAt).toISOString()
          })`
        );
      }
    }
  }
}

setInterval(cleanupOfflineByTtl, 60 * 1000);

// Healthcheck
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    totalPlayers: players.size,
    online: Array.from(players.values()).filter(p => p.status !== 'offline').length
  });
});

/**
 * POST /presence
 *
 * Клиент шлёт:
 * {
 *   "uuid": "...",
 *   "nickname": "...",
 *   "modVersion": "1.0",
 *   "build": 3,
 *   "state": "online" | "menu" | "server" | "offline",
 *   "server": "mc.example.com:25565" // только если state === "server"
 * }
 *
 * Назначение:
 *  - обновить/создать запись игрока
 *  - обновить статус (online/menu/server/offline)
 */
app.post('/presence', (req, res) => {
  try {
    const { uuid, nickname, modVersion, build, state, server } = req.body || {};
    if (!uuid || !nickname) {
      return res.status(400).json({ error: 'uuid and nickname are required' });
    }

    const now = Date.now();
    const normalizedState = ['online', 'menu', 'server', 'offline'].includes(state)
      ? state
      : 'online';

    let existing = players.get(uuid);
    if (!existing) {
      existing = {
        uuid,
        nickname: String(nickname),
        firstSeenAt: now,
        lastSeenAt: now,
        status: normalizedState,
        currentServer: normalizedState === 'server' ? String(server || '') || null : null,
        modVersion: modVersion ? String(modVersion) : 'unknown',
        build: typeof build === 'number' ? build : null
      };
    } else {
      existing.nickname = String(nickname);
      existing.lastSeenAt = now;
      existing.status = normalizedState;
      existing.currentServer =
        normalizedState === 'server' ? (server ? String(server) : null) : null;
      existing.modVersion = modVersion ? String(modVersion) : existing.modVersion;
      existing.build = typeof build === 'number' ? build : existing.build;
    }

    players.set(uuid, existing);

    console.log(
      `[PRESENCE] ${existing.nickname} (${uuid}) state=${existing.status} server=${
        existing.currentServer || '-'
      } v${existing.modVersion} build ${existing.build ?? '?'}`
    );

    return res.json({ ok: true, timestamp: now });
  } catch (e) {
    console.error('Error in /presence:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /who-has-mod
 *
 * Тело:
 * {
 *   "players": ["Nick1", "Nick2", "LordLevuch"],
 *   "server": "mc.example.com:25565" // опционально
 * }
 *
 * Ответ:
 * {
 *   "withMod": ["Nick2", "LordLevuch"],
 *   "meta": {
 *     "Nick2": { "status": "server", "currentServer": "mc...", "modVersion": "...", "build": 3, "lastSeenAt": 123 },
 *     "LordLevuch": { ... }
 *   },
 *   "now": 123
 * }
 */
app.post('/who-has-mod', (req, res) => {
  try {
    const { players: nicknames, server } = req.body || {};
    if (!Array.isArray(nicknames)) {
      return res.status(400).json({ error: 'players must be array' });
    }

    const now = Date.now();
    const normalized = nicknames.map(p => String(p).trim()).filter(Boolean);

    const withMod = [];
    const meta = {};

    for (const p of players.values()) {
      if (!normalized.includes(p.nickname)) continue;
      // если хотим фильтровать по серверу:
      if (server && p.currentServer && p.currentServer !== server) continue;
      if (p.status === 'offline') continue;

      withMod.push(p.nickname);
      meta[p.nickname] = {
        status: p.status,
        currentServer: p.currentServer,
        modVersion: p.modVersion,
        build: p.build,
        lastSeenAt: p.lastSeenAt
      };
    }

    return res.json({ withMod, meta, now });
  } catch (e) {
    console.error('Error in /who-has-mod:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  console.log(`MoonLord backend (players DB) listening on port ${PORT}`);
});
