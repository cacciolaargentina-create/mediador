// radarEngine.js
// Bloque 25 — lógica de negocio del radar competitivo: clasificar cambios
// entre dos snapshots, detectar menciones de funcionalidades del catálogo,
// extraer precios de forma heurística, y persistir el resultado de un
// chequeo. Sin acceso a red acá — eso vive en radarScraper.js — para poder
// testear toda esta lógica sin pegarle a ningún sitio real (ver
// scripts/regression-test-bloque25.js).
//
// Regla de todo el bloque (§9/§13/§22 de la spec): esto NUNCA decide que
// Mediador tiene que construir algo. Cada función de acá produce, como
// mucho, una OBSERVACIÓN + EVIDENCIA — la decisión de confirmar, descartar o
// convertir en oportunidad es siempre una acción humana explícita desde
// routes/radar.js.

const { nanoid } = require('nanoid');

// ---- catálogo de funcionalidades relevantes para Mediador (§7) — lista
// fija mantenida a mano, no se genera ni se descubre solo. `keywords` es lo
// que se busca (case-insensitive) en el texto scrapeado.
const FEATURE_CATALOG = [
  { key: 'agenda', label: 'Agenda', keywords: ['agenda'] },
  { key: 'disponibilidad', label: 'Disponibilidad', keywords: ['disponibilidad', 'horarios disponibles'] },
  { key: 'audiencias', label: 'Audiencias', keywords: ['audiencia'] },
  { key: 'reprogramaciones', label: 'Reprogramaciones', keywords: ['reprogramaci', 'reagendar'] },
  { key: 'partes', label: 'Gestión de partes', keywords: ['gestión de partes', 'partes involucradas'] },
  { key: 'abogados', label: 'Gestión de abogados', keywords: ['abogados', 'letrados'] },
  { key: 'documentos', label: 'Documentos', keywords: ['gestión documental', 'documentos'] },
  { key: 'plantillas', label: 'Plantillas', keywords: ['plantillas', 'modelos de documento'] },
  { key: 'comunicaciones', label: 'Comunicaciones', keywords: ['mensajería', 'comunicación con las partes'] },
  { key: 'whatsapp', label: 'WhatsApp', keywords: ['whatsapp'] },
  { key: 'email', label: 'Email', keywords: ['notificaciones por email', 'envío de emails', 'correo electrónico'] },
  { key: 'google_calendar', label: 'Google Calendar', keywords: ['google calendar'] },
  { key: 'google_meet', label: 'Google Meet', keywords: ['google meet'] },
  { key: 'portal_partes', label: 'Portal de partes', keywords: ['portal para las partes', 'portal del cliente'] },
  { key: 'portal_abogados', label: 'Portal de abogados', keywords: ['portal para abogados', 'portal del profesional'] },
  { key: 'tareas', label: 'Tareas', keywords: ['gestión de tareas', 'tareas pendientes'] },
  { key: 'compromisos', label: 'Compromisos', keywords: ['compromisos'] },
  { key: 'timeline', label: 'Timeline / historial', keywords: ['línea de tiempo', 'historial de actividad', 'timeline'] },
  { key: 'notificaciones', label: 'Notificaciones', keywords: ['notificaciones push', 'notificaciones automáticas'] },
  { key: 'firma_digital', label: 'Firma digital', keywords: ['firma digital', 'firma electrónica'] },
  { key: 'certificacion', label: 'Certificación', keywords: ['certificación', 'informe certificado'] },
  { key: 'exportacion', label: 'Exportación', keywords: ['exportar', 'exportación de datos'] },
  { key: 'equipos_estudios', label: 'Equipos / estudios', keywords: ['equipos de trabajo', 'estudios jurídicos', 'multiusuario'] },
  { key: 'reportes', label: 'Reportes', keywords: ['reportes', 'estadísticas', 'informes gerenciales'] },
  { key: 'facturacion', label: 'Facturación', keywords: ['facturación', 'facturación electrónica'] },
  { key: 'ia', label: 'Inteligencia artificial', keywords: ['inteligencia artificial', 'asistente virtual'] },
  { key: 'directorio', label: 'Directorio', keywords: ['directorio de mediadores', 'directorio profesional'] },
  { key: 'marketplace', label: 'Marketplace', keywords: ['marketplace', 'bolsa de trabajo'] },
  { key: 'autenticacion', label: 'Autenticación', keywords: ['inicio de sesión', 'autenticación', 'login con google'] },
  { key: 'verificacion_identidad', label: 'Verificación de identidad', keywords: ['verificación de identidad', 'validación de identidad'] },
];

