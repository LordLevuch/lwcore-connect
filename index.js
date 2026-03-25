import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Разрешаем CORS и JSON
app.use(cors());
app.use(express.json());

// Простое in-memory хранилище
// key: uuid, value: { uuid, nickname, modVersion, build, server, lastSeen }
const clients = new Map();

// TTL (игрок считается "онлайн с модом", если обновлялся за последние N минут)
const ONLINE_TTL_MS = 5 * 60 * 1000; // 5 минут

function cleanupOldClients() {
  const now = Date.now();
  for (const [uuid, data] of clients.entries()) {
    if (now - data.lastSeen > ONLINE_TTL_MS) {
      clients.delete(uuid);
    }
  }
}

// Периодическая очистка
setInterval(cleanupOldClients, 60 * 1000);

// Простой healthcheck
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    onlineClients: clients.size,
    ttlMinutes: ONLINE_TTL_MS / 60000
  });
});

// Клиент с модом сообщает о себе
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

// Клиент спрашивает: у кого из этих ников есть мод
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
      // Если хочешь учитывать сервер, раскомментируй условие ниже
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

// Запуск сервера
app.listen(PORT, () => {
  console.log(`MoonLord presence backend listening on port ${PORT}`);
});