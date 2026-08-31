// routes/whatsapp.js
// Webhook de WhatsApp Cloud API — montado en /webhook/whatsapp. Solo dos
// usos: onboarding (CREAR/UNIRSE) y mensajes de texto libre de alguien ya
// vinculado a un canal. Nunca reenvía contenido ajeno por WhatsApp — eso lo
// hace messaging.js con la notificación agrupada.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid, customAlphabet } = require('nanoid');
const { getDB, commit } = require('../db');
const { analyzeMessage } = require('../moderation');
const { postMessage, postSystemMessage } = require('../messaging');
const { sendText, sendButtons, verifySignature } = require('../whatsapp');
const { logWhatsappEvent, logWebhookRaw } = require('../whatsappLog');

const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const webhookLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 300, // suma mensajes de ambas personas de varios canales, generoso a propósito
  standardHeaders: true,
  legacyHeaders: false,
});

// Map<phone, { channelId, senderId, original, reformulation, reason, createdAt }>
// espera la respuesta de los botones "Usar sugerida" / "Enviar igual".
const pendingConfirmations = new Map();
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

function findUserByPhone(phone) {
  const db = getDB();
  return db.users.find((u) => u.phone === phone);
}
function findChannelForPhone(phone) {
  const db = getDB();
  const user = findUserByPhone(phone);
  if (!user) return null;
  const member = db.members.find((m) => m.userId === user.id && (m.role === 'A' || m.role === 'B'));
  if (!member) return null;
  const channel = db.channels.find((c) => c.id === member.channelId);
  return channel ? { channel, user, member } : null;
}

const USAGE_TEXT = 'No entendí ese mensaje. Para arrancar un canal nuevo mandá: CREAR Tu Nombre. Para unirte a uno existente: UNIRSE CODIGO Tu Nombre.';

async function createChannelFromWhatsApp(phone, name) {
  const db = getDB();
  const user = { id: nanoid(), googleId: null, phone, email: '', name, avatar: '', createdAt: Date.now() };
  db.users.push(user);
  const channel = { id: nanoid(), code: genCode(), guestToken: nanoid(24), calendarToken: nanoid(24), createdAt: Date.now() };
  db.channels.push(channel);
  db.members.push({ id: nanoid(), channelId: channel.id, userId: user.id, role: 'A', webAccessToken: nanoid(24), joinedAt: Date.now() });
  await commit();
  return channel;
}

async function joinChannelFromWhatsApp(phone, name, code) {
  const db = getDB();
  const channel = db.channels.find((c) => c.code === code.toUpperCase());
  if (!channel) return { error: `No encontré ningún canal con el código ${code.toUpperCase()}.` };

  const parties = db.members.filter((m) => m.channelId === channel.id && (m.role === 'A' || m.role === 'B'));
  if (parties.length >= 2) return { error: 'Ese canal ya tiene dos participantes.' };
  const role = parties.some((m) => m.role === 'A') ? 'B' : 'A';

  const user = { id: nanoid(), googleId: null, phone, email: '', name, avatar: '', createdAt: Date.now() };
  db.users.push(user);
  db.members.push({ id: nanoid(), channelId: channel.id, userId: user.id, role, webAccessToken: nanoid(24), joinedAt: Date.now() });
  await commit();
  return { channel, user };
}

