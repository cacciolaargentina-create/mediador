// scripts/regression-test-bloque26-jobs.js
// Bloque 26 §2 — tests directos de checkHearingsStartingSoon() (jobs.js),
// sin pasar por HTTP: arma mediación/parte/hilo/audiencia a mano contra una
// DB descartable propia (mismo patrón que
// regression-test-bloque22-automation-engine.js), corre el job, e inspecciona
// los mensajes posteados. Cubre el test obligatorio 7 (idempotencia) y las
// reglas de "cuándo NO alertar" del §3.
//
// Requiere SQLITE_PATH propio (se setea acá mismo, no depende del server).

const path = require('path');
process.env.SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'test-b26-jobs.sqlite');

const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { checkHearingsStartingSoon } = require('../jobs');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

// io falso — postSystemMessage solo usa io.to(code).emit(...) para el
// realtime; acá no hay sockets reales conectados, así que un no-op alcanza.
const fakeIo = { to: () => ({ emit: () => {} }) };

function makeMediationWithParty(db, { mediatorUserId, withThread = true }) {
  const now = Date.now();
  const mediation = {
    id: nanoid(), code: `TEST-${nanoid(6)}`, internalNumber: null, mediatorUserId, channelId: null,
    type: null, object: 'Mediación de test — Bloque 26', description: null, status: 'iniciada',
    nextActionText: null, nextActionResponsibleType: null, nextActionResponsibleId: null, nextActionDueDate: null,
    closedAt: null, closedResult: null, closedNotes: null, createdAt: now,
  };
  db.mediations.push(mediation);
  const party = {
    id: nanoid(), mediationId: mediation.id, type: 'persona', role: 'requirente',
    firstName: 'Parte', lastName: 'Test', status: 'activa', linkedUserId: null,
    allowDocumentUpload: true, createdAt: now,
  };
  db.parties.push(party);
  let thread = null;
  if (withThread) {
    const partyUser = { id: nanoid(), googleId: null, email: '', phone: '', name: 'Parte Test', avatar: '', guest: true, createdAt: now };
    db.users.push(partyUser);
    party.linkedUserId = partyUser.id;
    thread = { id: nanoid(), code: nanoid(8), guestToken: null, calendarToken: nanoid(24), status: 'abierto', mediationId: mediation.id, partyId: party.id, createdAt: now };
    db.channels.push(thread);
    db.members.push({ id: nanoid(), channelId: thread.id, userId: mediatorUserId, role: 'mediador', joinedAt: now });
    db.members.push({ id: nanoid(), channelId: thread.id, userId: partyUser.id, role: 'parte', joinedAt: now });
  }
  return { mediation, party, thread };
}

function todayAt(minutesFromNow) {
  const t = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const date = t.toISOString().slice(0, 10);
  const startTime = t.toTimeString().slice(0, 5);
  return { date, startTime };
}

function makeHearing(db, mediationId, overrides) {
  const { minutesFromNow, ...rest } = overrides;
  const { date, startTime } = todayAt(minutesFromNow);
  const hearing = {
    id: nanoid(), mediationId, date, startTime, endTime: null,
    type: 'primera', modality: 'virtual', location: null, meetingUrl: 'https://meet.example.com/test',
    status: 'programada', notes: null, proposalGroupId: null, targetPartyId: null,
    lastModifiedBy: null, lastModifiedAt: null, createdAt: Date.now(), startAlertSentAt: null,
    ...rest,
  };
  db.hearings.push(hearing);
  return hearing;
}

