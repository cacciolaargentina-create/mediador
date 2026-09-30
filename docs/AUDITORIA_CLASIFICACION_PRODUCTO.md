# Auditoría de clasificación — superficie completa de Mediador

**Fecha**: 2026-09-30. Auditoría de solo lectura, hecha ANTES de tocar código
(ver commit `adc5d0c`, que implementa jerarquía/clicks/presentación sobre la
base de esta clasificación). Cubre backend (rutas + jobs) y frontend (cada
pantalla del SPA + los paneles separados). Referencias: `docs/AUDITORIA_DIFERENCIAL.md`
(2026-09-29, pre-existente) y el radar competitivo (Bloque 25) — con la
salvedad documentada en la sección 0.

Clasificar NO es borrar. Ninguna función listada acá fue eliminada por estar
clasificada como duplicada o sin valor — esa decisión es del usuario.

## 0. Aviso sobre el radar competitivo

Se pidió usar el radar competitivo (Bloque 25) como referencia. No se pudo:
está completo en código (sin stubs, job corriendo, panel propio en
`radar.html`) pero tiene **cero filas cargadas** en las seis tablas
(`competitorSources`, `competitorSnapshots`, `competitorChanges`,
`competitorFeatureDetections`, `competitorPrices`, `competitorOpportunities`).
Existe `scripts/seed-radar-sources.js` con 5 fuentes reales (medi.ar, SIGIM,
MEPRE, Mediare-PBA) pero nunca se ejecutó contra la base actual. No se corrió
durante esta auditoría (de solo lectura). Por eso la referencia principal
terminó siendo `docs/AUDITORIA_DIFERENCIAL.md` más lectura directa del
código.

## 1. FUNCIONANDO

Núcleo de expediente (crear, listar con filtros, transiciones de estado con
historial), Partes y Abogados (CRUD), autoregistro de profesional (apply),
Documentos (carga/versionado/revisión), chat interno por mediación, Tareas y
Compromisos por expediente, Audiencias (programar/proponer/confirmar/
reprogramar, chequeo de conflictos de horario, disponibilidad y bloqueos),
Multiusuario/Estudio (roles, invitaciones, transferencia de propiedad, baja,
permisos acotados del Bloque 33), Billing (planes/suscripción/pagos con
Mercado Pago, paywall), Admin Console de Mediador (dashboard, usuarios,
estudios, mediaciones, audiencias, sistema/salud, billing, soporte,
seguridad, auditoría, honorarios), radar competitivo como infraestructura
(sin datos, ver §0), sugerir tareas desde una nota, push del navegador,
WhatsApp saliente, jobs programados, Auditor de expediente y Generador de
actas (Herramientas Legales), Motor de Plazos Legales (Bloque 43, con las
salvedades de la sección 3 incompleta).

## 2. NECESITA MEJORA

- **Listado de mediaciones**: abrir siempre va al detalle completo, sin
  vista rápida.
- **Detalle del expediente** (10 secciones en una pantalla): 12 llamadas en
  paralelo cada vez que se abre, aunque sea para mirar un dato puntual.
- **Vista de Agenda (día/semana)**: la vista "semana" es una pila de 7
  tarjetas apiladas, no una grilla real.
- **Bandeja global de Comunicaciones**: antes de este commit, era solo una
  lista que redirigía sin poder responder directo (parcialmente corregido,
  ver informe de implementación).

## 3. INCOMPLETA

- **Portal de Abogados**: ya tiene chat propio de ida y vuelta (mejoró desde
  la auditoría vieja), pero sigue sin poder completar tareas — sin paridad
  con el Portal de Partes.
- **Aprobación de registro profesional**: el flujo de `apply` vive en
  `routes/professionals.js` (Mediador), pero la aprobación/rechazo
  (`GET/POST /professional-applications*`) vive en `routes/admin.js`, el
  panel VIEJO de coparentalidad — no en `routes/admin-mediador.js`. Un admin
  de Mediador no puede aprobar un registro desde su propio Admin Console.
- **Radar competitivo**: cero datos cargados (ver §0) — infraestructura
  completa que hoy no informa ninguna decisión real.
