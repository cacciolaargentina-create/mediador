# IMPLEMENTATION_PLAN.md — Mediador (B2B)

> Este documento es el resultado de analizar el repositorio real (no una
> propuesta genérica). Cada tabla, endpoint y archivo mencionado abajo
> existe hoy en `github.com/cacciolaargentina-create/mediador`, salvo que
> se diga explícitamente "nuevo". No se hizo ningún cambio de código
> todavía — esto es solo el plan, como se pidió.
>
> **Revisión 2** — incorpora las 9 correcciones pedidas sobre la v1:
> próxima acción como campo funcional (§3.1), motor de consecuencias
> evento→acción sin event-sourcing (§3.11), permisos extensibles a
> asistente/abogado vía `mediation_access` (§3.2b, §6), checklist completo
> de seguridad de documentos (§3.7), arquitectura preparada — no
> implementada — para `mediation_topics` (§3.7), timeline con cadena
> causal vía `causedByEventId` (§3.10), dashboard armado alrededor de las
> 6 preguntas explícitas (§5), y reafirmación del alcance excluido (§10).
> **Sigue sin tocarse ningún código** — esperando autorización explícita
> para empezar a programar, como se pidió en el punto 9.
>
> **Revisión 3** — los Bloques 1 a 8 (§8) ya están implementados y
> probados. Se agrega §8b con la hoja de ruta después del MVP: Fase 2
> (Bloques 9-13, producto profesional avanzado), Fase 3 (Bloques 14-15,
> plataforma profesional), y el Marketplace B2C (Bloque 16) confirmado
> como proyecto separado, nunca una extensión de este repositorio.

---

## 0. Alcance de este documento

Este plan cubre el **Fase 1** definido en la especificación: Dashboard,
Mediaciones, Partes, Abogados, Audiencias, Documentos, Comunicaciones,
Timeline, Tareas, Compromisos, Vencimientos, Portal de partes, Cierre.

Deja fuera a propósito (Fase 2/3 según la especificación): IA extendida
más allá del asistente que ya existe, plantillas con variables,
honorarios, multi-mediador/estudios, exportaciones avanzadas, API pública.

**Ninguna funcionalidad de este plan expone datos a un usuario que busca
mediador, ni crea un directorio, matching o marketplace** — ver §1.3 para
el único punto del código actual que apuntaba en esa dirección y cómo se
neutraliza.

---

## 1. Diagnóstico — qué hay hoy, de verdad

### 1.1 Arquitectura general

- Node.js + Express + Socket.IO, sin framework frontend (HTML+JS plano,
  `public/app.js` de ~3950 líneas, `public/admin.js` de ~810).
- SQLite nativo (`node:sqlite`, sin dependencia npm) vía `db.js` — capa de
  compatibilidad: el resto del código sigue viendo `getDB()` como un
  objeto en memoria (`{users:[], channels:[], ...}`) con `.filter()` /
  `.find()` / `.push()`, y `commit()` vuelca todo a SQLite en una
  transacción. Esto importa para el plan: **agregar tablas nuevas es
  barato y no rompe nada existente**, siguiendo el mismo patrón.
- Autenticación: Google OAuth (`routes/auth.js`) + acceso de invitado por
  token (`routes/guest.js`) + acceso de profesional por token de invitación
  (dentro de `routes/channels.js`).
- Un archivo de rutas por dominio: `channels.js` (1115 líneas, el más
  grande y el centro de todo), `admin.js` (667), `professionals.js` (62),
  `auth.js`, `guest.js`, `push.js`, `verify.js`, `whatsapp.js`, `draft.js`.

### 1.2 Tablas actuales (14, todas reales, columnas exactas en `db.js`)

| Tabla | Para qué sirve hoy | Relevante para Mediador |
|---|---|---|
| `users` | Cuenta real (Google/WhatsApp/invitado). Incluye `verifiedProfessional`, `verifiedProfessionalRole`, `verifiedProfessionalOrg` | Sí — el mediador ES un `user` con estas columnas ya pobladas |
| `channels` | El "expediente" actual. Tiene `status` (abierto/en_proceso/cerrado) | Se convierte en el canal de comunicación de una mediación, no el expediente |
| `members` | Vincula un `user` a un `channel` con un `role` (A, B, mediador, estudio, psicologo) | Reusar tal cual para "quién tiene acceso a la comunicación" |
| `messages` | Chat, con hilos (`replyToId`), reacciones, deshacer envío (`deliverAt`), lectura | Reusar 100% — es "Comunicaciones" |
| `message_reactions` | Reacciones por mensaje | Reusar tal cual |
| `events` | Calendario: entregas y **ya tiene `kind:'vencimiento'`** | Ver §1.4 — colisión de nombre importante |
| `case_notes` | Notas privadas, solo visibles para profesional/admin | Reusar tal cual como "Notas privadas" |
| `expenses` | Gastos compartidos entre partes | Fuera de alcance de mediación en general, pero no estorba — se deja como está |
| `checkins` | Ubicación en confirmaciones de entrega | Específico de coparentalidad, no aplica a mediación — se deja sin usar en este flujo, no se borra |
| `audit_log` | Acciones sensibles para el panel admin | Ver §1.4 — no confundir con el "Event" de la especificación |
| `certified_exports` | Hash + firma Ed25519 de cada export certificado, página pública de verificación | Reusar 100% para exportar una mediación |
| `professional_applications` | Autoregistro de mediador/a o estudio, aprobado a mano por admin | Es el alta de cuenta de mediador — reusar, con el ajuste de §1.3 |
| `push_subscriptions`, `whatsapp_log`, `moderation_stats`, `reports` | Notificaciones, moderación, reportes | Reusar sin cambios |

**Lo que NO existe todavía, en ningún lado:** documentos/archivos
(ninguna tabla, ningún endpoint de upload), partes con datos legales
(DNI, domicilio, tipo de documento), abogados, audiencias como entidad
propia, tareas, compromisos.

### 1.3 El punto que hay que neutralizar explícitamente

`routes/professionals.js`, comentario original del propio autor del código:

> "Aprobar NO lo mete en ningún canal — solo lo marca como 'profesional
> verificado' ... y, **más adelante, para un directorio público**."

`verifiedProfessional` existe hoy solo como una marca de confianza (un
✓ visible cuando un profesional ya aprobado se suma a un caso). Nunca se
implementó el directorio. Pero es la semilla exacta de lo que la
especificación pide no construir.

**Decisión para el plan**: dejar `verifiedProfessional` como está (sirve
para el sello de confianza dentro de un caso, eso es B2B legítimo), pero
**el `IMPLEMENTATION_PLAN.md` dejará constancia explícita de que ningún
endpoint nuevo debe listar, buscar o exponer profesionales fuera del
contexto de una mediación en la que ya participan.** No se toca código
ahora — es una restricción de diseño para toda etapa futura, documentada
acá para que no se cuele por goteo en un sprint posterior.

