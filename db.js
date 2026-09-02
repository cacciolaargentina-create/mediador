// db.js
// Almacenamiento en SQLite (node:sqlite, nativo de Node — sin dependencias
// npm nuevas, así que no depende de compilar nada en el servidor). Tablas e
// índices reales, pensados para que más adelante se puedan reescribir
// consultas puntuales en SQL directo si el volumen lo pide.
//
// Por ahora el resto del código (routes/, messaging.js, certificate.js,
// reminders.js, audit.js, serializers.js) sigue viendo exactamente la misma
// forma en memoria que antes — getDB() devuelve {users:[], channels:[], ...}
// y se sigue usando con .filter()/.find()/.push() como siempre. Eso evita
// tener que reescribir cada consulta de golpe contra datos reales de
// producción. commit() ahora vuelca ese estado a SQLite dentro de UNA
// transacción — sigue siendo una resincronización completa por escritura
// (mismo costo conceptual que el fs.writeFileSync de antes), pero ahora es
// atómica de verdad: un crash a mitad de un commit ya no puede dejar el
// archivo corrupto a medias, como sí podía pasar con el JSON plano.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data.sqlite');
// ruta del data.json viejo, solo para la migración automática de una vez
const LEGACY_JSON_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');

const EMPTY_DB = {
  users: [],       // { id, googleId, email, name, avatar, phone, guest, createdAt }
  channels: [],    // { id, code, guestToken, calendarToken, professionalInvites, status:'abierto'|'en_proceso'|'cerrado', createdAt }
  members: [],     // { id, channelId, userId, role, label, webAccessToken, assignedByAdmin, joinedAt }
  messages: [],    // { id, channelId, senderId|null, text, flagged, reason, pattern, eventId, readAt, createdAt }
  events: [],      // { id, channelId, date, detail, requestedBy(userId), status, seriesId, respondedAt, reminderSentAt, createdAt }
  caseNotes: [],   // { id, channelId, authorId, text, createdAt } — solo visibles para mediador/a, estudio jurídico o admin del canal, nunca para las partes A/B
  expenses: [],    // { id, channelId, amount, description, requestedBy(userId), status:'pendiente'|'confirmado'|'rechazado', respondedAt, createdAt }
  checkins: [],    // { id, channelId, userId, lat, lng, createdAt } — la ubicación nunca se muestra en el texto del chat, solo queda en el registro
  auditLog: [],    // { id, actorId, action, channelCode, meta, createdAt } — acciones sensibles para el panel de admin
  whatsappLog: [],      // { id, kind, phone, userName, channelCode, detail, createdAt } — notificaciones enviadas, onboarding, mensajes entrantes procesados
  whatsappWebhookRaw: [], // { id, payload, createdAt } — últimos payloads crudos del webhook de Meta, para debug técnico
  certifiedExports: [], // { id, hash, channelCode, generatedByName, generatedByRole, createdAt } — un registro por cada export certificado en PDF, para que la página pública de verificación (/verificar/:hash) pueda confirmar que el documento realmente salió de acá
  professionalApplications: [], // { id, userId, role, orgName, status:'pending'|'approved'|'rejected', createdAt, decidedAt, decidedBy } — autoregistro de mediador/a o estudio jurídico, pendiente de aprobación manual de un admin
  moderationStats: [], // { id, date:'YYYY-MM-DD', channelCode|null, successCount, failCount, flaggedCount } — UNA fila por día+canal (no una por llamada), para que el panel de Costos y Salud pueda sumar por período sin que la tabla crezca sin límite
  pushSubscriptions: [], // { id, userId, endpoint, keys:{p256dh,auth}, createdAt } — un dispositivo suscripto a notificaciones push del navegador; una persona puede tener varios (celu + compu)
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, googleId TEXT, email TEXT, name TEXT, avatar TEXT,
  phone TEXT, guest INTEGER DEFAULT 0, aiUsage TEXT,
  verifiedProfessional INTEGER DEFAULT 0, verifiedProfessionalRole TEXT, verifiedProfessionalOrg TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, guestToken TEXT, calendarToken TEXT,
  professionalInvites TEXT, remindedAt INTEGER, lastSummary TEXT,
  status TEXT DEFAULT 'abierto', createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, channelId TEXT, userId TEXT, role TEXT, label TEXT,
  webAccessToken TEXT, assignedByAdmin INTEGER DEFAULT 0, joinedAt INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channelId TEXT, senderId TEXT, text TEXT,
  flagged INTEGER DEFAULT 0, reason TEXT, pattern INTEGER DEFAULT 0,
  eventId TEXT, readAt INTEGER, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, channelId TEXT, date TEXT, detail TEXT, requestedBy TEXT,
  status TEXT, seriesId TEXT, respondedAt INTEGER, reminderSentAt INTEGER, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS case_notes (
  id TEXT PRIMARY KEY, channelId TEXT, authorId TEXT, text TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY, channelId TEXT, amount REAL, description TEXT,
  requestedBy TEXT, status TEXT, respondedAt INTEGER, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY, channelId TEXT, userId TEXT, lat REAL, lng REAL, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actorId TEXT, action TEXT, channelCode TEXT, meta TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS whatsapp_log (
  id TEXT PRIMARY KEY, kind TEXT, phone TEXT, userName TEXT, channelCode TEXT, detail TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS whatsapp_webhook_raw (
  id TEXT PRIMARY KEY, payload TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS certified_exports (
  id TEXT PRIMARY KEY, hash TEXT UNIQUE, channelCode TEXT, generatedByName TEXT,
  generatedByRole TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS professional_applications (
  id TEXT PRIMARY KEY, userId TEXT, role TEXT, orgName TEXT, status TEXT,
  createdAt INTEGER, decidedAt INTEGER, decidedBy TEXT
);
CREATE TABLE IF NOT EXISTS moderation_stats (
  id TEXT PRIMARY KEY, date TEXT, channelCode TEXT,
  successCount INTEGER DEFAULT 0, failCount INTEGER DEFAULT 0, flaggedCount INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, userId TEXT, endpoint TEXT UNIQUE, keys TEXT, createdAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_certified_exports_hash ON certified_exports(hash);
CREATE INDEX IF NOT EXISTS idx_professional_applications_user ON professional_applications(userId);
CREATE INDEX IF NOT EXISTS idx_moderation_stats_date ON moderation_stats(date);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(userId);
CREATE INDEX IF NOT EXISTS idx_members_channel ON members(channelId);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(userId);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channelId);
CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channelId);
CREATE INDEX IF NOT EXISTS idx_case_notes_channel ON case_notes(channelId);
CREATE INDEX IF NOT EXISTS idx_expenses_channel ON expenses(channelId);
CREATE INDEX IF NOT EXISTS idx_checkins_channel ON checkins(channelId);
`;

// columnas que se guardan como 0/1 en SQLite pero son boolean en JS —
// declaradas por tabla para poder convertir en los dos sentidos sin
// tener que acordarse a mano en cada función.
const BOOL_COLUMNS = {
  users: ['guest', 'verifiedProfessional'],
  members: ['assignedByAdmin'],
  messages: ['flagged', 'pattern'],
};
// columnas que viajan como objeto/array en JS pero se guardan como texto JSON
const JSON_COLUMNS = {
  channels: ['professionalInvites', 'lastSummary'],
  auditLog: ['meta'],
  users: ['aiUsage'],
  pushSubscriptions: ['keys'],
};
const TABLE_NAMES = {
  users: 'users', channels: 'channels', members: 'members', messages: 'messages',
  events: 'events', caseNotes: 'case_notes', expenses: 'expenses',
  checkins: 'checkins', auditLog: 'audit_log',
  whatsappLog: 'whatsapp_log', whatsappWebhookRaw: 'whatsapp_webhook_raw',
  certifiedExports: 'certified_exports', professionalApplications: 'professional_applications',
  moderationStats: 'moderation_stats', pushSubscriptions: 'push_subscriptions',
};

function rowToRecord(collectionKey, row) {
  const rec = { ...row };
  for (const col of BOOL_COLUMNS[collectionKey] || []) rec[col] = !!rec[col];
  for (const col of JSON_COLUMNS[collectionKey] || []) {
    try { rec[col] = rec[col] ? JSON.parse(rec[col]) : (col === 'professionalInvites' ? undefined : null); }
    catch (e) { rec[col] = null; }
  }
  return rec;
}
function recordToRow(collectionKey, rec) {
  const row = { ...rec };
  for (const col of BOOL_COLUMNS[collectionKey] || []) row[col] = row[col] ? 1 : 0;
  for (const col of JSON_COLUMNS[collectionKey] || []) {
    row[col] = row[col] != null ? JSON.stringify(row[col]) : null;
  }
  return row;
}

// agrega columnas nuevas a una tabla que ya existía de una versión anterior
// del esquema — CREATE TABLE IF NOT EXISTS no las suma sola en una base que
// ya está creada. Sin esto, un data.sqlite de producción de antes de sumar
// un campo se queda corto y explota en el primer INSERT.
function ensureColumns(sqlite, table, columns) {
  const existing = new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

function openDb() {
  const isNew = !fs.existsSync(SQLITE_PATH);
  const sqlite = new DatabaseSync(SQLITE_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec(SCHEMA);
  ensureColumns(sqlite, 'users', {
    aiUsage: 'TEXT', verifiedProfessional: 'INTEGER DEFAULT 0',
    verifiedProfessionalRole: 'TEXT', verifiedProfessionalOrg: 'TEXT',
  });
  ensureColumns(sqlite, 'channels', { remindedAt: 'INTEGER', lastSummary: 'TEXT', status: "TEXT DEFAULT 'abierto'" });
  if (isNew && fs.existsSync(LEGACY_JSON_PATH)) {
    migrateFromJson(sqlite, LEGACY_JSON_PATH);
  }
  return sqlite;
}

// migración de una sola vez: si aparece un data.sqlite nuevo pero ya existía
// un data.json de la versión anterior, lo importa entero antes de arrancar.
function migrateFromJson(sqlite, jsonPath) {
  console.log(`Migrando datos existentes de ${jsonPath} a SQLite (${SQLITE_PATH})...`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (e) {
    console.error('No se pudo leer el data.json existente para migrar — se arranca con base vacía.', e);
    return;
  }
  const tx = sqlite.exec.bind(sqlite);
  tx('BEGIN');
  try {
    for (const key of Object.keys(EMPTY_DB)) {
      const table = TABLE_NAMES[key];
      const list = Array.isArray(raw[key]) ? raw[key] : [];
      for (const rec of list) {
        insertRecord(sqlite, key, table, rec);
      }
    }
    tx('COMMIT');
    console.log(`Migración completa: ${Object.keys(EMPTY_DB).map((k) => `${k}=${(raw[k] || []).length}`).join(', ')}`);
  } catch (e) {
    tx('ROLLBACK');
    console.error('Error migrando data.json a SQLite, se revirtió todo:', e);
    throw e;
  }
}

function insertRecord(sqlite, collectionKey, table, rec) {
  const row = recordToRow(collectionKey, rec);
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);
  stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
}

function loadAllFromSqlite(sqlite) {
  const data = structuredClone(EMPTY_DB);
  for (const key of Object.keys(EMPTY_DB)) {
    const table = TABLE_NAMES[key];
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    data[key] = rows.map((r) => rowToRecord(key, r));
  }
  return data;
}

const sqlite = openDb();
let cache = loadAllFromSqlite(sqlite);

function getDB() {
  return cache;
}

// resincroniza TODO el estado en memoria a SQLite en una única transacción
// — más simple y más seguro que llevar el rastro de qué cambió desde el
// último commit, y a este volumen (miles de filas, no millones) el costo es
// insignificante. Lo importante es que ahora es atómico: si el proceso
// muere a mitad de camino, SQLite descarta la transacción entera y el
// archivo queda como estaba en el último commit exitoso — nunca a medias.
async function commit() {
  sqlite.exec('BEGIN');
  try {
    for (const key of Object.keys(EMPTY_DB)) {
      const table = TABLE_NAMES[key];
      sqlite.exec(`DELETE FROM ${table}`);
      for (const rec of cache[key]) {
        insertRecord(sqlite, key, table, rec);
      }
    }
    sqlite.exec('COMMIT');
  } catch (e) {
    sqlite.exec('ROLLBACK');
    console.error('Error guardando en SQLite, se descartó este commit:', e);
    throw e;
  }
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
