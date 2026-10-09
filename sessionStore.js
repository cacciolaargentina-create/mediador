// sessionStore.js
// Bloque 56 — store de express-session respaldado en SQLite (node:sqlite,
// nativo de Node, sin dependencias npm nuevas) en vez del MemoryStore por
// default. Antes, cada reinicio de pm2 (cada deploy) desloguea a TODO el
// mundo — las sesiones solo vivían en la RAM del proceso que se reemplaza.
//
// Usa su PROPIO archivo SQLite, separado de data.sqlite, a propósito: acá
// el patrón de acceso es completamente distinto al del resto de la app.
// db.js (ver comentario ahí) resincroniza TABLAS ENTERAS en cada commit()
// — perfecto para datos de negocio que cambian de a poco, pésimo para
// sesiones, que se leen/tocan en CADA request. Si las sesiones vivieran
// en data.sqlite bajo ese mismo patrón, cada commit() de cualquier otra
// cosa (crear una tarea, mandar un mensaje, lo que sea) reescribiría
// también la tabla entera de sesiones activas. Acá cada operación es una
// sola fila, con su propia conexión — no interfiere con nada más.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('express-session');

const SESSIONS_SQLITE_PATH = process.env.SESSIONS_SQLITE_PATH || path.join(__dirname, 'sessions.sqlite');

const sqlite = new DatabaseSync(SESSIONS_SQLITE_PATH);
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt);
`);

const stmtGet = sqlite.prepare('SELECT data, expiresAt FROM sessions WHERE sid = ?');
const stmtSet = sqlite.prepare(
  'INSERT INTO sessions (sid, data, expiresAt) VALUES (?, ?, ?) ' +
  'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expiresAt = excluded.expiresAt'
);
const stmtDestroy = sqlite.prepare('DELETE FROM sessions WHERE sid = ?');
const stmtTouch = sqlite.prepare('UPDATE sessions SET expiresAt = ? WHERE sid = ?');
const stmtAll = sqlite.prepare('SELECT data FROM sessions WHERE expiresAt > ?');
const stmtClear = sqlite.prepare('DELETE FROM sessions');
const stmtLength = sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expiresAt > ?');
const stmtPurgeExpired = sqlite.prepare('DELETE FROM sessions WHERE expiresAt <= ?');

// Mismo default que documenta express-session cuando una sesión no trae
// su propio cookie.expires (sesión de navegador, sin maxAge): 24hs.
function expiryOf(sess) {
  if (sess && sess.cookie && sess.cookie.expires) return new Date(sess.cookie.expires).getTime();
  return Date.now() + 1000 * 60 * 60 * 24;
}

class SqliteSessionStore extends Store {
  get(sid, cb) {
    try {
      const row = stmtGet.get(sid);
      if (!row || row.expiresAt <= Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      stmtSet.run(sid, JSON.stringify(sess), expiryOf(sess));
      if (cb) cb(null);
    } catch (e) { if (cb) cb(e); }
  }

  destroy(sid, cb) {
    try {
      stmtDestroy.run(sid);
      if (cb) cb(null);
    } catch (e) { if (cb) cb(e); }
  }

  touch(sid, sess, cb) {
    try {
      stmtTouch.run(expiryOf(sess), sid);
      if (cb) cb(null);
    } catch (e) { if (cb) cb(e); }
  }

  all(cb) {
    try {
      cb(null, stmtAll.all(Date.now()).map((r) => JSON.parse(r.data)));
    } catch (e) { cb(e); }
  }

  clear(cb) {
    try { stmtClear.run(); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
  }

  length(cb) {
    try { cb(null, stmtLength.get(Date.now()).n); } catch (e) { cb(e); }
  }
}

// SQLite no tiene TTL nativo — las filas vencidas no desaparecen solas.
// Se purgan cada una hora; no hace falta que sea frecuente ni exacto,
// get() ya ignora cualquier fila vencida aunque todavía no se haya borrado.
setInterval(() => {
  try { stmtPurgeExpired.run(Date.now()); } catch (e) { console.error('Error purgando sesiones vencidas:', e); }
}, 1000 * 60 * 60).unref();

module.exports = { SqliteSessionStore };
