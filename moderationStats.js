// moderationStats.js
// Contador diario de llamadas a analyzeMessage() (moderation.js), para el
// panel de admin (Costos y Salud). A propósito NO es un log por-llamada
// (como whatsappLog.js) — con mensajería en volumen, un log de cada
// llamada individual crecería sin límite. En cambio, se acumula UNA fila
// por día+canal con los contadores ya sumados: alcanza para costo por
// período, tasa de error, y detectar un canal con volumen fuera de lo
// normal, sin que la tabla crezca más que unas pocas filas por día.
//
// Solo se llama cuando ANTHROPIC_API_KEY está configurada (ver los call
// sites en routes/channels.js y routes/draft.js) — si no hay key, la
// llamada real nunca ocurrió (moderation.js devuelve {flagged:false} sin
// pegarle a la API), así que no hay costo real que contar.

const { nanoid } = require('nanoid');

function todayStr() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// channelCode: código del canal, o null para /api/draft/analyze y /demo
// (borrador privado o demo pública, sin canal todavía).
function recordModerationCall(db, { channelCode, success, flagged }) {
  const date = todayStr();
  const key = channelCode || null;
  let row = db.moderationStats.find((r) => r.date === date && r.channelCode === key);
  if (!row) {
    row = { id: nanoid(), date, channelCode: key, successCount: 0, failCount: 0, flaggedCount: 0 };
    db.moderationStats.push(row);
  }
  if (success) row.successCount += 1;
  else row.failCount += 1;
  if (flagged) row.flaggedCount += 1;
}

module.exports = { recordModerationCall, todayStr };
