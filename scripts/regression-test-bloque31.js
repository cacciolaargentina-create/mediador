// scripts/regression-test-bloque31.js
// Bloque 31 — "Diferencial competitivo" Fase 1. La mayor parte de la
// especificación (centro de atención, timeline, comunicaciones, portal de
// partes) ya existía de bloques anteriores; este script cubre SOLO lo que
// se agregó/tocó en este bloque:
//   - compromisos: notes/documentId (evidencia) + GET /api/mediations/commitments (cross-expediente, con filtros)
//   - tareas delegadas a una parte (assignedToPartyId) + completarlas desde el portal
//   - mensajes: campo `via` (medio de comunicación)
//   - centro de atención: campo `responsible`
//   - portal de partes: bloque de tareas propias + info del mediador
//
// Requiere: server con ENABLE_FAKE_LOGIN=1.
// Uso: node scripts/regression-test-bloque31.js [http://localhost:PORT]

const BASE = process.argv[2] || 'http://localhost:3099';

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

function cookieJar() {
  let cookie = null;
  return {
    async fetch(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch (e) {}
      return { status: res.status, body };
    },
  };
}
// el portal de partes no usa cookie de sesión — el token va en la URL.
async function portalFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { ...opts, headers });
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body };
}
async function login(email, name) {
  const jar = cookieJar();
  const r = await jar.fetch('/auth/fake-login', { method: 'POST', body: JSON.stringify({ email, name }) });
  if (r.status !== 200) throw new Error(`No se pudo loguear ${email}: ${JSON.stringify(r.body)}`);
  jar.userId = r.body.user.id;
  return jar;
}

