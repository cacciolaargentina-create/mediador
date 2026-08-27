// routes/guest.js
// Acceso de Persona B sin cuenta de Google: el link con el guestToken hace
// de sesión. No hay login — solo se le pide el nombre una vez.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const { getDB, commit, resolveGuest } = require('../db');
const { serializeChannel, serializeMessage } = require('../serializers');

// único endpoint público sin identidad previa — throttle liviano, más que
// nada contra loops accidentales del cliente, ya que el token de 24
// caracteres no es adivinable por fuerza bruta en la práctica.
const enterLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos — esperá unos minutos.' },
});

module.exports = function (io) {
  const router = express.Router();

  router.post('/:token/enter', enterLimiter, async (req, res) => {
    // primero: ¿ya es alguien conocido? cubre tanto el reingreso de B por el
    // guest-link clásico como el link de acceso de quien se sumó por WhatsApp.
    const existing = resolveGuest(req.params.token);
    if (existing) {
      return res.json({ code: existing.channel.code, id: existing.user.id, name: existing.user.name });
    }

    const db = getDB();
    const channel = db.channels.find((c) => c.guestToken === req.params.token);
    if (!channel) return res.status(404).json({ error: 'Enlace inválido' });

    const parties = db.members.filter((m) => m.channelId === channel.id && (m.role === 'A' || m.role === 'B'));
    if (parties.length >= 2) return res.status(409).json({ error: 'Este canal ya tiene dos participantes' });

    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Falta el nombre' });

    const guestUser = {
      id: nanoid(), googleId: null, email: '', name: name.trim(), avatar: '', createdAt: Date.now(), guest: true,
    };
    db.users.push(guestUser);
    db.members.push({ id: nanoid(), channelId: channel.id, userId: guestUser.id, role: 'B', joinedAt: Date.now() });
    const sysMsg = {
      id: nanoid(), channelId: channel.id, senderId: null,
      text: `${guestUser.name} se unió al canal.`, flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();

    io.to(channel.code).emit('channel:update', serializeChannel(channel));
    io.to(channel.code).emit('message:new', serializeMessage(sysMsg));

    res.json({ code: channel.code, id: guestUser.id, name: guestUser.name });
  });

  return router;
};
