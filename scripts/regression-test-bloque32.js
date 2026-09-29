// scripts/regression-test-bloque32.js
// Bloque 32 — cierre de 4 brechas encontradas en la auditoría de
// diferencial competitivo (docs/AUDITORIA_DIFERENCIAL.md):
//   1. aviso automático al invitar a una parte/abogado (antes: nada)
//   2. revisión de documentos con comentario obligatorio al observar
//   3. pantalla de preparación de audiencia (detalle nombrado, no solo el checklist)
//   4. entitlements advancedAgenda/maxStudyMembers/maxAssistants, antes definidos y nunca aplicados
//
// Requiere: server con ENABLE_FAKE_LOGIN=1 Y BILLING_ENFORCE_IN_TEST=1 —
// sin el segundo flag, billingPaywallActive() apaga TODO el paywall a
// propósito (para no romper bloque22/22-automation/24), y la sección 4
// (entitlements) daría falso positivo. Mismo criterio que
// regression-test-bloque29-paywall.js — correr en su propio server,
// NUNCA en el 3099 compartido del resto de la batería. Sin WHATSAPP_TOKEN
// configurado en el entorno de test (lo normal) — eso es justo lo que
// permite probar el camino "no se pudo avisar" de forma determinística en
// los dos casos (sin teléfono / con teléfono pero WhatsApp no
// configurado), ver el fix en whatsapp.js callGraphAPI (antes devolvía
// éxito fantasma).
//
// Uso:
//   SQLITE_PATH=/tmp/b32.sqlite ENABLE_FAKE_LOGIN=1 BILLING_ENFORCE_IN_TEST=1 PORT=3098 node server.js &
//   node scripts/regression-test-bloque32.js http://localhost:3098

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

// ==================== 4 (motor). entitlements.js puro, sin servidor ====================
// Mismo patrón que regression-test-bloque29-engine.js — entitlements.js no
// importa db.js, así que esto corre standalone, sin tocar ninguna base.
function testEntitlementsEngine() {
  const { canUseAdvancedAgenda, canAddStudyMember, canAddAssistant } = require('../entitlements');
  const fakeUserFree = { id: 'u1' };
  const fakeUserPro = { id: 'u2' };
  const dbFree = { billingAccounts: [], mediations: [], mediationAccess: [], users: [{ id: 'u2', studioId: null }] };
  const dbPro = { billingAccounts: [{ userId: 'u2', planCode: 'PROFESIONAL', status: 'active' }], mediations: [], mediationAccess: [], users: [{ id: 'u2', studioId: null }] };

  check('4-motor. FREE: canUseAdvancedAgenda = false', canUseAdvancedAgenda(dbFree, fakeUserFree) === false);
  check('4-motor. PROFESIONAL: canUseAdvancedAgenda = true', canUseAdvancedAgenda(dbPro, fakeUserPro) === true);

  const dbStudioFree = { billingAccounts: [], users: [{ id: 'owner', studioId: 's1' }] };
  check('4-motor. Estudio FREE con 1 miembro: canAddStudyMember = false (límite ya alcanzado)', canAddStudyMember(dbStudioFree, fakeUserFree, 's1') === false);
  const dbStudioPro = { billingAccounts: [{ studioId: 's1', planCode: 'ESTUDIO', status: 'active' }], users: [{ id: 'owner', studioId: 's1' }] };
  check('4-motor. Estudio con plan ESTUDIO: canAddStudyMember = true (ilimitado)', canAddStudyMember(dbStudioPro, fakeUserFree, 's1') === true);

  // Bloque 33 — canAddAssistant se redefinió para contar miembros del
  // ESTUDIO con studioRole==='asistente' (nunca asignaciones puntuales de
  // mediationAccess, que era el modelo viejo e inalcanzable en la
  // práctica — ver el comentario en entitlements.js). El plan se resuelve
  // siempre por studioId, nunca por userId.
  const dbAssistFree = { billingAccounts: [], users: [{ id: 'owner', studioId: 's1' }] };
  check('4-motor. FREE: canAddAssistant = false (maxAssistants=0)', canAddAssistant(dbAssistFree, fakeUserFree, 's1') === false);
  const dbAssistPro = { billingAccounts: [{ studioId: 's1', planCode: 'PROFESIONAL', status: 'active' }], users: [{ id: 'owner', studioId: 's1' }] };
  check('4-motor. PROFESIONAL sin asistentes todavía: canAddAssistant = true (0 < 1)', canAddAssistant(dbAssistPro, fakeUserFree, 's1') === true);
  const dbAssistProFull = { billingAccounts: [{ studioId: 's1', planCode: 'PROFESIONAL', status: 'active' }], users: [{ id: 'owner', studioId: 's1' }, { id: 'asist1', studioId: 's1', studioRole: 'asistente' }] };
  check('4-motor. PROFESIONAL con 1 asistente ya asignado: canAddAssistant = false (1 < 1 es falso)', canAddAssistant(dbAssistProFull, fakeUserFree, 's1') === false);
}

