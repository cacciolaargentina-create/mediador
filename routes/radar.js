// routes/radar.js
// Bloque 25 — Radar competitivo. Herramienta EXCLUSIVAMENTE interna (§20):
// todo endpoint de acá exige isAdminUser, igual que routes/admin.js — no se
// creó un sistema de autorización nuevo, se reusó el mismo (roles.js). Nunca
// se expone nada de esto a mediadores/asistentes/partes/abogados.
//
// La lógica de red vive en radarScraper.js, la lógica de clasificación en
// radarEngine.js — acá solo se cablean las dos cosas contra la base y se
// aplican los permisos, mismo patrón que el resto de routes/*.js.

const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { isAdminUser } = require('../roles');
const radarScraper = require('../radarScraper');
const radarEngine = require('../radarEngine');

// §17 — ni un admin apurado puede gatillar chequeos manuales sin límite
// contra el mismo sitio; esto es ADEMÁS del rate limit por dominio que ya
// tiene radarScraper (ese protege al sitio ajeno, este protege de spam de
// clicks desde nuestra propia UI). Configurable solo para que los tests
// automáticos (scripts/regression-test-bloque25.js) no tengan que esperar
// 30s reales para probar el mecanismo — en producción (.env sin esta
// variable) queda siempre en 30s.
const MIN_MANUAL_CHECK_INTERVAL_MS = Number(process.env.RADAR_MIN_MANUAL_CHECK_MS) || 30 * 1000;

