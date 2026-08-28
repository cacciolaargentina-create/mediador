# Puente Digital — Backend

Backend real para reemplazar el `window.storage` del prototipo en artifact:
Express + Socket.IO (tiempo real, sin polling) + login con Google + moderación
de mensajes vía Claude, todo con tu propia infraestructura.

## Qué resuelve esto que el prototipo no podía

- **Login real**: cada canal está atado a cuentas de Google de verdad, no a un
  código adivinable.
- **Tiempo real**: los mensajes y eventos se emiten por WebSocket
  (`message:new`, `event:new`, `event:update`, `channel:update`) en vez de
  refrescar cada 4 segundos.
- **Moderación server-side**: la API key de Anthropic vive en el servidor, no
  expuesta en el HTML del cliente.
- **Permisos reales**: cada ruta de canal chequea que el usuario logueado sea
  miembro (`requireMembership`) antes de dejarlo leer o escribir.

## 1. Instalar y correr en local

```bash
cd puente-digital-backend
npm install
cp .env.example .env
```

Completá el `.env`:

```
SESSION_SECRET=      # openssl rand -hex 32
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ANTHROPIC_API_KEY=   # console.anthropic.com/settings/keys
```

```bash
npm start
```

Sin `GOOGLE_CLIENT_ID`/`SECRET` el server igual levanta (para que puedas
probar el resto de la API), pero `/auth/google` va a devolver un 503 hasta
que los completes.

## 2. Configurar login con Google

1. Andá a [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Creá un proyecto (o usá uno existente).
3. "Configure consent screen" → tipo **External** → completá nombre de la
   app, tu email de contacto. Alcanza con el modo "Testing" mientras solo lo
   usen vos y la otra persona (agregala como "test user").
4. "Create Credentials" → **OAuth client ID** → tipo **Web application**.
5. En **Authorized redirect URIs** poné exactamente la URL de tu callback:
   - Local: `http://localhost:3000/auth/google/callback`
   - Producción: `https://tu-dominio.com/auth/google/callback`
6. Copiá el **Client ID** y **Client Secret** al `.env`.

Importante: el Client ID/Secret quedan atados al dominio que registres. Si
después cambiás de dominio (por ejemplo al pasar de un subdominio de prueba
a tu dominio final), agregá también esa URL a "Authorized redirect URIs" —
podés tener varias al mismo tiempo mientras migrás.

## 3. Desplegar

Este backend es stateful en un solo proceso (guarda todo en `data.sqlite` y
las conexiones de socket.io viven en memoria), así que para arrancar te
sirve cualquier plataforma que corra un proceso Node persistente. Opciones
simples que no requieren gestionar servidores vos mismo:

- **Railway** (`railway.app`): conectás el repo de GitHub, seteás las
  variables de entorno, listo. Tiene un plan gratuito chico.
- **Render** (`render.com`): similar, "Web Service" desde GitHub.
- **Fly.io**: un poco más manual pero con mejor control, útil si después
  querés tener el server más cerca de Buenos Aires.

Pasos generales para cualquiera de las tres:

1. Subí este código a un repo de GitHub (no subas el `.env` real — ya está
   en `.gitignore` si lo generás con `git init` fresco, si no agregalo vos).
2. Conectá el repo en la plataforma elegida.
3. Configurá las variables de entorno (las mismas del `.env.example`).
4. Una vez que tengas la URL pública (ej. `https://puente-digital.up.railway.app`),
   actualizá:
   - `GOOGLE_CALLBACK_URL` en el `.env` de producción
   - "Authorized redirect URIs" en Google Cloud Console

## 4. Almacenamiento: SQLite

Los datos viven en `data.sqlite` (`node:sqlite`, nativo de Node — sin
dependencias que compilar). Tablas e índices reales por canal/usuario, con
escrituras atómicas (una transacción por `commit()`, no un `fs.writeFile`
plano) — un crash a mitad de camino ya no puede corromper el archivo.

`db.js` sigue exponiendo `getDB()` con la misma forma en memoria que usaba
el `data.json` de antes (`{users:[], channels:[], ...}`), así que el resto
del código no cambia. Si existe un `data.json` de una instalación anterior
la primera vez que arranca lo migra solo a SQLite (ver `DB_PATH` /
`SQLITE_PATH` en `.env.example`).

Vale la pena pasar a Postgres (con consultas SQL reales en cada ruta, no
solo el archivo) cuando:

- Vayas a correr más de una instancia del server (SQLite es de un solo
  proceso — no da para escalar horizontalmente).
- El volumen de mensajes/canales crezca lo suficiente como para que las
  consultas en memoria (`.filter()` sobre el array completo) empiecen a
  pesar — a la escala actual no hace falta.

## 5. Frontend

Ya está incluido en `public/` (`index.html` + `app.js`) y habla con este
backend por `fetch` (mismo origen, cookies de sesión) y Socket.IO en tiempo
real — nada de `window.storage` ni polling. Al levantar el server con
`npm start`, entrás por `http://localhost:3000` y ya está todo conectado.

Cómo funciona el canal ahora:
- Login con Google primero (`/auth/google`).
- "Crear canal" o "Unirme con código" dentro de la pestaña Canal.
- El link para compartir queda como `tudominio.com/?channel=CODIGO` — quien
  lo abre inicia sesión con su propia cuenta de Google y se une automático.
- Los mensajes y confirmaciones de calendario se empujan por WebSocket al
  instante, no hace falta refrescar.

## 6. Qué falta para producción real
- **HTTPS obligatorio** en producción (las plataformas sugeridas arriba lo
  dan gratis).
- **Backups** de `data.sqlite` (o migración a Postgres con backups
  automáticos del proveedor).
- Términos de uso claros sobre qué pasa con los datos si alguien deja de
  usar el canal — este backend no borra nada automáticamente todavía.

## Estructura

```
puente-digital-backend/
├── server.js          # Express + Socket.IO + sesión compartida
├── db.js               # almacenamiento en SQLite (node:sqlite), swap-eable por Postgres
├── moderation.js        # llamada a la API de Anthropic
├── routes/
│   ├── auth.js          # login con Google (Passport)
│   └── channels.js       # canales, mensajes, calendario, export
└── .env.example
```
