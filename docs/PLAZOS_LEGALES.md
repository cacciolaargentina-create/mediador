# Motor de Plazos Legales y Notificación Fehaciente (Bloque 43)

> **Esto no es asesoramiento legal.** El sistema hace aritmética de fechas sobre
> datos que el propio mediador carga (jurisdicción, notificaciones, fechas de
> audiencia). Nunca interpreta la ley, nunca asegura que un plazo esté bien
> computado para un caso concreto, y nunca reemplaza el criterio profesional
> del mediador ni el expediente judicial real. Verificá siempre contra la
> normativa vigente y el expediente.

## Nota sobre la numeración

El pedido original nombraba este trabajo "Bloque 33". Para cuando se
implementó, el repositorio ya tenía bloques committeados hasta el **42**
(Herramientas Legales: auditor, actas, control de vencimientos, calculadora
de honorarios) — así que este trabajo se numeró **Bloque 43**, siguiendo la
convención del repo (secuencial, sin huecos). Los archivos de test y
screenshots de este bloque usan `bloque43` en su nombre por ese motivo.

## 1. Qué existía antes de este bloque (auditoría previa)

- **Agenda/audiencias** (`hearings`): fecha, hora, modalidad — pero sin
  ningún concepto de "día hábil". `checkHearingConflicts` (agenda.js) usa
  aritmética de calendario común.
- **Mediaciones** (`mediations`): sin campo de jurisdicción a nivel
  mediación. El único uso de "jurisdicción" en toda la base era
  `honorariosScales.jurisdiccion`, hardcodeado a `'nacion'` — un concepto
  distinto (la escala arancelaria aplicable), no la jurisdicción del
  expediente.
- **Partes** (`parties`): ya tenían `role: 'requirente'|'requerido'|'otro'`
  — se reutilizó tal cual, sin tocar el esquema.
- **Documentos** (`documents`): ya existía un módulo de carga/versionado —
  se reutiliza como prueba adjunta de una notificación, nunca se duplicó.
- **Centro de atención** (`automationEngine.js`): motor de detectores ya
  centralizado (Bloque 22) — los detectores nuevos de este bloque se
  agregan ahí, mismo formato de ítem, sin sistema paralelo.
- **Jobs** (`jobs.js` + registro en `server.js`): patrón `runTrackedJob`
  con `setTimeout`+`setInterval` por hora — se agregó un job más, mismo
  patrón.
- **Acta de Cierre automática** (Bloque 34): genera un PDF certificado al
  cerrar la mediación (`mediation.closedAt`). No hay una fecha separada de
  "notificación del acta a las partes" — ver §4.3 sobre cómo se usa esto.
- **Nada de esto existía**: calendario de días hábiles/feriados, modelo de
  jurisdicción por mediación, registro de notificación fehaciente por
  parte, ni ningún cómputo de plazo procesal.

No se creó ningún sistema paralelo de alertas, agenda o documentos — todo
lo nuevo se conecta a lo existente.

## 2. Calendario de días hábiles (`businessCalendar.js`)

Tabla `legal_holidays` (`year`, `date`, `type`, `description`). Un día es
NO hábil si es sábado/domingo o figura en esta tabla. Dos funciones, usadas
por **todo** el resto del motor, sin excepción:

- `addBusinessDays(db, fechaISO, cantidad)`
- `businessDaysBetween(db, fechaA, fechaB)`

### Carga de feriados

Al arrancar el servidor (`server.js`), `seedDefaultHolidays()` siembra —
**de forma idempotente, por `year+date`, nunca pisa una fila ya cargada**
— el año en curso y el siguiente con:

- Feriados nacionales **inamovibles** (fecha fija por ley: 1° de enero, 24
  de marzo, 2 de abril, 1° de mayo, 25 de mayo, 20 de junio, 9 de julio, 8
  y 25 de diciembre).
- Carnaval y Viernes Santo, derivados del cálculo de Pascua (también fijos
  por ley en relación a esa fecha, no discrecionales).
- Feria judicial de **enero completo** (fija por reglamento).
- Feria judicial de **invierno en julio**, con las fechas **habituales**
  (primera quincena) — marcadas explícitamente en su descripción como
  **"estimadas, confirmar con la Acordada de la CSJN del año en curso"**.

### Lo que NO se siembra (a propósito)

Los feriados **trasladables "con fines turísticos"** (17 de agosto, 12 de
octubre, 20 de noviembre) dependen de un decreto del Poder Ejecutivo que se
dicta año a año — no se puede anticipar con certeza, así que **no se
inventan**. Quedan pendientes de carga manual por un admin, insertando
filas directamente en `legal_holidays` (`year`, `date`, `type: 'asueto'` u
`'otro'`, `description`).

### Aviso si falta el año en curso

`GET /api/admin-mediador/system/health` (panel de admin de plataforma)
incluye un chequeo `plazosLegales`: si el año en curso no tiene **ninguna**
fila cargada, avisa en estado `ATENCION` — nunca asume en silencio que no
hay feriados ese año.

## 3. Jurisdicción (`jurisdictionRules.js`)

