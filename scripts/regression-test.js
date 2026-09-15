// scripts/regression-test.js
// Bloque 18 — batería de regresión real (HTTP/API), no unitaria. Corre
// contra un server ya levantado con ENABLE_FAKE_LOGIN=1 y una base
// descartable (NUNCA correr esto contra producción — usa fake-login y
// crea datos de prueba reales).
//
// Uso:
//   SQLITE_PATH=/tmp/regression.sqlite ENABLE_FAKE_LOGIN=1 PORT=3199 node server.js &
//   node scripts/regression-test.js http://localhost:3199
//
// Cubre específicamente el aislamiento entre mediaciones/estudios/
// portales — la superficie que Bloque 18 §7 pidió auditar — y el bug de
// IDOR encontrado y corregido en esa auditoría (confirmaciones de
// audiencia sin verificar mediationId).

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3099';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function api(base, path, opts = {}) {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* respuesta no-JSON (ej. binario de un download) */ }
  return { status: res.status, body, headers: res.headers };
}

function cookieJar() {
  let cookie = null;
  return {
    async fetch(path, opts = {}) {
      // Content-Type por default — sin esto, express.json() no parsea el
      // body y cualquier POST/PATCH con JSON falla en silencio (esto rompió
      // la primera versión de este script: parecía un fallo de aislamiento
      // real pero era el propio script mandando el body sin Content-Type).
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, { ...opts, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch (e) { /* ok si no es JSON */ }
      return { status: res.status, body };
    },
  };
}

async function login(email, name) {
  const jar = cookieJar();
  const r = await jar.fetch('/auth/fake-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  });
  if (r.status !== 200) throw new Error(`No se pudo loguear ${email}: ${JSON.stringify(r.body)} — ¿el server tiene ENABLE_FAKE_LOGIN=1?`);
  jar.userId = r.body.user.id;
  return jar;
}

(async function main() {
  console.log(`Regresión Bloque 18 contra ${BASE}\n`);

  const health = await api(BASE, '/api/health');
  if (health.status !== 200) {
    console.error('El servidor no responde en /api/health — abortando.');
    process.exit(1);
  }

  const A = await login('regression-a@test.local', 'Regresión A');
  const B = await login('regression-b@test.local', 'Regresión B');

  console.log('\n== Aislamiento entre mediaciones ==');
  const medA = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Regresión A' }) })).body;
  const medB = (await B.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Regresión B' }) })).body;

  check('B no puede ver la mediación de A', (await B.fetch(`/api/mediations/${medA.id}`)).status === 403);
  check('B no puede listar partes de la mediación de A', (await B.fetch(`/api/mediations/${medA.id}/parties`)).status === 403);
  check('B no puede editar la mediación de A', (await B.fetch(`/api/mediations/${medA.id}`, { method: 'PATCH', body: JSON.stringify({ description: 'hack' }) })).status === 403);
  check('B no puede cerrar la mediación de A', (await B.fetch(`/api/mediations/${medA.id}/close`, { method: 'POST', body: JSON.stringify({ result: 'acuerdo_total' }) })).status === 403);
  check('ID de mediación inexistente da 404 (no 500)', (await B.fetch('/api/mediations/no-existe')).status === 404);

  console.log('\n== IDOR de confirmaciones de audiencia (bug encontrado en Bloque 18, corregido) ==');
  const partyA = (await A.fetch(`/api/mediations/${medA.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'Parte', lastName: 'A' }) })).body;
  const hearingA = (await A.fetch(`/api/mediations/${medA.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-01-15', startTime: '10:00', modality: 'presencial', location: 'Sala 1' }) })).body;
  // B tiene acceso legítimo a SU PROPIA mediación (medB) — el exploit intenta
  // usar ese acceso legítimo para tocar una audiencia de la mediación de A.
  const exploit = await B.fetch(`/api/mediations/${medB.id}/hearings/${hearingA.id}/confirmations/${partyA.id}`, {
    method: 'POST', body: JSON.stringify({ response: 'confirma' }),
  });
  check('B no puede confirmar una audiencia de la mediación de A vía su propio :id', exploit.status === 404, `status=${exploit.status}`);
  const stillPending = (await A.fetch(`/api/mediations/${medA.id}/hearings`)).body[0].confirmations[0];
  check('la confirmación de A sigue intacta (pendiente) después del intento', stillPending.response === 'pendiente');

  console.log('\n== Documentos ==');
  // multipart real (archivo .txt rechazado por tipo, PDF válido aceptado,
  // descarga cruzada entre mediaciones) se corrió a mano con curl -F
  // durante la auditoría — un body JSON plano nunca llega a multer, así
  // que probarlo acá solo confirmaría que falta el archivo, no el tipo.
  check('subir documento sin archivo falla con 400 (no 500)', (await A.fetch(`/api/mediations/${medA.id}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'otro' }) })).status === 400);
  check('path traversal en docId da 404, no 500', (await A.fetch(`/api/mediations/${medA.id}/documents/${encodeURIComponent('../../../etc/passwd')}/download`)).status === 404);

  console.log('\n== Portal de partes ==');
  const invite = await A.fetch(`/api/mediations/${medA.id}/parties/${partyA.id}/invite`, { method: 'POST' });
  const token = invite.body.portalToken;
  check('token inválido da 404', (await api(BASE, '/api/party-portal/token-que-no-existe')).status === 404);
  check('token válido carga la mediación correcta', (await api(BASE, `/api/party-portal/${token}`)).body.mediationCode === medA.code);
  const regen = await A.fetch(`/api/mediations/${medA.id}/parties/${partyA.id}/invite`, { method: 'POST' });
  check('token viejo queda invalidado tras regenerar', (await api(BASE, `/api/party-portal/${token}`)).status === 404);
  check('token nuevo funciona', (await api(BASE, `/api/party-portal/${regen.body.portalToken}`)).status === 200);

  console.log('\n== Estudios / multiusuario ==');
  const studio = await A.fetch('/api/studios', { method: 'POST', body: JSON.stringify({ name: 'Estudio Regresión' }) });
  check('estudio creado', studio.status === 200);
  check('B (no admin) no puede invitar gente al estudio de A', (await B.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'x@test.com', role: 'admin' }) })).status === 403);
  check('el propietario no puede abandonar el estudio directamente', (await A.fetch('/api/studios/leave', { method: 'POST' })).status === 400);

  console.log(`\n${passed} pasaron, ${failed} fallaron.`);
  if (failed > 0) {
    console.log('\nFallidas:', failures.join(', '));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('Error ejecutando la regresión:', e);
  process.exit(1);
});