(async function main() {
  console.log(`Bloque 31 (Diferencial competitivo — Fase 1) — tests contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || health.status >= 500) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const A = await login('b31-mediador-a@test.local', 'Mediador A');
  const B = await login('b31-mediador-b@test.local', 'Mediador B'); // cross-mediador

  // ---------- setup: mediación de A con una parte y un documento ----------
  const medA = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Test Bloque 31' }) })).body;
  const partyA = (await A.fetch(`/api/mediations/${medA.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Lucía', lastName: 'Pérez' }) })).body;
  const invite = (await A.fetch(`/api/mediations/${medA.id}/parties/${partyA.id}/invite`, { method: 'POST' })).body;
  const portalToken = invite.portalToken;
  check('setup: invitar a la parte devuelve portalToken', !!portalToken, JSON.stringify(invite));

  const minimalPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const form = new FormData();
  form.append('type', 'otro');
  form.append('file', new Blob([minimalPdf], { type: 'application/pdf' }), 'evidencia.pdf');
  const docA = (await A.fetch(`/api/mediations/${medA.id}/documents`, { method: 'POST', body: form })).body;

  // mediación de B, para los chequeos de aislamiento cross-mediador
  const medB = (await B.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Test Bloque 31 (B)' }) })).body;
  const partyB = (await B.fetch(`/api/mediations/${medB.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Bruno', lastName: 'Cruz' }) })).body;

  // ==================== 1. Compromisos: notes + documentId (evidencia) ====================
  const c1 = await A.fetch(`/api/mediations/${medA.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: partyA.id, description: 'Enviar comprobante de pago', dueDate: null, notes: 'Acordado en la audiencia del 1/1', documentId: docA.id }) });
  check('1. POST /commitments acepta notes + documentId de un documento real de la misma mediación', c1.status === 200 && c1.body.notes === 'Acordado en la audiencia del 1/1' && c1.body.documentId === docA.id, JSON.stringify(c1.body));
  check('1. La respuesta incluye el documento embebido (nombre/tipo, nunca storagePath)', c1.body.document && c1.body.document.originalFilename === 'evidencia.pdf' && !('storagePath' in c1.body.document));

  const c1CrossDoc = await A.fetch(`/api/mediations/${medA.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: partyA.id, description: 'Compromiso con doc ajeno', documentId: 'doc-inexistente-o-de-otra-mediacion' }) });
  check('1b. POST /commitments rechaza (400) un documentId que no pertenece a esta mediación', c1CrossDoc.status === 400);

  const c1Patch = await A.fetch(`/api/mediations/${medA.id}/commitments/${c1.body.id}`, { method: 'PATCH', body: JSON.stringify({ notes: 'Actualizado', documentId: null }) });
  check('1c. PATCH /commitments puede actualizar notes y limpiar documentId', c1Patch.status === 200 && c1Patch.body.notes === 'Actualizado' && c1Patch.body.documentId === null, JSON.stringify(c1Patch.body));

  const listPerExpediente = await A.fetch(`/api/mediations/${medA.id}/commitments`);
  check('1d. GET /:id/commitments (por expediente, ya existente) sigue funcionando con los campos nuevos', listPerExpediente.status === 200 && listPerExpediente.body.some((c) => c.id === c1.body.id && 'notes' in c && 'documentId' in c));

  // ==================== 2. Compromisos: vista global + filtros ====================
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const cOverdue = (await A.fetch(`/api/mediations/${medA.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: partyA.id, description: 'Compromiso vencido de prueba', dueDate: yesterday }) })).body;
  const cToday = (await A.fetch(`/api/mediations/${medA.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: partyA.id, description: 'Compromiso de hoy', dueDate: today }) })).body;
  const cUpcoming = (await A.fetch(`/api/mediations/${medA.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: partyA.id, description: 'Compromiso próximo', dueDate: nextWeek }) })).body;

  const globalAll = await A.fetch('/api/mediations/commitments');
  check('2. GET /api/mediations/commitments (sin filtro) devuelve 200 y lista', globalAll.status === 200 && Array.isArray(globalAll.body));
  check('2. Incluye los compromisos recién creados, con mediationCode y partyName', globalAll.body.some((c) => c.id === cOverdue.id && c.mediationCode === medA.code && c.partyName));

  const globalOverdue = await A.fetch('/api/mediations/commitments?status=vencidos');
  check('2b. Filtro vencidos incluye el compromiso vencido', globalOverdue.body.some((c) => c.id === cOverdue.id));
  check('2b. Filtro vencidos NO incluye el de hoy ni el próximo', !globalOverdue.body.some((c) => c.id === cToday.id || c.id === cUpcoming.id));

  const globalToday = await A.fetch('/api/mediations/commitments?status=hoy');
  check('2c. Filtro hoy incluye el compromiso de hoy', globalToday.body.some((c) => c.id === cToday.id));
  check('2c. Filtro hoy NO incluye el vencido de ayer', !globalToday.body.some((c) => c.id === cOverdue.id));

  const globalUpcoming = await A.fetch('/api/mediations/commitments?status=proximos');
  check('2d. Filtro próximos incluye el de la semana que viene', globalUpcoming.body.some((c) => c.id === cUpcoming.id));
  check('2d. Filtro próximos NO incluye el vencido', !globalUpcoming.body.some((c) => c.id === cOverdue.id));

  await A.fetch(`/api/mediations/${medA.id}/commitments/${cUpcoming.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cumplido' }) });
  const globalDone = await A.fetch('/api/mediations/commitments?status=cumplidos');
  check('2e. Filtro cumplidos refleja el cambio de estado', globalDone.body.some((c) => c.id === cUpcoming.id));

  const globalByParty = await A.fetch(`/api/mediations/commitments?partyId=${partyA.id}`);
  check('2f. Filtro por responsable (partyId) devuelve solo los de esa parte', globalByParty.body.length > 0 && globalByParty.body.every((c) => c.partyId === partyA.id));

  // ---- aislamiento cross-mediador ----
  const cB = (await B.fetch(`/api/mediations/${medB.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: partyB.id, description: 'Compromiso de B', dueDate: yesterday }) })).body;
  const globalA2 = await A.fetch('/api/mediations/commitments');
  check('2g. La vista global de A no incluye compromisos de B', !globalA2.body.some((c) => c.id === cB.id));
  const globalB = await B.fetch('/api/mediations/commitments');
  check('2g. La vista global de B no incluye compromisos de A', !globalB.body.some((c) => c.id === cOverdue.id));

  const anonCommitments = await fetch(BASE + '/api/mediations/commitments');
  check('2h. Sin sesión, GET /api/mediations/commitments devuelve 401', anonCommitments.status === 401);

  // ==================== 3. Tareas delegadas a una parte ====================
  const taskCrossParty = await A.fetch(`/api/mediations/${medA.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Tarea con parte ajena', assignedToPartyId: partyB.id }) });
  check('3a. POST /tasks rechaza (400) una parte que no pertenece a esta mediación', taskCrossParty.status === 400);

  const taskForParty = (await A.fetch(`/api/mediations/${medA.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Enviar comprobante de domicilio', assignedToPartyId: partyA.id }) })).body;
  check('3b. POST /tasks acepta assignedToPartyId de una parte real de la mediación', taskForParty.assignedToPartyId === partyA.id);

  const taskForMediator = (await A.fetch(`/api/mediations/${medA.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Tarea interna del equipo' }) })).body;
  check('3c. Una tarea sin assignedToPartyId sigue siendo del equipo mediador (assignedToPartyId null)', taskForMediator.assignedToPartyId === null);

  // ==================== 4. Portal de partes: tareas + mediador ====================
  const portalView = await portalFetch(`/api/party-portal/${portalToken}`);
  check('4a. GET /:token incluye info del mediador (nombre)', portalView.status === 200 && !!portalView.body.mediator && !!portalView.body.mediator.name);
  check('4b. GET /:token incluye SOLO las tareas delegadas a ESTA parte', portalView.body.tasks.some((t) => t.id === taskForParty.id) && !portalView.body.tasks.some((t) => t.id === taskForMediator.id));

  const completeOk = await portalFetch(`/api/party-portal/${portalToken}/tasks/${taskForParty.id}/complete`, { method: 'POST' });
  check('4c. La parte puede marcar su propia tarea como realizada', completeOk.status === 200 && completeOk.body.status === 'completada');

  const completeInternal = await portalFetch(`/api/party-portal/${portalToken}/tasks/${taskForMediator.id}/complete`, { method: 'POST' });
  check('4d. La parte NO puede completar una tarea interna del equipo mediador (404)', completeInternal.status === 404);

  const taskFromOtherMediation = await portalFetch(`/api/party-portal/${portalToken}/tasks/${taskCrossParty.body?.id || 'x'}/complete`, { method: 'POST' });
  check('4e. La parte no puede completar una tarea inexistente/ajena (404, nunca 200)', taskFromOtherMediation.status === 404);

  const timelineAfterComplete = await A.fetch(`/api/mediations/${medA.id}/timeline?type=TASK_COMPLETED`);
  check('4f. Completar la tarea desde el portal queda en el timeline (TASK_COMPLETED)', timelineAfterComplete.body.some((e) => e.entityId === taskForParty.id));

  // ==================== 5. Mensajes: campo `via` ====================
  const chatMsg = await A.fetch(`/api/mediations/${medA.id}/parties/${partyA.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Hola, ¿cómo estás?' }) });
  check('5. Un mensaje de chat normal trae via:"interno"', chatMsg.status === 200 && chatMsg.body.via === 'interno', JSON.stringify(chatMsg.body));

  // ==================== 6. Centro de atención: campo `responsible` ====================
  const dashA = await A.fetch('/api/mediations/dashboard');
  const overdueItem = dashA.body.centroAtencion.find((it) => it.type === 'compromisoVencido' && it.refId === cOverdue.id);
  check('6. El centro de atención trae "responsible" en un compromiso vencido, con el nombre de la parte', !!overdueItem && overdueItem.responsible === 'Lucía Pérez', JSON.stringify(overdueItem));

  console.log(`\n${passed} OK, ${failed} FAIL`);
  if (failed) { console.log('\nFallaron:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