- **Impersonación y Feature flags** (Admin Console): existen como pantalla,
  sin ningún mecanismo real que haga cumplir lo que prometen (hallazgo ya
  documentado en la auditoría anterior, sin evidencia de que haya cambiado).
- **7 de 11 tarjetas de Herramientas Legales** ("Próximamente"):
  `acuerdos`, `notificaciones`, `propuestas`, `cumplimiento`, `normativa`,
  `asistente`, `connect` — sin ninguna función real detrás.
- **Motor de Plazos Legales (Bloque 43)**: 2 de 3 reglas secundarias con
  limitación reconocida y documentada en el propio código (aviso de
  audiencia por proxy; regla del acta mapeada a `closedAt` sin confirmación
  normativa).
- **Firma electrónica** de los PDF certificados: se omite en silencio si
  faltan las claves configuradas — nadie se entera (hallazgo heredado de la
  auditoría anterior).

## 4. DUPLICADA

- **"Qué está por vencer" en tres pantallas**: widget "Tareas y
  vencimientos" del Dashboard, pantalla global "Compromisos" (sidebar), y
  "Control de vencimientos" dentro de Herramientas Legales — mismo dato,
  tres recortes distintos.
- **Estadísticas vs. Dashboard**: antes de esta vuelta, Estadísticas
  repetía el total/activas/cerradas y la distribución por resultado que ya
  estaban en el Dashboard (ya recortado en la implementación — ver informe).
- **Dos superficies de radar**: `/radar-summary` dentro del Admin Console
  vs. el panel completo en `radar.html` — mismo dato, dos lugares.
- **Etiquetas inconsistentes para "ir a la mediación"**: "Abrir" (quick
  actions), "Ver mediación" (centro de atención), "Ver expediente →"
  (Compromisos, ya unificado), "Continuar MED-XXXX" (dashboard, CTA
  contextual distinto, no es la misma situación) — no es duplicación
  funcional, pero sí de nomenclatura para la misma acción.

## 5. NO APORTA VALOR (hoy)

Las más incómodas de admitir, tal como se pidió:

1. **Radar competitivo**: inversión de ingeniería completa (scraper, motor
   de diffs, panel propio, job programado), cero datos cargados, no
   enlazado desde ninguna pantalla del producto (solo por URL directa). Hoy
   no aporta ningún valor real — ni siquiera pudo usarse como referencia
   para esta misma auditoría.
2. **Tarjeta "Puente Connect" en el dashboard operativo**: ocupaba espacio
   real en la pantalla más usada del producto sin ofrecer ninguna acción —
   publicidad de un roadmap futuro metida en una herramienta de trabajo
   (ya sacada en la implementación).
3. **Las 7 tarjetas "Próximamente" de Herramientas Legales**: cero valor de
   uso hoy, y activamente dañan la percepción de producto terminado (64% de
   la grilla no hace nada).
4. **Con reserva, sin confirmar** (no tracé los call-sites del frontend):
   `routes/guest.js` y `routes/draft.js` están construidos alrededor de
   conceptos de coparentalidad (sesión de "Persona B" invitada sin cuenta,
   borrador de reformulación de mensajes por IA) que no mapean claramente al
   modelo mediador/parte/abogado/estudio de Mediador. Antes de clasificarlos
   con más firmeza habría que confirmar que la UI de Mediador realmente no
   los usa.

## 6. DIFERENCIAL

Acta de Cierre certificada (hash + firma Ed25519 + QR de verificación
pública), Portal de Partes (paridad completa: audiencias, documentos, chat,
tareas, compromisos), Preparación de audiencia (el mejor patrón de UX del
producto — resuelve todo in-place, sin navegar), Feed ICS de solo lectura,
videoconferencia real con Google Meet/Zoom/Microsoft Teams (confirmado no
simulado, con fallo ruidoso si faltan credenciales), Centro de atención
(detectores + severidad + acción sugerida — el corazón del producto),
Timeline automático, Calculadora de honorarios (fuente normativa citada),
Asistente de IA por expediente y dashboard (con degradación honesta si falta
la API key), Motor de Plazos Legales (Bloque 43, con las reservas de la
sección 3).
