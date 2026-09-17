// routes/video-providers.js
// Bloque 28 §23 — "Configuración → Videoconferencias": conectar/ver
// estado/desconectar cada proveedor. Google Meet es OAuth por mediador
// (cada quien conecta SU cuenta); Zoom y Teams son de una sola cuenta
// para toda la instalación (Server-to-Server / app-only, configurados por
// variables de entorno — ver .env.example), así que acá solo se informa
// su estado, no hay "conectar" por usuario para esos dos.

const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { listSelectableProviders } = require('../videoProviders');
const googleMeet = require('../videoProviders/googleMeetProvider');

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }

  // mismo criterio que safeNextPath en routes/auth.js — nunca redirigir a
  // otro host a partir de un valor que vino de afuera.
  function safeNextPath(value) {
    return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null;
  }

  router.get('/', requireAuth, async (req, res) => {
    const db = getDB();
    const list = await Promise.all(listSelectableProviders().map(async (adapter) => {
      const status = await adapter.getStatus(db, req.user.id);
      return {
        provider: adapter.name, label: adapter.label, perMediatorAccount: adapter.perMediatorAccount,
        status: status.status, accountEmail: status.accountEmail, lastError: status.lastError,
      };
    }));
    res.json(list);
  });

  // ---------- Google Meet — OAuth propio (scope calendar.events) ----------
  router.get('/google_meet/connect', requireAuth, (req, res) => {
    if (!googleMeet.configured()) {
      return res.status(503).json({ error: 'Google Meet no está configurado (falta GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET en el servidor)' });
    }
    const state = nanoid();
    req.session.videoOAuthState = state;
    req.session.videoOAuthReturnTo = safeNextPath(req.query.next) || '/mediador.html';
    const redirectUri = `${req.protocol}://${req.get('host')}${googleMeet.callbackUrl()}`;
    res.redirect(googleMeet.buildAuthUrl({ redirectUri, state }));
  });

  router.get('/google_meet/callback', requireAuth, async (req, res) => {
    const returnTo = req.session.videoOAuthReturnTo || '/mediador.html';
    delete req.session.videoOAuthReturnTo;
    const expectedState = req.session.videoOAuthState;
    delete req.session.videoOAuthState;
    if (req.query.error) {
      return res.redirect(`${returnTo}?videoProvider=google_meet&status=error`);
    }
    if (!req.query.state || req.query.state !== expectedState) {
      return res.status(400).send('Estado de autorización inválido — probá conectar la cuenta de nuevo desde Configuración.');
    }
    try {
      const redirectUri = `${req.protocol}://${req.get('host')}${googleMeet.callbackUrl()}`;
      const tokens = await googleMeet.exchangeCodeForTokens({ code: req.query.code, redirectUri });
      if (!tokens.refresh_token) {
        // pasa cuando el mediador ya había autorizado esta app antes y
        // Google no reemite refresh_token salvo prompt=consent — ya lo
        // pedimos siempre (buildAuthUrl), así que esto sería un caso raro;
        // se informa en vez de guardar una conexión que dejaría de andar
        // en 1 hora.
        return res.status(502).send('Google no devolvió acceso persistente — probá conectar la cuenta de nuevo.');
      }
      const db = getDB();
      const email = await googleMeet.fetchUserEmail(tokens.access_token);
      let account = db.videoProviderAccounts.find((a) => a.userId === req.user.id && a.provider === 'google_meet');
      const now = Date.now();
      if (!account) {
        account = { id: nanoid(), userId: req.user.id, provider: 'google_meet', connectedAt: now };
        db.videoProviderAccounts.push(account);
      }
      account.status = 'conectado';
      account.accessToken = tokens.access_token;
      account.refreshToken = tokens.refresh_token;
      account.expiresAt = now + (tokens.expires_in || 3600) * 1000;
      account.accountEmail = email;
      account.lastError = null;
      account.updatedAt = now;
      await commit();
      res.redirect(`${returnTo}?videoProvider=google_meet&status=conectado`);
    } catch (err) {
      console.error('[video] error en callback OAuth de Google Meet:', err.cause || err);
      res.redirect(`${returnTo}?videoProvider=google_meet&status=error`);
    }
  });

  router.post('/:provider/disconnect', requireAuth, async (req, res) => {
    const { provider } = req.params;
    if (provider !== 'google_meet') {
      return res.status(400).json({ error: 'Este proveedor se configura por variables de entorno del servidor, no por conexión de cuenta' });
    }
    const db = getDB();
    const account = db.videoProviderAccounts.find((a) => a.userId === req.user.id && a.provider === provider);
    if (account) {
      // revocación best-effort — si Google ya no reconoce el token, no es
      // un error para el usuario: la cuenta se desconecta igual del lado
      // de Mediador (spec §17: nunca bloquear al usuario por un detalle
      // de limpieza de credenciales).
      if (account.accessToken) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(account.accessToken)}`, { method: 'POST' });
        } catch (e) { /* best-effort */ }
      }
      db.videoProviderAccounts = db.videoProviderAccounts.filter((a) => a.id !== account.id);
      await commit();
    }
    res.json({ ok: true });
  });

  return router;
};
