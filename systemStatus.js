// systemStatus.js
// Bloque 27 — tracker de estado de jobs y errores recientes, EN MEMORIA
// (se resetea al reiniciar el proceso, y eso se documenta a propósito, no
// se simula persistencia que no existe). No hay hoy ninguna infraestructura
// de logging/errores consultable — antes de este bloque, un fallo de job
// solo se veía en console.error del proceso. Esto no reemplaza los logs de
// PM2: es un resumen liviano para el Admin Console ("¿está todo
// funcionando?"), sin leer archivos de log ni depender del sistema
// operativo del servidor.

const MAX_ERRORS = 200;

const jobStatuses = new Map(); // name -> { lastRunAt, lastOkAt, lastErrorAt, lastError, lastResult }
const recentErrors = []; // [{ at, source, message }] — más nuevo al final

function recordJobRun(name, { ok, result, error }) {
  const now = Date.now();
  const prev = jobStatuses.get(name) || {};
  const next = {
    lastRunAt: now,
    lastOkAt: ok ? now : (prev.lastOkAt || null),
    lastErrorAt: ok ? (prev.lastErrorAt || null) : now,
    lastError: ok ? (prev.lastError || null) : String(error),
    lastResult: ok ? (result || null) : (prev.lastResult || null),
  };
  jobStatuses.set(name, next);
  if (!ok) recordError(`job:${name}`, String(error));
}

function recordError(source, message) {
  recentErrors.push({ at: Date.now(), source, message: String(message).slice(0, 500) });
  if (recentErrors.length > MAX_ERRORS) recentErrors.splice(0, recentErrors.length - MAX_ERRORS);
}

function getJobStatuses() {
  return Object.fromEntries(jobStatuses.entries());
}

function getRecentErrors(limit = 50) {
  return recentErrors.slice(-limit).reverse();
}

module.exports = { recordJobRun, recordError, getJobStatuses, getRecentErrors };
