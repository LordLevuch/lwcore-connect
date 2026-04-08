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

// TTL для авто-оффлайна, если клиент пропал
const OFFLINE_TTL_MS = 60 * 60 * 1000; // 10 минут

// ===== База конфигов (share/load) =====
//
// key: shareKey (строка)
// value: { key, ownerUuid, ownerNickname, config, createdAt, expiresAt }
const sharedConfigs = new Map();

// TTL ключей конфигов — 1 день
const CONFIG_TTL_MS = 24 * 60 * 60 * 1000;

// Утилиты очистки
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

function cleanupOldConfigs() {
  const now = Date.now();
  for (const [key, data] of sharedConfigs.entries()) {
    if (now > data.expiresAt) {
      sharedConfigs.delete(key);
      console.log(`[CONFIG_TTL] Removed expired config key ${key}`);
    }
  }
}

setInterval(() => {
  cleanupOfflineByTtl();
  cleanupOldConfigs();
}, 60 * 1000);

// Генерация share-ключа
function generateShareKey(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов
  let key = '';
  for (let i = 0; i < length; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// Healthcheck
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    totalPlayers: players.size,
    online: Array.from(players.values()).filter(p => p.status !== 'offline').length,
    sharedConfigs: sharedConfigs.size,
    offlineTtlMinutes: OFFLINE_TTL_MS / 60000,
    configTtlHours: CONFIG_TTL_MS / 3600000
  });
});

/**
 * POST /presence
 *
 * {
 *   "uuid": "...",
 *   "nickname": "...",
 *   "modVersion": "1.0",
 *   "build": 3,
 *   "state": "online" | "menu" | "server" | "offline",
 *   "server": "mc.example.com:25565"
 * }
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
 * {
 *   "players": ["Nick1", "Nick2", "LordLevuch"],
 *   "server": "mc.example.com:25565"
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

/**
 * POST /config/share
 *
 * {
 *   "uuid": "...",
 *   "nickname": "...",
 *   "config": { ...JSON настроек... }
 * }
 *
 * Ответ:
 * { "ok": true, "key": "ABCD1234", "expiresAt": 1711470000000 }
 */
app.post('/config/share', (req, res) => {
  try {
    const { uuid, nickname, config } = req.body || {};
    if (!uuid || !nickname || !config) {
      return res
        .status(400)
        .json({ error: 'uuid, nickname and config are required' });
    }

    const now = Date.now();
    const expiresAt = now + CONFIG_TTL_MS;

    let key;
    do {
      key = generateShareKey(8);
    } while (sharedConfigs.has(key));

    sharedConfigs.set(key, {
      key,
      ownerUuid: uuid,
      ownerNickname: String(nickname),
      config,
      createdAt: now,
      expiresAt
    });

    console.log(
      `[CONFIG_SHARE] ${nickname} (${uuid}) shared config with key ${key}, expires at ${new Date(
        expiresAt
      ).toISOString()}`
    );

    return res.json({ ok: true, key, expiresAt });
  } catch (e) {
    console.error('Error in /config/share:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /config/load
 *
 * { "key": "ABCD1234" }
 */
app.post('/config/load', (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) {
      return res.status(400).json({ error: 'key is required' });
    }

    const normalizedKey = String(key).trim().toUpperCase();
    const entry = sharedConfigs.get(normalizedKey);
    const now = Date.now();

    if (!entry) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    if (now > entry.expiresAt) {
      sharedConfigs.delete(entry.key);
      return res.status(410).json({ ok: false, error: 'expired' });
    }

    return res.json({
      ok: true,
      key: entry.key,
      ownerUuid: entry.ownerUuid,
      ownerNickname: entry.ownerNickname,
      config: entry.config,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt
    });
  } catch (e) {
    console.error('Error in /config/load:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  console.log(`MoonLord backend (players + configs) listening on port ${PORT}`);
});
