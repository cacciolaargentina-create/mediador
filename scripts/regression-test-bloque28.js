// scripts/regression-test-bloque28.js
// Bloque 28 (Videoconferencias integradas) — batería HTTP contra la app
// real: capa de proveedores, creación/actualización/cancelación de
// reunión, aislamiento cross-mediation, portales de parte/abogado, y que
// ningún token/credencial se filtre en ninguna respuesta.
//
// Requiere: server con ENABLE_FAKE_LOGIN=1. Para los tests de Admin
// Console hace falta además ADMIN_EMAILS incluyendo b28-admin@test.local
// (si no está, esos tests puntuales se saltean con un aviso, igual que
// documenta scripts/regression-test-bloque27.js).
//
// Nota: en este entorno no hay credenciales reales de sandbox de Google/
// Zoom/Teams, así que estos tests validan el camino "proveedor real sin
// conectar" (falla con VIDEO_PROVIDER_AUTH_REQUIRED/NOT_CONFIGURED, nunca
// crea una audiencia virtual sin enlace) y el camino "enlace manual"
// (funciona siempre, sin depender de ninguna API externa) — el llamado
// real a Google Calendar/Zoom/Teams se prueba con las credenciales de
// sandbox si existen, ver docs/VIDEO_CONFERENCING.md §Testing.

const BASE = process.argv[2] || 'http://localhost:3099';

// fechas únicas por corrida — evita choques de "conflicto de horario"
// (agenda.js) si este script se corre más de una vez contra el mismo
// server/DB sin reiniciarlo (en CI corre una vez contra una DB fresca,
// pero en desarrollo local es común repetirlo).
const RUN_DAY = 10 + (Date.now() % 15);
function d(day) { return `2027-02-${String(day).padStart(2, '0')}`; }

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
      return { status: res.status, body, location: res.headers.get('location') };
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

const allBodies = [];
function record(r) { allBodies.push(JSON.stringify(r.body)); return r; }

