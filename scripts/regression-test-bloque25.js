// scripts/regression-test-bloque25.js
// Bloque 25 (radar competitivo) — tests HTTP contra la app real: permisos,
// aislamiento, flujo de oportunidades, rate limiting y regresión de
// coparentalidad (tests 11-15, 17-18 de la spec §24). Los tests de
// scraper/engine puros (1-10, 16) están en
// regression-test-bloque25-engine.js, sin pegarle a la app.
//
// Requiere: server corriendo con ENABLE_FAKE_LOGIN=1, ADMIN_EMAILS incluyendo
// b25-admin@test.local, y opcionalmente RADAR_MIN_MANUAL_CHECK_MS bajo (ej.
// 200) para no tener que esperar 30s reales en el test de rate limiting.

const http = require('http');

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

// fixture local con contenido "que cambia" — sirve V1 en el primer hit de
// cada path y V2 en los siguientes, para poder generar un cambio real de
// verdad sin tocar ningún sitio externo.
function startFixtureServer(port) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const n = (hits.get(req.url) || 0) + 1;
    hits.set(req.url, n);
    const html = n === 1
      ? `<html><head><title>Fixture HTTP Test</title></head><body><p>Ofrece agenda inteligente.</p><p>Plan Basic ARS 30000 /mes</p></body></html>`
      : `<html><head><title>Fixture HTTP Test</title></head><body><p>Ofrece agenda inteligente con Google Calendar.</p><p>Plan Basic ARS 60000 /mes</p></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

(async function main() {
  console.log(`Bloque 25 (radar) — tests HTTP contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const fixtureServer = await startFixtureServer(3097);
  const FIXTURE_BASE = 'http://127.0.0.1:3097';

  const ADMIN = await login('b25-admin@test.local', 'Admin Test'); // tiene que estar en ADMIN_EMAILS del server de test
  const NORMAL = await login('b25-normal-mediador@test.local', 'Mediador Normal');

  try {
    // ==== 13. usuario sin permisos → 403 en TODO el radar ====
    check('13. no-admin: GET /sources → 403', (await NORMAL.fetch('/api/radar/sources')).status === 403);
    check('13(b). no-admin: POST /sources → 403', (await NORMAL.fetch('/api/radar/sources', { method: 'POST', body: JSON.stringify({ name: 'x', url: 'https://x.com', category: 'competidor' }) })).status === 403);
    check('13(c). no-admin: GET /dashboard → 403', (await NORMAL.fetch('/api/radar/dashboard')).status === 403);
    check('13(d). no-admin: GET /matrix → 403', (await NORMAL.fetch('/api/radar/matrix')).status === 403);
    check('13(e). no-admin: GET /changes → 403', (await NORMAL.fetch('/api/radar/changes')).status === 403);
    check('13(f). no-admin: GET /opportunities → 403', (await NORMAL.fetch('/api/radar/opportunities')).status === 403);
    check('13(g). anónimo (sin sesión): GET /sources → 401', (await fetch(BASE + '/api/radar/sources')).status === 401);

    // ==== 14. admin → acceso ====
    const createRes = await ADMIN.fetch('/api/radar/sources', { method: 'POST', body: JSON.stringify({ name: 'Fixture HTTP Test', url: `${FIXTURE_BASE}/change-flow`, category: 'competidor', checkFrequency: 'manual', notes: 'fuente de test, no real' }) });
    check('14. admin: POST /sources → 200', createRes.status === 200, JSON.stringify(createRes.body));
    const sourceId = createRes.body.id;
    check('14(b). admin: GET /sources incluye la fuente creada', (await ADMIN.fetch('/api/radar/sources')).body.some((s) => s.id === sourceId));
    check('14(c). admin: GET /dashboard → 200', (await ADMIN.fetch('/api/radar/dashboard')).status === 200);
    check('14(d). admin: GET /matrix → 200', (await ADMIN.fetch('/api/radar/matrix')).status === 200);
    check('14(e). admin: GET /competitors/:id → 200', (await ADMIN.fetch(`/api/radar/competitors/${sourceId}`)).status === 200);
    const patchRes = await ADMIN.fetch(`/api/radar/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify({ notes: 'nota actualizada' }) });
    check('14(f). admin: PATCH /sources/:id → 200', patchRes.status === 200 && patchRes.body.notes === 'nota actualizada');
    check('14(g). admin: PATCH con categoría inválida → 400', (await ADMIN.fetch(`/api/radar/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify({ category: 'no-existe' }) })).status === 400);

    // ==== 15. aislamiento de datos ====
    check('15. no-admin: GET /competitors/:id de una fuente real → 403 igual (no ve nada aunque sepa el ID)', (await NORMAL.fetch(`/api/radar/competitors/${sourceId}`)).status === 403);
    const med = (await NORMAL.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Mediación normal — no debe mezclarse con datos del radar' }) })).body;
    const dashboardAfterMed = await ADMIN.fetch('/api/radar/dashboard');
    check('15(b). una mediación normal no aparece mezclada en el dashboard del radar', !JSON.stringify(dashboardAfterMed.body).includes(med.id));
    const sourcesAfterMed = await ADMIN.fetch('/api/radar/sources');
    check('15(c). la lista de fuentes del radar no contiene ids de mediaciones', !JSON.stringify(sourcesAfterMed.body).includes(med.id));

    // ==== flujo de check real → cambio → oportunidad (11/12) ====
    const check1 = await ADMIN.fetch(`/api/radar/sources/${sourceId}/check`, { method: 'POST' });
    check('check manual #1 (línea de base): ok=true, changed=false', check1.body.ok === true && check1.body.changed === false, JSON.stringify(check1.body));

    // ==== 17. rate limiting — un segundo check inmediato se rechaza ====
    const check1b = await ADMIN.fetch(`/api/radar/sources/${sourceId}/check`, { method: 'POST' });
    check('17. rate limiting: segundo check inmediato → 429', check1b.status === 429, JSON.stringify(check1b.body));

    // esperamos el intervalo configurado para test (RADAR_MIN_MANUAL_CHECK_MS, chico) antes de seguir
    await new Promise((r) => setTimeout(r, Number(process.env.RADAR_MIN_MANUAL_CHECK_MS || 30000) + 100));

    const check2 = await ADMIN.fetch(`/api/radar/sources/${sourceId}/check`, { method: 'POST' });
    check('check manual #2 (contenido cambió de verdad): changed=true', check2.body.ok === true && check2.body.changed === true, JSON.stringify(check2.body));
    const changeId = check2.body.change && check2.body.change.id;
    check('el cambio detectado tiene status "nueva"', check2.body.change && check2.body.change.status === 'nueva');

    const changesList = await ADMIN.fetch(`/api/radar/changes?sourceId=${sourceId}`);
    check('GET /changes filtra por sourceId y trae el cambio recién creado', changesList.body.some((c) => c.id === changeId));

    // 11. oportunidad creada a partir de un cambio
    const oppRes = await ADMIN.fetch(`/api/radar/changes/${changeId}/create-opportunity`, { method: 'POST', body: JSON.stringify({ title: 'Evaluar integración de calendario', observation: 'Varios competidores lo promocionan' }) });
    check('11. crear oportunidad desde un cambio → 200, status pendiente', oppRes.status === 200 && oppRes.body.status === 'pendiente', JSON.stringify(oppRes.body));
    const opportunityId = oppRes.body.id;
    const changeAfterOpp = await ADMIN.fetch(`/api/radar/changes?sourceId=${sourceId}`);
    const changedRow = changeAfterOpp.body.find((c) => c.id === changeId);
    check('11(b). el cambio de origen queda con status "convertida_en_oportunidad"', changedRow.status === 'convertida_en_oportunidad', JSON.stringify(changedRow));

    // 12. oportunidad descartada
    const dismissOppRes = await ADMIN.fetch(`/api/radar/opportunities/${opportunityId}/dismiss`, { method: 'POST' });
    check('12. descartar oportunidad → 200, status descartada, queda quién y cuándo', dismissOppRes.status === 200 && dismissOppRes.body.status === 'descartada' && !!dismissOppRes.body.confirmedBy && !!dismissOppRes.body.confirmedAt, JSON.stringify(dismissOppRes.body));

    // confirmar/descartar un CAMBIO directamente (sección 13 — revisión humana)
    const dismissChangeRes = await ADMIN.fetch(`/api/radar/sources`, { method: 'POST', body: JSON.stringify({ name: 'Fixture HTTP Test 2', url: `${FIXTURE_BASE}/change-flow-2`, category: 'mercado', checkFrequency: 'manual' }) });
    const source2Id = dismissChangeRes.body.id;
    await ADMIN.fetch(`/api/radar/sources/${source2Id}/check`, { method: 'POST' }); // baseline
    await new Promise((r) => setTimeout(r, Number(process.env.RADAR_MIN_MANUAL_CHECK_MS || 30000) + 100));
    const check2b = await ADMIN.fetch(`/api/radar/sources/${source2Id}/check`, { method: 'POST' });
    const change2Id = check2b.body.change && check2b.body.change.id;
    check('setup: segunda fuente también generó un cambio real', !!change2Id, JSON.stringify(check2b.body));
    const confirmChangeRes = await ADMIN.fetch(`/api/radar/changes/${change2Id}/confirm`, { method: 'POST' });
    check('sección 13: confirmar un cambio → status revisada, con reviewedBy/reviewedAt', confirmChangeRes.status === 200 && confirmChangeRes.body.status === 'revisada' && !!confirmChangeRes.body.reviewedBy);

    // no-admin no puede confirmar/descartar nada tampoco
    check('13(h). no-admin no puede confirmar cambios → 403', (await NORMAL.fetch(`/api/radar/changes/${changeId}/confirm`, { method: 'POST' })).status === 403);
    check('13(i). no-admin no puede confirmar oportunidades → 403', (await NORMAL.fetch(`/api/radar/opportunities/${opportunityId}/confirm`, { method: 'POST' })).status === 403);

    // ==== 18. coparentalidad sin regresión ====
    const C = await login('b25-coparent-c@test.local', 'Coparent C');
    const D = await login('b25-coparent-d@test.local', 'Coparent D');
    const coChannel = await C.fetch('/api/channels', { method: 'POST', body: JSON.stringify({}) });
    check('18. coparentalidad: el canal se sigue creando normalmente', coChannel.status === 200, JSON.stringify(coChannel.body));
    if (coChannel.status === 200) {
      const joinRes = await D.fetch('/api/channels/join', { method: 'POST', body: JSON.stringify({ code: coChannel.body.code }) });
      check('18(b). coparentalidad: el segundo integrante se sigue pudiendo unir', joinRes.status === 200);
    }

    // regresión rápida: mediaciones normales siguen funcionando igual
    check('regresión: crear mediación normal (ya probado arriba) siguió devolviendo 200', !!med.id);
  } finally {
    fixtureServer.close();
  }

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
