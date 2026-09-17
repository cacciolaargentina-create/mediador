// radarScraper.js
// Bloque 25 — scraper HTTP respetuoso para el radar competitivo. Descarga
// SOLO la URL pública indicada a mano en competitor_sources: nunca sigue
// links descubiertos, nunca intenta login/paywall/CAPTCHA, nunca guarda el
// HTML completo (ver extractContent). Toda la lógica de qué hacer con el
// resultado vive en radarEngine.js — acá adentro solo hay red + parseo.
//
// Dependencia nueva: cheerio. Se evaluó extraer texto visible con regex a
// mano para no sumar una librería, y se descartó a propósito: HTML real
// tiene comentarios, CDATA, atributos con '>' dentro de un string, tags mal
// cerrados, etc. — un regex se rompe en silencio justo en esos casos, y acá
// el output alimenta decisiones de producto (§22: nunca inventar). cheerio
// da un parser DOM real (usa parse5, el mismo motor que usan jsdom/browsers
// para parsear HTML tolerante a errores) para poder sacar
// scripts/estilos/nav de forma confiable y quedarnos con texto visible real.
// Es una librería chica, sin motor de renderizado ni ejecución de JS de la
// página (no hay riesgo de que "ejecute" nada del sitio de un competidor).

const crypto = require('crypto');
const cheerio = require('cheerio');

const USER_AGENT = 'Mediador-Radar/1.0 (+https://mediador.caosmatik.com.ar; uso interno, respeta robots.txt)';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1500;
const MIN_INTERVAL_PER_DOMAIN_MS = 3000; // §17 — nunca más de 1 request cada 3s al mismo dominio

const lastRequestAtByDomain = new Map();
const robotsCache = new Map(); // domain -> { disallowed:[...], fetchedAt }
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;

function domainOf(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

async function waitForRateLimit(domain) {
  if (!domain) return;
  const last = lastRequestAtByDomain.get(domain) || 0;
  const wait = MIN_INTERVAL_PER_DOMAIN_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAtByDomain.set(domain, Date.now());
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
  } finally {
    clearTimeout(timer);
  }
}

// parser mínimo de robots.txt: solo el grupo "User-agent: *" — alcanza para
// sitios públicos normales, no soportamos grupos de UA específicos.
function parseRobotsDisallow(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const disallowed = [];
  let inWildcardGroup = false;
  for (const line of lines) {
    if (/^user-agent\s*:/i.test(line)) {
      inWildcardGroup = line.split(':').slice(1).join(':').trim() === '*';
    } else if (inWildcardGroup && /^disallow\s*:/i.test(line)) {
      const path = line.split(':').slice(1).join(':').trim();
      if (path) disallowed.push(path);
    }
  }
  return disallowed;
}

function isPathAllowed(url, disallowed) {
  if (!disallowed || !disallowed.length) return true;
  let path;
  try { path = new URL(url).pathname; } catch (e) { return true; }
  return !disallowed.some((rule) => path.startsWith(rule));
}

async function getRobotsDisallowed(baseUrl, timeoutMs) {
  const domain = domainOf(baseUrl);
  if (!domain) return [];
  const cached = robotsCache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) return cached.disallowed;
  let disallowed = [];
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    await waitForRateLimit(domain);
    const res = await fetchWithTimeout(robotsUrl, timeoutMs);
    if (res.ok) disallowed = parseRobotsDisallow(await res.text());
  } catch (e) {
    disallowed = []; // si no se puede leer robots.txt no bloqueamos, pero tampoco insistimos más de una vez por hora
  }
  robotsCache.set(domain, { disallowed, fetchedAt: Date.now() });
  return disallowed;
}

async function fetchWithRetry(url, { timeoutMs, retries }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await waitForRateLimit(domainOf(url));
      return await fetchWithTimeout(url, timeoutMs);
    } catch (e) {
      lastError = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text || '', 'utf-8').digest('hex');
}

// extrae SOLO texto/extractos cortos — nunca el HTML completo (§3/§5/§15).
function extractContent(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer, iframe, svg, [aria-hidden="true"]').remove();

  const title = normalizeText($('title').first().text());
  const description = normalizeText($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'));
  const rawText = normalizeText($('body').text());

  const priceRegex = /(\$|ARS|USD|U\$S)\s?[\d][\d.,]*/i;
  const featureRegex = /(funcionalidad|módulo|incluye|permite|ofrece|integraci[oó]n|plan|precio|caracter[ií]sticas)/i;
  const integrationRegex = /(google calendar|google meet|whatsapp|api|integraci[oó]n|zoom|outlook|calendly)/i;

  const chunks = [];
  $('p, li, h1, h2, h3, td, span, dd, dt').each((_, el) => {
    const t = normalizeText($(el).text());
    if (t && t.length > 3 && t.length < 400) chunks.push(t);
  });
  const uniqueChunks = [...new Set(chunks)];

  const pricingText = uniqueChunks.filter((c) => priceRegex.test(c)).slice(0, 30).join(' | ') || null;
  const featuresText = uniqueChunks.filter((c) => featureRegex.test(c)).slice(0, 60).join(' | ') || null;
  const integrationsText = uniqueChunks.filter((c) => integrationRegex.test(c)).slice(0, 30).join(' | ') || null;

  return {
    title: title || null,
    description: description || null,
    pricingText, featuresText, integrationsText,
    rawText,
  };
}

// resultado: { ok, status, error, content, contentHash, rawTextHash }
async function checkSource(source, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = opts.retries != null ? opts.retries : MAX_RETRIES;

  const disallowed = await getRobotsDisallowed(source.url, timeoutMs);
  if (!isPathAllowed(source.url, disallowed)) {
    return { ok: false, status: null, error: 'Bloqueado por robots.txt' };
  }

  let res;
  try {
    res = await fetchWithRetry(source.url, { timeoutMs, retries });
  } catch (e) {
    return { ok: false, status: null, error: e.name === 'AbortError' ? 'Timeout' : (e.message || 'Error de red') };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }
  const contentType = res.headers.get('content-type') || '';
  const NON_TEXT_TYPES = ['application/pdf', 'image/', 'video/', 'audio/', 'application/zip', 'application/octet-stream'];
  if (NON_TEXT_TYPES.some((t) => contentType.includes(t))) {
    return { ok: false, status: res.status, error: `Tipo de contenido no soportado (${contentType})` };
  }

  const html = await res.text();
  const content = extractContent(html);
  const contentHash = sha256([content.title, content.description, content.pricingText, content.featuresText, content.integrationsText].join('||'));
  const rawTextHash = sha256(content.rawText);
  return { ok: true, status: res.status, content, contentHash, rawTextHash };
}

module.exports = {
  checkSource, extractContent, sha256, parseRobotsDisallow, isPathAllowed,
  USER_AGENT, MIN_INTERVAL_PER_DOMAIN_MS,
};
