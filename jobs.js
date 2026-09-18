// jobs.js
// Jobs periódicos simples — alcanza con setInterval para este volumen, no
// hace falta una cola de trabajos. Si el volumen crece mucho en el futuro,
// ahí sí conviene algo como BullMQ + Redis, pero sería sobre-ingeniería hoy.

const { getDB, commit } = require('./db');
const { nanoid } = require('nanoid');
const { sendText } = require('./whatsapp');
const { sendPushToUser } = require('./push');
const { accessLinkFor, notifyPartyAboutHearing, postSystemMessage } = require('./messaging');
const { logMediationEvent } = require('./mediationEvents');

// Bloque 17 §14/15 — "YYYY-MM-DD" a "DD/MM/YYYY" para texto pensado para
// una persona (recordatorios push/WhatsApp), mismo formato que fmtDate()
// en el frontend.
function fmtDateEs(ymd) {
  return ymd.split('-').reverse().join('/');
}

const REMINDER_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 días sin que se una la otra parte
const SUMMARY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // resumen semanal

// Tarea C — si a un canal recién creado nadie se sumó en 3 días, le avisamos
// A QUIEN LO CREÓ (nunca directo al tercero — no tenemos su contacto salvo
// que la propia persona lo haya dado, y escribirle en frío a alguien que
// nunca interactuó con la app es spam, no growth). Si el creador no tiene
// teléfono (se registró con Google), no hay canal proactivo para avisarle
// todavía — para ese caso, public/app.js muestra un banner en la pestaña
// Canal con la misma condición de tiempo, sin necesitar nada de este job.
async function checkUnjoinedChannels() {
  const db = getDB();
  const now = Date.now();
  let sent = 0;

  for (const channel of db.channels) {
    if (channel.remindedAt) continue;
    const members = db.members.filter((m) => m.channelId === channel.id);
    if (members.length !== 1) continue;
    if (now - channel.createdAt <= REMINDER_AFTER_MS) continue;

    const creator = db.users.find((u) => u.id === members[0].userId);
    if (!creator || !creator.phone) continue; // sin teléfono, lo cubre el banner del frontend

    try {
      await sendText(creator.phone, `Todavía nadie se unió a tu canal ${channel.code} en Puente Digital. ¿Le reenviás el link a la otra persona?`);
      channel.remindedAt = now;
      sent++;
    } catch (err) {
      console.error('No se pudo mandar el recordatorio de canal sin unir:', err);
    }
  }
  if (sent > 0) await commit();
  return { sent };
}