// funcionalidades cuya aparición nueva se trata como HIGH (§6: "nueva
// integración importante"), no MEDIUM como una funcionalidad genérica.
const HIGH_IMPACT_FEATURES = new Set(['google_calendar', 'google_meet', 'facturacion', 'firma_digital', 'verificacion_identidad', 'marketplace']);

const CONFIRM_WORDS = ['incluye', 'ofrece', 'cuenta con', 'disponible', 'integrado con', 'permite', 'con soporte de'];
const UNCERTAIN_WORDS = ['próximamente', 'en desarrollo', 'planeamos', 'estamos trabajando', 'roadmap', 'no incluye', 'todavía no', 'muy pronto'];

// Estado real de Mediador HOY — mantenido A MANO por criterio propio, no se
// auto-genera (no tendría sentido "scrapear" la propia base de código). Se
// usa solo para la columna de comparación de la matriz competitiva (§8),
// nunca se expone a mediadores normales. Revisar a mano si el catálogo de
// Mediador cambia — este archivo no se actualiza solo.
const MEDIADOR_FEATURES = {
  agenda: 'confirmada', disponibilidad: 'confirmada', audiencias: 'confirmada',
  reprogramaciones: 'confirmada', partes: 'confirmada', abogados: 'confirmada',
  documentos: 'confirmada', plantillas: 'no_confirmada', comunicaciones: 'confirmada',
  whatsapp: 'confirmada', email: 'no_confirmada',
  google_calendar: 'posible', // exporta .ics / calendarToken, no es sync bidireccional con la API de Google Calendar
  google_meet: 'no_confirmada', portal_partes: 'confirmada', portal_abogados: 'confirmada',
  tareas: 'confirmada', compromisos: 'confirmada', timeline: 'confirmada',
  notificaciones: 'confirmada', firma_digital: 'confirmada', certificacion: 'confirmada',
  exportacion: 'confirmada', equipos_estudios: 'confirmada',
  reportes: 'posible', // estadísticas básicas (Bloque 13), no un módulo de reportes gerenciales completo
  facturacion: 'no_confirmada', ia: 'confirmada', directorio: 'no_confirmada',
  marketplace: 'no_confirmada', autenticacion: 'confirmada', verificacion_identidad: 'no_confirmada',
};

function detectFeatures(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const results = [];
  for (const f of FEATURE_CATALOG) {
    let idx = -1;
    for (const k of f.keywords) {
      const i = lower.indexOf(k.toLowerCase());
      if (i >= 0) { idx = i; break; }
    }
    if (idx < 0) continue;
    const windowText = lower.slice(Math.max(0, idx - 60), idx + 60);
    let status = 'posible'; // default deliberado — nunca "confirmada" sin evidencia afirmativa cercana (§7)
    if (UNCERTAIN_WORDS.some((w) => windowText.includes(w))) status = 'no_confirmada';
    else if (CONFIRM_WORDS.some((w) => windowText.includes(w))) status = 'confirmada';
    results.push({
      feature: f.key,
      status,
      evidence: text.slice(Math.max(0, idx - 80), idx + 120).trim(),
    });
  }
  return results;
}

// heurística de precios (§11) — best effort, NO una extracción estructurada
// confiable. Sirve para detectar "hay un número con signo de moneda cerca de
// este texto" y guardar el fragmento como evidencia, no para parsear tablas
// de precios complejas con precisión.
function parsePriceEntries(pricingText) {
  if (!pricingText) return [];
  const chunks = pricingText.split(' | ');
  const entries = [];
  for (const chunk of chunks) {
    const priceMatch = chunk.match(/(ARS|USD|U\$S|\$)\s?([\d][\d.,]*)/i);
    if (!priceMatch) continue;
    const periodicityMatch = chunk.match(/\/\s?(mes|año|anual|mensual|year|month)/i);
    let currency = priceMatch[1].toUpperCase();
    if (currency === 'U$S') currency = 'USD';
    if (currency === '$') currency = 'ARS';
    entries.push({
      plan: chunk.replace(priceMatch[0], '').trim().slice(0, 80) || null,
      price: priceMatch[2],
      currency,
      periodicity: periodicityMatch ? periodicityMatch[1].toLowerCase() : null,
      featuresText: chunk.slice(0, 300),
    });
  }
  return entries;
}

