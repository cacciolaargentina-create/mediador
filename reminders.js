// reminders.js
// Recordatorio de eventos confirmados por WhatsApp, un día antes. Corre en
// un setInterval desde server.js (no es un cron real — alcanza con revisar
// cada tanto mientras el proceso esté vivo bajo pm2). Cada evento se
// marca con reminderSentAt para no mandar el mismo recordatorio dos veces
// aunque el intervalo corra varias veces el mismo día.

const { getDB, commit } = require('./db');
const { sendText } = require('./whatsapp');

function tomorrowDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function checkAndSendReminders() {
  const db = getDB();
  const tomorrow = tomorrowDateStr();
  const due = db.events.filter((e) => e.status === 'confirmado' && e.date === tomorrow && !e.reminderSentAt);
  if (due.length === 0) return { checked: 0, sent: 0 };

  let sent = 0;
  for (const ev of due) {
    ev.reminderSentAt = Date.now(); // se marca antes de mandar — un error de red no debe reintentar infinito
    const channel = db.channels.find((c) => c.id === ev.channelId);
    if (!channel) continue;
    const parties = db.members.filter((m) => m.channelId === channel.id && (m.role === 'A' || m.role === 'B'));
    for (const member of parties) {
      const user = db.users.find((u) => u.id === member.userId);
      if (!user || !user.phone) continue;
      try {
        await sendText(user.phone, `Recordatorio de Puente Digital: mañana tenés "${ev.detail}" (${ev.date}).`);
        sent++;
      } catch (err) {
        console.error('No se pudo enviar recordatorio de evento:', err);
      }
    }
  }
  await commit();
  return { checked: due.length, sent };
}

module.exports = { checkAndSendReminders };