// Tarea D — resumen de actividad por canal desde el último resumen (o desde
// que se creó el canal, si nunca hubo uno). No manda nada si no hubo
// actividad real en el período — un "0 mensajes esta semana" no aporta y
// genera ruido. El resumen calculado se guarda en el propio canal
// (lastSummary) para que public/app.js lo muestre sin tener que recalcular
// nada en cada request.
async function generateWeeklySummaries() {
  const db = getDB();
  const now = Date.now();
  let sent = 0;

  for (const channel of db.channels) {
    const periodStart = channel.lastSummary ? channel.lastSummary.periodEnd : channel.createdAt;
    if (now - periodStart < SUMMARY_PERIOD_MS) continue;

    const msgs = db.messages.filter(
      (m) => m.channelId === channel.id && m.senderId && m.createdAt >= periodStart && m.createdAt < now
    );
    if (msgs.length === 0) continue; // sin actividad — no tocamos lastSummary, se re-evalúa la próxima corrida

    const flaggedCount = msgs.filter((m) => m.flagged).length;
    const confirmedEvents = db.events.filter(
      (e) => e.channelId === channel.id && e.status === 'confirmado' && e.respondedAt && e.respondedAt >= periodStart && e.respondedAt < now
    ).length;

    const stats = { messages: msgs.length, flagged: flaggedCount, confirmedEvents };
    channel.lastSummary = { periodStart, periodEnd: now, stats };

    // en positivo — "marcados por el sistema" suena a que alguien hizo algo
    // mal (una nota de mala conducta); "el sistema ayudó a bajar la tensión"
    // es el mismo dato pero se lee como que la herramienta está ayudando,
    // no vigilando. Los acuerdos confirmados van primero porque son el
    // resultado más concreto de la semana. Si algo dio 0, no se menciona —
    // "0 acuerdos" o "0 marcados" no aporta y solo suma ruido.
    const parts = [`${stats.messages} mensaje${stats.messages === 1 ? '' : 's'}`];
    if (stats.confirmedEvents > 0) {
      parts.push(`${stats.confirmedEvents} acuerdo${stats.confirmedEvents === 1 ? '' : 's'} confirmado${stats.confirmedEvents === 1 ? '' : 's'}`);
    }
    if (stats.flagged > 0) {
      parts.push(`el sistema ayudó a bajar la tensión en ${stats.flagged} mensaje${stats.flagged === 1 ? '' : 's'}`);
    }
    const summaryLine = parts.join(', ');

    const parties = db.members.filter((m) => m.channelId === channel.id && (m.role === 'A' || m.role === 'B'));
    for (const member of parties) {
      const user = db.users.find((u) => u.id === member.userId);
      if (!user) continue;
      const link = accessLinkFor(channel, user);

      if (user.phone) {
        try {
          await sendText(user.phone, `Esta semana en tu canal ${channel.code}: ${summaryLine}. Verlo: ${link}`);
          sent++;
        } catch (err) {
          console.error('No se pudo mandar el resumen semanal por WhatsApp:', err);
        }
      }
      // independiente del WhatsApp — antes esto era el único canal, así que
      // quien entró solo con Google (sin vincular teléfono) nunca se
      // enteraba del resumen salvo que abriera el chat y desplegara el
      // panel colapsado a mano. Ahora, si además (o en cambio) aceptó
      // notificaciones push, le llega igual.
      try {
        // sendPushToUser no informa cuántos dispositivos recibieron nada
        // (puede no tener ninguna suscripción y listo) — sent solo cuenta
        // WhatsApp, que es lo único que sabemos con certeza que se mandó.
        await sendPushToUser(db, commit, user.id, {
          title: 'Resumen semanal — Puente Digital',
          body: `Canal ${channel.code}: ${summaryLine}.`,
          url: link,
        });
      } catch (err) {
        console.error('No se pudo mandar el resumen semanal por push:', err);
      }
    }
  }
  await commit();
  return { sent };
}

// Bloque 6 de Mediador (B2B) — motor operativo, reglas COMMITMENT_OVERDUE
// y HEARING_CONFIRMATION_MISSING (ver IMPLEMENTATION_PLAN.md §3.11).
//
// Importante, y ya documentado en el plan: el dashboard de Mediador NUNCA
// depende de que este job haya corrido a tiempo — las alertas ahí se
// recalculan en vivo contra la fecha. Este job solo se encarga de:
// (a) la transición de estado real (pendiente -> vencido), que si o si
//     necesita que algo la dispare en algún momento, y
// (b) dejar constancia en el timeline la PRIMERA vez que se detecta cada
//     caso — nunca repite el mismo aviso en cada corrida.
// Bloque 11 — manda el aviso de verdad, por los canales que el mediador
// configuró para ESA mediación puntual (reminderChannels, por defecto
// los dos). whatsapp se salta solo si el mediador no cargó teléfono —
// mismo criterio ya usado en generateWeeklySummaries de acá arriba.
// Bloque 22 (Parte 1.3) — el envío real, separado de "resolver el
// mediador desde una mediación puntual" para poder reusarlo también
// desde el digest (que junta varias mediaciones de un mismo usuario, no
// tiene una sola mediación de la cual derivar canales).
async function notifyUserDirect(db, user, { title, body, url }, channels) {
  if (channels.includes('push')) {
    try { await sendPushToUser(db, commit, user.id, { title, body, url }); }
    catch (err) { console.error('No se pudo mandar push de Mediador:', err); }
  }
  if (channels.includes('whatsapp') && user.phone) {
    try { await sendText(user.phone, body); }
    catch (err) { console.error('No se pudo mandar WhatsApp de Mediador:', err); }
  }
}

async function notifyMediator(db, mediation, { title, body, url }) {
  const channels = (mediation.reminderChannels || 'push,whatsapp').split(',');
  const mediator = db.users.find((u) => u.id === mediation.mediatorUserId);
  if (!mediator) return;
  await notifyUserDirect(db, mediator, { title, body, url }, channels);
}