// compara el snapshot anterior contra el contenido recién scrapeado y
// devuelve, como mucho, UN cambio relevante a registrar (o null si no hay
// nada que valga la pena reportar). prevSnapshot === null significa "primera
// vez que se chequea esta fuente" — eso establece línea de base, nunca se
// reporta como cambio (si no, la primera corrida de cada fuente generaría
// una alerta falsa de "todo es nuevo").
function classifyChange(prevSnapshot, nextContent) {
  if (!prevSnapshot) return null;

  const prevPricing = prevSnapshot.pricingText || '';
  const nextPricing = nextContent.pricingText || '';
  if (prevPricing !== nextPricing && (prevPricing || nextPricing)) {
    return {
      type: 'cambio_precio', level: 'HIGH', title: 'Se detectó un cambio de precio',
      beforeText: prevPricing || null, afterText: nextPricing || null,
      evidenceText: nextPricing || prevPricing,
    };
  }

  const prevFeatures = prevSnapshot.featuresText || '';
  const nextFeatures = nextContent.featuresText || '';
  if (nextFeatures && prevFeatures !== nextFeatures && !prevFeatures.includes(nextFeatures)) {
    const newChunks = nextFeatures.split(' | ').filter((c) => !prevFeatures.includes(c));
    const newishText = newChunks.join(' | ') || nextFeatures;
    const mentionsHighImpact = [...HIGH_IMPACT_FEATURES].some((key) => {
      const cat = FEATURE_CATALOG.find((f) => f.key === key);
      return cat && cat.keywords.some((k) => newishText.toLowerCase().includes(k));
    });
    return {
      type: 'nueva_funcionalidad', level: mentionsHighImpact ? 'HIGH' : 'MEDIUM',
      title: mentionsHighImpact ? 'Posible nueva integración importante mencionada' : 'Posible nueva funcionalidad mencionada',
      beforeText: prevFeatures || null, afterText: nextFeatures,
      evidenceText: newishText,
    };
  }

  const prevIntegrations = prevSnapshot.integrationsText || '';
  const nextIntegrations = nextContent.integrationsText || '';
  if (nextIntegrations && prevIntegrations !== nextIntegrations && !prevIntegrations.includes(nextIntegrations)) {
    return {
      type: 'nueva_integracion', level: 'HIGH', title: 'Posible nueva integración detectada',
      beforeText: prevIntegrations || null, afterText: nextIntegrations,
      evidenceText: nextIntegrations,
    };
  }

  const prevTitle = prevSnapshot.title || '';
  const nextTitle = nextContent.title || '';
  if (nextTitle && prevTitle !== nextTitle) {
    return {
      type: 'cambio_posicionamiento', level: 'MEDIUM', title: 'Cambió el título/posicionamiento de la página',
      beforeText: prevTitle || null, afterText: nextTitle,
      evidenceText: nextTitle,
    };
  }

  // el hash cambió pero ninguno de los campos resumidos — texto comercial
  // menor, sin impacto claro identificado.
  return {
    type: 'cambio_texto', level: 'LOW', title: 'Cambio de texto detectado (sin impacto claro en producto o precio)',
    beforeText: null, afterText: null,
    evidenceText: (nextContent.description || nextContent.title || '').slice(0, 300) || 'Cambio de contenido detectado (hash de texto distinto al anterior)',
  };
}

// clasifica también cambios regulatorios: si la fuente es categoría
// 'regulatorio' u 'oficial' y hay CUALQUIER cambio de contenido, se marca
// como CAMBIO REGULATORIO DETECTADO independientemente de lo que diga
// classifyChange — §18/§19: nunca se interpreta solo, se deja para revisión.
function classifyRegulatoryChange(source, prevSnapshot, nextContent) {
  if (!prevSnapshot) return null;
  if (!['regulatorio', 'oficial'].includes(source.category)) return null;
  const baseChange = classifyChange(prevSnapshot, nextContent);
  if (!baseChange) return null;
  return {
    ...baseChange,
    type: 'cambio_regulatorio',
    level: baseChange.level === 'LOW' ? 'MEDIUM' : baseChange.level, // un cambio regulatorio nunca se trata como trivial
    title: `CAMBIO REGULATORIO DETECTADO — ${source.name}`,
  };
}

function upsertFeatureDetections(db, sourceId, detections, now) {
  for (const d of detections) {
    let row = db.competitorFeatureDetections.find((r) => r.sourceId === sourceId && r.feature === d.feature);
    if (row) {
      row.status = d.status;
      row.evidence = d.evidence;
      row.detectedAt = now;
    } else {
      db.competitorFeatureDetections.push({
        id: nanoid(), sourceId, feature: d.feature, status: d.status, evidence: d.evidence, detectedAt: now,
      });
    }
  }
}