(async function main() {
  console.log('Bloque 26 §2 — tests directos de checkHearingsStartingSoon()\n');
  const db = getDB();
  const now = Date.now();
  const mediatorUser = { id: nanoid(), googleId: 'g1', email: 'mediador-test@test.local', name: 'Mediador Test', avatar: '', guest: false, createdAt: now };
  db.users.push(mediatorUser);

  // ==== escenario 1: dentro de la ventana (12 min antes), virtual, programada, con hilo → SÍ alerta ====
  const s1 = makeMediationWithParty(db, { mediatorUserId: mediatorUser.id });
  const h1 = makeHearing(db, s1.mediation.id, { minutesFromNow: 12 });

  // ==== escenario 2: demasiado temprano (45 min antes) → NO alerta ====
  const s2 = makeMediationWithParty(db, { mediatorUserId: mediatorUser.id });
  const h2 = makeHearing(db, s2.mediation.id, { minutesFromNow: 45 });

  // ==== escenario 3: demasiado tarde / ya casi empezando (2 min antes) → NO alerta (eso lo cubre el banner, no este job) ====
  const s3 = makeMediationWithParty(db, { mediatorUserId: mediatorUser.id });
  const h3 = makeHearing(db, s3.mediation.id, { minutesFromNow: 2 });

  // ==== escenario 4: presencial (sin link real de reunión) → nunca alerta aunque el horario califique ====
  const s4 = makeMediationWithParty(db, { mediatorUserId: mediatorUser.id });
  const h4 = makeHearing(db, s4.mediation.id, { minutesFromNow: 12, modality: 'presencial', meetingUrl: null });

  // ==== escenario 5: cancelada → nunca alerta aunque el horario califique ====
  const s5 = makeMediationWithParty(db, { mediatorUserId: mediatorUser.id });
  const h5 = makeHearing(db, s5.mediation.id, { minutesFromNow: 12, status: 'cancelada' });

  // ==== escenario 6: dentro de ventana pero la parte NUNCA fue invitada al portal (sin hilo) → no debe romper, no postea nada ====
  const s6 = makeMediationWithParty(db, { mediatorUserId: mediatorUser.id, withThread: false });
  const h6 = makeHearing(db, s6.mediation.id, { minutesFromNow: 12 });

  await commit();

  const messagesBefore = db.messages.length;
  const run1 = await checkHearingsStartingSoon(fakeIo);

  check('escenario 1: audiencia dentro de la ventana queda marcada como alertada', !!db.hearings.find((h) => h.id === h1.id).startAlertSentAt);
  check('escenario 1: se posteó un mensaje de sistema en el hilo de la parte', db.messages.some((m) => m.channelId === s1.thread.id && m.senderId === null && m.text.includes(h1.meetingUrl)));

  check('escenario 2: audiencia demasiado temprano NO se alerta todavía', !db.hearings.find((h) => h.id === h2.id).startAlertSentAt);
  check('escenario 3: audiencia a 2 min (fuera de ventana por el otro lado) NO se alerta', !db.hearings.find((h) => h.id === h3.id).startAlertSentAt);
  check('escenario 4: audiencia presencial nunca se alerta aunque el horario califique', !db.hearings.find((h) => h.id === h4.id).startAlertSentAt);
  check('escenario 5: audiencia cancelada nunca se alerta aunque el horario califique', !db.hearings.find((h) => h.id === h5.id).startAlertSentAt);

  check('escenario 6: audiencia sin ninguna parte con hilo queda marcada (nunca reintenta) pero no postea nada', !!db.hearings.find((h) => h.id === h6.id).startAlertSentAt && run1.messagesPosted === 1);

  // ==== 7. idempotencia — correr el job de nuevo no debe volver a postear en h1 ====
  const messagesAfterRun1 = db.messages.length;
  const run2 = await checkHearingsStartingSoon(fakeIo);
  const messagesAfterRun2 = db.messages.length;
  check('7. idempotencia: la segunda corrida no postea un segundo mensaje para la misma audiencia', messagesAfterRun2 === messagesAfterRun1, `run1 total=${messagesAfterRun1} run2 total=${messagesAfterRun2}`);
  check('7(b). idempotencia: la segunda corrida no marca ninguna audiencia nueva (ya estaban todas resueltas)', run2.hearingsAlerted === 0, JSON.stringify(run2));

  // ==== aislamiento: el mensaje de la mediación 1 nunca llega al hilo de otra mediación ====
  const otherThreadMessages = db.messages.filter((m) => m.channelId !== s1.thread.id && m.senderId === null && m.text.includes(h1.meetingUrl));
  check('aislamiento: el mensaje de la audiencia de la mediación 1 no aparece en ningún otro hilo', otherThreadMessages.length === 0);

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
