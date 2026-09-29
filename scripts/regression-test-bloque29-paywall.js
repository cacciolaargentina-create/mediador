// scripts/regression-test-bloque29-paywall.js
// Bloque 29 (Billing + Mercado Pago) §17 — test HTTP real del wiring del
// paywall en routes/mediations.js (no la lógica de entitlements.js en sí,
// ya cubierta exhaustivamente por regression-test-bloque29-engine.js).
// Requiere: server con ENABLE_FAKE_LOGIN=1 Y BILLING_ENFORCE_IN_TEST=1 —
// sin el segundo flag, billingPaywallActive() apaga el paywall a propósito
// para no romper las baterías bloque22/22-automation/24 (ver el comentario
// en routes/mediations.js).
//
// Uso:
//   SQLITE_PATH=/tmp/b31.sqlite ENABLE_FAKE_LOGIN=1 BILLING_ENFORCE_IN_TEST=1 PORT=3098 node server.js &
//   node scripts/regression-test-bloque29-paywall.js http://localhost:3098

const BASE = process.argv[2] || 'http://localhost:3098';

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
      headers['Content-Type'] = 'application/json';
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
  return jar;
}
async function createMediation(jar) {
  return jar.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test paywall' }) });
}

(async function main() {
  console.log(`Bloque 29 §17 — paywall HTTP real contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const user = await login('b31-paywall@test.local', 'Test Paywall FREE');

  const m1 = await createMediation(user);
  check('1ra mediación (FREE, límite 3): 200', m1.status === 200, JSON.stringify(m1.body));
  const m2 = await createMediation(user);
  check('2da mediación: 200', m2.status === 200, JSON.stringify(m2.body));
  const m3 = await createMediation(user);
  check('3ra mediación: 200 (llega justo al límite)', m3.status === 200, JSON.stringify(m3.body));

  const m4 = await createMediation(user);
  check('4ta mediación: 402 (paywall real activo)', m4.status === 402, JSON.stringify(m4.body));
  check('4ta mediación: code PLAN_LIMIT_REACHED', m4.body && m4.body.code === 'PLAN_LIMIT_REACHED', JSON.stringify(m4.body));

  // cerrar una mediación libera el cupo
  const closeRes = await user.fetch(`/api/mediations/${m1.body.id}/close`, { method: 'POST', body: JSON.stringify({ result: 'acuerdo_total', notes: 'test' }) });
  check('cerrar una mediación: 200', closeRes.status === 200, JSON.stringify(closeRes.body));
  const m5 = await createMediation(user);
  check('tras cerrar una, vuelve a permitir crear: 200', m5.status === 200, JSON.stringify(m5.body));

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
