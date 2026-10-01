# Radar competitivo — estado y cómo reactivarlo

## Estado actual (2026-09-30)

El radar competitivo (Bloque 25: `radarEngine.js`, `radarScraper.js`,
`radarJobs.js`, `routes/radar.js`, `public/radar.html`) está **completo en
código** — sin stubs, con su job programado corriendo cada hora
(`checkDueSources`, registrado en `server.js`) — pero tiene **cero filas
cargadas** en las seis tablas (`competitorSources`, `competitorSnapshots`,
`competitorChanges`, `competitorFeatureDetections`, `competitorPrices`,
`competitorOpportunities`). El seed (`scripts/seed-radar-sources.js`, con 5
fuentes reales: medi.ar, SIGIM, MEPRE, Sistema Mediare-PBA, un artículo del
CPACF sobre SIGIM) nunca se ejecutó contra la base de producción.

Sin datos, el radar no informa ninguna decisión real — por eso, ante el
pedido explícito de "auditar contra el radar competitivo" (ver
`docs/AUDITORIA_CLASIFICACION_PRODUCTO.md`, sección 0), no se pudo usar como
referencia.

## Ya estaba oculto del usuario final

Revisado al recibir el pedido de "sacarlo de la vista del usuario final":
**ya lo estaba**, en dos capas independientes, sin necesidad de ningún
cambio de código:

1. **Frontend**: el único link a `radar.html` en todo el producto vive en
   el menú de cuenta (`renderAccountMenu()`, `public/mediador.js`), detrás
   de `isPlatformAdmin` — una variable que se resuelve contra
   `GET /api/admin/am-i-admin` al cargar la sesión (nunca un valor fijo).
   Un mediador o estudio normal jamás ve ese link.
2. **Backend**: todas las rutas de `routes/radar.js` están detrás de
   `requireAuth` + `isAdminUser`/`requireAdmin` — aunque alguien adivinara
   la URL de `radar.html`, cada llamada a la API le devuelve 403.

No se encontró ningún otro punto del producto (dashboard, Herramientas
Legales, Admin Console de Mediador) que lo enlace para un usuario no-admin.

## Cómo reactivarlo con datos reales

1. Sembrar las fuentes (una sola vez, es idempotente — no duplica si ya
   existen):
   ```bash
   node scripts/seed-radar-sources.js
   ```
2. Confirmar que se cargaron: `GET /api/radar/sources` (como admin de
   plataforma) o mirar la tabla `competitor_sources` en el sqlite.
3. Disparar el primer chequeo manual por fuente (no hace falta esperar la
   corrida horaria del job):
   ```
   POST /api/radar/sources/:id/check
   ```
   (rate-limited — ver `RADAR_MIN_MANUAL_CHECK_MS`).
4. A partir de ahí, `checkDueSources` (ya registrado y corriendo) sigue
   revisando cada fuente según su `checkFrequency` (`daily`/`weekly`/
   `manual`) sin que haga falta tocar nada más.
5. El admin de plataforma accede a `Radar competitivo` desde el menú de
   cuenta (arriba a la derecha) una vez logueado — o a `/radar-summary`
   dentro del Admin Console (`admin-mediador.html`) para un resumen rápido.

No hace falta ningún cambio de código para reactivarlo — es puro estado
(sembrar + dejar correr el job que ya existe).
