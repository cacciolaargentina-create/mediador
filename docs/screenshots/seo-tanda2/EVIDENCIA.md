# Evidencia — SEO Tanda 2

## 1. Contenido visible sin JS (curl, sin cookie de sesión)

```
$ curl -s http://localhost:3095/ | grep -o '<div id="login-gate"[^>]*>'
<div id="login-gate" class="mediador-app">

$ curl -s http://localhost:3095/ | grep -o '<div id="app"[^>]*>'
<div id="app" class="mediador-app shell" style="display:none;">

$ curl -s http://localhost:3095/ | grep -o '<h1>[^<]*</h1>'
<h1>El sistema operativo de tu mediación.</h1>
```

Sin ejecutar una sola línea de JS, el `<h1>` y todo el contenido de la
landing llegan visibles en el HTML servido. `#app` (el shell logueado)
es el que está oculto por defecto.

## 2. Con sesión real (curl -b con cookie de fake-login) — sin parpadeo

```
$ curl -s -b cookies.txt http://localhost:3095/ | grep -o '<div id="login-gate"[^>]*>'
<div id="login-gate" class="mediador-app" style="display:none;">

$ curl -s -b cookies.txt http://localhost:3095/ | grep -o '<div id="app"[^>]*>'
<div id="app" class="mediador-app shell">
```

La decisión se toma en `server.js` (`GET /`) antes de mandar el HTML —
nunca esperando un fetch async en el browser. Confirmado visualmente:
dashboard logueado carga directo, sin pasar por la landing.

## 3. Meta tags presentes (curl, grep sobre el HTML real)

```
<title>Mediador — Software de gestión de mediaciones para mediadores en Argentina</title>
<meta name="description" content="Mediador: software de gestión de mediaciones para mediadores y estudios jurídicos en Argentina. Expedientes, agenda de audiencias, documentos y comunicación con las partes en un solo lugar. Empezá gratis.">
<link rel="canonical" href="https://puentedigital.app/">
<meta property="og:type" content="website">
<meta property="og:title" content="Mediador — Software de gestión de mediaciones para mediadores en Argentina">
<meta property="og:description" content="Expedientes, agenda de audiencias, documentos y comunicación con las partes en un solo lugar. Empezá gratis, sin tarjeta.">
<meta property="og:url" content="https://puentedigital.app/">
<meta property="og:image" content="https://puentedigital.app/images/bridge.jpeg">
<meta property="og:image:width" content="1598">
<meta property="og:image:height" content="984">
<meta property="og:locale" content="es_AR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="...">
<meta name="twitter:description" content="...">
<meta name="twitter:image" content="https://puentedigital.app/images/bridge.jpeg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
```

Más 2 bloques `application/ld+json` (SoftwareApplication + Organization,
solo datos verificados: plan FREE real de `entitlements.js`, sin rating
ni reviewCount inventados).

Confirmado también en `legal.html`, `privacidad.html`, `terminos.html`:
title único, description propia, canonical, OG básico.

## 4. Sin socket.io para visitante anónimo

```
$ curl -s http://localhost:3095/ | grep -c "socket.io"
0

$ curl -s -b cookies.txt http://localhost:3095/ | grep -c "socket.io"
1
```

## 5. robots.txt sigue apuntando al sitemap, que ahora existe

```
$ curl -s http://localhost:3095/robots.txt | tail -1
Sitemap: https://puentedigital.app/sitemap.xml

$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3095/sitemap.xml
200
```

## 6. Peso de la landing — antes / después (visitante anónimo, sin sesión)

Medido con `curl -s -o /dev/null -w "%{size_download}"` contra cada
recurso, sirviendo exactamente el mismo código antes/después via
`git stash` (mismo servidor, misma base, única variable: el código).

| Recurso | Antes | Después | Diferencia |
|---|---|---|---|
| `GET /` (HTML) | 23.375 B | 27.073 B | +3.698 B (metadatos nuevos: OG, Twitter, Schema.org, canonical) |
| `mediador.js` | 279.718 B | 279.718 B | sin cambio de peso — pero ahora `defer` (no bloquea el primer pintado) |
| CSS (5 archivos) | 86.453 B | 86.453 B | sin cambio (fuera de alcance de esta tanda) |
| `images/bridge.jpeg` | 134.278 B | 134.278 B | sin cambio de peso — ver limitación abajo; sí tiene `width`/`height`/`fetchpriority` nuevos |
| `socket.io` (CDN) | 49.993 B | **0 B — no se carga** | **-49.993 B** |
| **Total transferido (visitante anónimo)** | **573.817 B (~560 KB)** | **527.522 B (~515 KB)** | **-46.295 B (~8%)** |

El ahorro de bytes real viene entero de sacar `socket.io` de la carga
pública. La mejora más importante en los hechos no es de bytes sino de
**orden de carga**: antes, `mediador.js` (280 KB) bloqueaba el pintado
inicial; con `defer`, el browser pinta la landing sin esperar a que ese
archivo baje, se parsee y se ejecute.

**Limitación honesta, no resuelta en esta tanda**: no re-codifiqué
`bridge.jpeg` a WebP/AVIF ni la recomprimí — no hay ninguna herramienta
de conversión de imágenes instalada en este entorno (sin `sharp`, sin
ImageMagick, sin Python/Pillow) y no quise agregar una dependencia nueva
al proyecto solo para esto sin preguntar primero. Lo que sí hice: agregar
`width="1598" height="984"` (elimina el salto de layout) y
`fetchpriority="high"` (es la imagen candidata a LCP). Si querés, en la
próxima vuelta agrego `sharp` como dependencia de build (no de runtime)
para generar un WebP real, o me pasás vos un asset ya optimizado.

## Capturas

`landing-anonima-1440x900.png`, `landing-anonima-390x844.png`,
`logueado-dashboard-1440x900.png` — en esta misma carpeta.
