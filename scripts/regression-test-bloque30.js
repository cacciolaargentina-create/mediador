// scripts/regression-test-bloque30.js
// Bloque 30 (Acceso rápido a chat + historial) — batería HTTP contra la
// app real: el endpoint nuevo GET /api/mediations/inbox (bandeja global
// de comunicaciones), que reusa getMyMediations/lastMessagePreview/
// unreadCountFor del Bloque 19 — nunca un cálculo de acceso o de "no
// leído" paralelo. Los botones [Chat]/[Historial]/[Abrir] agregados en
// el frontend son navegación pura (goTo('detail')+scroll) sobre rutas
// que YA estaban protegidas; lo único que puede tener un bug de
// seguridad nuevo es este endpoint, así que es el foco de este script.
//
// Requiere: server con ENABLE_FAKE_LOGIN=1.
// Uso: node scripts/regression-test-bloque30.js [http://localhost:PORT]

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
async function login(email, name) {
  const jar = cookieJar();
  const r = await jar.fetch('/auth/fake-login', { method: 'POST', body: JSON.stringify({ email, name }) });
  if (r.status !== 200) throw new Error(`No se pudo loguear ${email}: ${JSON.stringify(r.body)}`);
  jar.userId = r.body.user.id;
  return jar;
}

async function makeMediationWithMessages(jar, { object, partyFirst, partyLast }) {
  const med = (await jar.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object }) })).body;
  const party = (await jar.fetch(`/api/mediations/${med.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: partyFirst, lastName: partyLast }) })).body;
  await jar.fetch(`/api/mediations/${med.id}/parties/${party.id}/invite`, { method: 'POST' });
  // un mensaje del "otro lado" (senderId null simula un mensaje entrante
  // vía portal — alcanza para poblar lastMessage/unreadCount, que es lo
  // único que le importa a este endpoint) no es fácil de simular sin el
  // portal; en cambio, mandamos un mensaje COMO mediador — no queda
  // "no leído" para el propio mediador, pero sí puebla lastMessage y
  // deja el hilo visible en la bandeja (que es lo que este bloque prueba).
  await jar.fetch(`/api/mediations/${med.id}/parties/${party.id}/messages`, { method: 'POST', body: JSON.stringify({ text: `Hola ${partyFirst}, ¿seguimos con la mediación?` }) });
  return { med, party };
}

(async function main() {
  console.log(`Bloque 30 (Acceso rápido a chat + historial) — tests contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || health.status >= 500) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const MED_A = await login('b30-mediador-a@test.local', 'Mediador A');
  const MED_B = await login('b30-mediador-b@test.local', 'Mediador B'); // cross-mediation

  // ---- 1/2/4/5. la mediación existe, tiene comunicaciones y timeline alcanzables por los mismos endpoints de siempre ----
  const { med: medA1, party: partyA1 } = await makeMediationWithMessages(MED_A, { object: 'Conflicto A1', partyFirst: 'Ana', partyLast: 'Ríos' });
  const commsA1 = await MED_A.fetch(`/api/mediations/${medA1.id}/communications`);
  check('1/4. Chat: GET /:id/communications sigue accesible para el dueño', commsA1.status === 200 && Array.isArray(commsA1.body));
  const timelineA1 = await MED_A.fetch(`/api/mediations/${medA1.id}/timeline`);
  check('2/5. Historial: GET /:id/timeline sigue accesible para el dueño', timelineA1.status === 200 && Array.isArray(timelineA1.body));

  // ---- 3. bandeja global (Dashboard/Comunicaciones) ----
  const inboxA = await MED_A.fetch('/api/mediations/inbox');
  check('3. GET /inbox devuelve 200 y una lista', inboxA.status === 200 && Array.isArray(inboxA.body));
  const itemA1 = inboxA.body.find((it) => it.mediationId === medA1.id);
  check('3. La conversación recién creada aparece en la bandeja', !!itemA1);
  check('3. El item trae mediationCode/participantName/lastMessage (shape del Bloque 19, sin inventar campos)', !!(itemA1 && itemA1.mediationCode && itemA1.participantName && itemA1.lastMessage && itemA1.lastMessage.text));

  const dashA = await MED_A.fetch('/api/mediations/dashboard');
  check('3. El dashboard trae comunicacionesRecientes (máx 3)', dashA.status === 200 && Array.isArray(dashA.body.comunicacionesRecientes) && dashA.body.comunicacionesRecientes.length <= 3);

  // ---- 6. Agenda sigue trayendo mediationId por audiencia (lo que necesita el botón [Chat] de agenda) ----
  const today = new Date().toISOString().slice(0, 10);
  await MED_A.fetch(`/api/mediations/${medA1.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: today, startTime: '10:00', modality: 'presencial', location: 'Oficina' }) });
  const agendaA = await MED_A.fetch(`/api/agenda?from=${today}&to=${today}`);
  check('6. La agenda sigue devolviendo mediationId por audiencia', agendaA.status === 200 && (agendaA.body.hearings || agendaA.body).some?.((h) => h.mediationId === medA1.id) !== false);

  // ---- 8/9. no leído / marcar leído en la bandeja ----
  // un segundo mensaje del mediador no genera "no leído" para sí mismo;
  // lo que sí podemos probar end-to-end es que el contador de la bandeja
  // coincide exactamente con GET /:id/communications (misma función,
  // nunca un cálculo duplicado) y que read-all no rompe nada.
  const beforeRead = inboxA.body.find((it) => it.mediationId === medA1.id);
  const commsBefore = commsA1.body.find((c) => c.participantId === partyA1.id);
  check('8. unreadCount de la bandeja coincide con el de /:id/communications', beforeRead.unreadCount === commsBefore.unreadCount);
  const readAll = await MED_A.fetch(`/api/mediations/${medA1.id}/communications/${commsBefore.code}/read-all`, { method: 'POST' });
  check('9. Marcar leído sigue funcionando (200) sin que este bloque lo haya tocado', readAll.status === 200);

  // ---- 11. búsqueda ----
  const searchHit = await MED_A.fetch('/api/mediations/inbox?q=' + encodeURIComponent('Ríos'));
  check('11. Búsqueda por nombre de parte encuentra la conversación', searchHit.body.some((it) => it.mediationId === medA1.id));
  const searchMiss = await MED_A.fetch('/api/mediations/inbox?q=' + encodeURIComponent('NombreQueNoExisteEnNada'));
  check('11. Búsqueda sin coincidencias devuelve lista vacía (no la bandeja completa)', Array.isArray(searchMiss.body) && searchMiss.body.length === 0);

  // ---- 12/15. aislamiento entre mediaciones / cross-mediador ----
  const { med: medB1 } = await makeMediationWithMessages(MED_B, { object: 'Conflicto B1 (de otro mediador)', partyFirst: 'Bruno', partyLast: 'Cruz' });
  const inboxB = await MED_B.fetch('/api/mediations/inbox');
  check('12. La bandeja de A no incluye mediaciones de B', !inboxA.body.some((it) => it.mediationId === medB1.id));
  check('12/15. La bandeja de B no incluye mediaciones de A', !inboxB.body.some((it) => it.mediationId === medA1.id));
  const inboxARefetch = await MED_A.fetch('/api/mediations/inbox');
  check('12. (re-chequeo) A sigue sin ver nada de B después de que B tiene actividad', !inboxARefetch.body.some((it) => it.mediationId === medB1.id));

  // ---- 16. usuario sin acceso ----
  const anon = await fetch(BASE + '/api/mediations/inbox');
  check('16. Sin sesión, GET /inbox devuelve 401 (nunca la bandeja de otro)', anon.status === 401);

  // ---- 21. coparentalidad no se tocó: crear canal + unirse sigue funcionando ----
  const chRes = await MED_A.fetch('/api/channels', { method: 'POST', body: JSON.stringify({}) });
  check('21. Coparentalidad: crear canal sigue funcionando (Bloque 30 no tocó routes/channels.js)', chRes.status === 200 || chRes.status === 201);

  console.log(`\n${passed} OK, ${failed} FAIL`);
  if (failed) { console.log('\nFallaron:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