async function checkMediationDeadlines() {
  const db = getDB();
  const now = Date.now();
  let commitmentsMarked = 0;
  let hearingAlertsLogged = 0;
  let hearingRemindersLogged = 0;
  let tasksOverdueLogged = 0;
  const mediationById = Object.fromEntries(db.mediations.map((m) => [m.id, m]));

  // compromisos vencidos: pendiente + dueDate ya pasó — ahora además NOTIFICA
  // de verdad al mediador (antes solo quedaba logueado en el timeline).
  for (const commitment of db.commitments) {
    if (commitment.status !== 'pendiente' || !commitment.dueDate) continue;
    if (new Date(commitment.dueDate).getTime() >= now) continue;
    commitment.status = 'vencido';
    logMediationEvent(db, {
      mediationId: commitment.mediationId, type: 'COMMITMENT_OVERDUE', actorId: null,
      entityType: 'commitment', entityId: commitment.id,
      title: `Compromiso vencido: ${commitment.description}`,
      causedByEventId: commitment.createdFromEventId || null,
    });
    const mediation = mediationById[commitment.mediationId];
    if (mediation) {
      // Bloque 22 (Parte 1.3) — si el mediador tiene digest activado, este
      // aviso puntual se salta y en cambio se agrupa más abajo con el
      // resto de sus pendientes del día/semana. Sin digest (default), se
      // notifica igual que siempre — cero cambio de comportamiento.
      const mediator = db.users.find((u) => u.id === mediation.mediatorUserId);
      const digestOn = mediator && ['daily', 'weekly'].includes(mediator.notificationDigest);
      if (!digestOn) {
        await notifyMediator(db, mediation, {
          title: 'Compromiso vencido — Mediador',
          body: `${mediation.code}: "${commitment.description}" venció sin cumplirse.`,
          url: '/',
        });
      }
    }
    // Bloque 22 (Parte 1.1) — antes esto solo avisaba al mediador; ahora
    // también a la parte responsable del compromiso, con el mismo
    // mecanismo honesto (enviado/no_disponible/error) ya usado para
    // audiencias. Esto SIEMPRE se notifica de inmediato, sin digest — el
    // digest es una comodidad para el mediador, no aplica a las partes.
    const commitmentParty = db.parties.find((p) => p.id === commitment.partyId);
    if (commitmentParty) {
      const daysOverdue = Math.max(1, Math.floor((now - new Date(commitment.dueDate).getTime()) / (1000 * 60 * 60 * 24)));
      await notifyPartyAboutHearing(db, commitmentParty,
        `${mediation ? mediation.code : ''}: tu compromiso "${commitment.description}" venció hace ${daysOverdue} día(s). Contactá a tu mediador/a si necesitás reprogramarlo.`);
    }
    commitmentsMarked++;
  }

  // tareas vencidas — Bloque 11, cobertura nueva: antes esto solo se
  // calculaba en vivo para el dashboard, nunca generaba un aviso proactivo.
  // No hay estado "vencida" en tasks (solo pendiente/en_proceso/completada/
  // cancelada) — se avisa una sola vez, sin cambiar el status.
  for (const task of db.tasks) {
    if (!['pendiente', 'en_proceso'].includes(task.status) || !task.dueDate) continue;
    if (new Date(task.dueDate).getTime() >= now) continue;
    const alreadyLogged = db.mediationEvents.some((e) => e.type === 'TASK_OVERDUE' && e.entityId === task.id);
    if (alreadyLogged) continue;

    logMediationEvent(db, {
      mediationId: task.mediationId, type: 'TASK_OVERDUE', actorId: null,
      entityType: 'task', entityId: task.id, title: `Tarea vencida: ${task.title}`,
    });
    const mediation = mediationById[task.mediationId];
    if (mediation) {
      await notifyMediator(db, mediation, {
        title: 'Tarea vencida — Mediador',
        body: `${mediation.code}: "${task.title}" venció sin completarse.`,
        url: '/',
      });
    }
    tasksOverdueLogged++;
  }

  // audiencias próximas con alguna confirmación todavía pendiente — la
  // ventana ya no es fija (48hs): usa reminderHoursBefore de CADA
  // mediación (Bloque 11, configurable). Se avisa UNA sola vez por audiencia.
  for (const hearing of db.hearings) {
    if (!['programada', 'confirmada'].includes(hearing.status)) continue;
    const mediation = mediationById[hearing.mediationId];
    if (!mediation) continue;
    const windowMs = (mediation.reminderHoursBefore || 48) * 60 * 60 * 1000;
    const hearingTime = new Date(hearing.date + (hearing.startTime ? 'T' + hearing.startTime : '')).getTime();
    if (isNaN(hearingTime) || hearingTime - now > windowMs || hearingTime < now) continue;

    const stillPending = db.hearingConfirmations.some((c) => c.hearingId === hearing.id && c.response === 'pendiente');
    if (stillPending) {
      const alreadyAlerted = db.mediationEvents.some((e) => e.type === 'HEARING_CONFIRMATION_MISSING' && e.entityId === hearing.id);
      if (!alreadyAlerted) {
        const alertEvent = logMediationEvent(db, {
          mediationId: hearing.mediationId, type: 'HEARING_CONFIRMATION_MISSING', actorId: null,
          entityType: 'hearing', entityId: hearing.id,
          title: `Audiencia del ${fmtDateEs(hearing.date)} con confirmaciones pendientes`,
        });
        // Bloque 15 (Parte 3) §10 — tercer ejemplo de tarea operativa
        // determinista: "audiencia próxima sin confirmación → revisar confirmaciones".
        const reviewTask = {
          id: nanoid(), mediationId: hearing.mediationId, assignedTo: mediation.mediatorUserId,
          title: `Revisar confirmaciones: audiencia del ${fmtDateEs(hearing.date)}`, description: null,
          dueDate: null, priority: 'alta', status: 'pendiente',
          createdBy: null, completedAt: null, createdAt: Date.now(),
        };
        db.tasks.push(reviewTask);
        logMediationEvent(db, {
          mediationId: hearing.mediationId, type: 'TASK_CREATED', actorId: null,
          entityType: 'task', entityId: reviewTask.id, title: `Tarea generada: ${reviewTask.title}`,
          causedByEventId: alertEvent.id,
        });
        await notifyMediator(db, mediation, {
          title: 'Confirmación pendiente — Mediador',
          body: `${mediation.code}: hay partes sin confirmar la audiencia del ${fmtDateEs(hearing.date)}.`,
          url: '/',
        });
        hearingAlertsLogged++;
      }
    }

    // recordatorio de audiencia próxima — Bloque 11, cobertura nueva:
    // independiente de si ya confirmaron o no, un aviso simple de "se
    // viene la audiencia", que antes no existía en ninguna forma.
    const alreadyReminded = db.mediationEvents.some((e) => e.type === 'HEARING_REMINDER' && e.entityId === hearing.id);
    if (!alreadyReminded) {
      logMediationEvent(db, {
        mediationId: hearing.mediationId, type: 'HEARING_REMINDER', actorId: null,
        entityType: 'hearing', entityId: hearing.id,
        title: `Recordatorio: audiencia del ${fmtDateEs(hearing.date)}`,
      });
      // Bloque 28 §15 — el recordatorio incluye el enlace de la
      // videoconferencia cuando corresponde (modalidad virtual/híbrida
      // con reunión ya vinculada), sin depender de otro job aparte.
      const videoSuffix = (hearing.modality === 'virtual' || hearing.modality === 'hibrida') && hearing.meetingUrl
        ? ` Entrá acá: ${hearing.meetingUrl}` : '';
      await notifyMediator(db, mediation, {
        title: 'Audiencia próxima — Mediador',
        body: `${mediation.code}: audiencia el ${fmtDateEs(hearing.date)}${hearing.startTime ? ' a las ' + hearing.startTime : ''}.${videoSuffix}`,
        url: '/',
      });
      hearingRemindersLogged++;
    }
  }

  // Bloque 15 (Parte 2) §10 — recordatorio de solicitud de cambio
  // pendiente para el mediador. Mismo patrón que los de arriba: una sola
  // vez por solicitud, nunca reenvía si ya se avisó.
  let rescheduleRequestRemindersLogged = 0;
  const PENDING_REQUEST_REMINDER_AFTER_MS = 24 * 60 * 60 * 1000; // 1 día sin resolver
  for (const request of db.hearingRescheduleRequests) {
    if (request.status !== 'pendiente') continue;
    if (now - request.createdAt < PENDING_REQUEST_REMINDER_AFTER_MS) continue;
    const mediation = mediationById[request.mediationId];
    if (!mediation) continue;
    const alreadyReminded = db.mediationEvents.some((e) => e.type === 'HEARING_RESCHEDULE_REMINDER' && e.entityId === request.id);
    if (alreadyReminded) continue;
    logMediationEvent(db, {
      mediationId: request.mediationId, type: 'HEARING_RESCHEDULE_REMINDER', actorId: null,
      entityType: 'hearing_reschedule_request', entityId: request.id,
      title: 'Recordatorio: hay una solicitud de cambio de audiencia sin resolver',
    });
    await notifyMediator(db, mediation, {
      title: 'Solicitud de cambio pendiente',
      body: `${mediation.code}: hay una solicitud de cambio de audiencia esperando tu respuesta.`,
      url: '/',
    });
    rescheduleRequestRemindersLogged++;
  }

  // Bloque 22 (Parte 1.2) — escalamiento: si a una parte no se le pudo
  // notificar (no_disponible o error) durante 3 días corridos, avisarle
  // al mediador UNA sola vez — no reintenta contactar a la parte por su
  // cuenta, solo le marca al mediador que capaz conviene llamarla.
  let contactEscalationsLogged = 0;
  const ESCALATION_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
  const partyIdsWithFailures = new Set(
    db.whatsappLog.filter((w) => w.partyId && ['notification_unavailable', 'notification_error'].includes(w.kind)).map((w) => w.partyId)
  );
  for (const partyId of partyIdsWithFailures) {
    const party = db.parties.find((p) => p.id === partyId);
    if (!party) continue;
    const mediation = mediationById[party.mediationId];
    if (!mediation) continue;
    // la racha actual de fallos: todo lo que pasó DESPUÉS del último envío
    // exitoso (o desde siempre, si nunca hubo uno). Un solo envío exitoso
    // en el medio corta la racha — no promedia ni acumula fallos viejos.
    const entriesForParty = db.whatsappLog.filter((w) => w.partyId === partyId).sort((a, b) => a.createdAt - b.createdAt);
    let streakStart = null;
    for (let i = entriesForParty.length - 1; i >= 0; i--) {
      if (entriesForParty[i].kind === 'notification_sent') break;
      if (['notification_unavailable', 'notification_error'].includes(entriesForParty[i].kind)) streakStart = entriesForParty[i].createdAt;
    }
    if (!streakStart || now - streakStart < ESCALATION_AFTER_MS) continue;
    const alreadyEscalated = db.mediationEvents.some((e) => e.type === 'PARTY_CONTACT_ESCALATION' && e.entityId === partyId && e.createdAt > streakStart);
    if (alreadyEscalated) continue;

    logMediationEvent(db, {
      mediationId: mediation.id, type: 'PARTY_CONTACT_ESCALATION', actorId: null,
      entityType: 'party', entityId: partyId,
      title: `No se pudo contactar a ${party.firstName || 'una parte'} en los últimos 3 días`,
    });
    await notifyMediator(db, mediation, {
      title: 'No pudimos contactar a una parte',
      body: `${mediation.code}: no se pudo contactar a ${party.firstName || 'la parte'} en los últimos 3 días. Revisá el canal de contacto.`,
      url: '/',
    });
    contactEscalationsLogged++;
  }

  // Bloque 22 (Parte 1.3) — digest agrupado, para quien lo activó
  // (users.notificationDigest). Se recalcula en vivo con los mismos
  // datos que ya usa el dashboard — no se acumula en ninguna cola
  // nueva. Cubre compromisos vencidos y confirmaciones pendientes; lo
  // que quedó afuera de esta cobertura está documentado en el informe.
  let digestsSent = 0;
  const todayIsMonday = new Date(now).getUTCDay() === 1; // "weekly" = una vez por semana, lunes
  for (const user of db.users.filter((u) => ['daily', 'weekly'].includes(u.notificationDigest))) {
    if (user.notificationDigest === 'weekly' && !todayIsMonday) continue;
    const myMediations = db.mediations.filter((m) => m.mediatorUserId === user.id);
    if (myMediations.length === 0) continue;
    const myMediationIds = new Set(myMediations.map((m) => m.id));
    const overdueCommitments = db.commitments.filter((c) => myMediationIds.has(c.mediationId) && c.status === 'vencido');
    const unconfirmedHearings = db.hearings.filter((h) =>
      myMediationIds.has(h.mediationId) && ['programada', 'confirmada'].includes(h.status) &&
      db.hearingConfirmations.some((c) => c.hearingId === h.id && c.response === 'pendiente')
    );
    if (overdueCommitments.length === 0 && unconfirmedHearings.length === 0) continue;

    const parts = [];
    if (overdueCommitments.length) parts.push(`${overdueCommitments.length} compromiso(s) vencido(s)`);
    if (unconfirmedHearings.length) parts.push(`${unconfirmedHearings.length} audiencia(s) sin confirmar`);
    await notifyUserDirect(db, user, {
      title: user.notificationDigest === 'daily' ? 'Tu resumen de hoy' : 'Tu resumen de la semana',
      body: `Tenés ${parts.join(' y ')} en tus mediaciones. Entrá al dashboard para el detalle.`,
      url: '/',
    }, (myMediations[0].reminderChannels || 'push,whatsapp').split(','));
    digestsSent++;
  }

  if (commitmentsMarked > 0 || hearingAlertsLogged > 0 || hearingRemindersLogged > 0 || tasksOverdueLogged > 0 || rescheduleRequestRemindersLogged > 0 || contactEscalationsLogged > 0) await commit();
  return { commitmentsMarked, hearingAlertsLogged, hearingRemindersLogged, tasksOverdueLogged, rescheduleRequestRemindersLogged, contactEscalationsLogged, digestsSent };
}