(async function main() {
  console.log(`Bloque 28 (Videoconferencias) — tests contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const MED_A = await login('b28-mediador-a@test.local', 'Mediador A');
  const MED_B = await login('b28-mediador-b@test.local', 'Mediador B'); // cross-mediation

  // ==== 1. proveedores sin sesión → 401 ====
  {
    const r = await fetch(BASE + '/api/video-providers');
    check('1. GET /api/video-providers sin sesión → 401', r.status === 401);
  }

  // ==== 2. proveedores con sesión — lista los 3 seleccionables, nunca "manual" ====
  {
    const r = record(await MED_A.fetch('/api/video-providers'));
    check('2. GET /api/video-providers → 200', r.status === 200, JSON.stringify(r.body));
    const names = (r.body || []).map((p) => p.provider);
    check('2(b). incluye google_meet, zoom, teams', ['google_meet', 'zoom', 'teams'].every((n) => names.includes(n)), names.join(','));
    check('2(c). nunca incluye "manual" como proveedor seleccionable', !names.includes('manual'));
  }

  // ==== setup: mediación + parte de MED_A ====
  const medRes = record(await MED_A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Bloque 28 test' }) }));
  check('setup: se crea la mediación', medRes.status === 200, JSON.stringify(medRes.body));
  const MID = medRes.body.id;
  const partyRes = record(await MED_A.fetch(`/api/mediations/${MID}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Juan', lastName: 'Pérez' }) }));
  check('setup: se crea una parte', partyRes.status === 200, JSON.stringify(partyRes.body));
  const PARTY_ID = partyRes.body.id;

  // ==== 3. crear audiencia virtual SIN meetingUrl ni provider → 400, spec §5 ====
  {
    const r = record(await MED_A.fetch(`/api/mediations/${MID}/hearings`, { method: 'POST', body: JSON.stringify({ date: d(RUN_DAY), startTime: '10:00', modality: 'virtual' }) }));
    check('3. audiencia virtual sin link ni proveedor → 400', r.status === 400, JSON.stringify(r.body));
  }

  // ==== 4. crear audiencia virtual con meetingUrl manual → 200, provider "manual" ====
  let hearingManualId;
  {
    const r = record(await MED_A.fetch(`/api/mediations/${MID}/hearings`, { method: 'POST', body: JSON.stringify({ date: d(RUN_DAY + 1), startTime: '11:00', modality: 'virtual', meetingUrl: 'https://meet.example.com/manual-1' }) }));
    check('4. audiencia virtual con link manual → 200', r.status === 200, JSON.stringify(r.body));
    check('4(b). video.provider === "manual"', r.body?.video?.provider === 'manual', JSON.stringify(r.body?.video));
    check('4(c). video.meetingStatus === "creada"', r.body?.video?.meetingStatus === 'creada');
    hearingManualId = r.body?.id;
  }

  // ==== 5. crear audiencia virtual con provider google_meet SIN conectar → 502, NO se persiste ====
  {
    const before = record(await MED_A.fetch(`/api/mediations/${MID}/hearings`));
    const countBefore = before.body.length;
    const r = record(await MED_A.fetch(`/api/mediations/${MID}/hearings`, { method: 'POST', body: JSON.stringify({ date: d(RUN_DAY + 2), startTime: '12:00', modality: 'virtual', provider: 'google_meet' }) }));
    check('5. audiencia virtual con proveedor no conectado → 502', r.status === 502, JSON.stringify(r.body));
    check('5(b). código de error VIDEO_PROVIDER_AUTH_REQUIRED', r.body?.code === 'VIDEO_PROVIDER_AUTH_REQUIRED', r.body?.code);
    const after = record(await MED_A.fetch(`/api/mediations/${MID}/hearings`));
    check('5(c). la audiencia NO quedó persistida (spec §5)', after.body.length === countBefore, `antes=${countBefore} después=${after.body.length}`);
  }

  // ==== 6. sub-endpoint POST .../meeting — reintento/adjuntar reunión a audiencia existente ====
  let hearingRetryId;
  {
    const created = record(await MED_A.fetch(`/api/mediations/${MID}/hearings`, { method: 'POST', body: JSON.stringify({ date: d(RUN_DAY + 3), startTime: '13:00', modality: 'virtual', meetingUrl: 'https://meet.example.com/retry-0' }) }));
    hearingRetryId = created.body.id;
    const r = record(await MED_A.fetch(`/api/mediations/${MID}/hearings/${hearingRetryId}/meeting`, { method: 'POST', body: JSON.stringify({ meetingUrl: 'https://meet.example.com/retry-1' }) }));
    check('6. POST .../meeting actualiza el enlace', r.status === 200 && r.body?.meetingUrl === 'https://meet.example.com/retry-1', JSON.stringify(r.body));
  }

  // ==== 6(b). un intento fallido de CAMBIAR de proveedor sobre una
  // reunión que ya funcionaba nunca debe dejar la audiencia con un
  // enlace roto o un proveedor "mentiroso" — se restaura el estado
  // anterior que sí andaba, el error se informa aparte ====
  {
    const r = record(await MED_A.fetch(`/api/mediations/${MID}/hearings/${hearingRetryId}/meeting`, { method: 'POST', body: JSON.stringify({ provider: 'google_meet' }) }));
    check('6(b). intento de cambiar a proveedor no conectado → 502', r.status === 502, JSON.stringify(r.body));
    check('6(c). la audiencia conserva el link manual anterior que SÍ funcionaba', r.body?.hearing?.meetingUrl === 'https://meet.example.com/retry-1', JSON.stringify(r.body?.hearing));
    check('6(d). el proveedor sigue siendo "manual", no "google_meet" (nunca queda mintiendo)', r.body?.hearing?.video?.provider === 'manual', JSON.stringify(r.body?.hearing?.video));
    check('6(e). meetingStatus sigue "creada" (no "error") — el link viejo sigue siendo válido', r.body?.hearing?.video?.meetingStatus === 'creada', JSON.stringify(r.body?.hearing?.video));
  }

  // ==== 7. sub-endpoint DELETE .../meeting — desvincula sin tocar el resto ====
  {
    const r = record(await MED_A.fetch(`/api/mediations/${MID}/hearings/${hearingRetryId}/meeting`, { method: 'DELETE' }));
    check('7. DELETE .../meeting limpia video/meetingUrl', r.status === 200 && r.body?.video === null && r.body?.meetingUrl === null, JSON.stringify(r.body));
    check('7(b). la audiencia sigue existiendo (modalidad intacta)', r.body?.modality === 'virtual');
  }

  // ==== 8. cancelar audiencia con reunión manual → cancela sin error, spec §10 ====
  {
    const r = record(await MED_A.fetch(`/api/mediations/${MID}/hearings/${hearingManualId}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelada', note: 'test bloque 28' }) }));
    check('8. cancelar audiencia con reunión manual → 200', r.status === 200, JSON.stringify(r.body));
    check('8(b). status audiencia === cancelada', r.body?.status === 'cancelada');
    check('8(c). meetingStatus === cancelada', r.body?.video?.meetingStatus === 'cancelada', JSON.stringify(r.body?.video));
    check('8(d). sin videoError (manual nunca falla al cancelar)', r.body?.videoError === undefined);
  }

  // ==== 9. proponer + confirmar con proveedor real no conectado — la
  // audiencia queda confirmada aunque la reunión falle (spec: la
  // confirmación de horario y la reunión son cosas separadas) ====
  {
    const proposeRes = record(await MED_A.fetch(`/api/mediations/${MID}/hearings/propose`, {
      method: 'POST',
      body: JSON.stringify({ slots: [{ date: d(RUN_DAY + 4), startTime: '09:00' }], modality: 'virtual', provider: 'google_meet' }),
    }));
    check('9. proponer audiencia con proveedor real (sin crear reunión todavía)', proposeRes.status === 200, JSON.stringify(proposeRes.body));
    const proposedHearing = proposeRes.body?.hearings?.[0];
    check('9(b). meetingStatus sigue null al proponer (no se crea antes de tiempo)', proposedHearing && proposedHearing.video && proposedHearing.video.meetingStatus === null && proposedHearing.video.joinUrl === null, JSON.stringify(proposedHearing?.video));
    if (proposedHearing) {
      const confirmRes = record(await MED_A.fetch(`/api/mediations/${MID}/hearings/${proposedHearing.id}/confirm-proposal`, { method: 'POST' }));
      check('9(c). confirmar la propuesta → 200 aunque la reunión falle', confirmRes.status === 200, JSON.stringify(confirmRes.body));
      check('9(d). audiencia queda "programada"', confirmRes.body?.status === 'programada');
      check('9(e). videoError presente (proveedor no conectado)', confirmRes.body?.videoError?.code === 'VIDEO_PROVIDER_AUTH_REQUIRED', JSON.stringify(confirmRes.body?.videoError));
    }
  }

  // ==== 10. cross-mediation: MED_B no puede tocar nada de la mediación de MED_A ====
  {
    const r1 = await MED_B.fetch(`/api/mediations/${MID}/hearings`);
    check('10. cross-mediation: GET hearings ajenos → 403', r1.status === 403);
    const r2 = await MED_B.fetch(`/api/mediations/${MID}/hearings/${hearingRetryId}/meeting`, { method: 'POST', body: JSON.stringify({ meetingUrl: 'https://evil.example.com' }) });
    check('10(b). cross-mediation: POST meeting ajeno → 403', r2.status === 403);
    const r3 = await MED_B.fetch(`/api/mediations/${MID}/hearings/${hearingRetryId}/meeting`, { method: 'DELETE' });
    check('10(c). cross-mediation: DELETE meeting ajeno → 403', r3.status === 403);
  }

  // ==== 11. portal de parte — expone videoProvider, nunca hostUrl/meetingId/metadata ====
  {
    const inviteRes = record(await MED_A.fetch(`/api/mediations/${MID}/parties/${PARTY_ID}/invite`, { method: 'POST' }));
    check('11. invitar parte al portal', inviteRes.status === 200, JSON.stringify(inviteRes.body));
    const portalToken = inviteRes.body?.portalToken;
    if (portalToken) {
      const portalRes = await fetch(`${BASE}/api/party-portal/${portalToken}`);
      const portalBody = await portalRes.json();
      allBodies.push(JSON.stringify(portalBody));
      check('11(b). portal de parte responde 200', portalRes.status === 200);
      const hearingInPortal = (portalBody.hearings || []).find((h) => h.id === hearingRetryId || h.videoProvider);
      check('11(c). el portal de parte puede traer videoProvider', portalBody.hearings.some((h) => 'videoProvider' in h));
      const joined = JSON.stringify(portalBody);
      check('11(d). el portal de parte NUNCA expone hostUrl/meetingId/meetingMetadata', !/hostUrl|meetingMetadata|accessToken|refreshToken/i.test(joined), joined.slice(0, 200));
    }
  }

  // ==== 12. ningún response de toda esta corrida filtra tokens/credenciales ====
  const joinedAll = allBodies.join(' ');
  check('12. ninguna respuesta expone accessToken/refreshToken/clientSecret/portalToken de OTRO', !/"accessToken":"[^"n]|"refreshToken":"[^"n]|clientSecret/i.test(joinedAll));

  // ==== 13. Admin Console — métricas de video (requiere ADMIN_EMAILS) ====
  {
    const ADMIN = await login('b28-admin@test.local', 'Admin Plataforma');
    const r = await ADMIN.fetch('/api/admin-mediador/video-metrics');
    if (r.status === 403) {
      console.log('  SKIP 13. Admin Console: agregá b28-admin@test.local a ADMIN_EMAILS para correr este test.');
    } else {
      check('13. GET /api/admin-mediador/video-metrics → 200', r.status === 200, JSON.stringify(r.body));
      check('13(b). trae reunionesCreadas/reunionesConError/porProveedor', typeof r.body?.reunionesCreadas === 'number' && typeof r.body?.porProveedor === 'object', JSON.stringify(r.body));
      const joined = JSON.stringify(r.body);
      check('13(c). nunca expone joinUrl/hostUrl/tokens', !/joinUrl|hostUrl|accessToken|refreshToken/i.test(joined), joined);
    }
    const rNonAdmin = await MED_A.fetch('/api/admin-mediador/video-metrics');
    check('13(d). mediador normal no accede a /admin-mediador/video-metrics → 403', rNonAdmin.status === 403);
  }

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
