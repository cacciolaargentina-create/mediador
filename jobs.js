// jobs.js
// Jobs periódicos simples — alcanza con setInterval para este volumen, no
// hace falta una cola de trabajos. Si el volumen crece mucho en el futuro,
// ahí sí conviene algo como BullMQ + Redis, pero sería sobre-ingeniería hoy.

const { getDB, commit } = require('./db');
const { sendText } = require('./whatsapp');
const { sendPushToUser } = require('./push');
const { accessLinkFor } = require('./messaging');
const { logMediationEvent } = require('./mediationEvents');

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
async function notifyMediator(db, mediation, { title, body, url }) {
  const channels = (mediation.reminderChannels || 'push,whatsapp').split(',');
  const mediator = db.users.find((u) => u.id === mediation.mediatorUserId);
  if (!mediator) return;
  if (channels.includes('push')) {
    try { await sendPushToUser(db, commit, mediator.id, { title, body, url }); }
    catch (err) { console.error('No se pudo mandar push de Mediador:', err); }
  }
  if (channels.includes('whatsapp') && mediator.phone) {
    try { await sendText(mediator.phone, body); }
    catch (err) { console.error('No se pudo mandar WhatsApp de Mediador:', err); }
  }
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
      await notifyMediator(db, mediation, {
        title: 'Compromiso vencido — Mediador',
        body: `${mediation.code}: "${commitment.description}" venció sin cumplirse.`,
        url: '/mediador.html',
      });
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
        url: '/mediador.html',
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
        logMediationEvent(db, {
          mediationId: hearing.mediationId, type: 'HEARING_CONFIRMATION_MISSING', actorId: null,
          entityType: 'hearing', entityId: hearing.id,
          title: `Audiencia del ${hearing.date} con confirmaciones pendientes`,
        });
        await notifyMediator(db, mediation, {
          title: 'Confirmación pendiente — Mediador',
          body: `${mediation.code}: hay partes sin confirmar la audiencia del ${hearing.date}.`,
          url: '/mediador.html',
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
        title: `Recordatorio: audiencia del ${hearing.date}`,
      });
      await notifyMediator(db, mediation, {
        title: 'Audiencia próxima — Mediador',
        body: `${mediation.code}: audiencia el ${hearing.date}${hearing.startTime ? ' a las ' + hearing.startTime : ''}.`,
        url: '/mediador.html',
      });
      hearingRemindersLogged++;
    }
  }

  if (commitmentsMarked > 0 || hearingAlertsLogged > 0 || hearingRemindersLogged > 0 || tasksOverdueLogged > 0) await commit();
  return { commitmentsMarked, hearingAlertsLogged, hearingRemindersLogged, tasksOverdueLogged };
}

module.exports = { checkUnjoinedChannels, generateWeeklySummaries, checkMediationDeadlines, REMINDER_AFTER_MS, SUMMARY_PERIOD_MS };