### 1.4 Colisión de nombres a resolver antes de tocar código

La especificación (§9) pide una entidad `Event` para el timeline
("MEDIATION_CREATED", "PARTY_ADDED", etc.). **Ya existe una tabla
`events`** en este repo, pero es el calendario (entregas/vencimientos) —
un concepto completamente distinto.

Dos tablas llamadas parecido para dos cosas distintas es la forma más
segura de introducir un bug de confusión de datos en algún query futuro.

**Propuesta**: la nueva tabla del timeline se llama `mediation_events`
(no `events`). La tabla `events` actual **no se toca ni se renombra** —
sigue siendo calendario, y de hecho una fila nueva en `mediation_events`
se genera automáticamente cuando se crea/confirma algo en `events`
(ver §3.4).

### 1.5 Infraestructura reutilizable, confirmada archivo por archivo

- `messaging.js` — `postMessage()`, `postSystemMessage()`: se reusan tal
  cual para el chat de una mediación. Ya soportan mensajes de sistema
  (exactamente lo que hace falta para anunciar "se agregó una parte",
  "audiencia confirmada", etc. dentro del chat mismo).
- `assistant.js` — el asistente de IA ya está acotado por diseño a "solo
  el historial y calendario de ESTE canal, nunca inventa, nunca da
  consejo legal ni dice quién tiene razón" — **coincide palabra por
  palabra con la regla de IA de la especificación (§24)**. Se extiende
  (no se reescribe) para incluir partes/audiencias/tareas/compromisos en
  el contexto.
- `certificate.js` + `signing.js` — exportación certificada con hash +
  firma Ed25519 + verificación pública. Se reusa para exportar una
  mediación completa.
- `ics.js` — feed de calendario `.ics` ya funcionando. Las audiencias se
  suman a este mismo feed, no se crea uno paralelo.
- `roles.js` — `PROFESSIONAL_ROLE_LABELS` ya tiene `mediador`. Se extiende
  con `abogado` (hoy no existe como rol de acceso, solo como dato dentro
  de la lógica de partes).
- `push.js`, `whatsapp.js`, `reminders.js`, `jobs.js` — notificaciones y
  recordatorios periódicos. Se reusan agregando los tipos de evento
  nuevos (vencimiento de tarea, audiencia sin confirmar).
- `quota.js` — el límite gratuito mensual (`FREE_TIER_MONTHLY_LIMIT`) es
  un modelo B2C (por usuario). **No aplica directo a un mediador con
  varias mediaciones activas** — queda fuera de este plan (es honorarios/
  pricing, Fase 2 según la propia especificación), pero se documenta acá
  para que no se use por accidente como gate de la IA del mediador sin
  pensarlo.

---

## 2. Arquitectura propuesta

### 2.1 Relación conceptual

```
MEDIATOR (user con verifiedProfessional=1, role='mediador')
  └── MEDIATION (nueva entidad — el expediente real)
        ├── mediation_access (nueva — quién más tiene acceso: admin
        │     implícito, asistente/abogado explícitos; ver §3.2b)
        ├── CHANNEL (el existente — espacio de comunicación, 1:1 con la mediación)
        ├── PARTY (nueva — puede o no tener un user/member vinculado)
        │     └── LAWYER (nueva — vinculado a una party)
        ├── HEARING (nueva) → hearing_confirmations (una por party)
        ├── DOCUMENT (nueva)
        ├── TASK (nueva — del mediador o asistente asignado)
        ├── COMMITMENT (nueva — de una parte)
        ├── mediation_events (nueva — el timeline, con cadena causal)
        └── case_notes (existente, ya vinculada a channelId)
```

La `MEDIATION` es la entidad principal. El `CHANNEL` deja de ser "el
expediente" y pasa a ser un componente de la mediación (uno solo por
mediación, creado automáticamente al crear la mediación).

### 2.2 Por qué las partes NO son simplemente `members`

Un `member` hoy requiere un `user` (alguien que ya inició sesión con
Google o entró como invitado). Pero el mediador necesita poder cargar
"Juan Pérez, DNI 30.111.222, domicilio en..." **antes** de que Juan haga
nada — antes incluso de mandarle la invitación al portal.

Por eso `parties` es una tabla propia, con sus datos legales completos,
y un campo opcional `linkedUserId` que se completa recién cuando (y si)
esa parte acepta la invitación al portal y efectivamente entra al canal
de comunicación como `member`. Hasta ese momento, la parte "existe" en el
expediente sin necesitar ninguna cuenta.

---

## 3. Tablas nuevas propuestas

Todas siguen el patrón ya establecido en `db.js` (id TEXT PRIMARY KEY,
columnas planas, `ensureColumns()` para migrar sin romper filas viejas,
índices por `mediationId`).

### 3.1 `mediations`
```
id, code (único, visible, tipo "MED-2026-0042"), internalNumber,
mediatorUserId, channelId (FK a channels, 1:1),
type, object, description,
status ('borrador'|'iniciada'|'contactando_partes'|'notificaciones'|
        'audiencia_programada'|'en_mediacion'|'acuerdo'|'acuerdo_parcial'|
        'sin_acuerdo'|'incomparecencia'|'cerrada'),
nextActionText, nextActionResponsibleType ('mediador'|'party'|'lawyer'),
nextActionResponsibleId (nullable — id de party/lawyer si no es el mediador),
nextActionDueDate,
closedAt, closedResult, closedNotes,
createdAt
```
Índices: `mediatorUserId`, `status`, `channelId`.

**Sobre `nextAction` — no es un campo informativo, es parte del
funcionamiento** (corrección explícita del usuario sobre la v1 de este
plan). Se parte en tres columnas (`nextActionText`,
`nextActionResponsible*`, `nextActionDueDate`) en vez de un solo texto
libre, precisamente para que el dashboard pueda *consultarlo*, no solo
mostrarlo: "mediaciones activas con `nextActionText` vacío" es una query
directa (`WHERE status NOT IN ('cerrada', 'borrador') AND
(nextActionText IS NULL OR nextActionText = '')`), no un cálculo
heurístico. Cada vez que se cierra una tarea, se cumple un compromiso, o
se realiza una audiencia, el endpoint correspondiente debe preguntar (o
inferir cuando sea obvio) cuál es la próxima acción y actualizar estas
tres columnas — nunca queda "flotando" desactualizada a propósito; ver
§3.11 para cómo se conecta esto con el motor de consecuencias.

