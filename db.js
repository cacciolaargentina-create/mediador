// db.js
// Almacenamiento en SQLite (node:sqlite, nativo de Node — sin dependencias
// npm nuevas, así que no depende de compilar nada en el servidor). Tablas e
// índices reales, pensados para que más adelante se puedan reescribir
// consultas puntuales en SQL directo si el volumen lo pide.
//
// Por ahora el resto del código (routes/, messaging.js, certificate.js,
// reminders.js, audit.js, serializers.js) sigue viendo exactamente la misma
// forma en memoria que antes — getDB() devuelve {users:[], channels:[], ...}
// y se sigue usando con .filter()/.find()/.push() como siempre. Eso evita
// tener que reescribir cada consulta de golpe contra datos reales de
// producción. commit() ahora vuelca ese estado a SQLite dentro de UNA
// transacción — sigue siendo una resincronización completa por escritura
// (mismo costo conceptual que el fs.writeFileSync de antes), pero ahora es
// atómica de verdad: un crash a mitad de un commit ya no puede dejar el
// archivo corrupto a medias, como sí podía pasar con el JSON plano.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data.sqlite');
// ruta del data.json viejo, solo para la migración automática de una vez
const LEGACY_JSON_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');

const EMPTY_DB = {
  users: [],       // { id, googleId, email, name, avatar, phone, guest, icsToken|null, notificationDigest|null, createdAt, lastLoginAt|null, disabledAt|null } — notificationDigest (Bloque 22 Parte 1): 'none'|'daily'|'weekly', default 'none' (sin digest, sin cambio de comportamiento). lastLoginAt (Bloque 27): se actualiza en cada login real (Google o fake-login), nunca en cada request. disabledAt (Bloque 27): si está seteado, passport.deserializeUser (server.js) deja de autenticar a esa cuenta — mismo 401 de siempre, sin chequeo nuevo repetido en cada ruta
  channels: [],    // { id, code, guestToken, calendarToken, professionalInvites, status:'abierto'|'en_proceso'|'cerrado', createdAt, mediationId|null, partyId|null, lawyerId|null } — mediationId+partyId: hilo mediador↔parte de Mediador; mediationId+lawyerId: hilo mediador↔abogado; mediationId solo (los otros dos null): canal interno del equipo de esa mediación. Los tres null = canal de coparentalidad de siempre.
  members: [],     // { id, channelId, userId, role, label, webAccessToken, assignedByAdmin, lastSeenAt, joinedAt }
  messages: [],    // { id, channelId, senderId|null, text, flagged, reason, pattern, eventId, readAt, createdAt, replyToId, deliverAt, documentId|null, via:'interno'|'sistema'|'whatsapp'|'email' } — replyToId: id de otro mensaje del mismo canal al que este responde (hilo estilo WhatsApp), null si no es una respuesta. deliverAt: cuándo se transmite/notifica de verdad — igual a createdAt salvo durante la ventana de "deshacer envío" (ver messaging.js), mientras está en el futuro el mensaje solo lo ve quien lo escribió. documentId (Bloque 19): referencia opcional a un documento YA existente de la mediación — nunca un adjunto nuevo, el documento sigue viviendo solo en `documents`. via (Bloque 31, MEDIO de comunicación — nombrado distinto de "channel"/`channels` a propósito, ver comentario en ensureColumns): 'interno' (default, chat de siempre) o 'sistema' (senderId null) son los únicos valores que hoy escribe el código — 'whatsapp'/'email' quedan reservados para cuando exista esa integración real
  messageReactions: [], // { id, messageId, channelId, userId, emoji, createdAt } — una reacción activa por usuario por mensaje; reaccionar de nuevo con otro emoji reemplaza la anterior, reaccionar con el mismo la saca
  events: [],      // { id, channelId, date, detail, requestedBy(userId), status, seriesId, swapId, respondedAt, reminderSentAt, createdAt, kind:'entrega'|'vencimiento' } — kind default 'entrega' (coparentalidad, ver requireParty) en eventos viejos; 'vencimiento' es un plazo procesal (ver POST .../events/vencimiento), se crea directo en 'confirmado', sin flujo de propuesta/rechazo
  caseNotes: [],   // { id, channelId, authorId, text, createdAt } — solo visibles para mediador/a, estudio jurídico o admin del canal, nunca para las partes A/B
  expenses: [],    // { id, channelId, amount, description, requestedBy(userId), status:'pendiente'|'confirmado'|'rechazado', respondedAt, eventId, createdAt }
  checkins: [],    // { id, channelId, userId, lat, lng, createdAt } — la ubicación nunca se muestra en el texto del chat, solo queda en el registro
  auditLog: [],    // { id, actorId, action, channelCode, meta, createdAt } — acciones sensibles para el panel de admin
  whatsappLog: [],      // { id, kind, phone, userName, channelCode, mediationId|null, partyId|null, detail, createdAt } — notificaciones enviadas, onboarding, mensajes entrantes procesados. partyId (Bloque 22 Parte 1): para rastrear fallos consecutivos de contacto de UNA parte puntual
  whatsappWebhookRaw: [], // { id, payload, createdAt } — últimos payloads crudos del webhook de Meta, para debug técnico
  certifiedExports: [], // { id, hash, signature, channelCode, generatedByName, generatedByRole, createdAt } — un registro por cada export certificado en PDF, para que la página pública de verificación (/verificar/:hash) pueda confirmar que el documento realmente salió de acá. signature: firma electrónica Ed25519 del hash (ver signing.js) — null en exports viejos, de antes de que existiera esto
  professionalApplications: [], // { id, userId, role, orgName, status:'pending'|'approved'|'rejected', createdAt, decidedAt, decidedBy } — autoregistro de mediador/a o estudio jurídico, pendiente de aprobación manual de un admin
  moderationStats: [], // { id, date:'YYYY-MM-DD', channelCode|null, successCount, failCount, flaggedCount } — UNA fila por día+canal (no una por llamada), para que el panel de Costos y Salud pueda sumar por período sin que la tabla crezca sin límite
  pushSubscriptions: [], // { id, userId, endpoint, keys:{p256dh,auth}, createdAt } — un dispositivo suscripto a notificaciones push del navegador; una persona puede tener varios (celu + compu)
  reports: [], // { id, channelId, messageId|null, reporterId, reason, createdAt, status:'pendiente'|'revisado', reviewedBy, reviewedAt } — "Reportar" desde el chat, para cuando lo que preocupa es un mensaje del OTRO lado (la moderación de IA solo filtra lo que uno mismo manda)

  // ===== Mediador (B2B) — Bloque 1. Ver IMPLEMENTATION_PLAN.md §3 para el resto de las tablas (Bloques 4-6, todavía no creadas) =====
  mediations: [], // { id, code, internalNumber, mediatorUserId, channelId, type, object, description, status:'borrador'|'iniciada'|'contactando_partes'|'notificaciones'|'audiencia_programada'|'en_mediacion'|'acuerdo'|'acuerdo_parcial'|'sin_acuerdo'|'incomparecencia'|'cerrada', nextActionText, nextActionResponsibleType:'mediador'|'party'|'lawyer', nextActionResponsibleId, nextActionDueDate, closedAt, closedResult, closedNotes, createdAt, inactivityThresholdDays|null, partyNoResponseThresholdDays|null, onboardingDismissedAt|null } — inactivityThresholdDays/partyNoResponseThresholdDays (Bloque 22 automatización): ventanas configurables por mediación para el centro de atención, default en código (21 y 5 días) si son null — mismo patrón que upcomingDueWindowDays. onboardingDismissedAt (Bloque 24): se completa solo al descartar el asistente de carga guiada, nunca se lee fuera de ese flujo
  mediationStatusHistory: [], // { id, mediationId, fromStatus, toStatus, changedBy, note, createdAt } — nunca se borra una fila, solo se agregan
  mediationAccess: [], // { id, mediationId, userId, role:'mediador'|'asistente'|'abogado'|'admin', partyId|null, grantedBy, grantedAt } — el mediador titular vive en mediations.mediatorUserId, esta tabla es para accesos ADICIONALES (ver §3.2b del plan)

  // ===== Bloque 14 (Parte 1). Multiusuario/estudio =====
  studios: [], // { id, name, ownerId, status:'activo'|'inactivo', createdAt }
  studioInvitations: [], // { id, studioId, email, role:'admin'|'mediador'|'asistente', token, invitedBy, status:'pendiente'|'aceptada'|'rechazada', createdAt, resolvedAt }

  // ===== Bloque 4. Ver IMPLEMENTATION_PLAN.md §3.3-3.6 =====
  parties: [], // { id, mediationId, type:'persona'|'empresa', role:'requirente'|'requerido'|'otro', firstName, lastName, legalName, documentType, documentNumber, taxId, email, phone, address, status:'activa'|'inactiva', linkedUserId|null, notes, createdAt }
  lawyers: [], // { id, mediationId, partyId, name, enrollmentNumber, barAssociation, email, phone, createdAt }
  hearings: [], // { id, mediationId, date, startTime, endTime, type:'primera'|'continuacion'|'privada'|'otra', modality:'presencial'|'virtual'|'hibrida', location, meetingUrl, status:'propuesta'|'programada'|'confirmada'|'realizada'|'cancelada'|'no_realizada', notes, proposalGroupId|null, targetPartyId|null, createdAt, startAlertSentAt|null, videoProvider|null, meetingId|null, hostUrl|null, meetingCreatedAt|null, meetingUpdatedAt|null, meetingStatus|null, meetingMetadata|null, calendarSyncEventId|null, calendarSyncStatus|null, calendarSyncUpdatedAt|null } — startAlertSentAt (Bloque 26): se completa una sola vez, cuando se publica el mensaje de sistema de "audiencia por empezar" en los hilos de las partes — nunca se resetea, evita mandarlo dos veces. Campos de videoconferencia (Bloque 28): meetingUrl SIGUE siendo el join URL de siempre (lo que ya veían partes/abogados/agenda/ICS/el job de "audiencia por empezar") — nunca se duplicó. videoProvider:'google_meet'|'zoom'|'teams'|'manual'|null, meetingId (id de la reunión en el proveedor externo, para poder actualizarla/cancelarla después), hostUrl (link de organizador — SOLO Zoom lo diferencia del join URL; nunca se expone a partes/abogados), meetingStatus:'no_configurada'|'creando'|'creada'|'actualizando'|'actualizada'|'error'|'cancelada' (estado de la REUNIÓN, distinto del estado de la audiencia), meetingMetadata (objeto JSON con datos no sensibles del proveedor — nunca tokens/secrets). Campos de sincronización con Google Calendar (Bloque 44): calendarSyncEventId (id del evento en el Calendar del mediador, NULL si videoProvider ya es google_meet — ahí meetingId ya ES el evento, no se duplica), calendarSyncStatus:'sincronizado'|'error'|null, calendarSyncUpdatedAt|null
  videoProviderAccounts: [], // { id, userId, provider:'google_meet'|'zoom'|'teams', status:'conectado'|'requiere_autorizacion'|'error', accessToken|null, refreshToken|null, expiresAt|null, accountEmail|null, lastError|null, connectedAt, updatedAt } — credenciales OAuth de UN mediador para UN proveedor (Bloque 28 §17: nunca en hearings, nunca en logs/respuestas de API — ver serializeVideoAccount en routes/video-providers.js, que nunca incluye accessToken/refreshToken)
  hearingConfirmations: [], // { id, hearingId, partyId, response:'pendiente'|'confirma'|'no_puede'|'pide_cambio', respondedAt, createdAt } — una fila por parte por audiencia, se crea sola al crear la audiencia
  hearingRescheduleRequests: [], // { id, hearingId, mediationId, requestedByPartyId, requestedByType:'party'|'lawyer', requestedByLawyerId|null, reason|null, comment|null, preferredDayText|null, preferredTimeText|null, proposedDate|null, proposedStartTime|null, status:'pendiente'|'aceptada'|'rechazada'|'resuelta', mediatorNote|null, resolvedBy|null, resolvedAt|null, createdAt, sourceMessageId|null } — sourceMessageId (Bloque 19): si el mediador la creó a mano desde un mensaje de chat ("Gestionar cambio de audiencia"), en vez de haber llegado por el portal

  // ===== Bloque 15 (Parte 1). Agenda/disponibilidad =====
  mediatorAvailability: [], // { id, userId, dayOfWeek (0=domingo..6=sabado), startTime, endTime, createdAt } — varios bloques por día son varias filas
  mediatorScheduleBlocks: [], // { id, userId, date, startTime, endTime, reason (interno, nunca visible para partes/abogados), createdAt }

  // ===== Bloque 5. Ver IMPLEMENTATION_PLAN.md §3.7 =====
  documents: [], // { id, mediationId, uploadedBy, partyId|null, type, originalFilename (solo para mostrar), storagePath (nombre físico aleatorio en disco), mimeType, size, status:'pendiente_escaneo'|'recibido'|'pendiente_revision'|'revisado'|'observado'|'final', version, parentDocumentId|null (apunta a la RAÍZ del linaje de versiones, no a la anterior — null = documento independiente o es él mismo la raíz), createdAt, reviewNotes|null } — reviewNotes (Bloque 32): comentario del mediador al cambiar el estado — obligatorio al marcar 'observado' (rutas/mediations.js lo exige), visible para la parte dueña del documento en su portal

  // ===== Bloque 6. Ver IMPLEMENTATION_PLAN.md §3.10/3.11/3.8/3.9 =====
  mediationEvents: [], // { id, mediationId, type, actorId|null, visibility:'public'|'mediator_only', entityType, entityId, title, description, metadata|null, causedByEventId|null, createdAt }
  tasks: [], // { id, mediationId, assignedTo, title, description, dueDate, priority:'baja'|'media'|'alta'|'urgente', status:'pendiente'|'en_proceso'|'completada'|'cancelada', createdBy, completedAt, createdAt, sourceMessageId|null, sourceDocumentId|null, assignedToPartyId|null, assignedToLawyerId|null } — sourceDocumentId (Bloque 22 automatización): igual que sourceMessageId pero para "documento recibido → ¿crear tarea de revisión?"; sirve para no duplicar la sugerencia si ya existe una tarea activa para ese documento. assignedToPartyId (Bloque 31): si está seteada, la tarea es de UNA parte (visible/completable desde su portal, ver routes/party-portal.js) en vez de del equipo mediador — mutuamente excluyente en la práctica con assignedTo, aunque el campo no se borra. assignedToLawyerId (Bloque 61): mismo mecanismo, para UN abogado (ver routes/lawyer-portal.js) — mutuamente excluyente con assignedToPartyId, validado al crear la tarea
  attentionDismissals: [], // { id, mediationId, alertType, refId, dismissedBy, dismissedAt } — "descartar alerta" del centro de atención (Bloque 22 automatización). alertType+refId identifican la situación puntual (ej. alertType:'partyNoResponse', refId:partyId) — nunca borra el dato subyacente, solo oculta la alerta hasta que la situación cambie de verdad (ver automationEngine.js)
  commitments: [], // { id, mediationId, partyId, description, dueDate, status:'pendiente'|'cumplido'|'vencido'|'cancelado', createdFromEventId|null, completedAt, createdAt, sourceMessageId|null, notes|null, documentId|null } — notes/documentId (Bloque 31): observaciones libres y evidencia — documentId apunta a un documento YA existente de la mediación, nunca un adjunto nuevo (mismo patrón que messages.documentId)

  // ===== Bloque 25. Radar competitivo — herramienta interna, solo admin
  // (ver routes/radar.js). Monitorea información PÚBLICA de competidores y
  // sistemas oficiales para detectar cambios, nunca para copiar contenido ni
  // decidir producto en automático (ver radarEngine.js) =====
  competitorSources: [], // { id, name, url, category:'competidor'|'oficial'|'regulatorio'|'mercado', active, checkFrequency:'daily'|'weekly'|'manual', lastCheckedAt|null, lastChangedAt|null, lastHash|null, notes|null, createdAt, updatedAt }
  competitorSnapshots: [], // { id, sourceId, checkedAt, contentHash, title|null, description|null, pricingText|null, featuresText|null, integrationsText|null, rawTextHash } — solo texto resumido/extractos, nunca el HTML completo (ver radarScraper.js)
  competitorChanges: [], // { id, sourceId, type, level:'LOW'|'MEDIUM'|'HIGH', title, beforeText|null, afterText|null, evidenceText, detectedAt, status:'nueva'|'revisada'|'descartada'|'convertida_en_oportunidad', reviewedBy|null, reviewedAt|null } — también funciona como "alertas del radar" (§12 de la spec): un cambio relevante ES una alerta, no se duplicó una segunda tabla para lo mismo
  competitorFeatureDetections: [], // { id, sourceId, feature, status:'confirmada'|'posible'|'no_confirmada', evidence, detectedAt } — una fila por sourceId+feature, se actualiza (no se duplica) en cada chequeo
  competitorPrices: [], // { id, sourceId, plan|null, price|null, currency|null, periodicity|null, mediationLimit|null, featuresText|null, detectedAt } — histórico, append-only, nunca se borra ni se modifican precios de Mediador automáticamente
  competitorOpportunities: [], // { id, title, observation, evidence, sourceId|null, changeId|null, status:'pendiente'|'confirmada'|'descartada', createdAt, confirmedBy|null, confirmedAt|null } — siempre creada a mano desde un cambio (§9/§13: el sistema nunca decide solo)

  // ===== Bloque 29. Billing + Mercado Pago (ver billingService.js/
  // entitlements.js/services/mercadoPago.js). Mercado Pago es SOLO el
  // proveedor de cobro — Mediador es dueño del estado comercial real
  // (billingAccounts.status), nunca se activa un plan solo porque el
  // usuario volvió del checkout (ver syncSubscription). NUNCA se guardan
  // datos de tarjeta acá — solo referencias/estados de Mercado Pago =====
  billingPlans: [], // { id, code:'FREE'|'PROFESIONAL'|'ESTUDIO', name, description, price, currency, interval:'month'|'year', active, providerPlanId|null, createdAt, updatedAt } — precios configurables en DB, nunca hardcodeados en el frontend. providerPlanId: vestigial desde la corrección del modelo de Mercado Pago (ver billingService.js) — se dejó de escribir (era el id de un /preapproval_plan que ya no se crea), la columna queda en null para siempre y no se migró por no justificar el riesgo
  billingAccounts: [], // { id, userId|null, studioId|null, planCode, status:'inactive'|'trial'|'active'|'pending'|'past_due'|'cancelled'|'expired'|'suspended', provider:'mercadopago'|null, providerCustomerId|null, providerSubscriptionId|null, currentPeriodStart|null, currentPeriodEnd|null, cancelAtPeriodEnd, trialEndsAt|null, pastDueSince|null, createdAt, updatedAt } — userId XOR studioId (cuenta personal vs. de estudio, nunca las dos). Sin fila = FREE implícito (ver entitlements.js) — así una base existente no necesita backfill
  billingEvents: [], // { id, provider, eventId, eventType, subscriptionId|null, paymentId|null, payloadHash, status:'processed'|'ignored'|'error', processedAt|null, createdAt } — provider+eventId es la clave de idempotencia (§11): un mismo webhook nunca se procesa dos veces
  billingPayments: [], // { id, billingAccountId, provider, providerPaymentId, subscriptionId|null, amount, currency, status:'approved'|'pending'|'rejected'|'cancelled'|'refunded', approvedAt|null, paidAt|null, createdAt, updatedAt } — NUNCA número de tarjeta/CVV/vencimiento, solo lo que Mercado Pago informa sobre el pago en sí

  // ===== Bloque 29 (Admin Console 2.0) — soporte, acceso excepcional e
  // impersonación. NINGUNA de estas tres tablas reemplaza mediation_access
  // ni el chequeo normal de autorización — son mecanismos EXPLÍCITOS,
  // TEMPORALES y AUDITADOS para casos puntuales de soporte (spec §8/§9),
  // nunca "el admin ve todo siempre". Ver roles.js (requirePlatformAdmin)
  // y routes/admin-mediador.js para dónde se usan. =====
  supportTickets: [], // { id, userId|null, studioId|null, mediationId|null, category:'billing'|'login'|'mediation'|'agenda'|'documents'|'communications'|'notifications'|'video'|'performance'|'other', priority:'baja'|'media'|'alta'|'urgente', description, status:'open'|'in_progress'|'waiting'|'resolved'|'closed', assignedTo|null(adminUserId), resolution|null, createdBy(adminUserId que lo cargó), createdAt, updatedAt, resolvedAt|null }
  supportAccessGrants: [], // { id, adminUserId, mediationId, reason, durationMinutes, startedAt, expiresAt, endedAt|null, resourcesAccessed } — read-only por definición (nunca habilita POST/PATCH). Vence solo por tiempo (expiresAt) o manualmente (endedAt) — nunca queda "para siempre". resourcesAccessed: array de strings (qué se consultó mientras estuvo activo), para poder responder "¿qué recurso fue consultado?"
  impersonationSessions: [], // { id, adminUserId, targetUserId, reason, durationMinutes, startedAt, expiresAt, endedAt|null } — "ver como usuario": solo lectura, nunca permite mandar mensajes/modificar nada (eso se valida en cada ruta, no acá)
  featureFlags: [], // { id, key, label, enabled, updatedAt, updatedBy|null } — activar/desactivar funcionalidad sin tocar código (spec §22). Nunca sustituye autorización: un flag prendido no le da acceso a quien no tiene permiso.

  // ===== Herramientas Legales — Calculadora de honorarios (Bloque 42).
  // Separado en dos tablas a propósito: honorariosScales es la ESTRUCTURA
  // de la norma (tramos en unidades, rara vez cambia — solo si el
  // Ministerio/la SCBA modifica la reglamentación en sí), honorariosUnitValues
  // es el VALOR en pesos de esa unidad, que sí cambia todos los meses. Ningún
  // valor monetario vive en el frontend ni hardcodeado en código — ambas
  // tablas se cargan por seed versionado (ver routes/admin-mediador.js) y se
  // actualizan agregando FILAS NUEVAS, nunca pisando las viejas (así el
  // cálculo de una mediación cerrada hace tiempo puede recalcularse con el
  // valor vigente EN ESE MOMENTO, no con el de hoy). =====
  honorariosScales: [], // { id, jurisdiccion:'nacion', tipoMediacion:'general'|'familiar', unidad:'UHOM', norma, honorarioProvisionalUnidades, tramos:[{item,label,honorarioUnidades,montoDesdeUnidades|null,montoHastaUnidades|null,porcentaje|null,topeUnidades|null}], adicionalPorAudiencia:{desdeAudiencia,itemsMenor:['A','B'],unidadesMenor,unidadesMayor}, fuente, urlFuente, fechaVerificacion, createdAt }
  honorariosUnitValues: [], // { id, scaleId, valorPesos, fechaDesde, fechaHasta|null(null=vigente), fuente, urlFuente, fechaVerificacion, createdAt, createdBy|null } — fechaHasta null = valor vigente; al cargar un valor nuevo se cierra (fechaHasta) el anterior, nunca se borra

  // ===== Bloque 43. Motor de Plazos Legales y Notificación Fehaciente.
  // No duplica nada existente: reutiliza parties.role ('requerido'),
  // documents (prueba de notificación), mediationEvents (auditoría de
  // correcciones de fecha base) y jobs.js/automationEngine.js (recordatorios
  // y centro de atención). Lo único nuevo es lo que de verdad faltaba: el
  // calendario de días hábiles, el registro de notificación fehaciente por
  // parte, y el registro de prórrogas acordadas. Ver docs/PLAZOS_LEGALES.md. =====
  legalHolidays: [], // { id, year, date:'YYYY-MM-DD', type:'feriado_nacional'|'feria_judicial'|'asueto'|'otro', description, createdAt } — día NO hábil para el cómputo de plazos (ver businessCalendar.js). Se siembra al arrancar el servidor, de forma idempotente (por year+date), para el año en curso y el siguiente — nunca pisa filas cargadas a mano por un admin. Cargar feriados de años futuros/trasladables es una tarea manual (ver documentación); si el año en curso no tiene ninguna fila, el centro de atención avisa (solo a admin de plataforma)
  partyNotifications: [], // { id, mediationId, partyId, medium:'carta_documento'|'cedula'|'acta_notarial'|'personal'|'electronico', pieceId|null, sentDate|null(YYYY-MM-DD), status:'enviada'|'recibida'|'rechazada'|'no_localizado', receivedDate|null(YYYY-MM-DD) — el cómputo del plazo de 60 días hábiles usa SIEMPRE receivedDate, nunca sentDate (pueden diferir), documentId|null(prueba adjunta, reutiliza la tabla documents existente — nunca un adjunto paralelo), observations|null, createdBy, createdAt, updatedAt } — mientras una parte con role:'requerido' no tenga ninguna fila acá, su plazo se muestra como "no iniciado" (spec §5) y aparece en el centro de atención
  mediationDeadlineExtensions: [], // { id, mediationId, days|null, newDeadlineDate|null, reason, agreedDate(YYYY-MM-DD), recordedBy, createdAt } — prórroga del plazo de 60 días por acuerdo de partes (spec §4.1). Se puede cargar en días a sumar O una fecha límite nueva directa; nunca se borra una prórroga ya cargada, es un registro histórico
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, googleId TEXT, email TEXT, name TEXT, avatar TEXT,
  phone TEXT, guest INTEGER DEFAULT 0, aiUsage TEXT,
  verifiedProfessional INTEGER DEFAULT 0, verifiedProfessionalRole TEXT, verifiedProfessionalOrg TEXT,
  readReceiptsEnabled INTEGER DEFAULT 1,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, guestToken TEXT, calendarToken TEXT,
  professionalInvites TEXT, remindedAt INTEGER, lastSummary TEXT,
  status TEXT DEFAULT 'abierto', createdAt INTEGER, pinnedMessageId TEXT,
  mediationId TEXT, partyId TEXT
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, channelId TEXT, userId TEXT, role TEXT, label TEXT,
  webAccessToken TEXT, assignedByAdmin INTEGER DEFAULT 0, lastSeenAt INTEGER, joinedAt INTEGER,
  notificationsMuted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channelId TEXT, senderId TEXT, text TEXT,
  flagged INTEGER DEFAULT 0, reason TEXT, pattern INTEGER DEFAULT 0,
  eventId TEXT, readAt INTEGER, createdAt INTEGER, replyToId TEXT, deliverAt INTEGER,
  attachment TEXT
);
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY, messageId TEXT, channelId TEXT, userId TEXT, emoji TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, channelId TEXT, date TEXT, detail TEXT, requestedBy TEXT,
  status TEXT, seriesId TEXT, swapId TEXT, respondedAt INTEGER, reminderSentAt INTEGER, createdAt INTEGER,
  kind TEXT DEFAULT 'entrega'
);
CREATE TABLE IF NOT EXISTS case_notes (
  id TEXT PRIMARY KEY, channelId TEXT, authorId TEXT, text TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY, channelId TEXT, amount REAL, description TEXT,
  requestedBy TEXT, status TEXT, respondedAt INTEGER, eventId TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY, channelId TEXT, userId TEXT, lat REAL, lng REAL, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actorId TEXT, action TEXT, channelCode TEXT, meta TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS whatsapp_log (
  id TEXT PRIMARY KEY, kind TEXT, phone TEXT, userName TEXT, channelCode TEXT, detail TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS whatsapp_webhook_raw (
  id TEXT PRIMARY KEY, payload TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS certified_exports (
  id TEXT PRIMARY KEY, hash TEXT UNIQUE, signature TEXT, channelCode TEXT, generatedByName TEXT,
  generatedByRole TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS professional_applications (
  id TEXT PRIMARY KEY, userId TEXT, role TEXT, orgName TEXT, status TEXT,
  createdAt INTEGER, decidedAt INTEGER, decidedBy TEXT
);
CREATE TABLE IF NOT EXISTS moderation_stats (
  id TEXT PRIMARY KEY, date TEXT, channelCode TEXT,
  successCount INTEGER DEFAULT 0, failCount INTEGER DEFAULT 0, flaggedCount INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, userId TEXT, endpoint TEXT UNIQUE, keys TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, channelId TEXT, messageId TEXT, reporterId TEXT, reason TEXT,
  status TEXT DEFAULT 'pendiente', reviewedBy TEXT, reviewedAt INTEGER, createdAt INTEGER
);
-- ===== Mediador (B2B) — Bloque 1, ver IMPLEMENTATION_PLAN.md §3.1/3.2/3.2b =====
CREATE TABLE IF NOT EXISTS mediations (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, internalNumber TEXT,
  mediatorUserId TEXT, channelId TEXT,
  type TEXT, object TEXT, description TEXT,
  status TEXT DEFAULT 'borrador',
  nextActionText TEXT, nextActionResponsibleType TEXT, nextActionResponsibleId TEXT, nextActionDueDate TEXT,
  closedAt INTEGER, closedResult TEXT, closedNotes TEXT,
  createdAt INTEGER
);
-- historial de cambios de estado — nunca se borra una fila (spec §4:
-- "no eliminar información histórica"), solo se agregan nuevas.
CREATE TABLE IF NOT EXISTS mediation_status_history (
  id TEXT PRIMARY KEY, mediationId TEXT, fromStatus TEXT, toStatus TEXT,
  changedBy TEXT, note TEXT, createdAt INTEGER
);
-- quién más (además del mediador titular) tiene acceso a una mediación —
-- ver IMPLEMENTATION_PLAN.md §3.2b para por qué esto es una tabla propia
-- desde el día 1, en vez de agregarla recién cuando exista rol
-- asistente/abogado.
CREATE TABLE IF NOT EXISTS mediation_access (
  id TEXT PRIMARY KEY, mediationId TEXT, userId TEXT, role TEXT, partyId TEXT,
  grantedBy TEXT, grantedAt INTEGER
);
-- ===== Bloque 14 (Parte 1) — multiusuario/estudio =====
-- studios: la entidad mínima que pide la especificación — nombre,
-- propietario, estado. NADA de facturación/planes/límites (fuera de
-- alcance a propósito). "usuarios integrantes" no es una columna acá —
-- vive en users.studioId (ver ensureColumns más abajo), un usuario
-- pertenece a UN estudio, no hace falta una tabla de membresía aparte
-- para esta Parte 1.
CREATE TABLE IF NOT EXISTS studios (
  id TEXT PRIMARY KEY, name TEXT, ownerId TEXT, status TEXT DEFAULT 'activo', createdAt INTEGER
);
-- la invitación es su propio registro con token — recién se asocia el
-- usuario al estudio (users.studioId/studioRole) cuando alguien
-- autenticado con el email exacto de la invitación la acepta. Así nunca
-- se crea una cuenta nueva por invitar a alguien que todavía no existe.
CREATE TABLE IF NOT EXISTS studio_invitations (
  id TEXT PRIMARY KEY, studioId TEXT, email TEXT, role TEXT, token TEXT,
  invitedBy TEXT, status TEXT DEFAULT 'pendiente', createdAt INTEGER, resolvedAt INTEGER
);
-- ===== Bloque 4 — ver IMPLEMENTATION_PLAN.md §3.3/3.4/3.5/3.6 =====
-- las partes tienen sus propios datos legales completos, y existen
-- independientemente de que la persona alguna vez inicie sesión — por eso
-- linkedUserId es nullable: un mediador puede cargar "Juan Pérez, DNI
-- 30.111.222" en el expediente sin que Juan haya hecho nada todavía.
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY, mediationId TEXT, type TEXT, role TEXT,
  firstName TEXT, lastName TEXT, legalName TEXT, documentType TEXT, documentNumber TEXT,
  taxId TEXT, email TEXT, phone TEXT, address TEXT, status TEXT DEFAULT 'activa',
  linkedUserId TEXT, notes TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS lawyers (
  id TEXT PRIMARY KEY, mediationId TEXT, partyId TEXT, name TEXT,
  enrollmentNumber TEXT, barAssociation TEXT, email TEXT, phone TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS hearings (
  id TEXT PRIMARY KEY, mediationId TEXT, date TEXT, startTime TEXT, endTime TEXT,
  type TEXT, modality TEXT, location TEXT, meetingUrl TEXT,
  status TEXT DEFAULT 'programada', notes TEXT, createdAt INTEGER
);
-- una fila por parte por audiencia, así cada una confirma independiente
-- (spec §20) — se crean automáticamente al crear la audiencia (§3.11 del
-- plan, regla HEARING_SCHEDULED), nunca a mano.
CREATE TABLE IF NOT EXISTS hearing_confirmations (
  id TEXT PRIMARY KEY, hearingId TEXT, partyId TEXT, response TEXT DEFAULT 'pendiente',
  respondedAt INTEGER, createdAt INTEGER
);
-- Hardening — reprogramación estructurada. "pide_cambio" en
-- hearing_confirmations sigue existiendo como respuesta de esa parte
-- puntual a ESA audiencia, pero la solicitud en sí (motivo, fecha
-- propuesta, y la resolución del mediador) es un concepto distinto, con
-- su propio ciclo de vida — por eso tabla aparte, no un campo más en
-- hearing_confirmations.
CREATE TABLE IF NOT EXISTS hearing_reschedule_requests (
  id TEXT PRIMARY KEY, hearingId TEXT, mediationId TEXT,
  requestedByPartyId TEXT, requestedByType TEXT, requestedByLawyerId TEXT,
  reason TEXT, comment TEXT, preferredDayText TEXT, preferredTimeText TEXT,
  proposedDate TEXT, proposedStartTime TEXT,
  status TEXT DEFAULT 'pendiente', mediatorNote TEXT,
  resolvedBy TEXT, resolvedAt INTEGER, createdAt INTEGER
);
-- ===== Bloque 15 — agenda/disponibilidad. hearings sigue siendo la
-- única fuente de verdad de la audiencia en sí; esto es solo la
-- disponibilidad recurrente y los bloqueos puntuales del mediador, que
-- son datos nuevos (no existían en ningún lado), no una segunda tabla
-- de audiencias.
CREATE TABLE IF NOT EXISTS mediator_availability (
  id TEXT PRIMARY KEY, userId TEXT, dayOfWeek INTEGER, startTime TEXT, endTime TEXT, createdAt INTEGER
);
-- bloqueo puntual — nunca visible para partes ni abogados (ver §3 de la
-- especificación: "un bloqueo nunca debe aparecer como información para
-- partes o abogados").
CREATE TABLE IF NOT EXISTS mediator_schedule_blocks (
  id TEXT PRIMARY KEY, userId TEXT, date TEXT, startTime TEXT, endTime TEXT, reason TEXT, createdAt INTEGER
);
-- ===== Bloque 5 — ver IMPLEMENTATION_PLAN.md §3.7 y su checklist de
-- seguridad. originalFilename es SOLO para mostrar — nunca se usa para
-- construir un path físico; storagePath es el nombre aleatorio real en
-- disco, generado por el server, nunca derivado de lo que mandó el cliente.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, mediationId TEXT, uploadedBy TEXT, partyId TEXT,
  type TEXT, originalFilename TEXT, storagePath TEXT, mimeType TEXT, size INTEGER,
  status TEXT DEFAULT 'recibido', version INTEGER DEFAULT 1, createdAt INTEGER
);
-- ===== Bloque 6 — ver IMPLEMENTATION_PLAN.md §3.10/3.11/3.8/3.9 =====
-- el timeline: "events" a secas ya es el calendario de coparentalidad (ver
-- §1.4 del plan) — por eso este se llama distinto, para que nadie los
-- confunda escribiendo rápido.
CREATE TABLE IF NOT EXISTS mediation_events (
  id TEXT PRIMARY KEY, mediationId TEXT, type TEXT, actorId TEXT,
  visibility TEXT DEFAULT 'public', entityType TEXT, entityId TEXT,
  title TEXT, description TEXT, metadata TEXT, causedByEventId TEXT, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, mediationId TEXT, assignedTo TEXT,
  title TEXT, description TEXT, dueDate TEXT, priority TEXT DEFAULT 'media',
  status TEXT DEFAULT 'pendiente', createdBy TEXT, completedAt INTEGER, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, mediationId TEXT, partyId TEXT, description TEXT, dueDate TEXT,
  status TEXT DEFAULT 'pendiente', createdFromEventId TEXT, completedAt INTEGER, createdAt INTEGER
);
-- Bloque 22 (automatización) — "descartar alerta" del centro de atención,
-- solo para las alertas que no tienen un registro propio que cambiar de
-- estado (a diferencia de una tarea o un compromiso, que se resuelven
-- marcándolos completados). Nunca borra el dato de origen.
CREATE TABLE IF NOT EXISTS attention_dismissals (
  id TEXT PRIMARY KEY, mediationId TEXT, alertType TEXT, refId TEXT,
  dismissedBy TEXT, dismissedAt INTEGER
);
-- Bloque 25 (radar competitivo) — ver radarEngine.js/radarScraper.js y
-- routes/radar.js. Todo texto acá es un extracto corto, nunca HTML completo.
CREATE TABLE IF NOT EXISTS competitor_sources (
  id TEXT PRIMARY KEY, name TEXT, url TEXT, category TEXT,
  active INTEGER DEFAULT 1, checkFrequency TEXT DEFAULT 'weekly',
  lastCheckedAt INTEGER, lastChangedAt INTEGER, lastHash TEXT, notes TEXT,
  createdAt INTEGER, updatedAt INTEGER
);
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id TEXT PRIMARY KEY, sourceId TEXT, checkedAt INTEGER, contentHash TEXT,
  title TEXT, description TEXT, pricingText TEXT, featuresText TEXT,
  integrationsText TEXT, rawTextHash TEXT
);
CREATE TABLE IF NOT EXISTS competitor_changes (
  id TEXT PRIMARY KEY, sourceId TEXT, type TEXT, level TEXT, title TEXT,
  beforeText TEXT, afterText TEXT, evidenceText TEXT, detectedAt INTEGER,
  status TEXT DEFAULT 'nueva', reviewedBy TEXT, reviewedAt INTEGER
);
CREATE TABLE IF NOT EXISTS competitor_feature_detections (
  id TEXT PRIMARY KEY, sourceId TEXT, feature TEXT, status TEXT,
  evidence TEXT, detectedAt INTEGER
);
CREATE TABLE IF NOT EXISTS competitor_prices (
  id TEXT PRIMARY KEY, sourceId TEXT, plan TEXT, price TEXT, currency TEXT,
  periodicity TEXT, mediationLimit TEXT, featuresText TEXT, detectedAt INTEGER
);
CREATE TABLE IF NOT EXISTS competitor_opportunities (
  id TEXT PRIMARY KEY, title TEXT, observation TEXT, evidence TEXT,
  sourceId TEXT, changeId TEXT, status TEXT DEFAULT 'pendiente',
  createdAt INTEGER, confirmedBy TEXT, confirmedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_certified_exports_hash ON certified_exports(hash);
CREATE INDEX IF NOT EXISTS idx_professional_applications_user ON professional_applications(userId);
CREATE INDEX IF NOT EXISTS idx_moderation_stats_date ON moderation_stats(date);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(userId);
CREATE INDEX IF NOT EXISTS idx_members_channel ON members(channelId);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(userId);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channelId);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(messageId);
CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channelId);
CREATE INDEX IF NOT EXISTS idx_case_notes_channel ON case_notes(channelId);
CREATE INDEX IF NOT EXISTS idx_expenses_channel ON expenses(channelId);
CREATE INDEX IF NOT EXISTS idx_checkins_channel ON checkins(channelId);
CREATE INDEX IF NOT EXISTS idx_reports_channel ON reports(channelId);
CREATE INDEX IF NOT EXISTS idx_mediations_mediator ON mediations(mediatorUserId);
CREATE INDEX IF NOT EXISTS idx_mediations_status ON mediations(status);
CREATE INDEX IF NOT EXISTS idx_mediations_channel ON mediations(channelId);
CREATE INDEX IF NOT EXISTS idx_mediation_status_history_mediation ON mediation_status_history(mediationId);
CREATE INDEX IF NOT EXISTS idx_mediation_access_mediation ON mediation_access(mediationId);
CREATE INDEX IF NOT EXISTS idx_mediation_access_user ON mediation_access(userId);
CREATE INDEX IF NOT EXISTS idx_parties_mediation ON parties(mediationId);
CREATE INDEX IF NOT EXISTS idx_parties_document ON parties(documentNumber);
CREATE INDEX IF NOT EXISTS idx_parties_email ON parties(email);
CREATE INDEX IF NOT EXISTS idx_lawyers_party ON lawyers(partyId);
CREATE INDEX IF NOT EXISTS idx_hearings_mediation ON hearings(mediationId);
CREATE INDEX IF NOT EXISTS idx_hearing_confirmations_hearing ON hearing_confirmations(hearingId);
CREATE INDEX IF NOT EXISTS idx_reschedule_requests_hearing ON hearing_reschedule_requests(hearingId);
CREATE INDEX IF NOT EXISTS idx_reschedule_requests_mediation ON hearing_reschedule_requests(mediationId);
CREATE INDEX IF NOT EXISTS idx_studios_owner ON studios(ownerId);
CREATE INDEX IF NOT EXISTS idx_studio_invitations_studio ON studio_invitations(studioId);
CREATE INDEX IF NOT EXISTS idx_studio_invitations_email ON studio_invitations(email);
CREATE INDEX IF NOT EXISTS idx_mediator_availability_user ON mediator_availability(userId);
CREATE INDEX IF NOT EXISTS idx_mediator_blocks_user ON mediator_schedule_blocks(userId);
CREATE INDEX IF NOT EXISTS idx_mediator_blocks_date ON mediator_schedule_blocks(date);
CREATE INDEX IF NOT EXISTS idx_documents_mediation ON documents(mediationId);
CREATE INDEX IF NOT EXISTS idx_mediation_events_mediation ON mediation_events(mediationId);
CREATE INDEX IF NOT EXISTS idx_tasks_mediation ON tasks(mediationId);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(dueDate);
CREATE INDEX IF NOT EXISTS idx_commitments_mediation ON commitments(mediationId);
CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(dueDate);
CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_source ON competitor_snapshots(sourceId);
CREATE INDEX IF NOT EXISTS idx_competitor_changes_source ON competitor_changes(sourceId);
CREATE INDEX IF NOT EXISTS idx_competitor_changes_status ON competitor_changes(status);
CREATE INDEX IF NOT EXISTS idx_competitor_feature_detections_source ON competitor_feature_detections(sourceId);
CREATE INDEX IF NOT EXISTS idx_competitor_prices_source ON competitor_prices(sourceId);
CREATE INDEX IF NOT EXISTS idx_competitor_opportunities_status ON competitor_opportunities(status);
-- Bloque 28 — videoconferencias. Credenciales OAuth por mediador y por
-- proveedor, en su PROPIA tabla — nunca en hearings (spec §17): una
-- audiencia solo guarda el resultado (meetingUrl/meetingId/estado), nunca
-- un token. Una fila por userId+provider (ver upsert en routes/video-providers.js).
CREATE TABLE IF NOT EXISTS video_provider_accounts (
  id TEXT PRIMARY KEY, userId TEXT, provider TEXT, status TEXT DEFAULT 'requiere_autorizacion',
  accessToken TEXT, refreshToken TEXT, expiresAt INTEGER, accountEmail TEXT, lastError TEXT,
  connectedAt INTEGER, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_video_provider_accounts_user ON video_provider_accounts(userId);
-- Bloque 29 — billing + Mercado Pago. Mercado Pago es solo el proveedor de
-- cobro; estas tablas son la fuente de verdad COMERCIAL de Mediador. Sin
-- fila en billing_accounts = plan FREE implícito (§27: FREE funciona sin
-- Mercado Pago configurado, y una base existente no necesita backfill).
CREATE TABLE IF NOT EXISTS billing_plans (
  id TEXT PRIMARY KEY, code TEXT, name TEXT, description TEXT,
  price REAL DEFAULT 0, currency TEXT DEFAULT 'ARS', interval TEXT DEFAULT 'month',
  active INTEGER DEFAULT 1, providerPlanId TEXT, createdAt INTEGER, updatedAt INTEGER
);
CREATE TABLE IF NOT EXISTS billing_accounts (
  id TEXT PRIMARY KEY, userId TEXT, studioId TEXT, planCode TEXT DEFAULT 'FREE',
  status TEXT DEFAULT 'inactive', provider TEXT, providerCustomerId TEXT, providerSubscriptionId TEXT,
  currentPeriodStart INTEGER, currentPeriodEnd INTEGER, cancelAtPeriodEnd INTEGER DEFAULT 0,
  trialEndsAt INTEGER, pastDueSince INTEGER, createdAt INTEGER, updatedAt INTEGER
);
-- provider+eventId es UNIQUE a propósito (§11 idempotencia): un INSERT
-- duplicado del mismo webhook falla solo, sin necesitar un SELECT previo
-- con condición de carrera entre dos webhooks casi simultáneos.
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY, provider TEXT, eventId TEXT, eventType TEXT,
  subscriptionId TEXT, paymentId TEXT, payloadHash TEXT, status TEXT DEFAULT 'processed',
  processedAt INTEGER, createdAt INTEGER,
  UNIQUE(provider, eventId)
);
CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY, billingAccountId TEXT, provider TEXT, providerPaymentId TEXT,
  subscriptionId TEXT, amount REAL, currency TEXT, status TEXT,
  approvedAt INTEGER, paidAt INTEGER, createdAt INTEGER, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_user ON billing_accounts(userId);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_studio ON billing_accounts(studioId);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_subscription ON billing_accounts(providerSubscriptionId);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_status ON billing_accounts(status);
CREATE INDEX IF NOT EXISTS idx_billing_events_subscription ON billing_events(subscriptionId);
CREATE INDEX IF NOT EXISTS idx_billing_payments_account ON billing_payments(billingAccountId);
CREATE INDEX IF NOT EXISTS idx_billing_payments_provider_payment ON billing_payments(providerPaymentId);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY, userId TEXT, studioId TEXT, mediationId TEXT,
  category TEXT, priority TEXT DEFAULT 'media', description TEXT,
  status TEXT DEFAULT 'open', assignedTo TEXT, resolution TEXT,
  createdBy TEXT, createdAt INTEGER, updatedAt INTEGER, resolvedAt INTEGER
);
CREATE TABLE IF NOT EXISTS support_access_grants (
  id TEXT PRIMARY KEY, adminUserId TEXT, mediationId TEXT, reason TEXT,
  durationMinutes INTEGER, startedAt INTEGER, expiresAt INTEGER, endedAt INTEGER,
  resourcesAccessed TEXT
);
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id TEXT PRIMARY KEY, adminUserId TEXT, targetUserId TEXT, reason TEXT,
  durationMinutes INTEGER, startedAt INTEGER, expiresAt INTEGER, endedAt INTEGER
);
CREATE TABLE IF NOT EXISTS feature_flags (
  id TEXT PRIMARY KEY, key TEXT UNIQUE, label TEXT, enabled INTEGER DEFAULT 0,
  updatedAt INTEGER, updatedBy TEXT
);
CREATE TABLE IF NOT EXISTS honorarios_scales (
  id TEXT PRIMARY KEY, jurisdiccion TEXT, tipoMediacion TEXT, unidad TEXT, norma TEXT,
  honorarioProvisionalUnidades REAL, tramos TEXT, adicionalPorAudiencia TEXT,
  fuente TEXT, urlFuente TEXT, fechaVerificacion INTEGER, createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS honorarios_unit_values (
  id TEXT PRIMARY KEY, scaleId TEXT, valorPesos REAL, fechaDesde TEXT, fechaHasta TEXT,
  fuente TEXT, urlFuente TEXT, fechaVerificacion INTEGER, createdAt INTEGER, createdBy TEXT
);
CREATE INDEX IF NOT EXISTS idx_honorarios_unit_values_scale ON honorarios_unit_values(scaleId);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_access_grants_mediation ON support_access_grants(mediationId);
CREATE INDEX IF NOT EXISTS idx_support_access_grants_admin ON support_access_grants(adminUserId);
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_admin ON impersonation_sessions(adminUserId);

CREATE TABLE IF NOT EXISTS legal_holidays (
  id TEXT PRIMARY KEY, year INTEGER, date TEXT, type TEXT, description TEXT, createdAt INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_holidays_year_date ON legal_holidays(year, date);
CREATE TABLE IF NOT EXISTS party_notifications (
  id TEXT PRIMARY KEY, mediationId TEXT, partyId TEXT, medium TEXT, pieceId TEXT,
  sentDate TEXT, status TEXT DEFAULT 'enviada', receivedDate TEXT, documentId TEXT,
  observations TEXT, createdBy TEXT, createdAt INTEGER, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_party_notifications_mediation ON party_notifications(mediationId);
CREATE INDEX IF NOT EXISTS idx_party_notifications_party ON party_notifications(partyId);
CREATE TABLE IF NOT EXISTS mediation_deadline_extensions (
  id TEXT PRIMARY KEY, mediationId TEXT, days INTEGER, newDeadlineDate TEXT,
  reason TEXT, agreedDate TEXT, recordedBy TEXT, createdAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mediation_deadline_extensions_mediation ON mediation_deadline_extensions(mediationId);
`;

// columnas que se guardan como 0/1 en SQLite pero son boolean en JS —
// declaradas por tabla para poder convertir en los dos sentidos sin
// tener que acordarse a mano en cada función.
const BOOL_COLUMNS = {
  users: ['guest', 'verifiedProfessional', 'readReceiptsEnabled'],
  members: ['assignedByAdmin', 'notificationsMuted'],
  messages: ['flagged', 'pattern', 'internalOnly'],
  parties: ['allowDocumentUpload'],
  competitorSources: ['active'],
  billingPlans: ['active'],
  billingAccounts: ['cancelAtPeriodEnd'],
  featureFlags: ['enabled'],
};
// columnas que viajan como objeto/array en JS pero se guardan como texto JSON
const JSON_COLUMNS = {
  channels: ['professionalInvites', 'lastSummary'],
  auditLog: ['meta'],
  users: ['aiUsage'],
  pushSubscriptions: ['keys'],
  messages: ['attachment'],
  mediationEvents: ['metadata'],
  hearings: ['meetingMetadata'],
  supportAccessGrants: ['resourcesAccessed'],
  honorariosScales: ['tramos', 'adicionalPorAudiencia'],
  mediations: ['legalDeadlineRemindersSent'],
};
const TABLE_NAMES = {
  users: 'users', channels: 'channels', members: 'members', messages: 'messages',
  events: 'events', caseNotes: 'case_notes', expenses: 'expenses',
  checkins: 'checkins', auditLog: 'audit_log',
  whatsappLog: 'whatsapp_log', whatsappWebhookRaw: 'whatsapp_webhook_raw',
  certifiedExports: 'certified_exports', professionalApplications: 'professional_applications',
  moderationStats: 'moderation_stats', pushSubscriptions: 'push_subscriptions',
  reports: 'reports', messageReactions: 'message_reactions',
  // ===== Mediador (B2B) =====
  mediations: 'mediations', mediationStatusHistory: 'mediation_status_history',
  mediationAccess: 'mediation_access',
  studios: 'studios', studioInvitations: 'studio_invitations',
  parties: 'parties', lawyers: 'lawyers', hearings: 'hearings', hearingConfirmations: 'hearing_confirmations',
  videoProviderAccounts: 'video_provider_accounts',
  hearingRescheduleRequests: 'hearing_reschedule_requests',
  mediatorAvailability: 'mediator_availability', mediatorScheduleBlocks: 'mediator_schedule_blocks',
  documents: 'documents',
  mediationEvents: 'mediation_events', tasks: 'tasks', commitments: 'commitments',
  attentionDismissals: 'attention_dismissals',
  competitorSources: 'competitor_sources', competitorSnapshots: 'competitor_snapshots',
  competitorChanges: 'competitor_changes', competitorFeatureDetections: 'competitor_feature_detections',
  competitorPrices: 'competitor_prices', competitorOpportunities: 'competitor_opportunities',
  billingPlans: 'billing_plans', billingAccounts: 'billing_accounts',
  billingEvents: 'billing_events', billingPayments: 'billing_payments',
  supportTickets: 'support_tickets', supportAccessGrants: 'support_access_grants',
  impersonationSessions: 'impersonation_sessions', featureFlags: 'feature_flags',
  honorariosScales: 'honorarios_scales', honorariosUnitValues: 'honorarios_unit_values',
  legalHolidays: 'legal_holidays', partyNotifications: 'party_notifications',
  mediationDeadlineExtensions: 'mediation_deadline_extensions',
};

function rowToRecord(collectionKey, row) {
  const rec = { ...row };
  for (const col of BOOL_COLUMNS[collectionKey] || []) rec[col] = !!rec[col];
  for (const col of JSON_COLUMNS[collectionKey] || []) {
    try { rec[col] = rec[col] ? JSON.parse(rec[col]) : (col === 'professionalInvites' ? undefined : null); }
    catch (e) { rec[col] = null; }
  }
  return rec;
}
function recordToRow(collectionKey, rec) {
  const row = { ...rec };
  for (const col of BOOL_COLUMNS[collectionKey] || []) row[col] = row[col] ? 1 : 0;
  for (const col of JSON_COLUMNS[collectionKey] || []) {
    row[col] = row[col] != null ? JSON.stringify(row[col]) : null;
  }
  return row;
}

// agrega columnas nuevas a una tabla que ya existía de una versión anterior
// del esquema — CREATE TABLE IF NOT EXISTS no las suma sola en una base que
// ya está creada. Sin esto, un data.sqlite de producción de antes de sumar
// un campo se queda corto y explota en el primer INSERT.
function ensureColumns(sqlite, table, columns) {
  const existing = new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

function openDb() {
  const isNew = !fs.existsSync(SQLITE_PATH);
  const sqlite = new DatabaseSync(SQLITE_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec(SCHEMA);
  ensureColumns(sqlite, 'users', {
    aiUsage: 'TEXT', verifiedProfessional: 'INTEGER DEFAULT 0',
    verifiedProfessionalRole: 'TEXT', verifiedProfessionalOrg: 'TEXT',
    readReceiptsEnabled: 'INTEGER DEFAULT 1',
  });
  ensureColumns(sqlite, 'channels', { remindedAt: 'INTEGER', lastSummary: 'TEXT', status: "TEXT DEFAULT 'abierto'", pinnedMessageId: 'TEXT', mediationId: 'TEXT', partyId: 'TEXT' });
  ensureColumns(sqlite, 'members', { lastSeenAt: 'INTEGER', notificationsMuted: 'INTEGER DEFAULT 0' });
  ensureColumns(sqlite, 'events', { swapId: 'TEXT', kind: "TEXT DEFAULT 'entrega'" });
  ensureColumns(sqlite, 'expenses', { eventId: 'TEXT' });
  ensureColumns(sqlite, 'certified_exports', { signature: 'TEXT', mediationCode: 'TEXT' });
  ensureColumns(sqlite, 'messages', { replyToId: 'TEXT', deliverAt: 'INTEGER', attachment: 'TEXT' });
  // ===== Mediador (B2B) =====
  ensureColumns(sqlite, 'parties', { portalToken: 'TEXT', allowDocumentUpload: 'INTEGER DEFAULT 1' });
  // Portal de Abogados — mismo patrón que parties: portalToken para
  // acceso sin cuenta, linkedUserId para poder ver el hilo de mensajes de
  // la parte que representa (nunca para escribir — ver diseño abajo).
  ensureColumns(sqlite, 'lawyers', { portalToken: 'TEXT', linkedUserId: 'TEXT' });
  // Hardening — versionado real de documentos. NULL para todo documento
  // existente: eso ya representa correctamente "documento independiente,
  // versión 1" sin necesitar ningún backfill — nada se rompe.
  ensureColumns(sqlite, 'documents', { parentDocumentId: 'TEXT' });
  // el índice va ACÁ, no adentro de SCHEMA — SCHEMA se ejecuta antes que
  // esta migración, así que un índice sobre una columna que recién se
  // crea acá arriba rompe en una base de datos nueva.
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parentDocumentId);');
  // Bloque 15 (Parte 2) — "proponer audiencia": varios horarios candidatos
  // se agrupan por proposalGroupId; targetPartyId, si está, acota la
  // propuesta a una sola parte (null = todas). NULL en ambos para
  // cualquier audiencia ya creada — sigue siendo una audiencia normal,
  // no una propuesta, exactamente como antes.
  ensureColumns(sqlite, 'hearings', { proposalGroupId: 'TEXT', targetPartyId: 'TEXT', lastModifiedBy: 'TEXT', lastModifiedAt: 'INTEGER' });
  // Bloque 16 — faltaba esta migración: el campo ya estaba en el objeto
  // JS y en el comentario de EMPTY_DB, pero nunca en la columna SQL real.
  // Sin esto, cualquier intento de guardar una notificación con
  // mediationId hacía fallar el commit entero (se detectó con un test real).
  ensureColumns(sqlite, 'whatsapp_log', { mediationId: 'TEXT' });
  // Bloque 22 (Parte 1) — partyId propio, no solo userName+mediationId,
  // para poder rastrear fallos consecutivos de UNA parte puntual sin
  // ambigüedad (dos partes podrían compartir nombre de pila).
  ensureColumns(sqlite, 'whatsapp_log', { partyId: 'TEXT' });
  // preferencia de notificación agrupada — 'none' (default, sin cambios
  // de comportamiento) | 'daily' | 'weekly'.
  ensureColumns(sqlite, 'users', { notificationDigest: 'TEXT' });
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_hearings_proposal_group ON hearings(proposalGroupId);');
  // Bloque 14 — un usuario pertenece a lo sumo UN estudio en esta Parte 1.
  // NULL para todo usuario existente: sigue siendo un mediador
  // "independiente", exactamente como antes — no se rompe nada.
  ensureColumns(sqlite, 'users', { studioId: 'TEXT', studioRole: 'TEXT' });
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_users_studio ON users(studioId);');
  // Feed ICS de Mediador — token propio de cada mediador para suscribir su
  // agenda de audiencias en Google Calendar/Apple Calendar/Outlook, de
  // SOLO LECTURA (ver routes/agenda.js GET /feed.ics). NULL hasta que el
  // usuario lo pide por primera vez, ahí se genera y se guarda.
  ensureColumns(sqlite, 'users', { icsToken: 'TEXT' });
  // Bloque 11 — avisos configurables por mediación: con cuánta
  // anticipación avisar de una audiencia próxima, y por qué canal(es).
  ensureColumns(sqlite, 'mediations', { reminderHoursBefore: 'INTEGER DEFAULT 48', reminderChannels: "TEXT DEFAULT 'push,whatsapp'", nextActionSetBy: 'TEXT', upcomingDueWindowDays: 'INTEGER DEFAULT 7', closedBy: 'TEXT' });
  // Bloque 19 — Comunicaciones. Mismas tablas de siempre (channels/
  // members/messages), nada paralelo. lawyerId en channels distingue un
  // hilo mediador↔abogado (nuevo) del hilo mediador↔parte que ya existía
  // (channels.partyId) — un canal de Mediador con mediationId seteado y
  // partyId Y lawyerId ambos NULL es el canal interno del equipo.
  ensureColumns(sqlite, 'channels', { lawyerId: 'TEXT' });
  // referencia opcional a un documento YA existente (tabla documents,
  // Bloque 5) — nunca un adjunto nuevo/paralelo. NULL para todo mensaje
  // anterior a esto, que sigue siendo un mensaje de texto normal.
  ensureColumns(sqlite, 'messages', { documentId: 'TEXT' });
  // trazabilidad "mensaje → acción", nunca automática (ver mediador.js:
  // el mediador elige "Convertir en tarea"/"Crear compromiso" a mano,
  // esto solo guarda de dónde salió).
  ensureColumns(sqlite, 'tasks', { sourceMessageId: 'TEXT' });
  ensureColumns(sqlite, 'commitments', { sourceMessageId: 'TEXT' });
  ensureColumns(sqlite, 'hearing_reschedule_requests', { sourceMessageId: 'TEXT' });
  // Bloque 22 (automatización) — mismo criterio que sourceMessageId, pero
  // para "documento recibido → ¿crear tarea de revisión?" (ver §6 de la
  // spec): sirve para no sugerir/duplicar la tarea si ya existe una
  // activa para ESE documento puntual.
  ensureColumns(sqlite, 'tasks', { sourceDocumentId: 'TEXT' });
  // ventanas configurables del centro de atención, mismo patrón que
  // upcomingDueWindowDays (Bloque 11) — NULL usa el default del código
  // (21 días de inactividad, 5 días sin respuesta de una parte).
  ensureColumns(sqlite, 'mediations', { inactivityThresholdDays: 'INTEGER', partyNoResponseThresholdDays: 'INTEGER' });
  // Bloque 24 — el asistente de carga guiada se descarta a mano, una sola
  // vez; "parties.length===0" ya sirve para saber cuándo MOSTRARLO, pero
  // "el mediador lo descartó explícitamente" no se puede derivar de ningún
  // dato existente, por eso este es el único campo nuevo del bloque.
  ensureColumns(sqlite, 'mediations', { onboardingDismissedAt: 'INTEGER' });
  // Bloque 26 §2 — idempotencia del mensaje de sistema "audiencia por
  // empezar": un solo mensaje por audiencia, nunca dos, aunque el job corra
  // muchas veces mientras la audiencia sigue calificando para la ventana.
  ensureColumns(sqlite, 'hearings', { startAlertSentAt: 'INTEGER' });
  // Bloque 27 — Admin Console. lastLoginAt: no había ningún tracking de
  // último acceso a nivel usuario (members.lastSeenAt es por CANAL, no
  // sirve para "¿esta cuenta sigue activa?"). disabledAt: no existía ningún
  // mecanismo para desactivar una cuenta — se hace cumplir en
  // passport.deserializeUser (server.js), nunca duplicado ruta por ruta.
  ensureColumns(sqlite, 'users', { lastLoginAt: 'INTEGER', disabledAt: 'INTEGER' });
  // Bloque 28 — videoconferencias integradas. meetingUrl/modality/location
  // ya existían (Bloque 4) y siguen significando exactamente lo mismo;
  // estas columnas son PURAMENTE aditivas — NULL en toda audiencia
  // existente equivale a "sin proveedor" (audiencia presencial, o virtual
  // con link cargado a mano como siempre), cero cambio de comportamiento.
  ensureColumns(sqlite, 'hearings', {
    videoProvider: 'TEXT', meetingId: 'TEXT', hostUrl: 'TEXT',
    meetingCreatedAt: 'INTEGER', meetingUpdatedAt: 'INTEGER',
    meetingStatus: 'TEXT', meetingMetadata: 'TEXT',
  });
  // Bloque 31 — compromisos: "observaciones" de texto libre y un enlace
  // opcional a un documento YA EXISTENTE de la mediación como evidencia
  // (mismo patrón que messages.documentId — nunca un adjunto nuevo/paralelo).
  // NULL en todo compromiso existente = sin cambio de comportamiento.
  ensureColumns(sqlite, 'commitments', { notes: 'TEXT', documentId: 'TEXT' });
  // Bloque 31 — arquitectura de MEDIO de comunicación, preparada para
  // integrar WhatsApp/email más adelante SIN inventar esa integración
  // ahora (spec §4: "no inventar, preparar la arquitectura"). Se llama
  // "via" y no "channel" a propósito: "channel"/"canal" ya es la tabla
  // `channels` (el HILO mediador↔parte/abogado) en todo este archivo —
  // llamar igual al medio de comunicación de UN mensaje puntual hubiera
  // sido confundir dos conceptos distintos con el mismo nombre. Hoy solo
  // se escriben dos valores reales: 'interno' (chat de siempre) y
  // 'sistema' (avisos automáticos, senderId null) — 'whatsapp'/'email'
  // quedan reservados, ningún código los setea todavía. Default 'interno'
  // cubre todo mensaje viejo sin backfill.
  ensureColumns(sqlite, 'messages', { via: "TEXT DEFAULT 'interno'" });
  ensureColumns(sqlite, 'messages', { internalOnly: 'INTEGER DEFAULT 0' });
  // Bloque 31 — permite delegar una tarea a una PARTE (antes solo podía
  // vivir en el equipo mediador vía assignedTo=userId). NULL = tarea
  // interna de siempre, cero cambio de comportamiento. Con esto la parte
  // puede verla y marcarla realizada desde su portal (routes/party-portal.js).
  ensureColumns(sqlite, 'tasks', { assignedToPartyId: 'TEXT' });
  // Bloque 61 — mismo mecanismo que assignedToPartyId, pero para delegar
  // una tarea a un ABOGADO (ve/completa desde routes/lawyer-portal.js).
  // NULL = sin cambio de comportamiento. Mutuamente excluyente con
  // assignedToPartyId en la práctica (routes/mediations.js lo valida al
  // crear la tarea), igual que assignedToPartyId lo es con assignedTo.
  ensureColumns(sqlite, 'tasks', { assignedToLawyerId: 'TEXT' });
  // Bloque 32 §2 — "revisar" un documento era solo cambiar un estado; sin
  // esto la parte nunca se enteraba de POR QUÉ algo quedó "observado".
  // NULL en todo documento existente = sin comentario, cero cambio de
  // comportamiento.
  ensureColumns(sqlite, 'documents', { reviewNotes: 'TEXT' });
  // Bloque 43 — jurisdicción de la mediación (hoy solo 'nacion' tiene
  // reglas cargadas; ver jurisdictionRules.js). NULL = "sin jurisdicción
  // cargada", el motor de plazos lo muestra como "no calculable" (spec §3),
  // nunca inventa un valor por defecto. deadlineStartOverride* (spec §7):
  // corrección manual de la fecha base del cómputo de 60 días, con su
  // propio registro de auditoría (quién/cuándo) — además se loguea un
  // mediationEvent en cada corrección, no solo estas columnas.
  ensureColumns(sqlite, 'mediations', {
    jurisdiction: 'TEXT',
    deadlineStartOverride: 'TEXT', deadlineStartOverrideReason: 'TEXT',
    deadlineStartOverrideBy: 'TEXT', deadlineStartOverrideAt: 'INTEGER',
    legalDeadlineRemindersSent: 'TEXT',
  });
  // Bloque 44 — sincronización de audiencias con Google Calendar, aparte
  // de la reunión de video. Separado de meetingId/meetingStatus (Bloque
  // 28, que son del PROVEEDOR DE VIDEO elegido — google_meet/zoom/teams):
  // una audiencia con Zoom como videoconferencia puede IGUALMENTE
  // sincronizarse a Google Calendar si el mediador conectó su cuenta;
  // ahí calendarSyncEventId es el evento de Calendar (sin link de Meet) y
  // meetingId sigue siendo el id de la reunión de Zoom — dos cosas
  // distintas, nunca se pisan. Cuando el proveedor de video ES
  // google_meet, no hace falta un evento de sync aparte (meetingId YA es
  // el evento de Calendar) — calendarSyncEventId queda NULL en ese caso.
  ensureColumns(sqlite, 'hearings', {
    calendarSyncEventId: 'TEXT', calendarSyncStatus: 'TEXT', calendarSyncUpdatedAt: 'INTEGER',
  });
  if (isNew && fs.existsSync(LEGACY_JSON_PATH)) {
    migrateFromJson(sqlite, LEGACY_JSON_PATH);
  }
  return sqlite;
}

// migración de una sola vez: si aparece un data.sqlite nuevo pero ya existía
// un data.json de la versión anterior, lo importa entero antes de arrancar.
function migrateFromJson(sqlite, jsonPath) {
  console.log(`Migrando datos existentes de ${jsonPath} a SQLite (${SQLITE_PATH})...`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (e) {
    console.error('No se pudo leer el data.json existente para migrar — se arranca con base vacía.', e);
    return;
  }
  const tx = sqlite.exec.bind(sqlite);
  tx('BEGIN');
  try {
    for (const key of Object.keys(EMPTY_DB)) {
      const table = TABLE_NAMES[key];
      const list = Array.isArray(raw[key]) ? raw[key] : [];
      for (const rec of list) {
        insertRecord(sqlite, key, table, rec);
      }
    }
    tx('COMMIT');
    console.log(`Migración completa: ${Object.keys(EMPTY_DB).map((k) => `${k}=${(raw[k] || []).length}`).join(', ')}`);
  } catch (e) {
    tx('ROLLBACK');
    console.error('Error migrando data.json a SQLite, se revirtió todo:', e);
    throw e;
  }
}

function insertRecord(sqlite, collectionKey, table, rec) {
  const row = recordToRow(collectionKey, rec);
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);
  stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
}

function loadAllFromSqlite(sqlite) {
  const data = structuredClone(EMPTY_DB);
  for (const key of Object.keys(EMPTY_DB)) {
    const table = TABLE_NAMES[key];
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    data[key] = rows.map((r) => rowToRecord(key, r));
  }
  return data;
}

const sqlite = openDb();
let cache = loadAllFromSqlite(sqlite);

function getDB() {
  return cache;
}

// resincroniza TODO el estado en memoria a SQLite en una única transacción
// — más simple y más seguro que llevar el rastro de qué cambió desde el
// último commit, y a este volumen (miles de filas, no millones) el costo es
// insignificante. Lo importante es que ahora es atómico: si el proceso
// muere a mitad de camino, SQLite descarta la transacción entera y el
// archivo queda como estaba en el último commit exitoso — nunca a medias.
async function commit() {
  sqlite.exec('BEGIN');
  try {
    for (const key of Object.keys(EMPTY_DB)) {
      const table = TABLE_NAMES[key];
      sqlite.exec(`DELETE FROM ${table}`);
      for (const rec of cache[key]) {
        insertRecord(sqlite, key, table, rec);
      }
    }
    sqlite.exec('COMMIT');
  } catch (e) {
    sqlite.exec('ROLLBACK');
    console.error('Error guardando en SQLite, se descartó este commit:', e);
    throw e;
  }
}

// resuelve la identidad de Persona B a partir del token de su link de
// invitado — el token hace las veces de sesión, sin cookie ni expiración.
function resolveGuest(token) {
  const db = cache;
  let channel = db.channels.find((c) => c.guestToken === token);
  let member = channel && db.members.find((m) => m.channelId === channel.id && m.role === 'B' && m.userId);
  if (!member) {
    // fallback: token de acceso de alguien que se sumó por WhatsApp (puede ser A o B)
    member = db.members.find((m) => m.webAccessToken === token);
    channel = member && db.channels.find((c) => c.id === member.channelId);
  }
  if (!member || !channel) return null;
  const user = db.users.find((u) => u.id === member.userId);
  return user ? { channel, user } : null;
}

// Bloque 47 — misma idea que resolveGuest(), pero para el token del
// Portal de Partes/Abogados de Mediador (party.portalToken/
// lawyer.portalToken) — un sistema de identidad DISTINTO del guestToken
// de coparentalidad de arriba (channels.guestToken nunca se setea para
// estos canales, ver routes/mediations.js §invite). Solo resuelve el
// usuario (el llamador en server.js solo usa .user) — nunca un canal
// único, porque un abogado puede tener varios (uno por mediación en la
// que participa); cuál canal se une lo decide el cliente con
// join-channel, que ya valida membresía real contra isMemberOfChannel.
function resolvePortalGuest(token) {
  const db = cache;
  const party = db.parties.find((p) => p.portalToken === token);
  if (party && party.linkedUserId) {
    const user = db.users.find((u) => u.id === party.linkedUserId);
    if (user) return { user };
  }
  const lawyer = db.lawyers.find((l) => l.portalToken === token);
  if (lawyer && lawyer.linkedUserId) {
    const user = db.users.find((u) => u.id === lawyer.linkedUserId);
    if (user) return { user };
  }
  return null;
}

// snapshot completo y consistente de la base a un archivo aparte — usa
// VACUUM INTO en vez de copiar el .sqlite a mano porque así no hay que
// lidiar con el WAL/shm (VACUUM INTO arma un único archivo limpio,
// autocontenido, ya consistente al momento en que se pide). Pensado para
// el botón de "descargar backup" del panel de admin: a este volumen es
// prácticamente instantáneo, y da un archivo .sqlite abrible con cualquier
// cliente SQLite (o re-usable directo como SQLITE_PATH de otra instalación).
function backupTo(destPath) {
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  sqlite.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

module.exports = { getDB, commit, resolveGuest, resolvePortalGuest, backupTo };
