// scripts/regression-test-seo-consistency.js
// Chequeo de consistencia entre los 3 lugares que deciden si una página se
// indexa o no — <meta name="robots"> en el HTML, NOINDEX_STATIC_PATHS en
// server.js, y robots.txt — más sitemap.xml. No pega la base de datos ni
// levanta el servidor: lee los archivos reales directamente, así corre en
// segundos y nunca miente sobre lo que REALMENTE está desplegado.
//
// Por qué existe: en las Tandas 1-4 de SEO, activar o pausar una página
// significó tocar hasta 4 archivos a mano (el <meta> del HTML, el Set de
// server.js, el Disallow de robots.txt, la entrada de sitemap.xml) — y es
// fácil olvidarse de uno. Esto lo detecta antes de deployar, no semanas
// después cuando Search Console se queja.
//
// Regla que valida, por cada página pública bajo public/*.html:
//   - Si tiene <meta name="robots" content="noindex...">, TIENE que estar
//     en NOINDEX_STATIC_PATHS, TIENE que estar bloqueada en robots.txt, y
//     NO TIENE que estar en sitemap.xml (las 3 señales de "no indexar"
//     deben ir siempre juntas, nunca una sola).
//   - Si NO tiene noindex, NO TIENE que estar en NOINDEX_STATIC_PATHS ni
//     bloqueada en robots.txt (sería una contradicción: "es pública" pero
//     "no la rastrees"). Si tampoco está en sitemap.xml, es solo un AVISO
//     (puede ser una omisión real, o una página pública que a propósito no
//     se prioriza en el sitemap) — no hace fallar el chequeo.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

let passed = 0, failed = 0, warnings = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
function warn(label, detail) {
  warnings++;
  console.log(`  WARN ${label}${detail ? ' — ' + detail : ''}`);
}

// ---- recolectar todas las páginas HTML públicas (public/**/*.html) ----
function findHtmlFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(findHtmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) results.push(full);
  }
  return results;
}
function toPublicPath(filePath) {
  const rel = path.relative(PUBLIC_DIR, filePath).replace(/\\/g, '/');
  return rel === 'index.html' ? '/' : '/' + rel;
}

const htmlFiles = findHtmlFiles(PUBLIC_DIR);
const pages = htmlFiles.map((f) => ({ file: f, urlPath: toPublicPath(f), content: fs.readFileSync(f, 'utf8') }));

// ---- parsear server.js: NOINDEX_STATIC_PATHS ----
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const noindexSetMatch = serverJs.match(/const NOINDEX_STATIC_PATHS = new Set\(\[([\s\S]*?)\]\);/);
check('server.js: se encontró el bloque NOINDEX_STATIC_PATHS', !!noindexSetMatch);
const noindexStaticPaths = new Set(
  (noindexSetMatch ? noindexSetMatch[1] : '').match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) || []
);

// ---- parsear robots.txt ----
const robotsTxt = fs.readFileSync(path.join(PUBLIC_DIR, 'robots.txt'), 'utf8');
const disallowPaths = [...robotsTxt.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
function isDisallowed(urlPath) {
  return disallowPaths.some((d) => urlPath === d || (d !== '/' && urlPath.startsWith(d)));
}

// ---- parsear sitemap.xml ----
const sitemapXml = fs.readFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), 'utf8');
const sitemapUrls = new Set([...sitemapXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]));
function inSitemap(urlPath) {
  const full = 'https://puentedigital.app' + (urlPath === '/' ? '/' : urlPath);
  return sitemapUrls.has(full);
}

console.log(`\nPáginas encontradas: ${pages.length}\n`);

for (const page of pages) {
  const hasNoindexMeta = /<meta\s+name="robots"\s+content="noindex/i.test(page.content);
  const inStaticPaths = noindexStaticPaths.has(page.urlPath);
  const disallowed = isDisallowed(page.urlPath);
  const listedInSitemap = inSitemap(page.urlPath);

  if (hasNoindexMeta) {
    check(`${page.urlPath}: noindex en HTML ⇒ también en NOINDEX_STATIC_PATHS (server.js)`, inStaticPaths,
      'tiene <meta noindex> pero el header X-Robots-Tag no la refuerza — un crawler que no lea el <head> la indexaría igual');
    check(`${page.urlPath}: noindex en HTML ⇒ también bloqueada en robots.txt`, disallowed,
      'tiene <meta noindex> pero robots.txt no la bloquea — inconsistente');
    check(`${page.urlPath}: noindex en HTML ⇒ NO está en sitemap.xml`, !listedInSitemap,
      'le estamos diciendo a Google "no la indexes" y a la vez "acá está, andá a verla" — contradicción directa');
  } else {
    check(`${page.urlPath}: pública (sin noindex) ⇒ NO está en NOINDEX_STATIC_PATHS`, !inStaticPaths,
      'es pública mirando el HTML, pero el servidor le manda X-Robots-Tag: noindex igual');
    check(`${page.urlPath}: pública (sin noindex) ⇒ NO está bloqueada en robots.txt`, !disallowed,
      'es pública mirando el HTML, pero robots.txt le dice a los crawlers que no la visiten');
    if (!listedInSitemap) warn(`${page.urlPath}: es pública y no tiene noindex, pero no está en sitemap.xml`, 'puede ser intencional — confirmar');
  }
}

console.log(`\n${passed} OK, ${failed} FAIL, ${warnings} WARN de ${pages.length} páginas`);
if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