### 3.2 `mediation_status_history`
Historial de cambios de estado (la especificación lo pide explícito en
§4: "debe existir historial de cambios de estado", "no eliminar
información histórica").
```
id, mediationId, fromStatus, toStatus, changedBy, note, createdAt
```

### 3.2b `mediation_access` — permisos extensibles sin rediseño

La v1 de este plan usaba un solo campo `mediations.mediatorUserId` como
dueño exclusivo. El usuario pidió explícitamente dejar preparado el
modelo para roles adicionales (asistente, abogado) **sin tener que
rediseñar la tabla cuando lleguen** — así que el control de acceso pasa
a vivir en su propia tabla desde ahora, aunque en Fase 1 solo se pueble
para mediador/admin/parte.

```
id, mediationId, userId, role ('mediador'|'asistente'|'abogado'|'admin'),
partyId (nullable — para 'abogado': a qué parte representa, así su acceso
         queda naturalmente acotado a esa parte, no a toda la mediación),
grantedBy, grantedAt
```

`mediations.mediatorUserId` se mantiene como el mediador titular (así
"mis mediaciones" sigue siendo una query simple sobre la tabla
`mediations` directamente, sin joins para el caso común), pero
`requireMediationAccess` (§6) consulta **las dos** fuentes: es el
titular, O tiene una fila en `mediation_access`. Agregar "asistente" o
"abogado" el día de mañana es una fila nueva en una tabla que ya existe,
no una migración de esquema.

Reglas de acceso por rol, para cuando se implementen (documentadas acá
para que el diseño de cada endpoint nuevo ya las tenga en cuenta, aunque
Fase 1 no las active todas):
- `mediador` — acceso completo a sus mediaciones (implementado en Fase 1).
- `admin` — acceso total, cualquier mediación (implementado en Fase 1).
- `asistente` — mismo nivel que mediador, pero solo en las mediaciones
  donde tiene una fila explícita en `mediation_access` (no todas las del
  mediador que lo asignó).
- `abogado` — acceso de lectura a la mediación completa, pero limitado a
  las mediaciones donde su `partyId` participa; nunca ve notas privadas
  (`visibility='mediator_only'` en `mediation_events` y `case_notes`).
- `parte` — no pasa por `mediation_access` en absoluto, entra por el
  portal con token (§5), nunca por este chequeo de sesión.

### 3.3 `parties`
```
id, mediationId, type ('persona'|'empresa'), role ('requirente'|'requerido'|'otro'),
firstName, lastName, legalName, documentType, documentNumber, taxId,
email, phone, address, status ('activa'|'inactiva'),
linkedUserId (nullable — se completa cuando acepta el portal),
notes, createdAt
```
Índices: `mediationId`, `documentNumber`, `email`.

### 3.4 `lawyers`
```
id, mediationId, partyId, name, enrollmentNumber, barAssociation,
email, phone, createdAt
```
Índice: `partyId`.

### 3.5 `hearings`
```
id, mediationId, date, startTime, endTime,
type ('primera'|'continuacion'|'privada'|'otra'),
modality ('presencial'|'virtual'|'hibrida'),
location, meetingUrl,
status ('programada'|'confirmada'|'realizada'|'cancelada'|'no_realizada'),
notes, createdAt
```

### 3.6 `hearing_confirmations`
Una fila por parte, por audiencia — así cada parte confirma
independientemente (la especificación lo pide en §20).
```
id, hearingId, partyId, response ('pendiente'|'confirma'|'no_puede'|'pide_cambio'),
respondedAt, createdAt
```

### 3.7 `documents`
Metadatos del archivo. Los bytes van a disco (`/uploads/mediations/:id/`,
mismo patrón que ya usa el proyecto para otros assets estáticos), nunca
a la base — no hay infraestructura de almacenamiento binario hoy y no
hace falta inventarla, el filesystem del servidor alcanza para el
volumen esperado.
```
id, mediationId, uploadedBy, partyId (nullable),
type ('dni'|'poder'|'notificacion'|'presupuesto'|'contrato'|'acta'|
      'acuerdo'|'constancia'|'otro'),
originalFilename (el nombre tal cual lo mandó el usuario — solo para
                   mostrar, NUNCA se usa como path físico),
storagePath (nombre físico aleatorio, ver checklist abajo),
mimeType, size,
status ('recibido'|'pendiente_revision'|'revisado'|'observado'|'final'),
version, createdAt
```

**Checklist de seguridad para documentos** (lista provista explícitamente
por el usuario en la revisión de este plan — se transcribe completa acá
para que sea el criterio de aceptación al implementar, no una paráfrasis):

- [ ] Nunca usar el nombre enviado por el usuario como path físico —
      `originalFilename` es solo metadata para mostrar.
- [ ] Generar nombre físico aleatorio (`storagePath` = `nanoid() + extensión
      validada`, no derivado del nombre original de ninguna forma).
- [ ] Validar MIME **y** extensión (las dos, no alcanza con una — un
      archivo puede mentir el MIME declarado).
- [ ] Límite de tamaño explícito por archivo (a definir el número, pero
      el límite existe desde el primer commit, no se agrega después).
- [ ] Impedir path traversal — nunca construir la ruta de escritura ni de
      lectura concatenando algo que venga del cliente sin sanitizar
      (ni siquiera `mediationId`, aunque hoy sea un nanoid propio).
- [ ] No permitir ejecución de archivos — se sirven siempre con
      `Content-Disposition: attachment` y un `Content-Type` forzado desde
      lo ya validado en upload, nunca inferido en el momento de la
      descarga; el directorio de almacenamiento queda fuera de cualquier
      ruta servida estáticamente por Express.
- [ ] No exponer URLs públicas directas — `storagePath` nunca viaja en
      ninguna respuesta JSON, ni siquiera al dueño del documento.
- [ ] Descarga siempre mediante endpoint autenticado y autorizado — mismo
      patrón que ya usa `/verificar/:hash` para no exponer nada sin
      control.
- [ ] Verificar explícitamente que el documento pertenece a la mediación
      solicitada en la URL (`document.mediationId === req.params.id`),
      no solo que el usuario tiene acceso a *alguna* mediación.
- [ ] Registrar upload y download en `audit_log` (reusando la tabla
      existente — esto sí es del dominio de auditoría de acceso, a
      diferencia de `mediation_events` que es la narrativa operativa;
      ver la distinción en §1.4).
- [ ] Dejar el punto de enganche listo para un escaneo antivirus
      posterior (un paso `status: 'pendiente_escaneo'` antes de
      `'recibido'`, aunque en Fase 1 ese escaneo no exista todavía y el
      estado pase directo) — no bloquea Fase 1, pero el campo `status`
      ya contempla el estado intermedio para no tener que agregarlo
      después con una migración de datos.

**Preparado para temas (§3.7b), sin implementarlos todavía**: no se
agrega ninguna columna `topicId` en Fase 1 — se deja documentado acá que
`documents`, `tasks` y `commitments` son los candidatos naturales a
sumar un `topicId` nullable el día que exista `mediation_topics`, vía
`ensureColumns()` (mismo patrón ya usado en este repo para columnas
agregadas después, sin migración destructiva). No se crea la tabla
`mediation_topics` ni la columna todavía — es una nota de arquitectura,
no un compromiso de esquema.

### 3.8 `tasks`
```
id, mediationId, assignedTo (userId — en Fase 1 el mediador o, si ya
            existe, un asistente con acceso a esa mediación vía
            mediation_access, ver §3.2b),
title, description, dueDate, priority ('baja'|'media'|'alta'|'urgente'),
status ('pendiente'|'en_proceso'|'completada'|'cancelada'),
createdBy, completedAt, createdAt
```

### 3.9 `commitments`
```
id, mediationId, partyId, description, dueDate,
status ('pendiente'|'cumplido'|'vencido'|'cancelado'),
createdFromEventId (nullable — si se extrajo de un mensaje por IA, Fase 2),
completedAt, createdAt
```


### 3.10 `mediation_events` (el timeline — ver §1.4 por el nombre)
```
id, mediationId, type, actorId (nullable — null si lo generó el sistema),
visibility ('public'|'mediator_only'),
entityType, entityId, title, description, metadata (JSON),
causedByEventId (nullable — ver §3.11), createdAt
```
`visibility='mediator_only'` es la que usan las notas privadas y
cualquier evento de análisis interno — nunca visible desde el portal de
partes (§10 de la especificación, sin excepción).

`causedByEventId` es la corrección del usuario sobre la v1 de este plan:
el timeline tiene que poder mostrar no solo **qué pasó** (histórico) sino
**qué generó eso** (operativo) — ej. "Audiencia realizada" →
"Compromiso creado" → "Vencimiento 20/09" → "Compromiso vencido" →
"Alerta generada", como cadena visible, no como cinco filas sueltas sin
relación explícita. Cuando un evento es consecuencia directa de otro
(ver §3.11), se guarda el `id` del evento que lo originó. El render del
timeline puede entonces agrupar/indentar visualmente la cadena causal en
vez de una lista plana — mismo dato, pero permite responder tanto "¿qué
pasó?" como "¿qué generó eso y qué sigue pendiente?" desde la misma tabla.

### 3.11 El motor operativo — EVENTO → CONSECUENCIA → ACCIÓN

Corrección explícita del usuario: `mediation_events` no es un log pasivo,
tiene que poder generar consecuencias reales. Pero también pidió
explícitamente **no construir un sistema de event-sourcing genérico** —
mantenerlo simple, compatible con la arquitectura actual.

La arquitectura actual (`messaging.js`, `routes/channels.js`) ya resuelve
esto con el patrón más simple posible: **cuando pasa algo, el mismo
endpoint que lo maneja llama directo a la función que produce la
consecuencia** — no hay bus de eventos, no hay listeners registrados
dinámicamente, no hay cola. Por ejemplo, hoy `postMessage()` ya crea el
mensaje Y decide si dispara una notificación, en la misma función. Este
plan sigue exactamente ese mismo patrón para las consecuencias nuevas —
es la opción "simple y compatible" que se pidió, no una capa nueva de
abstracción.

**Reglas concretas de consecuencia para Fase 1** (las que la especificación
del usuario menciona explícitamente), cada una implementada como código
directo dentro del endpoint correspondiente, nunca como un listener aparte:

| Disparador | Dónde vive en código | Consecuencia | Automática o sugerida |
|---|---|---|---|
| `HEARING_HELD` (audiencia marcada 'realizada') | `POST .../hearings/:id/status` | Ofrece crear compromisos/tareas de seguimiento | **Sugerida** — el endpoint devuelve un prompt en la respuesta, no crea nada sin que el mediador lo confirme. Una audiencia real puede generar cero, uno o varios compromisos; no hay forma segura de adivinar cuántos. |
| `DOCUMENT_UPLOADED` | `POST .../documents` | Crea una `task` "Revisar documento: {filename}", `status:'pendiente'` | **Automática** — es un recordatorio de housekeeping de bajo riesgo, no una decisión sustantiva. |
| `COMMITMENT_CREATED` | `POST .../commitments` | No crea una fila aparte en `events` (evitaría duplicar el mismo dato en dos tablas) — el propio `commitment.dueDate` ES el vencimiento; el job diario (ver abajo) lo vigila directo desde `commitments` | Automática, por diseño de datos (no hace falta "generar" nada extra) |
| `COMMITMENT_OVERDUE` | Job diario (extensión de `jobs.js`, mismo patrón que ya usan los recordatorios existentes) | `commitment.status → 'vencido'`, UN `mediation_event` (`causedByEventId` = el `COMMITMENT_CREATED` original), entra en la alerta del dashboard | Automática — pero **el dashboard nunca depende de que este evento se haya logueado bien**: la alerta se calcula en vivo (`WHERE status='pendiente' AND dueDate < now()`), el evento en el timeline es narrativa, no la fuente de verdad de la alerta. Ver nota de robustez abajo. |
| `HEARING_SCHEDULED` | `POST .../hearings` | Crea una fila en `hearing_confirmations` por cada `party` de la mediación, `response:'pendiente'` | Automática — ya estaba implícito en §3.6, acá queda explícito como regla del motor |
| `HEARING_CONFIRMATION_MISSING` | Job diario | Si la audiencia es en ≤48hs y sigue habiendo `hearing_confirmations.response='pendiente'`, entra en la alerta del dashboard | Igual que `COMMITMENT_OVERDUE`: la alerta es una query en vivo, el evento logueado es narrativa complementaria |

**Nota de robustez, importante**: para las alertas que dependen de tiempo
(vencido, confirmación faltante), el dashboard **nunca** confía
exclusivamente en que un job haya corrido y haya logueado el evento a
tiempo — la condición se recalcula en vivo contra `dueDate`/`date` cada
vez que se pide el dashboard. El job diario solo se encarga de la
transición de estado (`pendiente → vencido`) y de dejar constancia en el
timeline la primera vez que lo detecta, para no loguear el mismo evento
todos los días. Esto evita el problema clásico de los sistemas basados en
eventos: si el job no corrió un día, la alerta igual aparece, porque no
depende de que el evento se haya disparado.

**Actualización de `nextAction`** (§3.1): cada una de estas consecuencias,
cuando corresponde, también actualiza `nextActionText` /
`nextActionResponsible*` / `nextActionDueDate` de la mediación — por
ejemplo, al crear un compromiso, la próxima acción pasa a ser "Esperar
[descripción del compromiso]", responsable = la parte, vencimiento = el
`dueDate` del compromiso. Si el mediador ya había escrito una próxima
acción manual, no se pisa sin avisar — se le pregunta si quiere
actualizarla, mismo criterio que Google Calendar cuando detecta un
conflicto de horario en vez de sobreescribir en silencio.

---

## 4. Migración — sin romper nada existente

1. **No se toca ninguna tabla existente en su forma**, solo se agrega
   `channels.mediationId` (nullable) vía `ensureColumns()`, mismo patrón
   que ya se usó para `channels.status` o `expenses.eventId` en este
   mismo repo — migración aditiva, cero downtime, canales viejos siguen
   funcionando con `mediationId = null`.
2. Los canales de coparentalidad que ya existen **siguen funcionando
   exactamente igual** — nada en su flujo verifica `mediationId`, así que
   no notan la diferencia.
3. Para una mediación nueva: se crea la fila en `mediations`, se crea un
   `channel` (usando el mismo código `createChannel` de siempre) y se
   linkean con `channel.mediationId = mediation.id`.
4. No hay script de "migrar mediaciones viejas" porque no existen
   mediaciones viejas — todo lo que hay hoy en `channels` es
   coparentalidad, y sigue siéndolo. Este es un producto nuevo que
   convive, no una conversión retroactiva de datos existentes.

---

## 5. Endpoints propuestos (REST, mismo estilo que `routes/channels.js`)

Nuevo archivo `routes/mediations.js`, mismo patrón de middlewares
(`requireAuth`, y un `requireMediationAccess` nuevo — ver §6).

```
GET    /api/mediations                       — listado del mediador logueado
POST   /api/mediations                       — crear (crea channel asociado)
GET    /api/mediations/:id                   — expediente completo
PATCH  /api/mediations/:id
POST   /api/mediations/:id/status            — cambia estado + fila en mediation_status_history
GET    /api/mediations/:id/timeline          — mediation_events, filtrable por type

GET    /api/mediations/:id/parties
POST   /api/mediations/:id/parties
PATCH  /api/mediations/:id/parties/:partyId
POST   /api/mediations/:id/parties/:partyId/invite   — genera token de portal (reusa guest.js)

GET    /api/mediations/:id/lawyers
POST   /api/mediations/:id/lawyers

GET    /api/mediations/:id/hearings
POST   /api/mediations/:id/hearings
POST   /api/mediations/:id/hearings/:hearingId/status
POST   /api/mediations/:id/hearings/:hearingId/confirm     — llamado desde el portal de partes

GET    /api/mediations/:id/documents
POST   /api/mediations/:id/documents          — multipart, guarda a disco + fila en documents
GET    /api/mediations/:id/documents/:docId/download   — autenticado, nunca URL pública

GET    /api/mediations/:id/tasks
POST   /api/mediations/:id/tasks
PATCH  /api/mediations/:id/tasks/:taskId

GET    /api/mediations/:id/commitments
POST   /api/mediations/:id/commitments
PATCH  /api/mediations/:id/commitments/:commitmentId

POST   /api/mediations/:id/close              — checklist + resultado, dispara MEDIATION_CLOSED

GET    /api/dashboard                         — agregado cross-mediación del mediador logueado
GET    /api/mediations/search?q=...           — por número/nombre/DNI/CUIT/abogado, agrupado por mediación

# reusa tal cual, sin modificar:
POST   /api/channels/:code/messages           (comunicaciones)
GET    /api/channels/:code/export/certified   (exportación de una mediación entera, adaptando el armado del PDF)
GET/POST /api/channels/:code/notes            (notas privadas)
```

**`GET /api/dashboard` — diseñado explícitamente alrededor de las 6
preguntas del punto 7 de la corrección del usuario**, no como una lista
de contadores genéricos. Cada pregunta mapea a una parte concreta y
consultable de la respuesta:

| Pregunta | De dónde sale |
|---|---|
| ¿Qué pasó? | Últimos `mediation_events` (filtrados por `visibility` según quién pregunta), cruzando todas las mediaciones del usuario |
| ¿Qué está pendiente? | `tasks` + `commitments` con `status IN ('pendiente','en_proceso')`, todas las mediaciones |
| ¿Quién debe hacer algo? | `commitments.partyId` (join a `parties.firstName`/`lastName`) para lo ajeno; `tasks.assignedTo` para lo propio |
| ¿Qué debe hacer? | `commitments.description` / `tasks.title` |
| ¿Cuándo? | `dueDate` de cada uno, ordenado ascendente |
| ¿Qué tengo que hacer yo ahora? | Sección separada y priorizada: `tasks` asignadas al usuario logueado + mediaciones con `nextActionText` vacío (§3.1) + alertas vivas (vencidos, confirmaciones faltantes, §3.11) |


**Portal de partes** — nuevo archivo `routes/party-portal.js`, mismo
patrón de token que ya usa `routes/guest.js` (acceso sin cuenta, token
en la URL). Expone solo: estado de la mediación, próxima audiencia +
confirmar, documentos propios + subir, compromisos propios,
comunicaciones. Nunca expone notas privadas ni datos de otras partes —
esto se filtra en el serializer, no confiando en que el frontend no lo
muestre.

---

## 6. Seguridad — el punto que la especificación marca como prioridad alta (§40)

**Regla central, la que la especificación subraya en §40**: "una parte
nunca debe poder consultar otra mediación cambiando simplemente un ID".

Middleware nuevo `requireMediationAccess`, mismo espíritu que
`requireMembership` ya existente en `channels.js` — actualizado en esta
revisión para consultar `mediation_access` (§3.2b), no solo el dueño:
```js
function requireMediationAccess(req, res, next) {
  const db = getDB();
  const mediation = db.mediations.find(m => m.id === req.params.id);
  if (!mediation) return res.status(404).json({ error: 'Mediación no encontrada' });

  if (isAdminUser(req.user) || mediation.mediatorUserId === req.user.id) {
    req.mediation = mediation;
    req.mediationRole = mediation.mediatorUserId === req.user.id ? 'mediador' : 'admin';
    return next();
  }
  const access = db.mediationAccess.find(
    a => a.mediationId === mediation.id && a.userId === req.user.id
  );
  if (!access) return res.status(403).json({ error: 'No tenés acceso a esta mediación' });
  req.mediation = mediation;
  req.mediationRole = access.role; // 'asistente' | 'abogado'
  req.mediationPartyId = access.partyId || null; // acota qué puede ver un abogado
  next();
}
```
En Fase 1, `mediation_access` solo se puebla para admin (implícito, no
necesita fila) y mediador (implícito, vía `mediatorUserId`) — la tabla ya
existe y el middleware ya la consulta, así que sumar asistente/abogado
más adelante es agregar filas, no tocar este middleware de nuevo.

Cada endpoint que expone datos sensibles (notas privadas,
`mediation_events` con `visibility='mediator_only'`) debe filtrar además
por `req.mediationRole` — un `abogado` nunca ve esas filas aunque pase el
chequeo de acceso general a la mediación.

Para documentos específicamente: el download nunca debe poder pedirse
sin pasar por este chequeo — nunca un `storagePath` absoluto en una
respuesta JSON, siempre un ID que se resuelve server-side. Ver el
checklist completo de seguridad de documentos en §3.7.

---

## 7. Pantallas (frontend)

**Principio explícito, no solo detalle técnico**: este plan ya cambia
simultáneamente el modelo de negocio (mediación en vez de channel), el
modelo de datos (7 tablas nuevas), el modelo de permisos
(`mediation_access` extensible) y suma almacenamiento de archivos por
primera vez en el proyecto. Cambiar **también** el framework de frontend
en la misma etapa sería una quinta variable moviéndose a la vez — si
algo se rompe después de desplegar, con cinco cambios simultáneos no hay
forma rápida de saber cuál de los cinco fue. Migrar a React/Next/Vue,
si en algún momento se justifica, es una decisión que se toma sola,
aislada, sobre una base de datos y de negocio ya estable — nunca en
paralelo con un cambio de esta magnitud.

Por eso se mantiene el mismo patrón ya usado en `public/app.js`
(pantallas por función, `goTo()` para navegar, sin framework, sin build
step nuevo) para todo lo de este plan, sin excepción — no es que el
código actual no pueda necesitar refactor más adelante, es que no es
este el momento de sumarlo a una lista de cambios que ya es grande.

Nuevas pantallas: `renderDashboard()`, `renderMediationsList()`,
`renderMediationDetail()` (con sub-tabs: Resumen/Partes/Abogados/
Audiencias/Documentos/Timeline/Tareas/Compromisos/Notas), y un archivo
nuevo `public/party-portal.js` (liviano, para el acceso de partes sin
cuenta — no debe cargar el JS completo del mediador).

---

## 7b. Arquitectura de comunicaciones del portal de partes — diseñada
ahora, implementada más adelante

Decisión explícita del usuario en la revisión del Bloque 7: pensar la
arquitectura completa (permisos, privacidad, notificaciones,
trazabilidad) antes de construir nada, para no tener que rehacerla
cuando se implemente el chat real. Lo que sigue es esa decisión — el
código de mensajería en sí queda para una etapa posterior.

### El problema que hay que evitar

El modelo de canal existente (`channels`/`messages`) fue diseñado para
**exactamente dos personas** en conflicto directo — coparentalidad. Una
mediación puede tener más de dos partes (varios requirentes o
requeridos). Un grupo compartido donde todas las partes se leen entre sí
sería, en muchos casos, **lo opuesto** de lo que un mediador quiere: la
escalada directa entre partes adversarias es exactamente el problema que
un mediador está ahí para evitar. Meterlas a todas en un mismo chat
grupal no es una limitación técnica a resolver, es probablemente el
diseño equivocado.

### Modelo elegido: rueda con centro (hub-and-spoke)

Cada parte tiene su **propio hilo privado con el mediador** — nunca ve
los mensajes de otra parte, nunca sabe qué le escribió otra parte al
mediador salvo que el mediador decida compartirlo explícitamente (fuera
del chat, como una nota o un documento). El mediador es el único que ve
todos los hilos de su mediación.

```
MEDIACIÓN
  ├── hilo con Parte A (mediador ↔ Juan Pérez)
  ├── hilo con Parte B (mediador ↔ María Gómez)
  └── hilo con Parte C, si la hay (mediador ↔ tercero)
```

### Cambio de esquema necesario (mínimo, aditivo)

`channels` ya es 1:1 con `mediations` (`mediations.channelId`). Para el
modelo de hilos, un canal deja de ser "el canal de la mediación" y pasa
a ser "un canal dentro de la mediación" — se necesita poder haber
**varios** canales por mediación, uno por parte.

Columna nueva, aditiva, mismo patrón `ensureColumns()` de siempre:
```
channels.partyId  (TEXT, nullable)
```
- `partyId = null` → es el canal general de la mediación (el que ya se
  crea hoy en el Bloque 2 — puede quedar para notas internas o uso
  futuro, no se elimina).
- `partyId = <id>` → es el hilo privado de esa parte puntual con el
  mediador. Se crea recién cuando el mediador invita a esa parte al
  portal (no antes — no tiene sentido un hilo vacío para una parte que
  todavía no fue invitada).

**Esto es lo único que se agrega de código ahora** — la columna, para
que cuando se construya el chat real no haga falta otra migración.
Ningún endpoint de mensajería nuevo se escribe todavía.

### Permisos

- El **mediador** (o admin, o un asistente con acceso a la mediación) ve
  y puede escribir en **todos** los hilos de su mediación.
- Una **parte**, entrando por el portal con su `portalToken`, ve y puede
  escribir **solamente en su propio hilo** (`channels.partyId === su
  propia party.id`) — nunca en el hilo de otra parte, ni siquiera
  sabiendo su ID (mismo principio que ya aplica en todo el resto del
  plan: nunca alcanza con no *mostrar* un link, tiene que estar
  bloqueado server-side).
- Un **abogado** con acceso a la mediación (vía `mediation_access`, ver
  §3.2b) puede leer el hilo de la parte que representa, pero no los de
  las demás partes — mismo principio de acceso acotado por `partyId` que
  ya usa esa tabla.

### Notificaciones

Se reusa la infraestructura existente (`push.js`, `whatsapp.js`) sin
cambios — un mensaje nuevo en un hilo notifica al mediador (siempre) y a
la parte dueña de ese hilo (si tiene push suscripto o teléfono
cargado), nunca a las demás partes.

### Trazabilidad

Cada mensaje enviado o recibido genera su fila en `mediation_events`
(`MESSAGE_SENT` / `MESSAGE_RECEIVED`, ya anticipados en la especificación
original §9), con `visibility: 'mediator_only'` — el timeline que ve el
mediador puede mencionar "hubo actividad en el hilo de Juan Pérez", pero
ninguna parte ve nunca en su propio portal que actividad hubo en el hilo
de otra. El contenido del mensaje en sí no se duplica en el evento (evita
tener el mismo dato en dos tablas) — el evento apunta a `entityId` =
`messageId`, el timeline lo resuelve si hace falta mostrar más detalle.

### Qué queda pendiente, a propósito

La implementación real (endpoints de mensajería, pantalla de chat en el
portal, la UI del mediador para ver los hilos en simultáneo) es trabajo
de una etapa posterior — lo que se agrega ahora es únicamente la columna
`channels.partyId` y esta decisión de arquitectura documentada, para que
esa etapa no tenga que rediseñar permisos, privacidad ni notificaciones
desde cero.

---

## 8. Orden de implementación propuesto

1. **Tablas** (`mediations`, `mediation_status_history`, `parties`,
   `lawyers`, `hearings`, `hearing_confirmations`, `documents`, `tasks`,
   `commitments`, `mediation_events`) + `channels.mediationId`.
2. **API de mediación** (crear, listar, expediente, cambio de estado).
3. **Dashboard** (el endpoint agregado + la pantalla).
4. **Partes + Abogados**.
5. **Audiencias + confirmaciones**.
6. **Documentos** (upload a disco + download autenticado).
7. **Timeline** (`mediation_events`, generado automáticamente por cada
   acción de los puntos 2 a 6 — no un paso aparte, se engancha en cada
   endpoint a medida que se construye).
8. **Tareas + Compromisos**.
9. **Portal de partes**.
10. **Cierre de mediación** + checklist.
11. **Exportación** (adaptar `certificate.js` para armar el PDF de una
    mediación completa, no solo el chat).

La IA extendida (resumir mediación, preparar audiencia, extraer
compromisos) queda para después de que exista el dato real que va a
leer — no tiene sentido construirla antes que las tablas que va a
consultar.

**Estado real: los Bloques 1 a 8 de acá arriba ya están implementados y
probados** (ver el historial de la sesión) — lo que sigue en §8b es la
hoja de ruta para lo que viene después, no una repetición de lo ya hecho.

---

## 8a. Actualización estratégica — posicionamiento frente a medi.ar

Decisión del usuario a partir de una comparación competitiva con medi.ar.
**No modifica ni interrumpe nada ya construido (Bloques 1-13)** — orienta
los bloques que siguen. Documentado acá, sin tocar código en este paso.

### Cambio de posicionamiento

De "agenda + partes + documentos + comunicaciones" (terreno que medi.ar
ya cubre) a:

> **"Mediador — El sistema operativo de tu mediación."**
> "Sabé qué pasó. Sabé qué falta. Sabé qué sigue."

El diferencial no es tener las mismas piezas — es el **control
operativo**: `MEDIACIÓN → EVENTOS → ACCIONES → RESPONSABLES →
COMPROMISOS → VENCIMIENTOS → SEGUIMIENTO → CIERRE`.

**Algo que vale la pena notar explícitamente**: esta actualización no
contradice nada de lo ya construido — lo confirma. Tres decisiones que
tomamos por otras razones, en su momento, resultan ser exactamente el
diferencial que este documento pide reforzar:
- `mediation_events` nunca se mezcló con la tabla `events` del calendario (§1.4) — el documento vuelve a pedir esto explícitamente, sin saber que ya era así.
- Las automatizaciones **sugieren, nunca inventan** compromisos sustantivos (§3.11, la regla de `HEARING_HELD`) — el documento lo vuelve a pedir punto por punto, ya implementado.
- El Bloque 8 no se reconstruyó en el Bloque 10, se amplió (§8b) — exactamente el criterio que este documento repite.

### Prioridades reforzadas para los bloques que siguen

Ya construido, mantener como eje central (no como una lista de features
más): próxima acción estructurada, responsables, tareas, compromisos,
vencimientos, alertas, timeline operativo con relaciones causales,
dashboard "qué tengo que hacer ahora", seguimiento post-audiencia,
cierre con trazabilidad. Ninguno de estos pasa a ser texto libre — siguen
siendo entidades estructuradas y consultables, como ya están.

**Dashboard — reformular la prioridad visual** (para cuando se retome
ese bloque): no la cantidad de mediaciones primero, sino la acción
pendiente primero. Formato objetivo:

```
"4 mediaciones requieren atención"
 - 2 audiencias sin confirmar
 - 1 documento pendiente de revisión
 - 1 compromiso vencido
 - 1 mediación sin próxima acción
```

Esto es una reformulación de presentación sobre datos que el dashboard
**ya calcula** (`necesitanAtencion` desde el Bloque 3/6) — no requiere
tablas nuevas, es cómo se agrupan y priorizan visualmente.

### Nuevo — Portal de Abogados (roadmap, no implementado)

Hoy un abogado es solo un registro en `lawyers` — dato, no acceso. El
documento pide evolucionar hacia un portal propio, **conceptualmente
separado del Portal de Partes** (Bloques 7/9), no una extensión de
`mediation_access` (que es para asistentes internos del estudio, Bloque
14 — un abogado externo es otra cosa). A futuro, según permisos:
consultar sus mediaciones y próximas audiencias, confirmar, cargar
documentación, responder solicitudes, recibir comunicaciones — sin
acceder nunca a notas privadas del mediador ni a información de la
parte contraria. Mismo principio de aislamiento que ya aplica en todo
el plan (§6): el acceso se bloquea server-side, nunca se confía en que
el frontend no lo muestre.

### Agenda competitiva (roadmap, no implementado)

medi.ar tiene disponibilidad/agenda fuerte. Para cuando corresponda:
calendario de audiencias, disponibilidad del mediador, bloqueo de
horarios, duración configurable, detección de conflictos,
sincronización con calendarios externos, eventualmente reserva de
turnos por abogados. **No es parte de ningún bloque actual** — queda
anotado para no perderlo, no para adelantarlo.

### Documentos — el diferencial es el ciclo, no la lista

Ya construido en espíritu (Bloque 5 + la tarea automática de revisión
del Bloque 6): `documento recibido → revisión → tarea → observado/
revisado → relacionado con la mediación → trazabilidad en timeline`. La
venta no es "tenemos upload de documentos" — es que cada documento
queda enganchado al ciclo operativo completo, no aislado.

### Criterio general para evaluar cualquier feature nueva de acá en más

Antes de agregar algo: **¿ayuda al mediador a controlar y ejecutar el
trabajo de sus mediaciones?** Si no, no es prioridad — sin importar si
medi.ar lo tiene o no. No se compite por cantidad de funcionalidades.

### Reafirmación — sigue sin cambiar

SIGIM, marketplace, directorio público, matching, B2C, comisiones,
perfiles públicos: siguen afuera, sin excepción (ver §0, §1.3, §10).



Decisión del usuario, tomada explícitamente después de completar los
Bloques 1-8: el proyecto no termina en el MVP operativo. Se define acá el
orden de lo que sigue, para que quede escrito **antes** de la tentación
de adelantar IA, multiusuario o marketplace mientras el núcleo todavía se
está asentando con uso real.

### Fase 2 — producto profesional avanzado (Bloques 9-13)

**Bloque 9 — Portal de partes avanzado**
Sobre la base ya construida en el Bloque 7 (acceso por token, ver
estado/audiencias/compromisos, documentos propios): invitaciones y
acceso más completo, comunicaciones específicas (acá es donde se
retoma la arquitectura de hilos hub-and-spoke diseñada en §7b, todavía
sin implementar), consulta de documentación más rica, confirmación/
cambio de audiencias ya con más matices, seguimiento de compromisos
desde el lado de la parte, y experiencia móvil cuidada — el Bloque 7
dejó la base funcional, esto la lleva a nivel de producto terminado.

**Bloque 10 — Cierre y expediente final**
Importante: **el cierre básico, el resultado, la exportación y el
certificado ya existen desde el Bloque 8.** Este bloque no es
construirlos de nuevo — es la versión más completa: revisión de
pendientes más elaborada antes de cerrar, un expediente histórico
navegable (no solo el timeline plano), y un paquete documental final
que empaquete el PDF certificado junto con los documentos originales
(hoy la exportación solo lista los documentos, no los adjunta) — algo
como un .zip con el informe + cada archivo original, para entregar todo
junto en un solo paso.

**Bloque 11 — Automatizaciones**
El job diario ya existe (`checkMediationDeadlines` en `jobs.js`, Bloque
6) y ya cubre compromisos vencidos y confirmaciones de audiencia
faltantes. Este bloque lo amplía: recordatorios proactivos (no solo
detectar y loguear, sino notificar por push/WhatsApp), más tipos de
vencimiento, avisos configurables por el mediador (con qué anticipación,
por qué canal), y reglas que hoy están fijas en código pasan a ser
configurables.

**Bloque 12 — IA sobre datos estructurados**
Recién acá tiene sentido ampliar el asistente (`assistant.js`, que hoy
solo conoce el chat de coparentalidad) para que consulte mediaciones,
partes, audiencias, documentos, tareas, compromisos y timeline — y
pueda responder cosas como "¿qué mediaciones tienen algo pendiente esta
semana?" o "prepárame un resumen de esta mediación". Se construye
después de las Fases 1-2 a propósito: no tiene sentido que la IA lea
datos de un modelo que todavía se está terminando de asentar con uso
real. Sigue aplicando sin excepción la regla de IA ya establecida en
este plan (§24 de la especificación original): nunca decide quién
tiene razón, nunca da consejo legal, nunca inventa.

**Bloque 13 — Gestión profesional**
Estadísticas e indicadores: productividad, cantidad de mediaciones,
tiempos, tasa de acuerdos, pendientes, historial — el equivalente para
Mediador de lo que `moderationStats.js` ya hace para coparentalidad,
pero sobre el modelo de mediaciones.

### Fase 3 — plataforma profesional (Bloques 14-15)

**Bloque 14 — Multiusuario / estudio**
Solo *cuando exista demanda real*, no antes: asistentes, varios
mediadores en un mismo estudio, permisos más finos, asignación de
expedientes entre personas del equipo, administración del estudio. La
base ya está preparada desde el Bloque 6 (`mediation_access` con los
roles `asistente`/`abogado` ya contemplados en el esquema, aunque
todavía sin poblarse) — este bloque activa lo que ya tiene lugar
reservado, no rediseña permisos desde cero.

**Bloque 15 — Integraciones**
Recién después de lo anterior se evalúan integraciones externas. Sobre
SIGIM en particular: **no se incorpora automáticamente** — se evalúa
como proyecto separado, y solo si existe una vía oficial (API o
convenio real) y una necesidad concreta de un mediador usando el
producto, no como algo que se construye especulativamente.

### Proyecto separado — Bloque 16 (Marketplace B2C)

Esto **no es una extensión de Mediador** — es otro producto, con su
propio repositorio, como ya se estableció al principio de este plan
(§0, §1.3, §10):

```
MEDIADOR (B2B)                    MARKETPLACE (B2C)
   ↓                                  ↓
gestión profesional            persona/empresa busca mediador
                                   ↓
                                elige → solicita mediación
```

Nada de este plan — ninguna tabla, endpoint o pantalla de los Bloques 1
a 15 — debe terminar sirviendo, ni parcialmente, a este bloque. Si en
algún momento se decide construirlo, es un repositorio nuevo.

### Resumen de fases, para el manual operativo

| Fase | Bloques | Qué es |
|---|---|---|
| Fase 1 | 1-8 | MVP profesional — **completo** |
| Fase 2 | 9-13 | Producto profesional avanzado |
| Fase 3 | 14-15 | Plataforma profesional |
| Proyecto separado | 16 | Marketplace B2C — nunca mezclado con lo de arriba |

---

## 9. Riesgos identificados

- **Cuatro variables ya se mueven a la vez en este plan** (negocio, datos,
  permisos, almacenamiento) — ver el principio explícito en §7. El riesgo
  concreto a vigilar durante la implementación es la tentación de sumar
  una quinta (reescribir el frontend, cambiar de base de datos, etc.)
  "ya que se está tocando esto". Cada etapa del orden de §8 debería
  poder revertirse sola si algo falla — eso deja de ser cierto en cuanto
  se mezclan cambios que no tienen relación entre sí.
- **`public/app.js` ya tiene ~3950 líneas.** Agregar todas las pantallas
  de mediación ahí lo vuelve difícil de mantener. Recomendación: nuevo
  archivo `public/mediation.js`, cargado solo en las pantallas que lo
  necesitan — no meter todo en el archivo grande existente.
- **Documentos es la pieza con más superficie de riesgo de seguridad**
  nueva (upload de archivos, control de acceso a descarga) — merece su
  propio repaso de seguridad antes de salir, no solo el genérico.
- **Colisión de nombres `events` vs `mediation_events`** (§1.4) — si en
  algún momento del desarrollo alguien escribe rápido y confunde las dos
  tablas, un query mal dirigido no tira error (ambas son tablas SQLite
  válidas) pero devuelve datos del dominio equivocado. Vale la pena un
  nombre lo bastante distinto como para que sea difícil de confundir
  incluso escribiendo rápido — `mediation_events` cumple eso mejor que,
  por ejemplo, `events_v2`.
- **`verifiedProfessional` (§1.3)** — repetido acá porque es el único
  punto real donde el código actual ya insinuaba, sin querer, el
  marketplace que se pidió no construir. No es un riesgo técnico, es un
  riesgo de que alguien lo retome sin leer este documento.

---

## 10. Lo que este plan NO incluye, a propósito

**Integración con SIGIM** — el producto es complementario ("SIGIM
gestiona el procedimiento oficial, Mediador gestiona el trabajo diario"),
no se integra en esta etapa, ni se copia su modelo de datos.

Buscador público de mediadores, marketplace, perfiles públicos para
captar clientes, solicitud pública de mediación, matching, reservas B2C,
comisiones por derivación, directorio público de mediadores — ninguno de
los endpoints, tablas o pantallas de este documento sirve, ni
parcialmente, a esas funciones. Si en algún momento se decide construir
eso, es correctamente un repositorio separado, como ya se definió.
