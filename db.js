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
  events: [],      // { id, channelId, date, detail, requestedBy(userId), status, createdAt }
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
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