function serializeSource(s) {
  return {
    id: s.id, name: s.name, url: s.url, category: s.category, active: !!s.active,
    checkFrequency: s.checkFrequency, lastCheckedAt: s.lastCheckedAt || null,
    lastChangedAt: s.lastChangedAt || null, notes: s.notes || null,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}
function serializeChange(c) {
  return {
    id: c.id, sourceId: c.sourceId, type: c.type, level: c.level, title: c.title,
    beforeText: c.beforeText, afterText: c.afterText, evidenceText: c.evidenceText,
    detectedAt: c.detectedAt, status: c.status, reviewedBy: c.reviewedBy || null, reviewedAt: c.reviewedAt || null,
  };
}
function serializeOpportunity(o) {
  return {
    id: o.id, title: o.title, observation: o.observation, evidence: o.evidence,
    sourceId: o.sourceId || null, changeId: o.changeId || null, status: o.status,
    createdAt: o.createdAt, confirmedBy: o.confirmedBy || null, confirmedAt: o.confirmedAt || null,
  };
}
function serializePrice(p) {
  return {
    id: p.id, sourceId: p.sourceId, plan: p.plan, price: p.price, currency: p.currency,
    periodicity: p.periodicity, mediationLimit: p.mediationLimit || null,
    featuresText: p.featuresText, detectedAt: p.detectedAt,
  };
}
function serializeFeatureDetection(d) {
  return { id: d.id, sourceId: d.sourceId, feature: d.feature, status: d.status, evidence: d.evidence, detectedAt: d.detectedAt };
}

const VALID_CATEGORIES = ['competidor', 'oficial', 'regulatorio', 'mercado'];
const VALID_FREQUENCIES = ['daily', 'weekly', 'manual'];

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }
  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!isAdminUser(req.user)) return res.status(403).json({ error: 'No tenés acceso al radar competitivo' });
    next();
  }
  router.use(requireAuth, requireAdmin);

  // ---------- fuentes (§2/§23) ----------
  router.get('/sources', (req, res) => {
    const db = getDB();
    res.json([...db.competitorSources].sort((a, b) => a.name.localeCompare(b.name)).map(serializeSource));
  });

  router.post('/sources', async (req, res) => {
    const { name, url, category, checkFrequency, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Falta el nombre de la fuente' });
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'La URL tiene que ser pública y empezar con http(s)://' });
    if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: `Categoría inválida — usar una de: ${VALID_CATEGORIES.join(', ')}` });
    const freq = checkFrequency && VALID_FREQUENCIES.includes(checkFrequency) ? checkFrequency : 'weekly';
    const db = getDB();
    const now = Date.now();
    const source = {
      id: nanoid(), name: name.trim(), url: url.trim(), category, active: true,
      checkFrequency: freq, lastCheckedAt: null, lastChangedAt: null, lastHash: null,
      notes: notes || null, createdAt: now, updatedAt: now,
    };
    db.competitorSources.push(source);
    await commit();
    res.json(serializeSource(source));
  });

  router.patch('/sources/:id', async (req, res) => {
    const db = getDB();
    const source = db.competitorSources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'Fuente no encontrada' });
    const { name, url, category, checkFrequency, active, notes } = req.body || {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
      source.name = name.trim();
    }
    if (url !== undefined) {
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'La URL tiene que ser pública y empezar con http(s)://' });
      source.url = url.trim();
    }
    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: `Categoría inválida — usar una de: ${VALID_CATEGORIES.join(', ')}` });
      source.category = category;
    }
    if (checkFrequency !== undefined) {
      if (!VALID_FREQUENCIES.includes(checkFrequency)) return res.status(400).json({ error: `Frecuencia inválida — usar una de: ${VALID_FREQUENCIES.join(', ')}` });
      source.checkFrequency = checkFrequency;
    }
    if (active !== undefined) source.active = !!active;
    if (notes !== undefined) source.notes = notes;
    source.updatedAt = Date.now();
    await commit();
    res.json(serializeSource(source));
  });

  // ---------- chequeo manual (§3/§17) ----------
  router.post('/sources/:id/check', async (req, res) => {
    const db = getDB();
    const source = db.competitorSources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'Fuente no encontrada' });
    if (source.lastCheckedAt && Date.now() - source.lastCheckedAt < MIN_MANUAL_CHECK_INTERVAL_MS) {
      return res.status(429).json({ error: 'Esta fuente se chequeó hace muy poco — esperá antes de volver a pedirlo (protege al sitio de afuera de recibir requests de más)' });
    }
    const scraperResult = await radarScraper.checkSource(source);
    const result = radarEngine.applyCheckResult(db, source, scraperResult);
    await commit();
    res.json({
      ok: result.ok, error: result.error || null, changed: !!result.changed,
      change: result.change ? serializeChange(result.change) : null,
    });
  });

  // ---------- cambios / alertas (§4/§6/§12/§13) ----------
  router.get('/changes', (req, res) => {
    const db = getDB();
    let list = [...db.competitorChanges];
    if (req.query.status) list = list.filter((c) => c.status === req.query.status);
    if (req.query.sourceId) list = list.filter((c) => c.sourceId === req.query.sourceId);
    if (req.query.level) list = list.filter((c) => c.level === req.query.level);
    list.sort((a, b) => b.detectedAt - a.detectedAt);
    res.json(list.map(serializeChange));
  });

  router.post('/changes/:id/confirm', async (req, res) => {
    const db = getDB();
    const change = db.competitorChanges.find((c) => c.id === req.params.id);
    if (!change) return res.status(404).json({ error: 'Cambio no encontrado' });
    change.status = 'revisada';
    change.reviewedBy = req.user.id;
    change.reviewedAt = Date.now();
    await commit();
    res.json(serializeChange(change));
  });

  router.post('/changes/:id/dismiss', async (req, res) => {
    const db = getDB();
    const change = db.competitorChanges.find((c) => c.id === req.params.id);
    if (!change) return res.status(404).json({ error: 'Cambio no encontrado' });
    change.status = 'descartada';
    change.reviewedBy = req.user.id;
    change.reviewedAt = Date.now();
    await commit();
    res.json(serializeChange(change));
  });

  // §9/§13 — "Crear oportunidad" a partir de un cambio: SIEMPRE una acción
  // humana explícita, nunca automática. title/observation los escribe quien
  // confirma (el sistema solo pre-completa con la evidencia del cambio).
  router.post('/changes/:id/create-opportunity', async (req, res) => {
    const db = getDB();
    const change = db.competitorChanges.find((c) => c.id === req.params.id);
    if (!change) return res.status(404).json({ error: 'Cambio no encontrado' });
    const { title, observation } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Falta el título de la oportunidad' });
    const now = Date.now();
    const opportunity = {
      id: nanoid(), title: title.trim(), observation: observation || change.title,
      evidence: change.evidenceText, sourceId: change.sourceId, changeId: change.id,
      status: 'pendiente', createdAt: now, confirmedBy: null, confirmedAt: null,
    };
    db.competitorOpportunities.push(opportunity);
    change.status = 'convertida_en_oportunidad';
    change.reviewedBy = req.user.id;
    change.reviewedAt = now;
    await commit();
    res.json(serializeOpportunity(opportunity));
  });

  // ---------- oportunidades (§9/§13/§23) ----------
  router.get('/opportunities', (req, res) => {
    const db = getDB();
    let list = [...db.competitorOpportunities];
    if (req.query.status) list = list.filter((o) => o.status === req.query.status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    res.json(list.map(serializeOpportunity));
  });

  router.post('/opportunities/:id/confirm', async (req, res) => {
    const db = getDB();
    const opp = db.competitorOpportunities.find((o) => o.id === req.params.id);
    if (!opp) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    opp.status = 'confirmada';
    opp.confirmedBy = req.user.id;
    opp.confirmedAt = Date.now();
    await commit();
    res.json(serializeOpportunity(opp));
  });

  router.post('/opportunities/:id/dismiss', async (req, res) => {
    const db = getDB();
    const opp = db.competitorOpportunities.find((o) => o.id === req.params.id);
    if (!opp) return res.status(404).json({ error: 'Oportunidad no encontrada' });
    opp.status = 'descartada';
    opp.confirmedBy = req.user.id;
    opp.confirmedAt = Date.now();
    await commit();
    res.json(serializeOpportunity(opp));
  });

  // ---------- ficha del competidor (§15/§23) ----------
  router.get('/competitors/:id', (req, res) => {
    const db = getDB();
    const source = db.competitorSources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'Fuente no encontrada' });
    const snapshots = db.competitorSnapshots.filter((s) => s.sourceId === source.id).sort((a, b) => b.checkedAt - a.checkedAt);
    const features = db.competitorFeatureDetections.filter((f) => f.sourceId === source.id);
    const prices = db.competitorPrices.filter((p) => p.sourceId === source.id).sort((a, b) => b.detectedAt - a.detectedAt);
    const changes = db.competitorChanges.filter((c) => c.sourceId === source.id).sort((a, b) => b.detectedAt - a.detectedAt);
    const opportunities = db.competitorOpportunities.filter((o) => o.sourceId === source.id);
    res.json({
      source: serializeSource(source),
      latestSnapshot: snapshots[0] ? { checkedAt: snapshots[0].checkedAt, title: snapshots[0].title, description: snapshots[0].description } : null,
      features: features.map(serializeFeatureDetection),
      prices: prices.map(serializePrice),
      changes: changes.map(serializeChange),
      opportunities: opportunities.map(serializeOpportunity),
    });
  });

  // ---------- matriz competitiva (§8) ----------
  router.get('/matrix', (req, res) => {
    const db = getDB();
    const sources = db.competitorSources.filter((s) => ['competidor', 'oficial'].includes(s.category));
    const rows = [];
    for (const cat of radarEngine.FEATURE_CATALOG) {
      rows.push({
        feature: cat.key, label: cat.label,
        mediador: radarEngine.MEDIADOR_FEATURES[cat.key] || 'no_confirmada',
        competitors: sources.map((s) => {
          const detection = db.competitorFeatureDetections.find((d) => d.sourceId === s.id && d.feature === cat.key);
          return {
            sourceId: s.id, sourceName: s.name,
            status: detection ? detection.status : 'no_confirmada',
            evidence: detection ? detection.evidence : null,
          };
        }),
      });
    }
    res.json({ sources: sources.map(serializeSource), rows });
  });

  // ---------- dashboard (§14) ----------
  router.get('/dashboard', (req, res) => {
    const db = getDB();
    const since30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentChanges = db.competitorChanges.filter((c) => c.detectedAt >= since30d).sort((a, b) => b.detectedAt - a.detectedAt);
    res.json({
      counts: {
        totalSources: db.competitorSources.length,
        activeSources: db.competitorSources.filter((s) => s.active).length,
        changesLast30d: recentChanges.length,
        priceChangesLast30d: recentChanges.filter((c) => c.type === 'cambio_precio').length,
        newFeaturesLast30d: recentChanges.filter((c) => c.type === 'nueva_funcionalidad' || c.type === 'nueva_integracion').length,
        pendingOpportunities: db.competitorOpportunities.filter((o) => o.status === 'pendiente').length,
        pendingChanges: db.competitorChanges.filter((c) => c.status === 'nueva').length,
      },
      recentChanges: recentChanges.slice(0, 20).map(serializeChange),
      opportunities: [...db.competitorOpportunities].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(serializeOpportunity),
      sources: [...db.competitorSources].sort((a, b) => a.name.localeCompare(b.name)).map(serializeSource),
      recentPrices: [...db.competitorPrices].sort((a, b) => b.detectedAt - a.detectedAt).slice(0, 20).map(serializePrice),
    });
  });

  return router;
};
