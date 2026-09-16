// scripts/regression-test-bloque22-jobs.js
// Bloque 22 (Parte 1) — verifica checkMediationDeadlines() directamente,
// sin pasar por HTTP: es un job periódico (setInterval en server.js), no
// un endpoint, así que no hay otra forma real de probar el escalamiento
// de 3 días ni el digest sin manipular timestamps a mano.
//
// A diferencia de regression-test-bloque22.js, este script NO habla con
// un servidor levantado — corre en el mismo proceso, contra el mismo
// SQLITE_PATH que use el servidor de prueba (o uno propio si no hay
// ninguno corriendo). Requiere que ya exista al menos una mediación con
// una parte y un compromiso vencido con status 'pendiente' — si no
// encuentra ninguna, crea una de cero para no depender de otro script.
//
// Uso:
//   SQLITE_PATH=/tmp/b22.sqlite node scripts/regression-test-bloque22-jobs.js

const { getDB, commit } = require('../db');
const { checkMediationDeadlines } = require('../jobs');
const { nanoid } = require('nanoid');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

function makeMediationWithOverdueCommitment(db, mediatorUserId, codeSuffix) {
  const mediation = {
    id: nanoid(), code: `MED-TEST-JOBS-${codeSuffix}`, internalNumber: null, mediatorUserId, channelId: null,
    type: 'familiar', object: `Mediación jobs test ${codeSuffix}`, description: null, status: 'iniciada',
    nextActionText: null, nextActionResponsibleType: null, nextActionResponsibleId: null, nextActionDueDate: null,
    closedAt: null, closedResult: null, closedNotes: null, createdAt: Date.now(),
  };
  db.mediations.push(mediation);
  const party = { id: nanoid(), mediationId: mediation.id, type: 'persona', role: 'requirente', firstName: 'Test', lastName: codeSuffix, status: 'activa', createdAt: Date.now() };
  db.parties.push(party);
  const commitment = {
    id: nanoid(), mediationId: mediation.id, partyId: party.id, description: `Compromiso vencido ${codeSuffix}`,
    dueDate: '2020-01-01', status: 'pendiente', createdFromEventId: null, completedAt: null, createdAt: Date.now(),
  };
  db.commitments.push(commitment);
  return { mediation, party, commitment };
}

(async function main() {
  const db = getDB();
  const mediatorUser = { id: nanoid(), googleId: null, email: `b22-jobs-mediator-${nanoid(6)}@test.local`, name: 'Mediador Jobs Test', avatar: '', phone: null, guest: false, createdAt: Date.now() };
  db.users.push(mediatorUser);
  await commit();

  console.log('== Parte 1.1: compromiso vencido notifica también a la parte ==');
  const { mediation, party, commitment } = makeMediationWithOverdueCommitment(db, mediatorUser.id, 'A');
  await commit();
  const r1 = await checkMediationDeadlines();
  check('el compromiso pasó a vencido', db.commitments.find((c) => c.id === commitment.id).status === 'vencido');
  const partyLogAfterFirstRun = db.whatsappLog.filter((w) => w.partyId === party.id);
  check('se registró un intento de notificación a LA PARTE (whatsappLog con partyId)', partyLogAfterFirstRun.length >= 1, JSON.stringify(partyLogAfterFirstRun));

  console.log('\n== Parte 1.2: escalamiento a los 3 días de fallos consecutivos ==');
  partyLogAfterFirstRun.forEach((e) => { e.createdAt = Date.now() - (4 * 24 * 60 * 60 * 1000); });
  await commit();
  const r2 = await checkMediationDeadlines();
  const escalations = db.mediationEvents.filter((e) => e.type === 'PARTY_CONTACT_ESCALATION' && e.entityId === party.id);
  check('se registró exactamente 1 escalamiento tras 3+ días de fallos', escalations.length === 1, `contactEscalationsLogged=${r2.contactEscalationsLogged}, eventos=${escalations.length}`);
  const r3 = await checkMediationDeadlines();
  const escalationsAfterThirdRun = db.mediationEvents.filter((e) => e.type === 'PARTY_CONTACT_ESCALATION' && e.entityId === party.id);
  check('el escalamiento NUNCA se repite para el mismo fallo (sigue en 1 tras una 3ra corrida)', escalationsAfterThirdRun.length === 1, `contactEscalationsLogged en 3ra corrida=${r3.contactEscalationsLogged}`);

  console.log('\n== Parte 1.3: digest agrupado (opt-in, default sin cambios) ==');
  check("el mediador de prueba arrancó con notificationDigest en 'none' o vacío (default, sin cambio de comportamiento)", !mediatorUser.notificationDigest || mediatorUser.notificationDigest === 'none');
  mediatorUser.notificationDigest = 'daily';
  const { commitment: commitmentB } = makeMediationWithOverdueCommitment(db, mediatorUser.id, 'B');
  await commit();
  const r4 = await checkMediationDeadlines();
  check('con digest activado, el compromiso igual pasa a vencido (el digest no cambia la transición de estado)', db.commitments.find((c) => c.id === commitmentB.id).status === 'vencido');
  check('con digest activado, se contabilizó al menos 1 digest enviado', r4.digestsSent >= 1, `digestsSent=${r4.digestsSent}`);

  console.log(`\n${passed} pasaron, ${failed} fallaron.`);
  if (failed > 0) { console.log('\nFallidas:', failures.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('Error ejecutando las pruebas:', e); process.exit(1); });
