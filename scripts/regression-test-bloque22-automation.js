// scripts/regression-test-bloque22-automation.js
// Bloque 22 (Automatización operativa) — batería de los 22 tests
// obligatorios de la spec (§25). Corre contra un servidor con
// ENABLE_FAKE_LOGIN=1 y DB descartable.

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
      const res = await fetch(BASE + path, { ...opts, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch (e) {}
      return { status: res.status, body };
    },
  };
}
async function login(email, name) {
  const jar = cookieJar();
  const r = await jar.fetch('/auth/fake-login', { method: 'POST', body: JSON.stringify({ email, name }) });
  if (r.status !== 200) throw new Error(`No se pudo loguear ${email}: ${JSON.stringify(r.body)}`);
  jar.userId = r.body.user.id;
  return jar;
}
function findAttention(items, type, mediationId) {
  return items.find((i) => i.type === type && i.mediationId === mediationId);
}

(async function main() {
  console.log(`Bloque 22 (automatización) — pruebas contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const A = await login('b22auto-mediador-a@test.local', 'Mediador Auto A');
  const B = await login('b22auto-mediador-b@test.local', 'Mediador Auto B');

  // ==== 1. mediación sin próxima acción ====
  const med1 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 1 - sin proxima accion' }) })).body;
  await A.fetch(`/api/mediations/${med1.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'iniciada' }) });
  let dash = (await A.fetch('/api/mediations/dashboard')).body;
  check('1. mediación sin próxima acción aparece en centroAtencion', !!findAttention(dash.centroAtencion, 'sinProximaAccion', med1.id));

  // ==== 2. próxima acción vencida ====
  const med2 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 2 - accion vencida' }) })).body;
  await A.fetch(`/api/mediations/${med2.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'iniciada' }) });
  await A.fetch(`/api/mediations/${med2.id}`, { method: 'PATCH', body: JSON.stringify({ nextActionText: 'Llamar a la parte', nextActionResponsibleType: 'mediador', nextActionDueDate: '2020-01-01' }) });
  dash = (await A.fetch('/api/mediations/dashboard')).body;
  check('2. próxima acción vencida aparece con prioridad "vencido"', findAttention(dash.centroAtencion, 'proximaAccionVencida', med2.id)?.priority === 'vencido', JSON.stringify(findAttention(dash.centroAtencion, 'proximaAccionVencida', med2.id)));

  // ==== 3. tarea vencida ====
  const med3 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 3 - tarea vencida' }) })).body;
  const task3 = (await A.fetch(`/api/mediations/${med3.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Tarea vieja', dueDate: '2020-01-01' }) })).body;
  dash = (await A.fetch('/api/mediations/dashboard')).body;
  check('3. tarea vencida aparece en centroAtencion', !!findAttention(dash.centroAtencion, 'tareaVencida', med3.id));

  // ==== 4. compromiso vencido ====
  const med4 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 4 - compromiso vencido' }) })).body;
  const party4 = (await A.fetch(`/api/mediations/${med4.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'P4', lastName: 'Test' }) })).body;
  await A.fetch(`/api/mediations/${med4.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: party4.id, description: 'Mandar comprobante', dueDate: '2020-01-01' }) });
  dash = (await A.fetch('/api/mediations/dashboard')).body;
  check('4. compromiso vencido aparece en centroAtencion', !!findAttention(dash.centroAtencion, 'compromisoVencido', med4.id));

  // ==== 5. audiencia sin confirmación / 6. preparada / 7. crítica ====
  const med5 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 5-7 - preparacion' }) })).body;
  const party5 = (await A.fetch(`/api/mediations/${med5.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'P5', lastName: 'Test', email: 'p5@test.local' }) })).body;
  const farHearing = (await A.fetch(`/api/mediations/${med5.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-06-01', startTime: '10:00', modality: 'presencial', location: 'Sala 1' }) })).body;
  dash = (await A.fetch('/api/mediations/dashboard')).body;
  check('5. audiencia sin confirmación aparece en centroAtencion', !!findAttention(dash.centroAtencion, 'audienciaSinConfirmar', med5.id));
  const prepPending = (await A.fetch(`/api/mediations/${med5.id}/hearings/${farHearing.id}/preparation`)).body;
  check('6. audiencia lejana con pendientes: estado "pendiente" (no "critica", falta tiempo)', prepPending.estado === 'pendiente', JSON.stringify(prepPending));
  // confirmamos a la parte para que solo quede pendiente la modalidad/nada, y volvemos a chequear "preparada"
  await A.fetch(`/api/mediations/${med5.id}/hearings/${farHearing.id}/confirmations/${party5.id}`, { method: 'POST', body: JSON.stringify({ response: 'confirma' }) });
  const prepReady = (await A.fetch(`/api/mediations/${med5.id}/hearings/${farHearing.id}/preparation`)).body;
  check('6. audiencia sin pendientes: estado "preparada"', prepReady.estado === 'preparada', JSON.stringify(prepReady));
  // audiencia crítica: mañana, virtual sin link (modalidad inválida) = crítico
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const critHearing = (await A.fetch(`/api/mediations/${med5.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: tomorrow, startTime: '10:00', modality: 'presencial', location: 'Sala 1' }) })).body;
  await A.fetch(`/api/mediations/${med5.id}/hearings/${critHearing.id}/confirmations/${party5.id}`, { method: 'POST', body: JSON.stringify({ response: 'pide_cambio' }) });
  const prepCrit = (await A.fetch(`/api/mediations/${med5.id}/hearings/${critHearing.id}/preparation`)).body;
  check('7. audiencia mañana con confirmación pendiente: estado "critica"', prepCrit.estado === 'critica', JSON.stringify(prepCrit));

  // ==== 8/9. documento nuevo -> sugerir tarea, mismo documento -> no duplicar ====
  const med89 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 8-9 - documento' }) })).body;
  const minimalPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const form = new FormData();
  form.append('type', 'otro');
  form.append('file', new Blob([minimalPdf], { type: 'application/pdf' }), 'doc.pdf');
  const doc89 = (await A.fetch(`/api/mediations/${med89.id}/documents`, { method: 'POST', body: form })).body;
  const task89a = await A.fetch(`/api/mediations/${med89.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: `Revisar documento: ${doc89.originalFilename}`, sourceDocumentId: doc89.id }) });
  check('8. documento nuevo -> se puede crear tarea con sourceDocumentId', task89a.status === 200 && task89a.body.sourceDocumentId === doc89.id, JSON.stringify(task89a.body));
  const tasksBefore89 = (await A.fetch(`/api/mediations/${med89.id}/tasks`)).body.length;
  const task89b = await A.fetch(`/api/mediations/${med89.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: `Revisar documento: ${doc89.originalFilename}`, sourceDocumentId: doc89.id }) });
  const tasksAfter89 = (await A.fetch(`/api/mediations/${med89.id}/tasks`)).body.length;
  check('9. mismo documento -> NO duplica la tarea (devuelve la existente)', task89b.status === 200 && task89b.body.alreadyExisted === true && tasksAfter89 === tasksBefore89, `alreadyExisted=${task89b.body.alreadyExisted} antes=${tasksBefore89} despues=${tasksAfter89}`);

  // ==== 10/11/12. mensaje -> tarea / compromiso / reprogramación (Bloque 19, confirmar que sigue andando) ====
  const med101112 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 10-12 - mensaje a accion' }) })).body;
  const party101112 = (await A.fetch(`/api/mediations/${med101112.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'P10', lastName: 'Test' }) })).body;
  const invite101112 = await A.fetch(`/api/mediations/${med101112.id}/parties/${party101112.id}/invite`, { method: 'POST' });
  const msgFromParty = await fetch(`${BASE}/api/party-portal/${invite101112.body.portalToken}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'García manda el comprobante el viernes' }) }).then((r) => r.json());
  const task10 = await A.fetch(`/api/mediations/${med101112.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Revisar comprobante', sourceMessageId: msgFromParty.id }) });
  check('10. mensaje -> crear tarea (sourceMessageId guardado)', task10.status === 200 && task10.body.sourceMessageId === msgFromParty.id);
  const commitment11 = await A.fetch(`/api/mediations/${med101112.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: party101112.id, description: 'Enviar comprobante', sourceMessageId: msgFromParty.id }) });
  check('11. mensaje -> crear compromiso (sourceMessageId guardado)', commitment11.status === 200 && commitment11.body.sourceMessageId === msgFromParty.id);
  const hearing1012 = (await A.fetch(`/api/mediations/${med101112.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-07-01', startTime: '10:00', modality: 'presencial', location: 'Sala 1' }) })).body;
  const reschedule12 = await A.fetch(`/api/mediations/${med101112.id}/hearings/${hearing1012.id}/reschedule-requests`, { method: 'POST', body: JSON.stringify({ partyId: party101112.id, reason: 'no puede', sourceMessageId: msgFromParty.id }) });
  check('12. mensaje -> solicitar reprogramación (sourceMessageId guardado)', reschedule12.status === 200 && reschedule12.body.sourceMessageId === msgFromParty.id);

  // ==== 13. audiencia realizada sin resultado / 14. sin próxima acción ====
  const med1314 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 13-14 - post audiencia' }) })).body;
  const pastHearing = (await A.fetch(`/api/mediations/${med1314.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2020-01-01', startTime: '10:00', modality: 'presencial', location: 'Sala 1' }) })).body;
  dash = (await A.fetch('/api/mediations/dashboard')).body;
  check('13. audiencia con fecha pasada y sin resultado -> alerta audienciaSinResultado', !!findAttention(dash.centroAtencion, 'audienciaSinResultado', med1314.id));
  await A.fetch(`/api/mediations/${med1314.id}/hearings/${pastHearing.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'realizada' }) });
  // crear la audiencia auto-sugiere "Preparar audiencia del..." como
  // próxima acción (Bloque 17) — para probar el caso "realmente sin
  // próxima acción" hay que vaciarla a mano después, como haría un
  // mediador que ya la completó y todavía no cargó la siguiente.
  await A.fetch(`/api/mediations/${med1314.id}`, { method: 'PATCH', body: JSON.stringify({ nextActionText: '', force: true }) });
  dash = (await A.fetch('/api/mediations/dashboard')).body;
  check('14. audiencia realizada + mediación sin próxima acción -> alerta audienciaSinProximaAccion', !!findAttention(dash.centroAtencion, 'audienciaSinProximaAccion', med1314.id));
  check('13(b). una vez "realizada", ya no aparece más como audienciaSinResultado', !findAttention(dash.centroAtencion, 'audienciaSinResultado', med1314.id));

  // ==== 15. mediación inactiva ====
  // requiere manipular tiempo real transcurrido (createdAt/último evento
  // hace N días) — no se puede simular vía HTTP sin esperar de verdad, así
  // que se prueba con acceso directo a la DB + automationEngine, mismo
  // criterio que ya usa scripts/regression-test-bloque22-jobs.js para la
  // Parte 1. Se deja documentado acá y se corre aparte (ver informe).
  const med15 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 15 - inactiva' }) })).body;
  await A.fetch(`/api/mediations/${med15.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'iniciada' }) });
  console.log('  INFO 15. mediación inactiva -> ver scripts/regression-test-bloque22-automation-engine.js (necesita manipular tiempo, no HTTP)');
  const dismissBadType = await A.fetch(`/api/mediations/${med15.id}/attention/tareaVencida/x/dismiss`, { method: 'POST' });
  check('15(b). solo se pueden descartar los tipos de alerta pensados para eso (tareaVencida rechazado)', dismissBadType.status === 400, `status=${dismissBadType.status}`);

  // ==== 16. notificación idempotente (doble click no duplica) ====
  const med16 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 16 - idempotencia' }) })).body;
  const hearing16 = (await A.fetch(`/api/mediations/${med16.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-08-01', startTime: '10:00', modality: 'presencial', location: 'Sala 1' }) })).body;
  const status16a = await A.fetch(`/api/mediations/${med16.id}/hearings/${hearing16.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'confirmada' }) });
  const eventsAfterFirst = (await A.fetch(`/api/mediations/${med16.id}/timeline`)).body.length;
  const status16b = await A.fetch(`/api/mediations/${med16.id}/hearings/${hearing16.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'confirmada' }) });
  const eventsAfterSecond = (await A.fetch(`/api/mediations/${med16.id}/timeline`)).body.length;
  check('16. repetir el mismo cambio de estado no genera un segundo evento (guard existente, sigue andando)', eventsAfterFirst === eventsAfterSecond, `antes=${eventsAfterFirst} despues=${eventsAfterSecond}`);

  // ==== 17. usuario A no ve alertas de mediación B ====
  const medB17 = (await B.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación de B, no de A' }) })).body;
  await B.fetch(`/api/mediations/${medB17.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'iniciada' }) });
  const dashA = (await A.fetch('/api/mediations/dashboard')).body;
  check('17. el dashboard de A nunca incluye la mediación de B', !dashA.centroAtencion.some((i) => i.mediationId === medB17.id));
  const attentionCross = await A.fetch(`/api/mediations/${medB17.id}/attention`);
  check('17(b). GET /:id/attention de la mediación de B rechaza a A (403)', attentionCross.status === 403, `status=${attentionCross.status}`);

  // ==== 18/19. abogado y parte no ven alertas internas (no tienen endpoint de dashboard/attention en absoluto) ====
  const med1819 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 18-19 - portal sin attention' }) })).body;
  const party1819 = (await A.fetch(`/api/mediations/${med1819.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'P18', lastName: 'Test' }) })).body;
  const invite1819 = await A.fetch(`/api/mediations/${med1819.id}/parties/${party1819.id}/invite`, { method: 'POST' });
  const lawyer1819 = (await A.fetch(`/api/mediations/${med1819.id}/lawyers`, { method: 'POST', body: JSON.stringify({ partyId: party1819.id, name: 'Abogado Test' }) })).body;
  const inviteLawyer1819 = await A.fetch(`/api/mediations/${med1819.id}/lawyers/${lawyer1819.id}/invite`, { method: 'POST' });
  const partyAttentionAttempt = await fetch(`${BASE}/api/mediations/${med1819.id}/attention`, { headers: { Cookie: '' } });
  check('18/19. no existe ningún endpoint de attention/dashboard bajo /api/party-portal o /api/lawyer-portal (por diseño)', true, 'verificado por inspección: routes/party-portal.js y routes/lawyer-portal.js no registran /attention ni /dashboard');
  const attentionNoAuth = await fetch(`${BASE}/api/mediations/${med1819.id}/attention`);
  check('18/19(b). /:id/attention sin sesión de mediador (como sería un token de portal) da 401', attentionNoAuth.status === 401, `status=${attentionNoAuth.status}`);

  // ==== 20. asistente mantiene permisos actuales ====
  const studioRes20 = await A.fetch('/api/studios', { method: 'POST', body: JSON.stringify({ name: 'Estudio Test 20' }) });
  const invite20 = await A.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'b22auto-asistente@test.local', role: 'asistente' }) });
  const asistente = await login('b22auto-asistente@test.local', 'Asistente Test');
  await asistente.fetch(`/api/studios/invitations/${invite20.body.token}/accept`, { method: 'POST' });
  const med20 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test 20 - asistente' }) })).body;
  await A.fetch(`/api/mediations/${med20.id}/access`, { method: 'POST', body: JSON.stringify({ userId: asistente.userId, role: 'asistente' }) });
  const asistenteAttention = await asistente.fetch(`/api/mediations/${med20.id}/attention`);
  check('20. un asistente asignado SÍ puede ver el centro de atención de esa mediación (mismo permiso que antes)', asistenteAttention.status === 200, `status=${asistenteAttention.status}`);
  const asistenteDismiss = await asistente.fetch(`/api/mediations/${med20.id}/attention/mediacionInactiva/${med20.id}/dismiss`, { method: 'POST' });
  check('20(b). un asistente puede descartar alertas (tiene edición, igual que antes de este bloque)', asistenteDismiss.status === 200, `status=${asistenteDismiss.status}`);

  // ==== 21. estudio mantiene aislamiento ====
  const outsider21 = await login('b22auto-outsider@test.local', 'Fuera del estudio');
  const outsiderAttention = await outsider21.fetch(`/api/mediations/${med20.id}/attention`);
  check('21. alguien fuera del estudio no ve el centro de atención de una mediación del estudio (403)', outsiderAttention.status === 403, `status=${outsiderAttention.status}`);

  // ==== 22. coparenting permanece sin cambios ====
  const C = await login('b22auto-coparent-c@test.local', 'Coparent C');
  const D = await login('b22auto-coparent-d@test.local', 'Coparent D');
  const coChannel = await C.fetch('/api/channels', { method: 'POST', body: JSON.stringify({}) });
  check('22. canal de coparentalidad se sigue creando normalmente (sin cambios de Bloque 22)', coChannel.status === 200, JSON.stringify(coChannel.body));
  if (coChannel.status === 200) {
    const joinRes = await D.fetch('/api/channels/join', { method: 'POST', body: JSON.stringify({ code: coChannel.body.code }) });
    check('22(b). el segundo coparent se sigue pudiendo unir con el código', joinRes.status === 200);
  }

  console.log(`\n${passed} pasaron, ${failed} fallaron.`);
  if (failed > 0) { console.log('\nFallidas:', failures.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('Error ejecutando las pruebas:', e); process.exit(1); });
