// jobs.js
// Jobs periódicos simples — alcanza con setInterval para este volumen, no
// hace falta una cola de trabajos. Si el volumen crece mucho en el futuro,
// ahí sí conviene algo como BullMQ + Redis, pero sería sobre-ingeniería hoy.

const { getDB, commit } = require('./db');
const { sendText } = require('./whatsapp');
const { sendPushToUser } = require('./push');
const { accessLinkFor } = require('./messaging');

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

module.exports = { checkUnjoinedChannels, generateWeeklySummaries, REMINDER_AFTER_MS, SUMMARY_PERIOD_MS };