function insertNewPrices(db, sourceId, priceEntries, now) {
  const inserted = [];
  for (const p of priceEntries) {
    // histórico append-only, pero no duplicamos la fila si el último precio
    // registrado para ese mismo plan es idéntico (si no, cada chequeo sin
    // cambios reales seguiría acumulando filas iguales).
    const lastForPlan = [...db.competitorPrices]
      .filter((r) => r.sourceId === sourceId && r.plan === p.plan)
      .sort((a, b) => b.detectedAt - a.detectedAt)[0];
    if (lastForPlan && lastForPlan.price === p.price && lastForPlan.currency === p.currency && lastForPlan.periodicity === p.periodicity) continue;
    const row = { id: nanoid(), sourceId, ...p, detectedAt: now };
    db.competitorPrices.push(row);
    inserted.push(row);
  }
  return inserted;
}

// orquesta UN chequeo ya resuelto por radarScraper.checkSource() — sin red
// acá adentro, por eso es testeable con un scraperResult fabricado a mano.
// No llama a commit(): eso es responsabilidad de quien invoca (ruta o job),
// mismo patrón que el resto de las rutas de Mediador.
function applyCheckResult(db, source, scraperResult, now = Date.now()) {
  source.lastCheckedAt = now;
  source.updatedAt = now;

  if (!scraperResult.ok) {
    return { ok: false, error: scraperResult.error, changed: false };
  }

  const prevSnapshot = [...db.competitorSnapshots]
    .filter((s) => s.sourceId === source.id)
    .sort((a, b) => b.checkedAt - a.checkedAt)[0] || null;

  const snapshot = {
    id: nanoid(), sourceId: source.id, checkedAt: now, contentHash: scraperResult.contentHash,
    title: scraperResult.content.title, description: scraperResult.content.description,
    pricingText: scraperResult.content.pricingText, featuresText: scraperResult.content.featuresText,
    integrationsText: scraperResult.content.integrationsText, rawTextHash: scraperResult.rawTextHash,
  };
  db.competitorSnapshots.push(snapshot);

  const sameAsLastHash = source.lastHash === scraperResult.contentHash;
  source.lastHash = scraperResult.contentHash;

  const detections = detectFeatures([
    scraperResult.content.title, scraperResult.content.description,
    scraperResult.content.featuresText, scraperResult.content.integrationsText,
  ].filter(Boolean).join(' '));
  upsertFeatureDetections(db, source.id, detections, now);

  // Histórico de precios (§11) — se guarda siempre que haya un precio nuevo
  // detectado, INCLUSO en el chequeo de línea de base (para tener el punto
  // de partida). La ALERTA de "cambio de precio" no sale de acá: sale de
  // classifyChange() más abajo, comparando contra el snapshot anterior — así
  // no se duplica la alerta (una por classifyChange, no dos) ni se dispara
  // en falso en el primer chequeo de una fuente nueva (no hay "antes" con
  // qué comparar todavía).
  const priceEntries = parsePriceEntries(scraperResult.content.pricingText);
  const newPrices = insertNewPrices(db, source.id, priceEntries, now);

  // "sin cambio" = ya había un snapshot anterior Y el hash es idéntico. La
  // primera vez que se chequea una fuente (prevSnapshot null) NUNCA es un
  // "cambio" aunque el hash pase de null a algo — es la línea de base.
  if (!prevSnapshot || sameAsLastHash) {
    return { ok: true, changed: false, snapshot, newPrices };
  }
  source.lastChangedAt = now;

  const regulatoryChange = classifyRegulatoryChange(source, prevSnapshot, scraperResult.content);
  const change = regulatoryChange || classifyChange(prevSnapshot, scraperResult.content);
  let changeRow = null;
  if (change) {
    changeRow = {
      id: nanoid(), sourceId: source.id, type: change.type, level: change.level, title: change.title,
      beforeText: change.beforeText, afterText: change.afterText, evidenceText: change.evidenceText,
      detectedAt: now, status: 'nueva', reviewedBy: null, reviewedAt: null,
    };
    db.competitorChanges.push(changeRow);
  }

  return { ok: true, changed: true, snapshot, change: changeRow, newPrices };
}

module.exports = {
  FEATURE_CATALOG, HIGH_IMPACT_FEATURES, MEDIADOR_FEATURES,
  detectFeatures, parsePriceEntries, classifyChange, classifyRegulatoryChange,
  applyCheckResult,
};