Cada mediación tiene un campo `jurisdiction` (`mediations.jurisdiction`,
`null` por defecto). Las reglas de plazo están definidas **por
jurisdicción**, nunca hardcodeadas en la lógica central
(`legalDeadlines.js`), que solo llama a `getJurisdictionRules(code)`.

- **Hoy solo existe `nacion`** (Ley 26.589, mediación prejudicial
  obligatoria nacional/CABA), completa.
- **Si una mediación no tiene jurisdicción cargada**, o su código no está
  en `jurisdictionRules.js`, el motor la muestra como **"no calculable"**
  — nunca asume una jurisdicción por defecto.
- **Agregar una provincia** es agregar una entrada al objeto
  `JURISDICTIONS` de `jurisdictionRules.js` con sus propios valores — no
  requiere tocar `legalDeadlines.js`, `automationEngine.js` ni las rutas.

Se edita desde el expediente: sección "Plazos" → selector de Jurisdicción
(`PATCH /api/mediations/:id/jurisdiction`).

## 4. Reglas implementadas (ámbito Nación, Ley 26.589)

### 4.1 Plazo de la mediación — 60 días hábiles

**Fuente:** Art. 20, Ley 26.589 — el plazo de la mediación es de hasta 60
días hábiles judiciales, contados desde la última notificación fehaciente
al requerido (o al último de los requeridos, si hay más de uno).
Prorrogable por acuerdo de partes.

- El cómputo arranca en la fecha de **recepción efectiva** (nunca la de
  envío) de la notificación de cada parte con rol `requerido`.
- Con varios requeridos, el plazo **no arranca** hasta que TODOS tengan una
  notificación efectiva registrada — una vez que la tienen, rige la fecha
  **más tardía** entre todas.
- Una notificación `rechazada` o `no_localizado` **no inicia el cómputo
  por sí sola** — es una lectura conservadora deliberada (ver §5) mientras
  no haya un seguimiento (un nuevo intento `recibido`).
- **Prórrogas** (`mediation_deadline_extensions`): registrables con motivo
  y fecha de acuerdo, en días hábiles adicionales o con una fecha límite
  directa. Nunca se borran, quedan como historial.
- **Corrección manual de la fecha base**
  (`mediations.deadlineStartOverride*`): si por algún motivo la fecha
  calculada automáticamente no es la correcta, el mediador puede
  corregirla a mano — **queda auditado** (quién, cuándo, motivo) tanto en
  columnas dedicadas como en un `mediationEvent` (`MEDIATION_DEADLINE_START_OVERRIDE_SET`),
  reutilizando el timeline existente.

### 4.2 Aviso de audiencia — mínimo 3 días hábiles

**Fuente:** Art. 20 in fine, Ley 26.589 — la audiencia debe notificarse con
una anticipación no menor a 3 días hábiles.

**Limitación reconocida:** el sistema no registra (todavía) una fecha de
"notificación de ESTA audiencia puntual" por parte — solo existe ese
registro para la notificación de inicio de la mediación
(`party_notifications`). Como proxy honesto, y **solo como advertencia,
nunca bloqueante**, se compara el momento en que se programa/reprograma la
audiencia contra su fecha: si entre ambos no hay al menos 3 días hábiles,
es matemáticamente imposible que la notificación llegue a tiempo, así que
se avisa. Cuando exista un registro específico de notificación de
audiencia, este cálculo debería migrar a usarlo — la arquitectura
(`jurisdictionRules.hearingNoticeBusinessDays`) ya está lista para eso.

### 4.3 Acta de cierre — reanudación de la prescripción a los 20 días

**Fuente:** Art. 22, Ley 26.589 — el efecto suspensivo sobre la
prescripción cesa a los 20 días **corridos** (el texto no dice "hábiles"
acá, a diferencia de las dos reglas anteriores) desde que el acta de
cierre queda a disposición de las partes.

**PENDIENTE DE CONFIRMACIÓN, marcado explícitamente en el código**
(`jurisdictionRules.js`): se usa `mediation.closedAt` (el momento en que se
genera automáticamente el acta de cierre, Bloque 34) como fecha de "a
disposición de las partes". Es la lectura más razonable con los datos que
existen hoy — el acta se genera justo en ese momento —, pero el sistema no
tiene un evento separado de "notificación del acta a cada parte". Si en la
práctica el acta se entrega en un momento posterior, la fecha debería
corregirse a mano hasta que exista un registro específico para esto.

## 5. Notificación fehaciente (`party_notifications`)

Por cada parte: medio (carta documento / cédula / acta notarial / personal
/ electrónico), número de pieza, fecha de envío, estado (enviada /
recibida / rechazada / no_localizado), fecha de recepción efectiva, prueba
adjunta (reutiliza `documents`, nunca un adjunto paralelo), observaciones.

- El cómputo del plazo de 60 días usa **siempre** la fecha de recepción,
  nunca la de envío.
- **Lectura conservadora, deliberada** (pedido explícito del usuario:
  "prefiero un plazo menos y bien, que tres mal"): una notificación
  `rechazada` o `no_localizado` no cuenta como "notificación efectiva" —
  el detector correspondiente (§6) pide un seguimiento, y el plazo queda
  como "no iniciado" hasta que haya una notificación con estado `recibida`.