(async function main() {
  console.log(`Bloque 32 (cierre de brechas) — tests contra ${BASE}\n`);
  testEntitlementsEngine();
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || health.status >= 500) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const A = await login('b32-mediador-a@test.local', 'Mediador A');

  const med = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Test Bloque 32' }) })).body;
  const partySinTelefono = (await A.fetch(`/api/mediations/${med.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Ana', lastName: 'SinTelefono' }) })).body;
  const partyConTelefono = (await A.fetch(`/api/mediations/${med.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requerido', firstName: 'Beto', lastName: 'ConTelefono', phone: '+5491100000000' }) })).body;
  const lawyer = (await A.fetch(`/api/mediations/${med.id}/lawyers`, { method: 'POST', body: JSON.stringify({ name: 'Dra. Test', partyId: partySinTelefono.id }) })).body;

  // ==================== 1. Aviso automático al invitar ====================
  const invite1 = await A.fetch(`/api/mediations/${med.id}/parties/${partySinTelefono.id}/invite`, { method: 'POST' });
  check('1a. Invitar a una parte sin teléfono: 200, notified:false', invite1.status === 200 && invite1.body.notified === false, JSON.stringify(invite1.body));

  const invite2 = await A.fetch(`/api/mediations/${med.id}/parties/${partyConTelefono.id}/invite`, { method: 'POST' });
  // sin WHATSAPP_TOKEN en el entorno de test, incluso con teléfono el envío real falla —
  // lo importante es que NUNCA se informe "enviado" sin haber mandado nada de verdad.
  check('1b. Invitar a una parte con teléfono pero sin WhatsApp configurado: notified:false (nunca finge éxito)', invite2.status === 200 && invite2.body.notified === false, JSON.stringify(invite2.body));

  const inviteLawyer = await A.fetch(`/api/mediations/${med.id}/lawyers/${lawyer.id}/invite`, { method: 'POST' });
  check('1c. Invitar a un abogado sin teléfono: notified:false', inviteLawyer.status === 200 && inviteLawyer.body.notified === false, JSON.stringify(inviteLawyer.body));

  const timeline1 = await A.fetch(`/api/mediations/${med.id}/timeline`);
  check('1d. El timeline registra PARTY_INVITED y PARTY_INVITE_NOTIFIED', timeline1.body.some((e) => e.type === 'PARTY_INVITED' && e.entityId === partySinTelefono.id) && timeline1.body.some((e) => e.type === 'PARTY_INVITE_NOTIFIED' && e.entityId === partySinTelefono.id));
  check('1e. El timeline registra LAWYER_INVITED y LAWYER_INVITE_NOTIFIED', timeline1.body.some((e) => e.type === 'LAWYER_INVITED' && e.entityId === lawyer.id) && timeline1.body.some((e) => e.type === 'LAWYER_INVITE_NOTIFIED' && e.entityId === lawyer.id));

  const commsSinTel = await A.fetch(`/api/mediations/${med.id}/parties/${partySinTelefono.id}/messages`);
  check('1f. Queda registrado en Comunicaciones (mensaje de sistema en el hilo de la parte)', commsSinTel.body.some((m) => !m.sender && (m.text || '').includes('invitación')));

  const dashA = await A.fetch('/api/mediations/dashboard');
  check('1g. El fallo de aviso aparece en el centro de atención (reusa falloNotificacion, sin código nuevo)', dashA.body.centroAtencion.some((it) => it.type === 'falloNotificacion' && it.mediationId === med.id));

  // ==================== 2. Revisión de documentos con comentario ====================
  const minimalPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const form = new FormData();
  form.append('type', 'otro');
  form.append('file', new Blob([minimalPdf], { type: 'application/pdf' }), 'general.pdf');
  const doc = (await A.fetch(`/api/mediations/${med.id}/documents`, { method: 'POST', body: form })).body;
  check('setup: se pudo subir el documento general', !!doc.id, JSON.stringify(doc));
  // se deja en su estado por default ('recibido') a propósito — así sigue
  // contando para documentosPendientesRevision en el test 3c de abajo; la
  // validación de "observado sin notas" no depende del estado de origen.

  const rejectNoNotes = await A.fetch(`/api/mediations/${med.id}/documents/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'observado' }) });
  check('2a. Marcar "observado" sin comentario: 400', rejectNoNotes.status === 400);

  // el documento recién creado no tiene partyId (documento general) — para
  // probar el aviso hace falta uno asociado a una parte puntual.
  const form2 = new FormData();
  form2.append('type', 'otro');
  form2.append('partyId', partyConTelefono.id);
  form2.append('file', new Blob([minimalPdf], { type: 'application/pdf' }), 'de-la-parte.pdf');
  const docDeParte = (await A.fetch(`/api/mediations/${med.id}/documents`, { method: 'POST', body: form2 })).body;
  check('setup: el documento quedó asociado a la parte', docDeParte.partyId === partyConTelefono.id, JSON.stringify(docDeParte));

  const rejectOk = await A.fetch(`/api/mediations/${med.id}/documents/${docDeParte.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'observado', notes: 'Falta la firma en la página 2' }) });
  check('2b. Marcar "observado" con comentario: 200, reviewNotes guardado', rejectOk.status === 200 && rejectOk.body.reviewNotes === 'Falta la firma en la página 2', JSON.stringify(rejectOk.body));
  check('2c. notified:false (mismo motivo que en las invitaciones — sin WhatsApp configurado)', rejectOk.body.notified === false);

  const timeline2 = await A.fetch(`/api/mediations/${med.id}/timeline?type=DOCUMENT_REVIEWED`);
  check('2d. El timeline trae la descripción con el comentario', timeline2.body.some((e) => e.entityId === docDeParte.id && e.description === 'Falta la firma en la página 2'));

  const invitePartyConTel = await A.fetch(`/api/mediations/${med.id}/parties/${partyConTelefono.id}/invite`);
  const commsConTel = await A.fetch(`/api/mediations/${med.id}/parties/${partyConTelefono.id}/messages`);
  check('2e. Queda registrado en Comunicaciones', commsConTel.body.some((m) => !m.sender && (m.text || '').includes('observado')));

  const revisadoSinNotas = await A.fetch(`/api/mediations/${med.id}/documents/${docDeParte.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'revisado' }) });
  check('2f. Pasar a "revisado" sin comentario sigue funcionando (solo "observado" lo exige)', revisadoSinNotas.status === 200);

  // el portal de la parte ahora tiene que poder VER el estado y el comentario
  const inviteForToken = await A.fetch(`/api/mediations/${med.id}/parties/${partyConTelefono.id}/invite`, { method: 'POST' });
  const portalToken = inviteForToken.body.portalToken;
  const portalView = await portalFetch(`/api/party-portal/${portalToken}`);
  const portalDoc = portalView.body.documents.find((d) => d.id === docDeParte.id);
  check('2g. El portal de la parte trae status y reviewNotes del documento', !!portalDoc && portalDoc.status === 'revisado');

  // ==================== 3. Pantalla de preparación de audiencia ====================
  const hearing = (await A.fetch(`/api/mediations/${med.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), startTime: '10:00', modality: 'presencial', location: 'Oficina' }) })).body;
  const cOverdue = (await A.fetch(`/api/mediations/${med.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: partyConTelefono.id, description: 'Enviar comprobante', dueDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }) })).body;
  await A.fetch(`/api/mediations/${med.id}/parties/${partyConTelefono.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Hola, ¿cómo seguimos?' }) });

  const prep = await A.fetch(`/api/mediations/${med.id}/hearings/${hearing.id}/preparation`);
  check('3a. GET preparation sigue devolviendo items/estado/motivo (checklist de siempre)', prep.status === 200 && !!prep.body.items && !!prep.body.estado);
  check('3b. Trae "details" con confirmaciones nombradas', Array.isArray(prep.body.details?.confirmations) && prep.body.details.confirmations.some((c) => c.partyId === partyConTelefono.id));
  check('3c. Trae documentos pendientes de revisión (nombrados, no solo un conteo)', Array.isArray(prep.body.details?.documentsPending) && prep.body.details.documentsPending.some((d) => d.id === doc.id));
  check('3d. Trae compromisos vencidos de ESTA mediación', prep.body.details.overdueCommitments.some((c) => c.id === cOverdue.id));
  check('3e. Trae las últimas comunicaciones', prep.body.details.recentCommunications.length > 0);
  check('3f. Trae los datos de la audiencia (serializeHearing, sin duplicar el cálculo)', prep.body.hearing && prep.body.hearing.id === hearing.id && prep.body.hearing.modality === 'presencial');
  check('3g. Audiencia presencial: video es null (no aplica)', prep.body.hearing.video === null);

  const otherMediation = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Otra mediación' }) })).body;
  const prepCross = await A.fetch(`/api/mediations/${otherMediation.id}/hearings/${hearing.id}/preparation`);
  check('3h. Preparación cross-mediación (audiencia de otro expediente): 404', prepCross.status === 404);

  // ==================== 4. Entitlements aplicados de verdad ====================
  const availBefore = await A.fetch('/api/agenda/availability', { method: 'POST', body: JSON.stringify({ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }) });
  check('4a. FREE: POST /agenda/availability -> 402 PLAN_LIMIT_REACHED (antes no se aplicaba)', availBefore.status === 402 && availBefore.body.code === 'PLAN_LIMIT_REACHED', JSON.stringify(availBefore.body));

  const blockAttempt = await A.fetch('/api/agenda/blocks', { method: 'POST', body: JSON.stringify({ date: '2027-01-01', startTime: '09:00', endTime: '10:00' }) });
  check('4b. FREE: POST /agenda/blocks -> 402 PLAN_LIMIT_REACHED', blockAttempt.status === 402 && blockAttempt.body.code === 'PLAN_LIMIT_REACHED');

  // estudio: FREE ya cuenta 1 miembro (el propio dueño) -> cualquier invitación nueva choca con el límite
  const studio = (await A.fetch('/api/studios', { method: 'POST', body: JSON.stringify({ name: 'Estudio Test B32' }) })).body;
  const inviteStudio = await A.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'nuevo-miembro-b32@test.local', role: 'mediador' }) });
  check('4c. FREE: invitar a un 2do integrante del estudio -> 402 PLAN_LIMIT_REACHED (antes no se aplicaba)', inviteStudio.status === 402 && inviteStudio.body.code === 'PLAN_LIMIT_REACHED', JSON.stringify(inviteStudio.body));

  // Bloque 33 — el gate de maxAssistants se movió acá (invitación con
  // role:'asistente'), en vez de la asignación puntual en /access (ver el
  // comentario más abajo sobre por qué ESE gate quedaba inalcanzable).
  // FREE tiene maxAssistants=0, así que la invitación de un asistente
  // rebota apenas se intenta, sin necesitar sumar primero un integrante
  // normal (canAddAssistant nunca comparte cupo con canAddStudyMember).
  const inviteAssistant = await A.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'asistente-b32@test.local', role: 'asistente' }) });
  check('4c(bis). FREE: invitar un asistente -> 402 PLAN_LIMIT_REACHED (maxAssistants=0)', inviteAssistant.status === 402 && inviteAssistant.body.code === 'PLAN_LIMIT_REACHED', JSON.stringify(inviteAssistant.body));

  // Hallazgo original de este bloque (ya corregido en Bloque 33, ver
  // arriba): POST /:id/access exige que target y dueño compartan estudio
  // (chequeo preexistente, no tocado acá), y con maxStudyMembers=1 en FREE
  // Y en PROFESIONAL un estudio nunca podía tener un 2do integrante en
  // esos dos planes — el gate de maxAssistants puesto en /access quedaba
  // inalcanzable en la práctica. Bloque 33 lo resolvió moviendo el gate a
  // la invitación (arriba) en vez de a la asignación puntual. Lo que SÍ se
  // sigue probando acá por HTTP es que, sin estudio
  // compartido, la asignación sigue rechazándose como siempre (regresión).
  const B = await login('b32-asistente-candidato@test.local', 'Candidato Asistente');
  const accessAttempt = await A.fetch(`/api/mediations/${med.id}/access`, { method: 'POST', body: JSON.stringify({ userId: B.userId, role: 'asistente' }) });
  check('4d. Regresión: asignar a alguien de OTRO estudio sigue rechazado como siempre (400, prerrequisito preexistente)', accessAttempt.status === 400, JSON.stringify(accessAttempt.body));

  // regresión: A ya tiene 2 mediaciones activas (med, otherMediation) — la
  // 3ra tiene que entrar (límite FREE=3), la 4ta tiene que rebotar. Mismo
  // entitlement que ya estaba aplicado ANTES de este bloque — confirma que
  // no se rompió nada al mover billingPaywallActive a entitlements.js.
  const thirdMediation = await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Regresión: 3ra mediación (límite FREE)' }) });
  check('4e. Regresión: 3ra mediación (dentro del límite FREE=3) sigue funcionando', thirdMediation.status === 200, JSON.stringify(thirdMediation.body));
  const fourthMediation = await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Regresión: 4ta mediación (fuera del límite)' }) });
  check('4f. Regresión: 4ta mediación (fuera del límite FREE=3) sigue rebotando con 402', fourthMediation.status === 402 && fourthMediation.body.code === 'PLAN_LIMIT_REACHED');

  console.log(`\n${passed} OK, ${failed} FAIL`);
  if (failed) { console.log('\nFallaron:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
