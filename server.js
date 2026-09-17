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
const { canAccessMediationChannel } = require('./mediationAccess');

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
// Bloque 27 — el health check del Admin Console necesita leer el estado
// real de socket.io (clientes conectados ahora mismo), sin crear una
// segunda instancia ni pasar io por parámetros por todas partes.
app.set('io', io);

app.use(
  helmet({
    // El frontend usa handlers inline (onclick="...") y carga socket.io /
    // Google Fonts desde CDN — una CSP compatible es un cambio de frontend
    // aparte (sacar los inline handlers), no de este pase de seguridad.
    contentSecurityPolicy: false,
  })
);
// origin:true junto con credentials:true refleja CUALQUIER origen que pida
// el navegador — si FRONTEND_URL no está seteado, cualquier sitio podría
// mandar pedidos autenticados usando la cookie de sesión de la víctima
// (es exactamente el patrón de vulnerabilidad de "CORS mal configurado con
// credenciales"). Como el frontend se sirve desde este mismo servidor
// (abajo, express.static), no hace falta ningún origen cruzado para el uso
// normal — CORS acá es solo para integraciones futuras que sí declaren su
// propio origen. Sin FRONTEND_URL configurado, la app sigue funcionando
// igual (mismo origen nunca lo bloquea CORS); lo único que se pierde es la
// posibilidad de pedidos autenticados desde OTRO dominio, que es
// justamente lo que no se quiere permitir por default.
if (!process.env.FRONTEND_URL) {
  console.warn('⚠ FRONTEND_URL no configurado — CORS con credenciales queda deshabilitado para orígenes cruzados (la app sigue funcionando normal desde el mismo dominio).');
}
app.use(cors({ origin: process.env.FRONTEND_URL || false, credentials: true }));
// guarda el body crudo además de parsearlo — routes/whatsapp.js lo necesita
// para verificar la firma HMAC del webhook antes de confiar en el payload.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// sin esto, un despliegue sin SESSION_SECRET en el .env firmaría las
// cookies de sesión con un string fijo que queda visible en el código
// fuente — cualquiera que lo vea podría forjar una cookie de sesión válida
// para cualquier usuario. En producción esto tiene que frenar el arranque,
// no seguir con un valor por defecto inseguro.
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('✕ SESSION_SECRET no configurado — no se puede arrancar en producción con el secreto de sesión por defecto (queda expuesto en el código fuente). Generá uno con `openssl rand -hex 32` y agregalo al .env.');
  process.exit(1);
}

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

// Presencia (online/escribiendo): en memoria, por proceso — con un solo
// server esto alcanza. Si en algún momento corre más de una instancia,
// esto necesita pasar a algo compartido (Redis) para que la presencia no
// quede partida entre instancias. Se declara ACÁ (antes de armar
// channelRoutes) porque GET /api/channels/mine también la necesita, para
// poder decir "hay alguien conectado ahora" en la lista de casos sin
// obligar al cliente a unirse a la room de todos sus canales a la vez.
const presence = new Map(); // channelCode -> Map(userId -> Set(socketId))
const typingTimers = new Map(); // "`${code}:${userId}`" -> timeout, apaga "escribiendo" solo si no llega otra señal

const channelRoutes = require('./routes/channels')(io, presence);
const guestRoutes = require('./routes/guest')(io);
const adminRoutes = require('./routes/admin')(io);
const whatsappRoutes = require('./routes/whatsapp')(io);
const draftRoutes = require('./routes/draft')();
const verifyRoutes = require('./routes/verify');
const professionalsRoutes = require('./routes/professionals');
const pushRoutes = require('./routes/push')();
const mediationRoutes = require('./routes/mediations')(io, presence);
const partyPortalRoutes = require('./routes/party-portal')(io);
const lawyerPortalRoutes = require('./routes/lawyer-portal')(io);
const studiosRoutes = require('./routes/studios')();
const agendaRoutes = require('./routes/agenda')();
const radarRoutes = require('./routes/radar')();
const adminMediadorRoutes = require('./routes/admin-mediador')();

app.use('/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/guest', guestRoutes);
app.use('/api/admin', adminRoutes);
app.use('/webhook/whatsapp', whatsappRoutes);
app.use('/api/draft', draftRoutes);
app.use('/verificar', verifyRoutes);
app.use('/api/professionals', professionalsRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/mediations', mediationRoutes);
app.use('/api/party-portal', partyPortalRoutes);
app.use('/api/lawyer-portal', lawyerPortalRoutes);
app.use('/api/studios', studiosRoutes);
app.use('/api/agenda', agendaRoutes);
app.use('/api/radar', radarRoutes);
app.use('/api/admin-mediador', adminMediadorRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, users: getDB().users.length }));

