// scripts/regression-test-bloque52.js
// Bloque 52 — dos huecos encontrados al repasar el centro de Atención:
//  1) audiencia virtual próxima sin meetingUrl: antes solo se veía en la
//     pantalla de preparación de ESA audiencia puntual, nunca en el feed.
//  2) calendarSyncStatus==='error': antes completamente silencioso, el
//     pill "En tu Calendar" simplemente no aparecía (igual que si nunca
//     se hubiera intentado sincronizar).
// Motor puro, sin servidor — mismo criterio que la parte 1 de
// regression-test-bloque43.js.

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('Bloque 52 (huecos del centro de Atención) — motor puro\n');

const automationEngine = require('../automationEngine');
const { getHearingsWithModalityIssue, getHearingsWithCalendarSyncError, getDashboardAttentionItems } = automationEngine;

function fakeDb() {
  return {
    legalHolidays: [], parties: [], lawyers: [], partyNotifications: [], mediationDeadlineExtensions: [],
    hearings: [], mediations: [], tasks: [], commitments: [], documents: [], mediationEvents: [],
    attentionDismissals: [], channels: [], messages: [], hearingConfirmations: [], hearingRescheduleRequests: [],
  };
}

function baseMediation(id) {
  return { id, code: `MED-${id}`, status: 'en_mediacion', closedAt: null, nextActionText: 'Seguimiento', nextActionDueDate: null, createdAt: Date.now() - 1000 * 60 * 60 * 24 * 30, jurisdiction: null };
}

const inTwoDays = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString().slice(0, 10);
const inTenDays = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString().slice(0, 10);

// ---- 1. getHearingsWithModalityIssue ----
{
  const db = fakeDb();
  const m = baseMediation('m1');
  db.mediations.push(m);
  db.hearings.push({ id: 'h1', mediationId: 'm1', status: 'confirmada', date: inTwoDays, modality: 'virtual', location: null, meetingUrl: null });
  const out = getHearingsWithModalityIssue(db, m);
  check('1a. audiencia virtual sin meetingUrl se detecta', out.length === 1 && out[0].hearing.id === 'h1');
  check('1b. el issue es el mensaje de validateModalityData', /link de reuni/.test(out[0].issue), out[0].issue);
}
{
  const db = fakeDb();
  const m = baseMediation('m2');
  db.mediations.push(m);
  db.hearings.push({ id: 'h2', mediationId: 'm2', status: 'confirmada', date: inTwoDays, modality: 'virtual', location: null, meetingUrl: 'https://meet.example/abc' });
  check('1c. audiencia virtual CON meetingUrl no se marca', getHearingsWithModalityIssue(db, m).length === 0);
}
{
  const db = fakeDb();
  const m = baseMediation('m3');
  db.mediations.push(m);
  db.hearings.push({ id: 'h3', mediationId: 'm3', status: 'confirmada', date: inTwoDays, modality: 'presencial', location: 'Oficina', meetingUrl: null });
  check('1d. audiencia presencial nunca requiere meetingUrl', getHearingsWithModalityIssue(db, m).length === 0);
}
{
  const db = fakeDb();
  const m = baseMediation('m4');
  db.mediations.push(m);
  db.hearings.push({ id: 'h4', mediationId: 'm4', status: 'confirmada', date: yesterday, modality: 'virtual', location: null, meetingUrl: null });
  check('1e. audiencia virtual sin link PERO ya pasada no se marca (no es "próxima")', getHearingsWithModalityIssue(db, m).length === 0);
}
{
  const db = fakeDb();
  const m = baseMediation('m5');
  db.mediations.push(m);
  db.hearings.push({ id: 'h5', mediationId: 'm5', status: 'cancelada', date: inTwoDays, modality: 'virtual', location: null, meetingUrl: null });
  check('1f. audiencia cancelada no se marca aunque le falte el link', getHearingsWithModalityIssue(db, m).length === 0);
}

// ---- 2. getHearingsWithCalendarSyncError ----
{
  const db = fakeDb();
  const m = baseMediation('m6');
  db.mediations.push(m);
  db.hearings.push({ id: 'h6', mediationId: 'm6', status: 'programada', date: inTenDays, modality: 'presencial', calendarSyncStatus: 'error' });
  const out = getHearingsWithCalendarSyncError(db, m);
  check('2a. calendarSyncStatus=error se detecta', out.length === 1 && out[0].id === 'h6');
}
{
  const db = fakeDb();
  const m = baseMediation('m7');
  db.mediations.push(m);
  db.hearings.push({ id: 'h7', mediationId: 'm7', status: 'programada', date: inTenDays, modality: 'presencial', calendarSyncStatus: 'sincronizado' });
  check('2b. sincronizado OK no se marca', getHearingsWithCalendarSyncError(db, m).length === 0);
}
{
  const db = fakeDb();
  const m = baseMediation('m8');
  db.mediations.push(m);
  db.hearings.push({ id: 'h8', mediationId: 'm8', status: 'programada', date: inTenDays, modality: 'presencial', calendarSyncStatus: null });
  check('2c. nunca sincronizada (null, cuenta no conectada) no se marca como error', getHearingsWithCalendarSyncError(db, m).length === 0);
}

// ---- 3. integración con el feed combinado (buildAttentionItems vía getDashboardAttentionItems) ----
{
  const db = fakeDb();
  const m = baseMediation('m9');
  db.mediations.push(m);
  db.hearings.push(
    { id: 'h9a', mediationId: 'm9', status: 'confirmada', date: inTwoDays, modality: 'virtual', location: null, meetingUrl: null },
    { id: 'h9b', mediationId: 'm9', status: 'programada', date: inTenDays, modality: 'presencial', calendarSyncStatus: 'error' },
  );
  const items = getDashboardAttentionItems(db, [m]);
  const modalidadItem = items.find((i) => i.type === 'audienciaModalidadIncompleta');
  const syncItem = items.find((i) => i.type === 'audienciaSyncCalendarFallido');
  check('3a. el feed combinado incluye audienciaModalidadIncompleta', !!modalidadItem);
  check('3b. audiencia en 2 días con modalidad incompleta es prioridad crítica', modalidadItem && modalidadItem.priority === 'critico', modalidadItem && modalidadItem.priority);
  check('3c. el feed combinado incluye audienciaSyncCalendarFallido', !!syncItem);
  check('3d. ambos items apuntan a la mediación correcta', modalidadItem.mediationId === 'm9' && syncItem.mediationId === 'm9');
}

console.log(`\n${passed} OK, ${failed} FAIL`);
if (failed > 0) { console.log('\nFallaron:'); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