- Toda alta/edición queda en el timeline de la mediación
  (`mediationEvents`).

Rutas: `GET/POST /api/mediations/:id/party-notifications`,
`PATCH /api/mediations/:id/party-notifications/:notifId`.

## 6. Centro de atención — detectores nuevos

Agregados a `automationEngine.js`, mismo formato de ítem que el resto
(`type`, `priority`, `dueDate`, `suggestedActions`, …), sin sistema
paralelo:

| Detector | Dispara cuando | Severidad |
|---|---|---|
| `plazoMediacionProximoAVencer` | quedan ≤15 días hábiles del plazo de 60 | creciente: `proximo` (≤15), `critico` (≤7) |
| `plazoMediacionVencido` | el plazo ya pasó | `vencido` |
| `requeridoSinNotificacion` | un requerido no tiene NINGUNA notificación cargada | `pendiente` |
| `notificacionSinSeguimiento` | la última notificación de un requerido quedó `rechazada`/`no_localizado` | `pendiente` |
| `audienciaSinAvisoMinimo` | una audiencia programada no cumple el proxy de 3 días hábiles (§4.2) | `pendiente` |
| feriados del año no cargados | solo en `/api/admin-mediador/system/health`, solo admin de plataforma | `ATENCION` |

## 7. Vista "Plazos" en el expediente

Nueva sección en el detalle de cada mediación (`GET
/api/mediations/:id/legal-tools/plazos`): jurisdicción, estado de
notificación por parte, plazo de la mediación (inicio del cómputo, días
transcurridos/restantes, fecha límite, con una línea de explicación del
origen de cada número, ej. *"60 días hábiles desde la notificación a
Pérez, recibida el 12/09"*), prórrogas registradas, próxima audiencia y si
cumple el aviso mínimo, y si está cerrada, la fecha del acta con su cómputo
de 20 días.

## 8. Recordatorios

`jobs.js: checkLegalDeadlineReminders`, mismo patrón de job que el resto
(`runTrackedJob`, cadencia horaria), reutiliza `notifyMediator` (push/
WhatsApp según `mediation.reminderChannels`, igual que el resto de los
avisos). Notifica al mediador al cruzar 15/7/3 días hábiles restantes.
**Idempotente**: `mediations.legalDeadlineRemindersSent` guarda qué
umbrales ya se avisaron, así una corrida hora a hora no repite el mismo
aviso — y si una prórroga aleja la fecha límite, el umbral se vuelve a
habilitar solo.

## 9. Seguridad y aislamiento

- Mismo mecanismo que el resto del expediente (`requireMediationAccess`):
  cross-mediación y cross-estudio dan 403, sin excepción nueva.
  Parties/lawyers **nunca** llegan a estas rutas — entran por
  `routes/party-portal.js` con su propio token, un router completamente
  distinto.
- **Permisos por rol dentro de la mediación** (mismo criterio que cerrar
  la mediación o registrar su resultado, Bloque 33): un **asistente**
  puede registrar notificaciones (trabajo administrativo delegable), pero
  **no puede** registrar una prórroga ni corregir la fecha base
  manualmente — eso altera el cómputo legal del plazo, reservado al
  mediador/admin.
- **Límite reconocido, no resuelto en este bloque**: el portal de partes
  (`routes/party-portal.js`) todavía no expone la fecha de notificación
  propia de cada parte ni indicadores de plazo — spec §9 pedía que una
  parte solo vea su propia fecha de notificación y su próxima audiencia.
  Hoy la aislación está garantizada (una parte no puede llegar a la vista
  de plazos del mediador de ninguna forma), pero mostrarle proactivamente
  su propia fecha de notificación quedó fuera de este bloque por alcance
  — es una extensión menor y aislada de agregar más adelante.

## 10. Lo que este motor NO hace (a propósito)

- No da asesoramiento legal ni interpreta la ley más allá de la
  aritmética de fechas.
- No calcula honorarios ni impuestos (eso ya existe, separado, en la
  Calculadora de honorarios — Bloque 42).
- No redacta documentos ni escritos.
- No integra con SIGIM ni ningún sistema judicial.
- **Nunca envía** cartas documento, cédulas ni ningún otro medio de
  notificación — el sistema solo **registra** que una notificación
  existió, jamás la despacha.
- No afirma consecuencias jurídicas de un plazo vencido (ej. nunca dice
  "esta mediación es nula" o "el reclamo prescribió") — solo muestra el
  cómputo de fechas.

## 11. Alcance de este bloque y qué quedó para una segunda vuelta

Por pedido explícito del usuario, ante el tamaño del bloque, se priorizó:
calendario de días hábiles → notificación fehaciente → plazo de 60 días →
detectores en el centro de atención. Las reglas 4.2 (aviso de audiencia) y
4.3 (acta de cierre) se implementaron igual, con la limitación del proxy
descripta en cada sección — la arquitectura (`jurisdictionRules.js`) ya
las contempla por si en una segunda vuelta se quiere afinar el cómputo con
registros más específicos (notificación de audiencia puntual, notificación
del acta a cada parte).