module.exports = function (io) {
  const router = express.Router();

  // handshake de verificación del webhook (Meta lo pide una vez al configurar)
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  router.post('/', webhookLimiter, async (req, res) => {
    // responder rápido siempre — Meta reintenta si no hay 200 a tiempo
    res.sendStatus(200);

    if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
      console.warn('Firma de webhook de WhatsApp inválida — mensaje descartado.');
      const db = getDB();
      logWhatsappEvent(db, { kind: 'webhook_invalid_signature', detail: 'Firma X-Hub-Signature-256 inválida o ausente' });
      await commit();
      return;
    }

    // guardado para debug técnico — recortado a las últimas N entradas,
    // separado del log de actividad porque es más pesado/sensible.
    const dbRaw = getDB();
    logWebhookRaw(dbRaw, req.body);
    await commit();

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const incoming = value?.messages?.[0];
    if (!incoming) return; // status updates (entregado/leído) u otros eventos sin mensaje

    const phone = incoming.from;

    try {
      if (incoming.type === 'interactive' && incoming.interactive?.type === 'button_reply') {
        await handleButtonReply(phone, incoming.interactive.button_reply.id, io);
        return;
      }
      if (incoming.type !== 'text') return; // ignoramos otros tipos (imágenes, audio, etc.)

      const text = (incoming.text?.body || '').trim();
      const existing = findChannelForPhone(phone);

      if (!existing) {
        await handleOnboarding(phone, text);
        return;
      }
      await handleFreeText(phone, text, existing, io);
    } catch (err) {
      console.error('Error procesando webhook de WhatsApp:', err);
    }
  });

  async function handleOnboarding(phone, text) {
    const crearMatch = text.match(/^crear\s+(.+)$/i);
    const unirseMatch = text.match(/^unirse\s+(\S+)\s+(.+)$/i);
    const db = getDB();

    if (crearMatch) {
      const name = crearMatch[1].trim();
      const channel = await createChannelFromWhatsApp(phone, name);
      await sendText(phone, `¡Listo, ${name}! Creé tu canal en Puente Digital. Código: ${channel.code}\nCompartiselo a la otra persona para que mande: UNIRSE ${channel.code} Su Nombre`);
      logWhatsappEvent(db, { kind: 'onboarding_create', phone, userName: name, channelCode: channel.code });
      await commit();
      return;
    }
    if (unirseMatch) {
      const code = unirseMatch[1].trim();
      const name = unirseMatch[2].trim();
      const result = await joinChannelFromWhatsApp(phone, name, code);
      if (result.error) {
        await sendText(phone, result.error);
        logWhatsappEvent(db, { kind: 'onboarding_error', phone, userName: name, channelCode: code.toUpperCase(), detail: result.error });
        await commit();
        return;
      }
      await sendText(phone, `¡Listo, ${name}! Te uniste al canal ${result.channel.code}.`);
      await postSystemMessage(io, result.channel, `${name} se unió al canal.`);
      logWhatsappEvent(db, { kind: 'onboarding_join', phone, userName: name, channelCode: result.channel.code });
      await commit();
      return;
    }
    await sendText(phone, USAGE_TEXT);
    logWhatsappEvent(db, { kind: 'onboarding_error', phone, detail: 'Comando no reconocido' });
    await commit();
  }

  async function handleFreeText(phone, text, { channel, user }, io) {
    if (!text) return;
    let result;
    try {
      result = await analyzeMessage(text);
    } catch (err) {
      console.error(err);
      result = { flagged: false };
    }

    if (result.flagged && result.reformulation) {
      pendingConfirmations.set(phone, {
        channelId: channel.id, senderId: user.id,
        original: text, reformulation: result.reformulation, reason: result.reason,
        createdAt: Date.now(),
      });
      await sendButtons(
        phone,
        `⚠ Este mensaje puede escalar el conflicto (${result.category || 'lenguaje conflictivo'}). Alternativa sugerida:\n\n"${result.reformulation}"`,
        [{ id: 'use_alt', title: 'Usar sugerida' }, { id: 'use_orig', title: 'Enviar igual' }]
      );
      return;
    }
    await postMessage(io, channel, { senderId: user.id, text, flagged: false, reason: null });
    const db = getDB();
    logWhatsappEvent(db, { kind: 'inbound_processed', phone, userName: user.name, channelCode: channel.code });
    await commit();
  }

  async function handleButtonReply(phone, buttonId, io) {
    const pending = pendingConfirmations.get(phone);
    if (!pending) return;
    pendingConfirmations.delete(phone);
    if (Date.now() - pending.createdAt > CONFIRMATION_TTL_MS) return; // muy vieja, la ignoramos

    const db = getDB();
    const channel = db.channels.find((c) => c.id === pending.channelId);
    if (!channel) return;

    let sender = null;
    if (buttonId === 'use_alt') {
      sender = await postMessage(io, channel, { senderId: pending.senderId, text: pending.reformulation, flagged: true, reason: pending.reason });
    } else if (buttonId === 'use_orig') {
      sender = await postMessage(io, channel, { senderId: pending.senderId, text: pending.original, flagged: true, reason: 'Enviado sin cambios pese a la señal del sistema.' });
    }
    if (sender) {
      logWhatsappEvent(db, { kind: 'inbound_processed', phone, userName: sender.sender ? sender.sender.name : null, channelCode: channel.code, detail: buttonId === 'use_alt' ? 'usó la sugerencia' : 'envió igual' });
      await commit();
    }
  }

  return router;
};

module.exports.getPendingConfirmationsCount = () => pendingConfirmations.size;
