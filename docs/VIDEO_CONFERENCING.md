# Videoconferencias integradas (Bloque 28)

Videoconferencia dentro de las audiencias de Mediador: crear, actualizar,
cancelar y entrar a una reunión sin copiar/pegar enlaces a mano. Mediador
administra **cuándo, con quién, dónde y qué enlace** — la videollamada en
sí ocurre siempre en el proveedor externo (Google Meet, Zoom o Microsoft
Teams). Cargar un enlace manualmente sigue siendo una opción de primera
clase, nunca una excepción al costado.

## 1. Arquitectura

```
hearing (routes/mediations.js)
   │
   ├── videoConferencing.js          (orquestación: create/update/cancel)
   │
   └── videoProviders/index.js       (registro de adapters)
          │
          ├── manualProvider.js      (sin API externa — el link ES el resultado)
          ├── googleMeetProvider.js  (Google Calendar API, OAuth por mediador)
          ├── zoomProvider.js        (Zoom Server-to-Server OAuth, 1 cuenta)
          └── teamsProvider.js       (Microsoft Graph, client-credentials, 1 cuenta)
```

`videoProviders/base.js` define el contrato común
(`createMeeting`/`updateMeeting`/`cancelMeeting`/`getStatus`/`isConfigured`)
y los códigos de error compartidos. `routes/mediations.js` **nunca**
importa un adapter directamente — siempre pasa por
`videoConferencing.js`, que a su vez pide el adapter correcto a
`videoProviders/index.js`. Agregar un proveedor nuevo es sumar un módulo
a `videoProviders/` y registrarlo en el índice; no toca la lógica de
audiencias.

## 2. Qué ya existía (Bloque 4/15) y se reutilizó

- `hearings.modality` (`presencial|virtual|hibrida`), `hearings.location`
  y **`hearings.meetingUrl`** ya existían — `meetingUrl` sigue siendo
  exactamente el mismo campo que usan la agenda, el feed ICS, el
  dashboard del mediador, el portal de partes y el portal de abogados
  desde antes de este bloque. Este bloque nunca lo duplicó.
- El job `checkHearingsStartingSoon` (`jobs.js`) ya manda el link por
  chat 20-5 minutos antes de la audiencia, con idempotencia real vía
  `hearing.startAlertSentAt`. No se tocó — sigue funcionando igual,
  ahora con más probabilidad de que `meetingUrl` esté poblado porque un
  proveedor lo generó solo.
- Notificaciones (crear/reprogramar/cancelar) reutilizan
  `notifyPartyAboutHearing`/`notifyLawyerAboutHearing` de `messaging.js`.
- Autorización: los endpoints nuevos usan el mismo
  `requireMediationAccess`/`requireEditAccess` que ya validaba
  hearing→mediation→usuario en `routes/mediations.js`.
- Timeline: los eventos nuevos (`VIDEO_MEETING_CREATED/UPDATED/CANCELLED/ERROR`)
  usan `logMediationEvent` de siempre y aparecen solos en
  `/api/admin-mediador/activity` (Bloque 27) — no se creó un timeline paralelo.

## 3. Campos nuevos en `hearings`

Todos aditivos, `NULL` en toda audiencia existente (sin cambio de
comportamiento):

| Campo | Significado |
|---|---|
| `videoProvider` | `google_meet｜zoom｜teams｜manual｜null` |
| `meetingId` | id de la reunión en el proveedor externo (para poder actualizarla/cancelarla) |
| `hostUrl` | link de organizador — **solo** Zoom lo diferencia del join URL; nunca se expone a partes/abogados |
| `meetingCreatedAt` / `meetingUpdatedAt` | timestamps |
| `meetingStatus` | `no_configurada｜creando｜creada｜actualizando｜actualizada｜error｜cancelada` — estado de la **reunión**, distinto del estado de la **audiencia** (`hearings.status`) |
| `meetingMetadata` | JSON con datos no sensibles del proveedor (ej. `calendarEventId`, `zoomMeetingNumber`) — nunca tokens |

Tabla nueva `video_provider_accounts` (credenciales OAuth por mediador,
por proveedor) — **nunca** en `hearings`, nunca devuelta completa por
ninguna API (`routes/video-providers.js` solo devuelve estado calculado).

## 4. Proveedores

### Google Meet — OAuth propio, por mediador

