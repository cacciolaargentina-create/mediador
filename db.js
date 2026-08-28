// db.js
// Almacenamiento simple en un archivo JSON. Alcanza para arrancar y para pocos
// canales activos. Cuando esto pase a producción de verdad, migrar a Postgres
// (el esquema de abajo ya está pensado como si fueran tablas).

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');

const EMPTY_DB = {
  users: [],       // { id, googleId, email, name, avatar, createdAt }
  channels: [],    // { id, code, createdAt }
  members: [],     // { id, channelId, userId, role: 'A'|'B', joinedAt }
  messages: [],    // { id, channelId, senderId|null, text, flagged, reason, original, pattern, createdAt }
  events: [],      // { id, channelId, date, detail, requestedBy(userId), status, createdAt, reminderSentAt }
  caseNotes: [],   // { id, channelId, authorId, text, createdAt } — solo visibles para mediador/a, estudio jurídico o admin del canal, nunca para las partes A/B
  expenses: [],    // { id, channelId, amount, description, requestedBy(userId), status:'pendiente'|'confirmado'|'rechazado', createdAt, respondedAt }
  checkins: [],    // { id, channelId, userId, lat, lng, createdAt } — la ubicación nunca se muestra en el texto del chat, solo queda en el registro
  auditLog: [],    // { id, actorId, action, channelCode, meta, createdAt } — acciones sensibles para el panel de admin
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    const data = JSON.parse(raw);
    // migración suave: un data.json de antes de sumar una colección nueva no
    // la tiene — la completamos en memoria en vez de romper en el primer push.
    for (const key of Object.keys(EMPTY_DB)) {
      if (!Array.isArray(data[key])) data[key] = [];
    }
    return data;
  } catch (e) {
    console.error('data.json corrupto, reiniciando con base vacía', e);
    return structuredClone(EMPTY_DB);
  }
}

// escritura serializada para evitar corrupción por escrituras simultáneas
let writeQueue = Promise.resolve();
function save(data) {
  writeQueue = writeQueue.then(() =>
    fs.promises.writeFile(DB_PATH, JSON.stringify(data, null, 2))
  );
  return writeQueue;
}

let cache = load();

function getDB() {
  return cache;
}
async function commit() {
  await save(cache);
}

// resuelve la identidad de Persona B a partir del token de su link de
// invitado — el token hace las veces de sesión, sin cookie ni expiración.
function resolveGuest(token) {
  const db = cache;
  let channel = db.channels.find((c) => c.guestToken === token);
  let member = channel && db.members.find((m) => m.channelId === channel.id && m.role === 'B' && m.userId);
  if (!member) {
    // fallback: token de acceso de alguien que se sumó por WhatsApp (puede ser A o B)
    member = db.members.find((m) => m.webAccessToken === token);
    channel = member && db.channels.find((c) => c.id === member.channelId);
  }
  if (!member || !channel) return null;
  const user = db.users.find((u) => u.id === member.userId);
  return user ? { channel, user } : null;
}

module.exports = { getDB, commit, resolveGuest };
