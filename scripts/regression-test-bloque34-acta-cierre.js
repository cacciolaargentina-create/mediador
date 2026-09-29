// scripts/regression-test-bloque34-acta-cierre.js
// Bloque 34 — Acta de Cierre automática. Test HTTP real: no existe antes
// de cerrar (400), existe y es un PDF válido después de cerrar, el hash es
// determinístico (descargarla dos veces no rompe el commit — mismo riesgo
// ya documentado para /export y /export/constancia), y una mediación
// AJENA no puede descargarse (regresión de aislamiento, mismo criterio que
// el resto de las rutas de export).
//
// Requiere: server con ENABLE_FAKE_LOGIN=1.
// Uso:
//   SQLITE_PATH=/tmp/b34.sqlite ENABLE_FAKE_LOGIN=1 PORT=3199 node server.js &
//   node scripts/regression-test-bloque34-acta-cierre.js http://localhost:3199

const BASE = process.argv[2] || 'http://localhost:3199';

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
      const buf = Buffer.from(await res.arrayBuffer());
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      return { status: res.status, headers: res.headers, buf, body };
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

(async function main() {
  console.log(`Bloque 34 — Acta de Cierre automática, contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const mediador = await login('b34-mediador@test.local', 'Mediador Test B34');
  const otro = await login('b34-otro@test.local', 'Otro Mediador B34');

  const med = (await mediador.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Test acta de cierre' }) })).body;
  check('setup: mediación creada', !!med.id);

  const before = await mediador.fetch(`/api/mediations/${med.id}/export/acta-cierre`);
  check('1. antes de cerrar: 400 (todavía no hay nada que generar)', before.status === 400, JSON.stringify(before.body));

  const closeRes = await mediador.fetch(`/api/mediations/${med.id}/close`, { method: 'POST', body: JSON.stringify({ result: 'acuerdo_total', notes: 'Las partes acordaron un plan de pagos en 6 cuotas.' }) });
  check('setup: mediación cerrada', closeRes.status === 200, JSON.stringify(closeRes.body));

  const acta1 = await mediador.fetch(`/api/mediations/${med.id}/export/acta-cierre`);
  check('2. después de cerrar: 200', acta1.status === 200, JSON.stringify(acta1.body));
  check('2(b). content-type application/pdf', (acta1.headers.get('content-type') || '').includes('application/pdf'));
  check('2(c). es un PDF real (empieza con %PDF)', acta1.buf.slice(0, 4).toString('ascii') === '%PDF');
  check('2(d). el PDF tiene contenido real (no un archivo vacío/roto)', acta1.buf.length > 2000, `${acta1.buf.length} bytes`);

  // hash determinístico: descargarla de nuevo sin cambios no debe romper
  // el commit (mismo riesgo ya documentado en /export y /export/constancia).
  const acta2 = await mediador.fetch(`/api/mediations/${med.id}/export/acta-cierre`);
  check('3. descargar de nuevo sin cambios: sigue dando 200 (no rompe el commit)', acta2.status === 200, JSON.stringify(acta2.body));
  const acta3 = await mediador.fetch(`/api/mediations/${med.id}/export/acta-cierre`);
  check('3(b). una tercera vez también: 200', acta3.status === 200);

  // regresión: algo totalmente no relacionado (crear otra mediación) sigue
  // funcionando después de las descargas repetidas — si el commit se
  // hubiera roto, esto fallaría.
  const sanity = await mediador.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Sanity post-acta' }) });
  check('3(c). sanity: crear otra mediación después sigue funcionando (commit no roto)', sanity.status === 200, JSON.stringify(sanity.body));

  // aislamiento: otro mediador no puede descargar el acta de esta mediación
  const cross = await otro.fetch(`/api/mediations/${med.id}/export/acta-cierre`);
  check('4. mediador ajeno no puede descargar el acta: 403', cross.status === 403, JSON.stringify(cross.body));

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