Reusa el mismo client (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) que ya
existía para el login (`routes/auth.js`), pero con su **propio**
consentimiento: el login pide scope `profile email` y descarta el token;
Google Meet necesita `https://www.googleapis.com/auth/calendar.events`
con acceso offline (`access_type=offline&prompt=consent`) para poder
crear reuniones sin loguearse cada vez. Por eso es un flujo de conexión
aparte ("Conectar cuenta" en Configuración → Videoconferencias), no una
ruta nueva de login. El link de Meet se genera con Calendar API
(`conferenceData.createRequest`, tipo `hangoutsMeet`) — la forma oficial
de generar un Meet por API. Sin dependencias nuevas: se usa `fetch`
nativo de Node (mismo criterio del repo de evitar paquetes cuando
alcanza con la plataforma — ver `db.js` usando `node:sqlite`).

### Zoom — Server-to-Server OAuth, una sola cuenta

Se configura **una vez** con `ZOOM_ACCOUNT_ID`/`ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET`
(Zoom Marketplace → Build App → Server-to-Server OAuth). No hay
"conectar cuenta" por mediador — es una única cuenta de Zoom para toda
la instalación. Diferencia estrictamente `join_url` (va a partes/
abogados vía `meetingUrl`) de `start_url` (host, solo `hostUrl`, nunca
sale de las respuestas para el mediador/equipo).

### Microsoft Teams — preparado, no simulado

Adapter completo (Microsoft Graph, client-credentials +
`onlineMeetings`), pero **sin credenciales reales en este entorno**:
`isConfigured()` da `false` si faltan `MICROSOFT_TENANT_ID`/
`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/`MICROSOFT_ORGANIZER_UPN`,
y Configuración muestra "Microsoft Teams no está configurado." — nunca
se fingió una integración funcionando. Limitación conocida: Graph
app-only no permite reprogramar un `onlineMeeting` existente (solo
create/get/delete), así que `updateMeeting` cancela y recrea, dejando
constancia en el timeline.

### Manual — siempre disponible

No llama a ninguna API externa: el enlace que carga el mediador ES el
resultado. Es un `VideoProvider` más (no una rama especial en el código),
así que crear/actualizar/cancelar usan el mismo camino sin importar si
hay un proveedor real detrás.

## 5. Variables de entorno

Ver `.env.example`. Ninguna es obligatoria — sin configurar nada,
Mediador sigue funcionando con "cargar enlace manualmente" como siempre.

```
GOOGLE_MEET_CALLBACK_URL   # reusa GOOGLE_CLIENT_ID/SECRET, callback propio
ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET
MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_ORGANIZER_UPN
```

## 6. Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/video-providers` | Estado de los 3 proveedores para el usuario logueado |
| `GET` | `/api/video-providers/google_meet/connect` | Inicia el OAuth de Google Calendar |
| `GET` | `/api/video-providers/google_meet/callback` | Vuelta del OAuth, guarda la cuenta |
| `POST` | `/api/video-providers/:provider/disconnect` | Desconecta (solo Google Meet — Zoom/Teams son por env vars) |
| `POST` | `/api/mediations/:id/hearings` | Crear audiencia — con `provider` o `meetingUrl` si es virtual |
| `POST` | `/api/mediations/:id/hearings/propose` | Proponer horarios — la reunión de un proveedor real recién se crea al confirmar (§9) |
| `POST` | `/api/mediations/:id/hearings/:hearingId/confirm-proposal` | Confirma un horario propuesto y crea la reunión diferida |
| `POST` | `/api/mediations/:id/hearings/:hearingId/status` | Cambiar estado — `cancelada` cancela la reunión externa |
| `POST` | `/api/mediations/:id/hearings/:hearingId/reschedule-requests/:id/resolve` | Reprogramar — actualiza la reunión existente, nunca crea una nueva |
| `POST` | `/api/mediations/:id/hearings/:hearingId/meeting` | Crear/reintentar/adjuntar una reunión a una audiencia existente |
| `DELETE` | `/api/mediations/:id/hearings/:hearingId/meeting` | Quita la videoconferencia (cancela en el proveedor si corresponde) sin tocar el resto de la audiencia |
| `GET` | `/api/admin-mediador/video-metrics` | Métricas agregadas (Admin Console) — nunca URLs/tokens |

## 7. Flujos

