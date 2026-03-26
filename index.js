import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===== Онлайн-игроки с модом =====

// key: uuid
// value: { uuid, nickname, modVersion, build, server, lastSeen }
const clients = new Map();

// TTL (онлайн) — 5 минут
const ONLINE_TTL_MS = 5 * 60 * 1000;

// ===== База конфигов (share/load) =====

// key: shareKey (строка), value: { key, ownerUuid, ownerNickname, config, createdAt, expiresAt }
const sharedConfigs = new Map();

// TTL ключей конфигов — 1 день
const CONFIG_TTL_MS = 24 * 60 * 60 * 1000;

// Утилита очистки старых записей
function cleanupOldClients() {
  const now = Date.now();
  for (const [uuid, data] of clients.entries()) {
    if (now - data.lastSeen > ONLINE_TTL_MS) {
      clients.delete(uuid);
    }
  }
}

function cleanupOldConfigs() {
  const now = Date.now();
  for (const [key, data] of sharedConfigs.entries()) {
    if (now > data.expiresAt) {
      sharedConfigs.delete(key);
    }
  }
}

setInterval(() => {
  cleanupOldClients();
  cleanupOldConfigs();
}, 60 * 1000);

// Простая генерация ключа
function generateShareKey(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов
  let key = '';
  for (let i = 0; i < length; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// ===== Эндпоинты =====

// Healthcheck
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    onlineClients: clients.size,
    sharedConfigs: sharedConfigs.size,
    onlineTtlMinutes: ONLINE_TTL_MS / 60000,
    configTtlHours: CONFIG_TTL_MS / 3600000
  });
});

// Presence от клиента
app.post('/presence', (req, res) => {
  try {
    const { uuid, nickname, modVersion, build, server } = req.body || {};
    if (!uuid || !nickname) {
      return res.status(400).json({ error: 'uuid and nickname are required' });
    }

    const now = Date.now();

    clients.set(uuid, {
      uuid,
      nickname: String(nickname),
      modVersion: modVersion ? String(modVersion) : 'unknown',
      build: typeof build === 'number' ? build : null,
      server: server ? String(server) : null,
      lastSeen: now
    });

    console.log(
      `[PRESENCE] ${nickname} (${uuid}) v${modVersion || 'unknown'} build ${build ?? '?'} @ ${
        server || 'unknown'
      }`
    );

    return res.json({ ok: true, timestamp: now });
  } catch (e) {
    console.error('Error in /presence:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Список, у кого есть мод (по никам)
app.post('/who-has-mod', (req, res) => {
  try {
    const { players, server } = req.body || {};
    if (!Array.isArray(players)) {
      return res.status(400).json({ error: 'players must be array' });
    }

    const now = Date.now();
    cleanupOldClients();

    const normalizedPlayers = players.map(p => String(p).trim()).filter(Boolean);

    const withMod = [];
    const meta = {};

    for (const data of clients.values()) {
      if (server && data.server && data.server !== server) continue;

      if (normalizedPlayers.includes(data.nickname)) {
        withMod.push(data.nickname);
        meta[data.nickname] = {
          modVersion: data.modVersion,
          build: data.build,
          lastSeen: data.lastSeen
        };
      }
    }

    return res.json({ withMod, meta, now });
  } catch (e) {
    console.error('Error in /who-has-mod:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ===== Share config =====
// Клиент шлёт свой текущий конфиг (JSON), сервер выдаёт ключ, который живёт 1 день

app.post('/config/share', (req, res) => {
  try {
    const { uuid, nickname, config } = req.body || {};
    if (!uuid || !nickname || !config) {
      return res.status(400).json({ error: 'uuid, nickname and config are required' });
    }

    // config — произвольный JSON объект с настройками мода
    const now = Date.now();
    const expiresAt = now + CONFIG_TTL_MS;

    // Генерируем уникальный ключ
    let key;
    do {
      key = generateShareKey(8);
    } while (sharedConfigs.has(key));

    sharedConfigs.set(key, {
      key,
      ownerUuid: uuid,
      ownerNickname: nickname,
      config,
      createdAt: now,
      expiresAt
    });

    console.log(
      `[CONFIG_SHARE] ${nickname} (${uuid}) shared config with key ${key}, expires at ${new Date(
        expiresAt
      ).toISOString()}`
    );

    return res.json({
      ok: true,
      key,
      expiresAt
    });
  } catch (e) {
    console.error('Error in /config/share:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ===== Load config =====
// Клиент присылает ключ, сервер если находит и не просрочен — возвращает config

app.post('/config/load', (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) {
      return res.status(400).json({ error: 'key is required' });
    }

    const entry = sharedConfigs.get(String(key).trim().toUpperCase());
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
  console.log(`MoonLord backend listening on port ${PORT}`);
});
