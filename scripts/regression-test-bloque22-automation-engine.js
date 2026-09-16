// scripts/regression-test-bloque22-automation-engine.js
// Bloque 22 (Automatización) — pruebas directas sobre automationEngine.js
// para lo que no se puede probar por HTTP sin esperar tiempo real:
// mediación inactiva (createdAt/última actividad hace N días) y su
// "descartar alerta". Mismo criterio que regression-test-bloque22-jobs.js
// para la Parte 1 (acceso directo a getDB()/commit(), sin servidor).
//
// Uso: SQLITE_PATH=/tmp/x.sqlite node scripts/regression-test-bloque22-automation-engine.js

const { getDB, commit } = require('../db');
const automationEngine = require('../automationEngine');
const { nanoid } = require('nanoid');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

(async function main() {
  const db = getDB();
  const DAY = 24 * 60 * 60 * 1000;

  console.log('== 15. mediación inactiva (createdAt hace 30 días, sin eventos ni mensajes) ==');
  const mediation = {
    id: nanoid(), code: 'MED-TEST-INACTIVE', internalNumber: null, mediatorUserId: nanoid(), channelId: null,
    type: 'familiar', object: 'Mediación inactiva test', description: null, status: 'iniciada',
    nextActionText: 'algo', nextActionResponsibleType: 'mediador', nextActionResponsibleId: null, nextActionDueDate: null,
    closedAt: null, closedResult: null, closedNotes: null, createdAt: Date.now() - 30 * DAY,
    inactivityThresholdDays: 21,
  };
  db.mediations.push(mediation);
  await commit();

  let inactive = automationEngine.getInactiveMediations(db, [mediation]);
  check('mediación con 30 días sin actividad y umbral de 21 -> aparece como inactiva', inactive.length === 1 && inactive[0].mediation.id === mediation.id, JSON.stringify(inactive.map((i) => i.mediation.id)));

  const recentMediation = { ...mediation, id: nanoid(), code: 'MED-TEST-RECENT', createdAt: Date.now() - 5 * DAY };
  db.mediations.push(recentMediation);
  await commit();
  const inactiveRecent = automationEngine.getInactiveMediations(db, [recentMediation]);
  check('mediación con 5 días (bajo el umbral de 21) -> NO aparece como inactiva', inactiveRecent.length === 0, JSON.stringify(inactiveRecent));

  console.log('\n== 15(b). descartar la alerta de inactividad ==');
  const dismissAt = Date.now();
  db.attentionDismissals.push({ id: nanoid(), mediationId: mediation.id, alertType: 'mediacionInactiva', refId: mediation.id, dismissedBy: nanoid(), dismissedAt: dismissAt });
  await commit();
  const afterDismiss = automationEngine.getInactiveMediations(db, [mediation]);
  check('tras descartar, ya no aparece (mismo período de inactividad)', afterDismiss.length === 0, JSON.stringify(afterDismiss));

  console.log('\n== 15(c). la alerta vuelve a aparecer si hay actividad NUEVA después del descarte, y esa actividad nueva vuelve a superar el umbral con el tiempo ==');
  // actividad real DESPUÉS del momento del descarte (a diferencia de "no
  // pasó nada" en 15(b)) — simula, ej., que llegó un mensaje justo
  // después de descartar la alerta. El descarte cubre la inactividad DE
  // ESE MOMENTO, no una inactividad futura distinta.
  const newActivityAt = dismissAt + 1000;
  db.mediationEvents.push({ id: nanoid(), mediationId: mediation.id, type: 'TASK_CREATED', actorId: null, visibility: 'public', entityType: null, entityId: null, title: 'x', description: null, metadata: null, causedByEventId: null, createdAt: newActivityAt });
  await commit();
  const rightAfter = automationEngine.getInactiveMediations(db, [mediation], newActivityAt + 1000);
  check('justo después de la actividad nueva, ya no está inactiva (obvio: acaba de pasar algo)', rightAfter.length === 0, JSON.stringify(rightAfter));
  // simulamos el paso de 22 días MÁS desde esa actividad nueva (pasando
  // "now" como parámetro — no se puede esperar 22 días de verdad en un test)
  const muchLater = newActivityAt + 22 * DAY;
  const afterMoreTimePasses = automationEngine.getInactiveMediations(db, [mediation], muchLater);
  check('22 días después de la actividad nueva (posterior al descarte), vuelve a aparecer inactiva', afterMoreTimePasses.length === 1, JSON.stringify(afterMoreTimePasses));

  console.log(`\n${passed} pasaron, ${failed} fallaron.`);
  if (failed > 0) { console.log('\nFallidas:', failures.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('Error ejecutando las pruebas:', e); process.exit(1); });
