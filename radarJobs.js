// radarJobs.js
// Bloque 25 — scheduler del radar competitivo. Mismo criterio que jobs.js
// ("alcanza con setInterval para este volumen, no hace falta un scheduler
// dedicado"), pero en su propio archivo porque es un dominio totalmente
// aparte de las mediaciones — no tiene sentido mezclarlo en jobs.js.

const { getDB, commit } = require('./db');
const radarScraper = require('./radarScraper');
const radarEngine = require('./radarEngine');

const FREQUENCY_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
// espaciar los chequeos DENTRO de una misma corrida — el rate limit por
// dominio ya vive en radarScraper, esto además evita lanzar N fetches en
// paralelo desde nuestro propio proceso en cada corrida del scheduler.
const BETWEEN_SOURCES_DELAY_MS = 2000;

function isDue(source, now) {
  if (!source.active || source.checkFrequency === 'manual') return false;
  if (!source.lastCheckedAt) return true;
  const intervalMs = FREQUENCY_MS[source.checkFrequency] || FREQUENCY_MS.weekly;
  return now - source.lastCheckedAt >= intervalMs;
}

// Idempotente por diseño (§24 test 16): una fuente recién chequeada dentro
// de su ventana deja de ser "due", así que correr esto dos veces seguidas no
// vuelve a golpear el mismo sitio ni duplica cambios — y si el contenido no
// cambió, applyCheckResult tampoco genera una fila de cambio nueva.
async function checkDueSources() {
  const db = getDB();
  const now = Date.now();
  const due = db.competitorSources.filter((s) => isDue(s, now));
  let checked = 0, changed = 0, failed = 0;
  for (let i = 0; i < due.length; i++) {
    const source = due[i];
    try {
      const scraperResult = await radarScraper.checkSource(source);
      const result = radarEngine.applyCheckResult(db, source, scraperResult, Date.now());
      checked++;
      if (result.changed) changed++;
      if (!result.ok) failed++;
    } catch (e) {
      failed++;
      console.error(`Radar: error chequeando "${source.name}" (${source.url}):`, e.message);
    }
    if (i < due.length - 1) await new Promise((r) => setTimeout(r, BETWEEN_SOURCES_DELAY_MS));
  }
  if (checked > 0) await commit();
  return { total: due.length, checked, changed, failed };
}

module.exports = { checkDueSources, isDue, FREQUENCY_MS };