**Creación**: si la modalidad es `virtual`, hace falta `meetingUrl` O
`provider`. Con un proveedor real, la reunión se crea **antes** de
persistir la audiencia — si falla, no se guarda una audiencia
aparentemente virtual sin enlace (`502` con `code` de
`VIDEO_MEETING_CREATE_FAILED`/`VIDEO_PROVIDER_AUTH_REQUIRED`/etc). Con
`hibrida`, un fallo no bloquea la creación (el enlace no es obligatorio
ahí) — queda en `meetingStatus:'error'`, visible en la tarjeta.

**Reprogramación**: `updateHearingMeeting` actualiza la reunión
**existente** (nunca crea una nueva) cuando la audiencia tiene un
`videoProvider`. Si el proveedor falla al actualizar, la reprogramación
de la audiencia igual se confirma — el error queda en `videoError` de la
respuesta y en el timeline, nunca bloquea la reprogramación en sí.

**Cancelación**: al cancelar la audiencia (`status:'cancelada'`), se
cancela la reunión externa cuando corresponde. Si falla, la audiencia
**igual queda cancelada** (su estado real no depende del proveedor
externo) — el error se registra y se expone en `videoError`.

## 8. Estados

`meetingStatus` (de la reunión) es independiente de `hearings.status`
(de la audiencia) a propósito — pueden combinarse de formas "raras"
(ej. audiencia `programada` + videoconferencia en `error`), y de eso se
entera el mediador por la tarjeta "Videoconferencia" en el detalle de la
audiencia, nunca por magia.

## 9. Seguridad

- `hostUrl`/`meetingMetadata`/tokens **nunca** salen hacia
  `routes/party-portal.js` ni `routes/lawyer-portal.js` — esos
  serializers whitelistean sus propios campos a mano y solo agregan
  `videoProvider` (el nombre, para mostrar "Virtual · Google Meet"),
  nunca `meetingUrl`-adyacentes sensibles.
- Todos los endpoints nuevos de audiencia pasan por el mismo
  `requireMediationAccess`/`requireEditAccess` que el resto de
  `routes/mediations.js` — cross-mediation/cross-study quedan cubiertos
  por el mismo mecanismo de siempre, no uno nuevo.
- Las credenciales OAuth viven en `video_provider_accounts`, nunca en
  `hearings`, nunca en una respuesta de API, nunca en un log (los
  `console.error` de `videoConferencing.js` loguean `err.cause`, que es
  el body crudo del proveedor externo — puede contener detalles del
  error pero nunca contiene el token en sí, ya que las llamadas fallidas
  son sobre el body de creación/actualización de la reunión, no sobre
  las credenciales).

## 10. Errores

Códigos uniformes (`videoProviders/base.js`), nunca stack traces al
usuario:

```
VIDEO_PROVIDER_NOT_CONFIGURED   VIDEO_PROVIDER_AUTH_REQUIRED
VIDEO_PROVIDER_AUTH_EXPIRED     VIDEO_MEETING_CREATE_FAILED
VIDEO_MEETING_UPDATE_FAILED     VIDEO_MEETING_CANCEL_FAILED
VIDEO_MEETING_NOT_FOUND
```

## 11. Testing

`scripts/regression-test-bloque28.js` — batería HTTP completa (proveedor
no configurado, creación/actualización/cancelación, aislamiento
cross-mediation, exposición correcta/incorrecta en portales, filtrado de
tokens, métricas de Admin Console). No depende de credenciales reales:
prueba el camino "proveedor real sin conectar" (falla limpio, nunca deja
una audiencia virtual sin enlace) y el camino manual (funciona siempre).

Si existen credenciales de sandbox de Google/Zoom/Teams, se pueden
correr pruebas reales configurando las variables de entorno
correspondientes antes de levantar el server — los adapters llaman a las
APIs reales sin ningún cambio de código.

```bash
ENABLE_FAKE_LOGIN=1 ADMIN_EMAILS=b28-admin@test.local node server.js
node scripts/regression-test-bloque28.js http://localhost:3000
```

## 12. Qué NO se implementó (a propósito)

Grabación automática, transcripción, IA de reuniones, resumen automático
de audiencia, reconocimiento facial, almacenamiento de audio/video,
lectura del contenido de las reuniones, integración con Google Calendar/
Outlook como calendario general, marketplace, SIGIM. Este bloque
solamente agrega videoconferencia a las audiencias.