// Bloque 26 §2 — mensaje de sistema en el hilo de cada parte cuando una
// audiencia virtual/híbrida está por empezar. Corre con SU PROPIO intervalo
// más frecuente (server.js lo llama cada 5 minutos), separado del resto de
// los jobs de este archivo (que corren cada hora) — con cadencia horaria no
// se puede acertar una ventana de "minutos antes" con ninguna precisión
// razonable (ver auditoría del bloque). No se tocó la cadencia general de
// checkMediationDeadlines ni de ningún otro job existente.
//
// Ventana: entre 20 y 5 minutos antes del inicio — nunca después de que ya
// empezó (eso ya lo cubre el banner en vivo de public/mediador.js/portal.js/
// lawyer-portal.js, que no depende de este job). Ancha a propósito (15 min)
// para garantizar que, con un poll cada 5 minutos, ninguna audiencia
// calificable quede sin al menos una corrida que la vea dentro de la ventana.
const HEARING_START_ALERT_WINDOW_START_MS = 20 * 60 * 1000;
const HEARING_START_ALERT_WINDOW_END_MS = 5 * 60 * 1000;

async function checkHearingsStartingSoon(io) {
  const db = getDB();
  const now = Date.now();
  let hearingsAlerted = 0, messagesPosted = 0;

  for (const hearing of db.hearings) {
    if (hearing.startAlertSentAt) continue; // idempotencia — nunca dos veces la misma audiencia
    if (!['programada', 'confirmada'].includes(hearing.status)) continue;
    if (!hearing.meetingUrl) continue;
    if (hearing.modality !== 'virtual' && hearing.modality !== 'hibrida') continue;
    if (!hearing.startTime) continue;
    const startMs = new Date(`${hearing.date}T${hearing.startTime}`).getTime();
    if (Number.isNaN(startMs)) continue;
    const msUntilStart = startMs - now;
    if (msUntilStart > HEARING_START_ALERT_WINDOW_START_MS || msUntilStart < HEARING_START_ALERT_WINDOW_END_MS) continue;

    const mediation = db.mediations.find((m) => m.id === hearing.mediationId);
    if (!mediation) continue;

    // se marca ANTES de postear — si algo falla a mitad de camino, la
    // audiencia queda igual marcada como alertada: preferimos el riesgo de
    // que a alguna parte le falte el mensaje una vez, nunca el de
    // duplicarlo (mismo criterio "nunca dos veces" del resto del bloque).
    hearing.startAlertSentAt = now;
    hearingsAlerted++;

    const activeParties = db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa');
    const text = `Audiencia de "${mediation.object}" (${mediation.code}) — hoy a las ${hearing.startTime}. Entrá acá: ${hearing.meetingUrl}`;
    for (const party of activeParties) {
      // solo si esa parte ya tiene hilo propio (fue invitada al portal) —
      // nunca a las partes de otra mediación, nunca a un hilo que no existe.
      const thread = db.channels.find((c) => c.mediationId === mediation.id && c.partyId === party.id);
      if (!thread) continue;
      await postSystemMessage(io, thread, text);
      messagesPosted++;
    }
  }

  if (hearingsAlerted > 0) await commit();
  return { hearingsAlerted, messagesPosted };
}

module.exports = {
  checkUnjoinedChannels, generateWeeklySummaries, checkMediationDeadlines, notifyMediator,
  checkHearingsStartingSoon, REMINDER_AFTER_MS, SUMMARY_PERIOD_MS,
};
