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
const { getDB, resolveGuest, commit } = require('./db');

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
const draftRoutes = require('./routes/draft')();
const verifyRoutes = require('./routes/verify');
const professionalsRoutes = require('./routes/professionals');
const pushRoutes = require('./routes/push')();

app.use('/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/guest', guestRoutes);
app.use('/api/admin', adminRoutes);
app.use('/webhook/whatsapp', whatsappRoutes);
app.use('/api/draft', draftRoutes);
app.use('/verificar', verifyRoutes);
app.use('/api/professionals', professionalsRoutes);
app.use('/api/push', pushRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, users: getDB().users.length }));

// el cliente se une a la "room" de su canal después de autenticarse por HTTP
//
// Presencia (online/escribiendo): en memoria, por proceso — con un solo
// server esto alcanza. Si en algún momento corre más de una instancia,
// esto necesita pasar a algo compartido (Redis) para que la presencia no
// quede partida entre instancias.
const presence = new Map(); // channelCode -> Map(userId -> Set(socketId))
const typingTimers = new Map(); // "`${code}:${userId}`" -> timeout, apaga "escribiendo" solo si no llega otra señal

function isMemberOfChannel(userId, code) {
  const db = getDB();
  const channel = db.channels.find((c) => c.code === code);
  if (!channel) return false;
  return db.members.some((m) => m.channelId === channel.id && m.userId === userId);
}

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
  socket.data.userId = identity.id;
  socket.data.channels = new Set();

  socket.on('join-channel', (code) => {
    const upper = String(code).toUpperCase();
    // antes esto confiaba ciegamente en lo que mandaba el cliente — ahora
    // valida membresía real, igual que ya hace requireMembership del lado HTTP.
    if (!isMemberOfChannel(identity.id, upper)) return;
    socket.join(upper);
    socket.data.channels.add(upper);

    if (!presence.has(upper)) presence.set(upper, new Map());
    const channelPresence = presence.get(upper);
    const alreadyOnline = channelPresence.has(identity.id);
    if (!alreadyOnline) channelPresence.set(identity.id, new Set());
    channelPresence.get(identity.id).add(socket.id);
    if (!alreadyOnline) {
      io.to(upper).emit('peer:presence', { userId: identity.id, online: true });
    }
  });

  socket.on('typing:start', (code) => {
    const upper = String(code).toUpperCase();
    if (!socket.data.channels.has(upper)) return; // no puede "escribir" en un canal al que ni se unió
    socket.to(upper).emit('peer:typing', { userId: identity.id, typing: true });
    const key = upper + ':' + identity.id;
    clearTimeout(typingTimers.get(key));
    // si no llega otra señal en 4s (ni typing:start de nuevo, ni typing:stop
    // al enviar), se apaga sola — cubre el caso de que se cierre la pestaña
    // a mitad de escribir sin mandar el "stop".
    typingTimers.set(key, setTimeout(() => {
      io.to(upper).emit('peer:typing', { userId: identity.id, typing: false });
      typingTimers.delete(key);
    }, 4000));
  });

  socket.on('typing:stop', (code) => {
    const upper = String(code).toUpperCase();
    if (!socket.data.channels.has(upper)) return;
    const key = upper + ':' + identity.id;
    clearTimeout(typingTimers.get(key));
    typingTimers.delete(key);
    io.to(upper).emit('peer:typing', { userId: identity.id, typing: false });
  });

  socket.on('disconnect', () => {
    for (const code of socket.data.channels) {
      const channelPresence = presence.get(code);
      if (!channelPresence || !channelPresence.has(identity.id)) continue;
      const sockets = channelPresence.get(identity.id);
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        channelPresence.delete(identity.id);
        const lastSeenAt = Date.now();
        io.to(code).emit('peer:presence', { userId: identity.id, online: false, lastSeenAt });
        // se guarda para poder mostrar "última vez hace X" la próxima vez que
        // alguien abra el chat, no solo mientras la otra persona está conectada.
        const db = getDB();
        const channel = db.channels.find((c) => c.code === code);
        const member = channel && db.members.find((m) => m.channelId === channel.id && m.userId === identity.id);
        if (member) {
          member.lastSeenAt = lastSeenAt;
          commit().catch((e) => console.error('No se pudo guardar lastSeenAt', e));
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Puente Digital backend corriendo en http://localhost:${PORT}`);
});

// recordatorio de eventos confirmados por WhatsApp, un día antes — revisa
// cada hora mientras el proceso esté vivo; una corrida temprana evita
// esperar hasta una hora completa después de cada deploy.
const { checkAndSendReminders } = require('./reminders');
setTimeout(() => checkAndSendReminders().catch((e) => console.error('Error en recordatorios:', e)), 10 * 1000);
setInterval(() => checkAndSendReminders().catch((e) => console.error('Error en recordatorios:', e)), 60 * 60 * 1000);

// canales sin unir (Tarea C) y resumen semanal (Tarea D) — corren cada
// 2hs; cada función internamente decide si le toca actuar o no en esa
// corrida, así que no hace falta un intervalo más fino que ese.
const { checkUnjoinedChannels, generateWeeklySummaries } = require('./jobs');
setTimeout(() => checkUnjoinedChannels().catch((e) => console.error('Error en job de canales sin unir:', e)), 15 * 1000);
setInterval(() => checkUnjoinedChannels().catch((e) => console.error('Error en job de canales sin unir:', e)), 2 * 60 * 60 * 1000);
setTimeout(() => generateWeeklySummaries().catch((e) => console.error('Error en job de resumen semanal:', e)), 20 * 1000);
setInterval(() => generateWeeklySummaries().catch((e) => console.error('Error en job de resumen semanal:', e)), 2 * 60 * 60 * 1000);
