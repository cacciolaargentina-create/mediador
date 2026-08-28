// server.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const authRoutes = require('./routes/auth');
const { getDB, resolveGuest } = require('./db');

// Sin FRONTEND_URL en producción, el CORS de abajo reflejaría cualquier
// origen (con credentials:true) — mejor no arrancar que quedar abierto.
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  console.error('FRONTEND_URL es obligatorio en producción — configuralo en las variables de entorno y reiniciá.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || true, credentials: true },
});

const PORT = process.env.PORT || 3000;

// necesario para que express-rate-limit identifique IPs reales detrás del
// proxy de plataformas como Railway/Render en vez de agrupar a todos bajo una.
app.set('trust proxy', 1);

app.use(
  helmet({
    // El frontend usa handlers inline (onclick="...") y carga socket.io /
    // Google Fonts desde CDN — una CSP compatible es un cambio de frontend
    // aparte (sacar los inline handlers), no de este pase de seguridad.
    contentSecurityPolicy: false,
  })
);
app.use(cors({ origin: process.env.FRONTEND_URL || true, credentials: true }));
// guarda el body crudo además de parsearlo — routes/whatsapp.js lo necesita
// para verificar la firma HMAC del webhook antes de confiar en el payload.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'cambiar-este-secreto-en-produccion',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Persona B no tiene sesión de Google: si no hay usuario de Passport pero
// llega el header con su guestToken, lo resolvemos igual que a un usuario
// logueado — así el resto de las rutas no necesita saber cómo se autenticó.
app.use((req, res, next) => {
  if (!req.user) {
    const token = req.headers['x-guest-token'];
    if (token) {
      const resolved = resolveGuest(token);
      if (resolved) req.user = resolved.user;
    }
  }
  next();
});

// comparte la sesión de Express con las conexiones de socket.io,
// así sabemos quién es quién sin pedir login de nuevo por websocket
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

const channelRoutes = require('./routes/channels')(io);
const guestRoutes = require('./routes/guest')(io);
const adminRoutes = require('./routes/admin')(io);
const whatsappRoutes = require('./routes/whatsapp')(io);

app.use('/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/guest', guestRoutes);
app.use('/api/admin', adminRoutes);
app.use('/webhook/whatsapp', whatsappRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, users: getDB().users.length }));

// el cliente se une a la "room" de su canal después de autenticarse por HTTP
io.on('connection', (socket) => {
  const req = socket.request;
  let identity = req.user || null;
  if (!identity) {
    const token = socket.handshake.auth && socket.handshake.auth.guestToken;
    if (token) {
      const resolved = resolveGuest(token);
      if (resolved) identity = resolved.user;
    }
  }
  if (!identity) {
    socket.disconnect();
    return;
  }
  socket.on('join-channel', (code) => {
    // Nota: para producción real, validar acá también que req.user sea miembro
    // del canal antes de sumarlo a la room (ver requireMembership en channels.js).
    socket.join(String(code).toUpperCase());
  });
});

server.listen(PORT, () => {
  console.log(`Puente Digital backend corriendo en http://localhost:${PORT}`);
});
