// scripts/regression-test-bloque25-engine.js
// Bloque 25 (radar competitivo) — tests de radarScraper.js/radarEngine.js/
// radarJobs.js SIN pegarle a ningún sitio externo real: todo lo que necesita
// red usa un servidor HTTP local de fixtures (ver startFixtureServer). Esto
// cubre los tests 1-11 y 16 de la spec (§24). Los tests de permisos/
// aislamiento/rate-limit HTTP (12-15, 17-18) están en
// regression-test-bloque25.js, contra la app real.
//
// Corre standalone (requiere db.js directo, como
// regression-test-bloque22-automation-engine.js) — necesita SQLITE_PATH
// apuntando a una base descartable.

const http = require('http');
const path = require('path');
process.env.SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'test-b25-engine.sqlite');

const radarScraper = require('../radarScraper');
const radarEngine = require('../radarEngine');
const radarJobs = require('../radarJobs');
const { getDB, commit } = require('../db');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

const FIXTURE_PAGE_V1 = `<html><head><title>Fixture Competitor</title><meta name="description" content="Software de mediación online"></head>
<body><nav>menu irrelevante</nav>
<h1>Fixture Competitor</h1>
<p>Ofrece agenda inteligente y gestión de partes.</p>
<p>Plan Basic ARS 40000 /mes</p>
<script>var x = Math.random();</script>
</body></html>`;

const FIXTURE_PAGE_V1_NOISE = `<html><head><title>Fixture Competitor</title><meta name="description" content="Software de mediación online"></head>
<body><nav>otro menu, distinto texto de navegación</nav>
<h1>Fixture Competitor</h1>
<p>Ofrece agenda inteligente y gestión de partes.</p>
<p>Plan Basic ARS 40000 /mes</p>
<script>var x = 999;</script>
<!-- comentario random ${Date.now()} -->
</body></html>`;

const FIXTURE_PAGE_V2_FEATURE = `<html><head><title>Fixture Competitor</title><meta name="description" content="Software de mediación online"></head>
<body>
<h1>Fixture Competitor</h1>
<p>Ofrece agenda inteligente con disponibilidad automática y Google Calendar.</p>
<p>Plan Basic ARS 40000 /mes</p>
</body></html>`;

const FIXTURE_PAGE_V3_PRICE = `<html><head><title>Fixture Competitor</title></head>
<body><p>Ofrece agenda inteligente y gestión de partes.</p><p>Plan Basic ARS 55000 /mes</p></body></html>`;

function startFixtureServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/normal') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FIXTURE_PAGE_V1); }
    else if (req.url === '/normal-noise') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FIXTURE_PAGE_V1_NOISE); }
    else if (req.url === '/feature-change') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FIXTURE_PAGE_V2_FEATURE); }
    else if (req.url === '/price-change') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FIXTURE_PAGE_V3_PRICE); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/normal' }); res.end(); }
    else if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('<html><body>tarde</body></html>'); }, 3000); }
    else { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

(async function main() {
  console.log('Bloque 25 (radar) — tests de scraper/engine/jobs, sin red externa\n');
  const server = await startFixtureServer(3098);
  const BASE = 'http://127.0.0.1:3098';

  try {
    // ==== 1. fuente válida ====
    const r1 = await radarScraper.checkSource({ url: `${BASE}/normal` });
    check('1. fuente válida: ok=true, status=200, título extraído', r1.ok && r1.status === 200 && r1.content.title === 'Fixture Competitor', JSON.stringify(r1));

    // ==== 2. fuente inexistente (404) ====
    const r2 = await radarScraper.checkSource({ url: `${BASE}/no-existe` });
    check('2. fuente inexistente: ok=false, error menciona HTTP 404', !r2.ok && /404/.test(r2.error), JSON.stringify(r2));

    // ==== 3. timeout ====
    const r3 = await radarScraper.checkSource({ url: `${BASE}/slow` }, { timeoutMs: 500, retries: 0 });
    check('3. timeout: ok=false, error="Timeout"', !r3.ok && r3.error === 'Timeout', JSON.stringify(r3));

    // ==== 4. redirect ====
    const r4 = await radarScraper.checkSource({ url: `${BASE}/redirect` });
    check('4. redirect: se sigue y llega al contenido de destino', r4.ok && r4.content.title === 'Fixture Competitor', JSON.stringify(r4));

    // ==== 5. contenido sin cambios ====
    const r5a = await radarScraper.checkSource({ url: `${BASE}/normal` });
    const r5b = await radarScraper.checkSource({ url: `${BASE}/normal` });
    check('5. contenido sin cambios: mismo contentHash en dos chequeos seguidos', r5a.contentHash === r5b.contentHash);

    // ==== 6. contenido modificado ====
    const r6 = await radarScraper.checkSource({ url: `${BASE}/feature-change` });
    check('6. contenido modificado: contentHash distinto al original', r6.contentHash !== r1.contentHash);

    // ==== 9. cambio falso por HTML irrelevante (nav distinto + script + comentario) ====
    const r9 = await radarScraper.checkSource({ url: `${BASE}/normal-noise` });
    check('9. ruido de HTML irrelevante (nav/script/comentario) NO cambia el contentHash', r9.contentHash === r1.contentHash, `r1=${r1.contentHash} r9=${r9.contentHash}`);

    // ==== engine: detectFeatures ====
    const detections = radarEngine.detectFeatures('Ofrece agenda inteligente, incluye integración con Google Calendar de forma nativa para todos los planes disponibles hoy mismo. Muy lejos de ahí: próximamente vamos a sumar firma digital.');
    const agenda = detections.find((d) => d.feature === 'agenda');
    const calendar = detections.find((d) => d.feature === 'google_calendar');
    const firma = detections.find((d) => d.feature === 'firma_digital');
    check('detectFeatures: "agenda" detectada con evidencia', !!agenda && !!agenda.evidence);
    check('detectFeatures: "google_calendar" con palabra afirmativa cercana → confirmada', calendar && calendar.status === 'confirmada', JSON.stringify(calendar));
    check('detectFeatures: "firma_digital" con "próximamente" cerca → no_confirmada', firma && firma.status === 'no_confirmada', JSON.stringify(firma));

    // ==== engine: parsePriceEntries ====
    const prices = radarEngine.parsePriceEntries('Plan Basic ARS 40000 /mes | Plan Pro USD 99 /mes | texto sin precio');
    check('parsePriceEntries: detecta 2 planes con precio', prices.length === 2, JSON.stringify(prices));
    check('parsePriceEntries: moneda y periodicidad correctas', prices[0].currency === 'ARS' && prices[0].periodicity === 'mes', JSON.stringify(prices[0]));

    // ==== engine: classifyChange ====
    const prevSnap = { pricingText: 'Plan Basic ARS 40000 /mes', featuresText: 'Ofrece agenda inteligente', integrationsText: null, title: 'Fixture' };
    check('classifyChange: primera vez (sin snapshot previo) = null (línea de base, no es un cambio)', radarEngine.classifyChange(null, { pricingText: 'x' }) === null);
    const priceChange = radarEngine.classifyChange(prevSnap, { ...prevSnap, pricingText: 'Plan Basic ARS 55000 /mes' });
    check('7. nuevo precio → type=cambio_precio, level=HIGH', priceChange.type === 'cambio_precio' && priceChange.level === 'HIGH', JSON.stringify(priceChange));
    const featureChange = radarEngine.classifyChange(prevSnap, { ...prevSnap, featuresText: 'Ofrece agenda inteligente y gestión de tareas' });
    check('8. nueva funcionalidad (no de alto impacto) → type=nueva_funcionalidad, level=MEDIUM', featureChange.type === 'nueva_funcionalidad' && featureChange.level === 'MEDIUM', JSON.stringify(featureChange));
    const highImpactChange = radarEngine.classifyChange(prevSnap, { ...prevSnap, featuresText: 'Ofrece agenda inteligente con integración con Google Calendar' });
    check('nueva integración de alto impacto (Google Calendar) → level=HIGH', highImpactChange.level === 'HIGH', JSON.stringify(highImpactChange));

    // ==== engine: applyCheckResult contra la DB real (aislado, SQLITE_PATH propio) ====
    const db = getDB();
    const now = Date.now();
    const source = {
      id: 'test-source-1', name: 'Fixture Competitor', url: `${BASE}/normal`, category: 'competidor',
      active: true, checkFrequency: 'weekly', lastCheckedAt: null, lastChangedAt: null, lastHash: null,
      notes: null, createdAt: now, updatedAt: now,
    };
    db.competitorSources.push(source);

    const check1 = await radarScraper.checkSource(source);
    const applied1 = radarEngine.applyCheckResult(db, source, check1, now);
    check('applyCheckResult: primer chequeo establece línea de base (changed=false, sin change row)', applied1.ok && applied1.changed === false && !applied1.change);
    check('applyCheckResult: guardó 1 snapshot', db.competitorSnapshots.filter((s) => s.sourceId === source.id).length === 1);

    const check2 = await radarScraper.checkSource(source);
    const applied2 = radarEngine.applyCheckResult(db, source, check2, now + 1000);
    check('applyCheckResult: segundo chequeo con mismo contenido → changed=false', applied2.ok && applied2.changed === false);

    // fuente apuntada a nueva URL con precio distinto, simulando que cambió afuera
    source.url = `${BASE}/price-change`;
    const check3 = await radarScraper.checkSource(source);
    const applied3 = radarEngine.applyCheckResult(db, source, check3, now + 2000);
    check('applyCheckResult: cambio real de precio → changed=true, crea change HIGH', applied3.ok && applied3.changed === true && applied3.change && applied3.change.level === 'HIGH', JSON.stringify(applied3.change));

    // repetir el MISMO chequeo (mismo contenido en /price-change) no debe duplicar el change ni el precio
    const check4 = await radarScraper.checkSource(source);
    const applied4 = radarEngine.applyCheckResult(db, source, check4, now + 3000);
    check('10. detección duplicada: repetir el mismo contenido no crea un segundo change', applied4.changed === false);
    const priceRowsForSource = db.competitorPrices.filter((p) => p.sourceId === source.id);
    check('10(b). no se duplicó la fila de precio para el mismo plan/valor', priceRowsForSource.filter((p) => p.price === '55000').length === 1, JSON.stringify(priceRowsForSource));

    await commit();

    // ==== 16. scheduler idempotente ====
    check('isDue: fuente manual nunca está due', radarJobs.isDue({ active: true, checkFrequency: 'manual', lastCheckedAt: null }, Date.now()) === false);
    check('isDue: fuente inactiva nunca está due', radarJobs.isDue({ active: false, checkFrequency: 'daily', lastCheckedAt: null }, Date.now()) === false);
    check('isDue: fuente nunca chequeada está due', radarJobs.isDue({ active: true, checkFrequency: 'weekly', lastCheckedAt: null }, Date.now()) === true);
    check('isDue: fuente semanal chequeada hace 1 día NO está due', radarJobs.isDue({ active: true, checkFrequency: 'weekly', lastCheckedAt: Date.now() - 24 * 60 * 60 * 1000 }, Date.now()) === false);
    check('isDue: fuente semanal chequeada hace 8 días SÍ está due', radarJobs.isDue({ active: true, checkFrequency: 'weekly', lastCheckedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }, Date.now()) === true);

    const source2 = {
      id: 'test-source-2', name: 'Fixture Due Source', url: `${BASE}/normal`, category: 'mercado',
      active: true, checkFrequency: 'daily', lastCheckedAt: null, lastChangedAt: null, lastHash: null,
      notes: null, createdAt: now, updatedAt: now,
    };
    db.competitorSources.push(source2);
    await commit();
    const run1 = await radarJobs.checkDueSources();
    const run2 = await radarJobs.checkDueSources();
    check('16. scheduler idempotente: 1er run chequea la fuente due', run1.checked >= 1, JSON.stringify(run1));
    check('16(b). scheduler idempotente: 2do run inmediato no la vuelve a chequear (ya no está due)', run2.checked === 0, JSON.stringify(run2));
    const snapshotsForSource2 = db.competitorSnapshots.filter((s) => s.sourceId === source2.id);
    check('16(c). solo hay 1 snapshot para la fuente tras las 2 corridas', snapshotsForSource2.length === 1, String(snapshotsForSource2.length));

  } finally {
    server.close();
  }

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