// el cliente se une a la "room" de su canal después de autenticarse por HTTP
function isMemberOfChannel(userId, code) {
  const db = getDB();
  const channel = db.channels.find((c) => c.code === code);
  if (!channel) return false;
  // Bloque 19 — un canal de Mediador (mediationId seteado) se autoriza
  // contra el acceso real a la mediación, no contra `members`: un
  // asistente recién asignado a la mediación todavía puede no tener una
  // fila de member en ESTE hilo puntual (se crea perezosamente, ver
  // routes/mediations.js), y aun así tiene que poder conectarse. Canales
  // de coparentalidad (mediationId null) siguen exactamente igual que
  // siempre — esto no les cambia nada.
  if (channel.mediationId) return canAccessMediationChannel(db, userId, channel);
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

// Bloque 27 — cada job de acá abajo se envuelve con runTrackedJob, que
// preserva EXACTAMENTE el mismo console.error de siempre y además guarda el
// resultado en systemStatus.js (en memoria) para que el Admin Console pueda
// mostrar "último estado conocido de cada job" sin leer logs de PM2.
const { recordJobRun } = require('./systemStatus');
function runTrackedJob(name, label, fn) {
  return fn()
    .then((result) => { recordJobRun(name, { ok: true, result }); return result; })
    .catch((e) => { console.error(`Error en ${label}:`, e); recordJobRun(name, { ok: false, error: e.message || String(e) }); });
}

// recordatorio de eventos confirmados por WhatsApp, un día antes — revisa
// cada hora mientras el proceso esté vivo; una corrida temprana evita
// esperar hasta una hora completa después de cada deploy.
const { checkAndSendReminders } = require('./reminders');
setTimeout(() => runTrackedJob('checkAndSendReminders', 'recordatorios', checkAndSendReminders), 10 * 1000);
setInterval(() => runTrackedJob('checkAndSendReminders', 'recordatorios', checkAndSendReminders), 60 * 60 * 1000);

// canales sin unir (Tarea C) y resumen semanal (Tarea D) — corren cada
// 2hs; cada función internamente decide si le toca actuar o no en esa
// corrida, así que no hace falta un intervalo más fino que ese.
const { checkUnjoinedChannels, generateWeeklySummaries, checkMediationDeadlines, checkHearingsStartingSoon } = require('./jobs');
setTimeout(() => runTrackedJob('checkUnjoinedChannels', 'job de canales sin unir', checkUnjoinedChannels), 15 * 1000);
setInterval(() => runTrackedJob('checkUnjoinedChannels', 'job de canales sin unir', checkUnjoinedChannels), 2 * 60 * 60 * 1000);
setTimeout(() => runTrackedJob('generateWeeklySummaries', 'job de resumen semanal', generateWeeklySummaries), 20 * 1000);
setInterval(() => runTrackedJob('generateWeeklySummaries', 'job de resumen semanal', generateWeeklySummaries), 2 * 60 * 60 * 1000);
setTimeout(() => runTrackedJob('checkMediationDeadlines', 'job de vencimientos de Mediador', checkMediationDeadlines), 25 * 1000);
setInterval(() => runTrackedJob('checkMediationDeadlines', 'job de vencimientos de Mediador', checkMediationDeadlines), 60 * 60 * 1000);

// Bloque 26 §2 — mensaje de "audiencia por empezar" en el chat. Cadencia
// PROPIA de 5 minutos (no la hora del resto de los jobs de arriba) — es lo
// que permite acertar la ventana de "minutos antes" con precisión razonable,
// ver auditoría en jobs.js. No cambia la cadencia de ningún otro job.
setTimeout(() => runTrackedJob('checkHearingsStartingSoon', 'job de "audiencia por empezar"', () => checkHearingsStartingSoon(io)), 35 * 1000);
setInterval(() => runTrackedJob('checkHearingsStartingSoon', 'job de "audiencia por empezar"', () => checkHearingsStartingSoon(io)), 5 * 60 * 1000);

// Bloque 25 — radar competitivo. checkDueSources() decide sola, por fuente,
// si le toca (frecuencia daily/weekly/manual) — por eso alcanza con
// revisarlo cada hora, igual que el resto de los jobs de arriba.
const { checkDueSources } = require('./radarJobs');
setTimeout(() => runTrackedJob('checkDueSources', 'job del radar competitivo', checkDueSources), 30 * 1000);
setInterval(() => runTrackedJob('checkDueSources', 'job del radar competitivo', checkDueSources), 60 * 60 * 1000);
