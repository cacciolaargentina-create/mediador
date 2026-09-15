// routes/auth.js
const express = require('express');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');

const router = express.Router();

const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (googleConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const db = getDB();
          let user = db.users.find((u) => u.googleId === profile.id);
          if (!user) {
            user = {
              id: nanoid(),
              googleId: profile.id,
              email: profile.emails?.[0]?.value || '',
              name: profile.displayName || 'Usuario',
              avatar: profile.photos?.[0]?.value || '',
              createdAt: Date.now(),
            };
            db.users.push(user);
            await commit();
          }
          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    )
  );
} else {
  console.warn(
    '⚠ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no configurados en .env — el login con Google está deshabilitado hasta que los completes.'
  );
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const db = getDB();
  const user = db.users.find((u) => u.id === id);
  done(null, user || null);
});

// solo permite volver a una ruta relativa propia (nunca a otro host) — evita
// que ?next= se use como open redirect.
function safeNextPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

router.get('/google', (req, res, next) => {
  if (!googleConfigured) {
    return res
      .status(503)
      .send('Login con Google no configurado todavía. Completá GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en tu .env.');
  }
  const nextPath = safeNextPath(req.query.next);
  if (nextPath) req.session.postLoginRedirect = nextPath;
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get(
  '/google/callback',
  (req, res, next) => {
    if (!googleConfigured) return res.status(503).send('Login con Google no configurado.');
    next();
  },
  passport.authenticate('google', { failureRedirect: '/login-error' }),
  (req, res) => {
    // Login exitoso -> volver al frontend (o a donde pidió ?next= antes de entrar a Google)
    const redirectTo = req.session.postLoginRedirect || process.env.FRONTEND_URL || '/';
    delete req.session.postLoginRedirect;
    res.redirect(redirectTo);
  }
);

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  const { id, name, email, avatar, readReceiptsEnabled } = req.user;
  // !== false, no "?? true": un usuario recién creado en memoria (antes
  // del primer commit+reload) todavía no tiene esta columna seteada, y
  // el default real es "activado" (ver DEFAULT 1 en db.js).
  res.json({ id, name, email, avatar, readReceiptsEnabled: readReceiptsEnabled !== false });
});

// preferencias de cuenta que no ameritan su propia tabla — hoy solo
// "confirmaciones de lectura" (ver POST .../messages/:id/read). Body
// parcial: solo se tocan las claves que vienen, el resto queda como
// estaba.
router.post('/me/preferences', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  const db = getDB();
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (typeof req.body.readReceiptsEnabled === 'boolean') {
    user.readReceiptsEnabled = req.body.readReceiptsEnabled;
  }
  await commit();
  res.json({ readReceiptsEnabled: user.readReceiptsEnabled !== false });
});

router.post('/logout', (req, res) => {
  req.logout(() => {
    res.json({ ok: true });
  });
});

// Bloque 18 §16 — login sin contraseña para scripts/regression-test.js
// (y para pruebas manuales durante el desarrollo). Apagado por default:
// solo existe si ENABLE_FAKE_LOGIN=1 está en el entorno, y ESO nunca debe
// estar en el .env de producción — confirmarlo es parte del checklist de
// BETA_READINESS.md antes de cada deploy. Sin la variable, esta ruta ni
// siquiera se registra.
if (process.env.ENABLE_FAKE_LOGIN === '1') {
  router.post('/fake-login', async (req, res) => {
    const db = getDB();
    const { email, name } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Falta el email' });
    let user = db.users.find((u) => u.email === email);
    if (!user) {
      user = { id: nanoid(), googleId: 'fake-' + nanoid(), email, name: name || email, avatar: '', createdAt: Date.now() };
      db.users.push(user);
      await commit();
    }
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({ ok: true, user });
    });
  });
}

module.exports = router;
