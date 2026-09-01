// public/app.js

let me = null;            // { id, name, email, avatar }
let channelCode = null;   // código del canal activo, tomado de ?channel=
let channelInfo = null;   // { code, createdAt, members:[{role,user}] }
let myRole = null;        // 'A' | 'B', derivado de channelInfo + me.id
let messages = [];
let events = [];
let socket = null;
let currentScreen = 'inicio';
let seen = { msgCount: 0, evCount: 0 }; // en memoria, se resetea por sesión — suficiente para el badge
let isGuest = false;      // true si entramos por link de invitado (Persona B, sin Google)
let guestToken = null;
let proposeFormOpen = false;   // formulario de "Proponer horario" abierto en el composer del chat
let proposeCounterFor = null;  // id del evento para el que se está armando una contrapropuesta
let notifyEnabled = false;     // sonido + notificaciones del navegador para mensajes nuevos
let audioCtx = null;
let hasMoreHistory = false;    // true si /messages todavía tiene mensajes más viejos que los cargados
let loadingMoreHistory = false;
let historialMessages = null;  // registro completo para la pantalla Historial — se carga aparte de `messages` (que ahora es solo la ventana en vivo del chat), null = todavía no se pidió
let socketEverConnected = false; // distingue la primera conexión (ya cargamos todo a mano) de una reconexión (hay que resincronizar)

// Ejemplos de mensajes centrados en hechos para situaciones típicas de
// coparentalidad — un empujón hacia comunicación estructurada en vez de
// texto libre que puede escalar. El usuario los edita antes de enviar.
const CHAT_TEMPLATES = [
  { label: '🕐 Confirmar horario', text: 'Confirmo que la entrega de hoy se hace a las 08:30 hs.' },
  { label: '⏱ Avisar demora', text: 'Aviso que voy a llegar tarde a la entrega, aproximadamente 15 minutos.' },
  { label: '🏫 Info de colegio/salud', text: 'Te comparto información sobre el colegio/salud de nuestro hijo/a: ' },
  { label: '📌 Recordar un acuerdo', text: 'Recordatorio: habíamos acordado que ' },
  { label: '💰 Gasto compartido', text: 'Te paso el detalle de un gasto para dividir: ' },
];

// la "otra parte" es específicamente el otro rol A/B — con mediador/a o
// estudio jurídico sumados al canal, ya no alcanza con "cualquier miembro
// que no sea yo".
function otherPartyOf(info){
  if(!info) return null;
  return info.members.find(m => (m.role === 'A' || m.role === 'B') && (!m.user || m.user.id !== me.id));
}

function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTs(iso){ return new Date(iso).toLocaleString('es-AR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}); }

async function api(path, opts={}){
  const headers = { 'Content-Type': 'application/json', ...(opts.headers||{}) };
  if(isGuest && guestToken) headers['X-Guest-Token'] = guestToken;
  const resp = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  let data = null;
  try{ data = await resp.json(); }catch(e){ /* respuestas de export son texto plano */ }
  if(!resp.ok) throw { status: resp.status, ...( data || {} ) };
  return data;
}

// ==================================================================
// BOOT
// ==================================================================
(async function boot(){
  const params = new URLSearchParams(location.search);
  const guestParam = params.get('guest');
  if(guestParam){
    isGuest = true;
    guestToken = guestParam;
    await bootGuest();
    return;
  }

  const proParam = params.get('pro');
  if(proParam){
    await bootProfessional(proParam);
    return;
  }

  try{
    me = await api('/auth/me');
  }catch(e){
    showLogin();
    return;
  }
  document.getElementById('login-screen').style.display = 'none';

  if(params.get('proSignup')){
    await renderProSignup();
    return;
  }

  document.getElementById('topbar').style.display = 'flex';
  document.getElementById('main').style.display = 'block';
  document.getElementById('tabs').style.display = 'flex';
  renderUserChip();
  checkAdminLink();
  initNotifications();

  const codeFromUrl = params.get('channel');
  if(codeFromUrl){
    await tryLoadChannel(codeFromUrl.toUpperCase());
    goTo(channelInfo ? 'chat' : 'inicio');
  } else {
    // sin ?channel= explícito: el caso más común es una persona con UN solo
    // canal (una pareja coparentando) — obligarla a pasar por la lista de
    // Inicio para tocar el único caso que tiene es un paso de más. Con 0 o
    // 2+ casos, la lista sigue siendo el punto de entrada normal.
    const mine = await refreshInicioBadge();
    if(mine.length === 1){
      await tryLoadChannel(mine[0].code);
      goTo(channelInfo ? 'chat' : 'inicio');
    } else {
      goTo('inicio');
    }
  }
  document.addEventListener('visibilitychange', () => { if(!document.hidden) refreshInicioBadge(); });
})();

// ==================================================================
// AUTOREGISTRO DE MEDIADOR/A O ESTUDIO JURÍDICO
// ==================================================================
// Llega por /auth/google?next=/%3FproSignup%3D1 desde el link "Registrate"
// del landing. A diferencia de bootProfessional(), acá la persona todavía
// no tiene ningún canal — es un alta de plataforma, pendiente de que un
// admin la revise a mano desde /admin.html.
async function renderProSignup(){
  document.getElementById('pro-signup-screen').style.display = 'flex';
  const el = document.getElementById('pro-signup-content');
  el.innerHTML = `<p class="screen-sub">Cargando…</p>`;

  let status;
  try{ status = await api('/api/professionals/me'); }
  catch(e){ el.innerHTML = `<p class="screen-sub">No se pudo cargar. Probá recargar la página.</p>`; return; }

  if(status.verifiedProfessional){
    el.innerHTML = `
      <p class="screen-sub">Ya sos profesional verificado en Puente Digital (${escapeHtml(status.verifiedProfessionalRole === 'estudio' ? 'estudio jurídico' : 'mediador/a')} — ${escapeHtml(status.verifiedProfessionalOrg || '')}).</p>
      <button class="primary" style="width:100%; margin-top:10px;" onclick="closeProSignup()">Continuar a la app</button>
    `;
    return;
  }

  if(status.application && status.application.status === 'pending'){
    el.innerHTML = `
      <p class="screen-sub">Tu solicitud como ${escapeHtml(status.application.roleLabel)} (${escapeHtml(status.application.orgName)}) está en revisión. Te avisamos apenas la veamos.</p>
      <button class="ghost" style="width:100%; margin-top:10px;" onclick="closeProSignup()">Continuar a la app</button>
    `;
    return;
  }

  const rejected = status.application && status.application.status === 'rejected';

  el.innerHTML = `
    ${rejected ? `<p class="screen-sub" style="color:var(--warn)">Tu solicitud anterior no fue aprobada. Podés volver a intentarlo o escribirnos por WhatsApp.</p>` : `<p class="screen-sub">Registrate como mediador/a o estudio jurídico. Un administrador revisa la solicitud antes de habilitarla.</p>`}
    <div class="card" style="text-align:left; margin-top:10px;">
      <label class="field-label">Rol</label>
      <select id="pro-signup-role" style="margin-bottom:10px;">
        <option value="mediador">Mediador/a</option>
        <option value="estudio">Estudio jurídico</option>
      </select>
      <label class="field-label">Nombre del estudio u organización</label>
      <input type="text" id="pro-signup-org" placeholder="Ej: Estudio Pérez &amp; Asoc." style="margin-bottom:12px;">
      <button class="primary" style="width:100%" onclick="submitProSignup()" id="pro-signup-btn">Enviar solicitud</button>
      <div id="pro-signup-result" style="margin-top:10px; font-size:12.5px;"></div>
    </div>
    <button class="ghost" style="width:100%; margin-top:10px;" onclick="closeProSignup()">Ahora no, llevame a la app</button>
  `;
}

async function submitProSignup(){
  const role = document.getElementById('pro-signup-role').value;
  const orgName = document.getElementById('pro-signup-org').value.trim();
  const resultEl = document.getElementById('pro-signup-result');
  const btn = document.getElementById('pro-signup-btn');
  if(!orgName){ resultEl.innerHTML = `<span style="color:var(--danger)">Falta el nombre del estudio u organización.</span>`; return; }
  btn.disabled = true;
  try{
    await api('/api/professionals/apply', { method:'POST', body: JSON.stringify({ role, orgName }) });
    await renderProSignup();
  }catch(e){
    resultEl.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.error || 'No se pudo enviar la solicitud.')}</span>`;
    btn.disabled = false;
  }
}

function closeProSignup(){
  document.getElementById('pro-signup-screen').style.display = 'none';
  const url = new URL(location.href);
  url.searchParams.delete('proSignup');
  history.pushState({}, '', url); // limpia el ?proSignup=1 de la URL sin tocar otros params
  document.getElementById('topbar').style.display = 'flex';
  document.getElementById('main').style.display = 'block';
  document.getElementById('tabs').style.display = 'flex';
  renderUserChip();
  checkAdminLink();
  initNotifications();
  goTo('inicio');
}

async function bootGuest(){
  let entered;
  try{
    entered = await api(`/api/guest/${guestToken}/enter`, { method:'POST', body: JSON.stringify({}) });
  }catch(e){
    if(e.status === 400){
      entered = await promptGuestName();
      if(!entered) return; // el usuario nunca pudo entrar (error mostrado en la pantalla)
    } else {
      showGuestError(e.error || 'Este enlace no es válido o el canal ya está completo.');
      return;
    }
  }

  me = { id: entered.id, name: entered.name, avatar: '' };
  channelCode = entered.code;

  document.getElementById('guest-name-screen').style.display = 'none';
  document.getElementById('guest-error-screen').style.display = 'none';
  document.getElementById('topbar').style.display = 'flex';
  document.getElementById('main').style.display = 'block';
  document.getElementById('main').style.paddingBottom = '20px'; // sin nav de abajo, no hace falta el espacio reservado para esa barra
  // el/la invitada de solo lectura tiene un único canal fijo, ninguno propio:
  // "Inicio" (lista de casos) y "Nuevo/Unirme" no aplican porque no tiene
  // más casos ni puede crear uno, y "Borrador" tampoco porque es personal
  // del usuario (un espacio propio para redactar), no del caso ajeno que
  // está mirando desde afuera. Sin ningún ítem global que le corresponda,
  // el nav de abajo (#tabs) directamente no se muestra — todo lo suyo es
  // el Nivel 2 del caso al que fue invitada.
  renderUserChip();
  initNotifications();

  channelInfo = await api('/api/channels/' + channelCode);
  const mine = channelInfo.members.find(m => m.user && m.user.id === me.id);
  myRole = mine ? mine.role : 'B';
  connectSocket();
  await Promise.all([loadMessages(), loadEvents()]);
  seen.msgCount = messages.length;
  seen.evCount = events.length;
  goTo('chat');
}

// true para mediador/a o estudio jurídico: acceso de solo lectura, nunca
// pueden mandar mensajes ni resolver acuerdos en nombre de las partes.
function isProfessional(){ return myRole === 'mediador' || myRole === 'estudio'; }
function professionalRoleLabel(role){ return role === 'mediador' ? 'Mediador/a' : role === 'estudio' ? 'Estudio jurídico' : null; }

async function bootProfessional(token){
  let info;
  try{
    info = await api(`/api/channels/professional/${token}`);
  }catch(e){
    showGuestError('Este enlace de invitación no es válido.');
    return;
  }
  if(info.used){
    showGuestError('Esta invitación ya fue utilizada. Pedile a la parte que te invitó que genere un nuevo enlace.');
    return;
  }

  try{
    me = await api('/auth/me');
  }catch(e){
    showProLogin(info, token);
    return;
  }
  await acceptProfessionalInvite(token);
}

function showProLogin(info, token){
  document.getElementById('pro-login-role').textContent = professionalRoleLabel(info.role);
  document.getElementById('pro-login-label').textContent = info.label;
  document.getElementById('pro-login-btn').onclick = () => {
    location.href = '/auth/google?next=' + encodeURIComponent('/?pro=' + token);
  };
  document.getElementById('pro-login-screen').style.display = 'flex';
}

async function acceptProfessionalInvite(token){
  try{
    channelInfo = await api(`/api/channels/professional/${token}/accept`, { method:'POST' });
  }catch(e){
    showGuestError(e.error || 'No se pudo procesar la invitación.');
    return;
  }
  channelCode = channelInfo.code;
  const mine = channelInfo.members.find(m => m.user && m.user.id === me.id);
  myRole = mine ? mine.role : null;
  markVisited(channelCode);

  document.getElementById('pro-login-screen').style.display = 'none';
  document.getElementById('guest-error-screen').style.display = 'none';
  document.getElementById('topbar').style.display = 'flex';
  document.getElementById('main').style.display = 'block';
  document.getElementById('tabs').style.display = 'flex';
  renderUserChip();
  checkAdminLink();
  initNotifications();

  updateUrl(channelCode); // limpia el ?pro= de la URL una vez que ya entramos
  connectSocket();
  await Promise.all([loadMessages(), loadEvents()]);
  seen.msgCount = messages.length;
  seen.evCount = events.length;
  goTo('chat');
}

function promptGuestName(){
  return new Promise((resolve) => {
    document.getElementById('guest-name-screen').style.display = 'flex';
    const input = document.getElementById('guest-name-input');
    const errEl = document.getElementById('guest-name-error');
    input.focus();
    window.submitGuestName = async () => {
      const name = input.value.trim();
      errEl.textContent = '';
      if(!name){ errEl.textContent = 'Completá tu nombre.'; return; }
      try{
        const entered = await api(`/api/guest/${guestToken}/enter`, { method:'POST', body: JSON.stringify({ name }) });
        resolve(entered);
      }catch(e){
        errEl.textContent = e.error || 'No se pudo entrar al canal.';
      }
    };
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') window.submitGuestName(); });
  });
}

function showGuestError(msg){
  document.getElementById('guest-error-text').textContent = msg;
  document.getElementById('guest-error-screen').style.display = 'flex';
}

function showLogin(){
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('topbar').style.display = 'none';
  document.getElementById('main').style.display = 'none';
  document.getElementById('tabs').style.display = 'none';
  // el navegador intenta hacer scroll al #hash antes de que la landing sea
  // visible (estaba display:none mientras se resolvía /auth/me) — lo repetimos ahora.
  if(location.hash){
    const target = document.querySelector(location.hash);
    if(target) target.scrollIntoView();
  }
}

function renderUserChip(){
  const el = document.getElementById('user-chip');
  const roleBadge = isProfessional() ? `<span class="role-badge">${professionalRoleLabel(myRole)}</span>` : '';
  el.innerHTML = `
    ${roleBadge}
    ${me.avatar ? `<img src="${me.avatar}" alt="">` : ''}
    <span class="name">${escapeHtml(me.name)}</span>
    ${isGuest ? '' : '<button onclick="logout()">Salir</button>'}
  `;
}
async function logout(){
  await api('/auth/logout', { method:'POST' });
  location.href = '/';
}
async function checkAdminLink(){
  if(isGuest) return;
  try{
    const res = await api('/api/admin/am-i-admin');
    if(!res.isAdmin) return;
    const chip = document.getElementById('user-chip');
    const a = document.createElement('a');
    a.href = '/admin.html';
    a.textContent = 'Admin';
    a.style.cssText = 'color:var(--calm); font-size:11px; text-decoration:underline;';
    chip.insertBefore(a, chip.firstChild);
  }catch(e){ /* si falla, simplemente no aparece el link */ }
}

// ==================================================================
// SONIDO + NOTIFICACIONES DE MENSAJES NUEVOS
// ==================================================================
function initNotifications(){
  if(typeof Notification === 'undefined'){ return; } // navegador sin soporte (ej. algunos in-app browsers)
  notifyEnabled = localStorage.getItem('pd_notify_enabled') === '1' && Notification.permission === 'granted';
  renderNotifyToggle();
  // el audio necesita un gesto del usuario para desbloquearse — si ya estaba
  // habilitado en una sesión anterior, lo desbloqueamos en la primera
  // interacción de esta carga de página.
  document.addEventListener('click', () => { if(notifyEnabled) ensureAudioCtx(); }, { once:true });
}

function renderNotifyToggle(){
  if(typeof Notification === 'undefined') return;
  const chip = document.getElementById('user-chip');
  if(!chip) return;
  let btn = document.getElementById('notify-toggle');
  if(!btn){
    btn = document.createElement('button');
    btn.id = 'notify-toggle';
    btn.onclick = toggleNotifications;
    btn.style.cssText = 'background:none; border:none; font-size:15px; cursor:pointer; padding:0 2px; line-height:1;';
    chip.insertBefore(btn, chip.firstChild);
  }
  btn.textContent = notifyEnabled ? '🔔' : '🔕';
  btn.title = notifyEnabled ? 'Sonido y notificaciones activados — tocá para desactivar' : 'Activar sonido y notificaciones de mensajes nuevos';
}

async function toggleNotifications(){
  if(notifyEnabled){
    notifyEnabled = false;
    localStorage.removeItem('pd_notify_enabled');
    renderNotifyToggle();
    return;
  }
  if(Notification.permission === 'denied'){
    alert('Bloqueaste las notificaciones para este sitio — activalas desde la configuración del navegador si querés usarlas.');
    return;
  }
  const perm = await Notification.requestPermission();
  notifyEnabled = perm === 'granted';
  if(notifyEnabled){
    localStorage.setItem('pd_notify_enabled', '1');
    ensureAudioCtx();
    playNotifySound();
  }
  renderNotifyToggle();
}

function ensureAudioCtx(){
  if(!audioCtx){
    try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){ /* sin soporte de audio */ }
  }
  return audioCtx;
}

async function playNotifySound(){
  const ctx = ensureAudioCtx();
  if(!ctx) return;
  try{
    if(ctx.state === 'suspended') await ctx.resume();
    const notes = [[880, 0, 0.11], [1175, 0.11, 0.16]];
    notes.forEach(([freq, offset, dur]) => {
      const start = ctx.currentTime + offset;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    });
  }catch(e){ /* audio no disponible en este momento */ }
}

function notifyIncoming(m){
  if(!notifyEnabled) return;
  let fromOther = false;
  if(m.sender){
    fromOther = m.sender.id !== me.id;
  } else if(m.eventId){
    const ev = events.find(e => e.id === m.eventId);
    fromOther = !!(ev && ev.requestedBy && ev.requestedBy.id !== me.id);
  }
  if(!fromOther) return;

  playNotifySound();

  const shouldPopup = document.hidden || currentScreen !== 'chat';
  if(shouldPopup && Notification.permission === 'granted'){
    try{
      const senderName = m.sender ? m.sender.name : 'Puente Digital';
      const n = new Notification(senderName + ' · Puente Digital', {
        body: m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text,
        tag: 'puente-digital-chat',
      });
      n.onclick = () => { window.focus(); goTo('chat'); n.close(); };
    }catch(e){ /* algunos navegadores mobile no soportan new Notification() directo */ }
  }
}

// ==================================================================
// CHANNEL LOADING
// ==================================================================
async function tryLoadChannel(code){
  try{
    channelInfo = await api('/api/channels/' + code);
    channelCode = code;
    const mine = channelInfo.members.find(m => m.user && m.user.id === me.id);
    myRole = mine ? mine.role : null;
    calendarLinkCache = null;
    historialMessages = null; // canal nuevo/distinto — el Historial completo se vuelve a pedir la próxima vez que se abra
    renderUserChip();
    connectSocket();
    await Promise.all([loadMessages(), loadEvents(), loadExpenses()]);
    seen.msgCount = messages.length;
    seen.evCount = events.length;
    markVisited(code);
    return true;
  }catch(e){
    channelInfo = null; channelCode = null; myRole = null;
    if(e.status === 403){
      // no soy miembro — quizás me llegó el link para unirme
      pendingJoinCode = code;
    }
    return false;
  }
}
let pendingJoinCode = null;

// cambia de caso sin recargar la página — reusa tryLoadChannel(), que ya
// hace todo lo necesario (cargar mensajes/eventos/gastos, reconectar el
// socket al room correcto). Se usa al tocar un caso desde "Mis casos".
async function openCase(code){
  const ok = await tryLoadChannel(code);
  if(ok){
    updateUrl(code);
    goTo('chat');
  } else {
    alert('No se pudo abrir ese caso. Probá recargar la página.');
  }
}

function showConnectionBanner(){
  const el = document.getElementById('connection-banner');
  if(el) el.style.display = 'flex';
}
function hideConnectionBanner(){
  const el = document.getElementById('connection-banner');
  if(el) el.style.display = 'none';
}

function connectSocket(){
  if(socket) socket.disconnect();
  socketEverConnected = false;
  hideConnectionBanner();
  const opts = { withCredentials:true };
  if(isGuest) opts.auth = { guestToken };
  socket = io(opts);
  socket.on('connect', ()=>{
    socket.emit('join-channel', channelCode);
    if(socketEverConnected){
      // no es la primera conexión — es una reconexión después de un corte.
      // El socket ya se reconectó solo (comportamiento por defecto de
      // socket.io-client), pero eso no trae de vuelta lo que se perdió
      // mientras estuvo cortado — hay que volver a pedirlo.
      resyncMessages();
      if(currentScreen === 'calendario') loadEvents().then(renderCalendario);
      if(currentScreen === 'gastos') loadExpenses().then(renderGastos);
    }
    socketEverConnected = true;
    hideConnectionBanner();
  });
  socket.on('disconnect', ()=> showConnectionBanner());
  socket.on('message:new', (m)=>{
    if(!messages.find(x=>x.id===m.id)) messages.push(m);
    // si Historial ya cargó su registro completo, se mantiene al día en
    // vivo también — si todavía no se cargó ni hace falta tocarlo acá,
    // se carga fresco (con este mensaje ya incluido) la próxima vez que se abra.
    if(historialMessages && !historialMessages.find(x=>x.id===m.id)) historialMessages.push(m);
    if(currentScreen === 'chat') paintMessages();
    if(currentScreen === 'historial') renderHistorial();
    updateNavBadges();
    notifyIncoming(m);
  });
  socket.on('event:new', (e)=>{ upsertEvent(e); if(currentScreen==='calendario') renderCalendario(); if(currentScreen==='chat') paintMessages(); updateNavBadges(); });
  socket.on('event:update', (e)=>{ upsertEvent(e); if(currentScreen==='calendario') renderCalendario(); if(currentScreen==='chat') paintMessages(); updateNavBadges(); });
  socket.on('channel:update', (info)=>{ channelInfo = info; if(currentScreen==='config') renderConfig(); if(currentScreen==='chat') renderCaseTabsInfo(); });
  socket.on('expense:new', (e)=>{ upsertExpense(e); if(currentScreen==='gastos') renderGastos(); });
  socket.on('expense:update', (e)=>{ upsertExpense(e); if(currentScreen==='gastos') renderGastos(); });
  socket.on('checkin:new', ()=>{ if(currentScreen==='calendario') loadCheckins(); });
  socket.on('message:read', ({id, readAt})=>{
    const m = messages.find(x=>x.id===id);
    if(m){ m.readAt = readAt; if(currentScreen==='chat') paintMessages(); }
  });
}
let expenses = [];
function upsertExpense(e){
  const idx = expenses.findIndex(x=>x.id===e.id);
  if(idx>=0) expenses[idx] = e; else expenses.push(e);
}
function upsertEvent(e){
  const idx = events.findIndex(x=>x.id===e.id);
  if(idx>=0) events[idx] = e; else events.push(e);
}
// carga la ventana "en vivo" (los últimos ~50) al entrar al canal —
// reemplaza lo que hubiera antes, es siempre el punto de partida.
async function loadMessages(){
  const res = await api(`/api/channels/${channelCode}/messages`);
  messages = res.messages;
  hasMoreHistory = res.hasMore;
}

// trae la página anterior a la más vieja que ya está cargada y la agrega
// adelante — se llama al tocar "Cargar mensajes anteriores" arriba del chat.
// Mantiene la posición de scroll: sin esto, agregar contenido arriba hace
// que la pantalla "salte" porque el navegador no sabe que hay que compensar.
async function loadMoreMessages(){
  if(loadingMoreHistory || !hasMoreHistory || !messages.length) return;
  loadingMoreHistory = true;
  // se actualiza el botón directo (sin un paintMessages() completo acá):
  // un repaint entero fuerza el scroll al final del chat, justo lo
  // contrario de lo que se quiere mientras se está mirando historial viejo.
  const loadMoreBtn = document.getElementById('load-more-btn');
  if(loadMoreBtn){ loadMoreBtn.textContent = 'Cargando…'; loadMoreBtn.disabled = true; }
  const log = document.getElementById('chat-log');
  const oldest = messages[0].createdAt;
  const prevScrollHeight = log ? log.scrollHeight : 0;
  try{
    const res = await api(`/api/channels/${channelCode}/messages?before=${oldest}`);
    const newOnes = res.messages.filter(m => !messages.find(x => x.id === m.id));
    messages = [...newOnes, ...messages];
    hasMoreHistory = res.hasMore;
  }catch(e){ /* si falla, el botón sigue disponible para reintentar */ }
  loadingMoreHistory = false;
  paintMessages();
  if(log) log.scrollTop = log.scrollHeight - prevScrollHeight;
}

// se llama al reconectar el socket después de un corte — trae de nuevo la
// ventana "en vivo" desde el servidor (fuente de verdad) y suma lo que
// falte, así ningún mensaje que haya llegado durante el corte queda
// invisible hasta que alguien recargue la página a mano.
async function resyncMessages(){
  if(!channelCode) return;
  try{
    const res = await api(`/api/channels/${channelCode}/messages`);
    let added = false;
    res.messages.forEach(m => {
      if(!messages.find(x => x.id === m.id)){ messages.push(m); added = true; }
    });
    if(added) messages.sort((a, b) => a.createdAt - b.createdAt);
    // ojo: no se toca hasMoreHistory acá — resincroniza solo la punta
    // "en vivo", no reemplaza el estado de la paginación hacia atrás.
    if(currentScreen === 'chat') paintMessages();
    updateNavBadges();
  }catch(e){ /* se reintenta solo en el próximo reconnect */ }
}
async function loadEvents(){ events = await api(`/api/channels/${channelCode}/events`); }
async function loadExpenses(){ try{ expenses = await api(`/api/channels/${channelCode}/expenses`); }catch(e){ expenses = []; } }
async function loadCheckins(){
  try{
    const list = await api(`/api/channels/${channelCode}/checkins`);
    const el = document.getElementById('checkins-list');
    if(!el) return;
    el.innerHTML = list.length
      ? list.slice(0,5).map(c => `<div class="hist-item"><div class="txt">${escapeHtml(c.user ? c.user.name : '—')} confirmó su llegada</div><div class="ts">${fmtTs(c.createdAt)}</div></div>`).join('')
      : `<p class="empty-hint">Todavía no hay check-ins registrados.</p>`;
  }catch(e){ /* la sección de check-ins simplemente no se actualiza si falla */ }
}

function updateUrl(code){
  const url = new URL(location.href);
  url.searchParams.set('channel', code);
  history.pushState({}, '', url);
}

// ==================================================================
// NAV — dos niveles: global (Inicio/Borrador/Nuevo·Unirme, siempre visible)
// y contextual (Chat/Calendario/Gastos/Historial/Asistente/Config, solo
// visible dentro de un caso elegido). Ver NAV-RESTRUCTURE-para-claude-code.md.
// ==================================================================
const CONTEXTUAL_SCREENS = ['chat', 'calendario', 'gastos', 'historial', 'asistente', 'config'];

function goTo(name){
  // pantalla contextual sin ningún caso cargado (ej. alguien llega directo
  // por bookmark a un estado raro) — no tiene sentido, volvemos a Inicio.
  if(CONTEXTUAL_SCREENS.includes(name) && !channelCode) name = 'inicio';

  closeCaseSwitcher();

  currentScreen = name;
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  document.querySelectorAll('nav.tabs button').forEach(b=> b.classList.toggle('active', b.dataset.screen===name));
  document.querySelectorAll('.case-tabs-scroller button').forEach(b=> b.classList.toggle('active', b.dataset.screen===name));

  const caseTabs = document.getElementById('case-tabs');
  if(caseTabs) caseTabs.style.display = CONTEXTUAL_SCREENS.includes(name) ? 'flex' : 'none';
  if(CONTEXTUAL_SCREENS.includes(name)) renderCaseTabsInfo();

  if(name === 'inicio') renderInicio();
  if(name === 'config') renderConfig();
  if(name === 'chat'){ renderChatScreen(); renderCaseSummary(); seen.msgCount = messages.length; updateNavBadges(); }
  if(name === 'calendario'){ renderCalendario(); seen.evCount = events.length; updateNavBadges(); }
  if(name === 'gastos') renderGastos();
  if(name === 'historial') renderHistorial();
  if(name === 'asistente') renderAsistenteScreen();
  if(name === 'borrador') renderBorrador();

  if(name === 'inicio' && document.getElementById('dot-inicio')) document.getElementById('dot-inicio').classList.remove('show');
}
function updateNavBadges(){
  const chatDot = document.getElementById('dot-chat');
  const calDot = document.getElementById('dot-calendario');
  if(chatDot) chatDot.classList.toggle('show', currentScreen!=='chat' && messages.length > seen.msgCount);
  if(calDot) calDot.classList.toggle('show', currentScreen!=='calendario' && events.length > seen.evCount);
}

// ------------------------------------------------------------------
// Badge de "hay novedades" en Inicio, agregado across TODOS los casos
// (no solo el que se está viendo) — se guarda por localStorage cuándo
// se visitó cada caso por última vez, y se compara contra su
// lastActivity real (que ya viene de /api/channels/mine).
// ------------------------------------------------------------------
function getLastVisited(code){
  try{ return Number(localStorage.getItem('pd_last_visited_' + code)) || 0; }catch(e){ return 0; }
}
function markVisited(code){
  try{ localStorage.setItem('pd_last_visited_' + code, String(Date.now())); }catch(e){ /* localStorage no disponible — el badge simplemente no persiste entre recargas */ }
}
function updateInicioDot(list){
  const hasNews = list.some(c => c.lastActivity > getLastVisited(c.code));
  const dot = document.getElementById('dot-inicio');
  if(dot) dot.classList.toggle('show', hasNews && currentScreen !== 'inicio');
}
async function refreshInicioBadge(){
  let list = [];
  try{ list = await api('/api/channels/mine'); }catch(e){ return list; }
  updateInicioDot(list);
  return list;
}

// ------------------------------------------------------------------
// Selector rápido de caso: tocar el nombre del caso actual (Nivel 2)
// despliega los otros casos sin tener que volver a Inicio.
// ------------------------------------------------------------------
let caseSwitcherOpen = false;
async function toggleCaseSwitcher(){
  caseSwitcherOpen = !caseSwitcherOpen;
  const el = document.getElementById('case-switcher');
  if(!caseSwitcherOpen){ el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let list;
  try{ list = await api('/api/channels/mine'); }catch(e){ el.innerHTML = `<p class="empty-hint">No se pudo cargar.</p>`; return; }
  const others = list.filter(c => c.code !== channelCode);
  el.innerHTML = others.length ? others.map(c => `
    <div class="card" style="margin-bottom:8px; cursor:pointer;" onclick="switchToCase('${c.code}')">
      <div class="row1">
        <div class="what" style="font-weight:600;">${escapeHtml(c.code)}</div>
        ${c.inactiveDays > 3 ? `<span class="ev-pill pendiente">sin actividad ${c.inactiveDays}d</span>` : ''}
      </div>
      <div class="who">${c.otherNames.length ? 'Con ' + c.otherNames.map(escapeHtml).join(', ') : 'Esperando a la otra parte'}</div>
    </div>
  `).join('') : `<p class="empty-hint">No tenés otros casos activos.</p>`;
}
function closeCaseSwitcher(){
  caseSwitcherOpen = false;
  const el = document.getElementById('case-switcher');
  if(el) el.style.display = 'none';
}
async function switchToCase(code){
  closeCaseSwitcher();
  await openCase(code);
}

// franja arriba de las 5 tabs contextuales: con quién es el caso y su
// código, para no perderse cuando hay varios casos activos — más el
// acceso a "Configurar caso" (antes mezclado con la pestaña "Canal").
function renderCaseTabsInfo(){
  const slot = document.getElementById('case-tabs-info');
  if(!slot || !channelInfo) return;
  const other = otherPartyOf(channelInfo);
  const withWhom = isProfessional()
    ? `${professionalRoleLabel(myRole)} · solo lectura`
    : (other && other.user) ? 'Con ' + escapeHtml(other.user.name) : 'Esperando a la otra parte';
  slot.innerHTML = `
    <button class="case-switch-btn" onclick="toggleCaseSwitcher()" title="Cambiar de caso">${withWhom} · ${escapeHtml(channelInfo.code)} <span class="caret">▾</span></button>
    <button class="gear-btn" onclick="goTo('config')" title="Configurar este caso">⚙</button>
  `;
}

function renderCaseSummary(){
  const slot = document.getElementById('case-summary-slot');
  if(!slot) return;
  if(!channelInfo){ slot.innerHTML = ''; return; }

  const summaryHtml = channelInfo.lastSummary ? `
    <div class="card">
      <div class="eyebrow">Resumen de la semana</div>
      <p style="font-size:13px; line-height:1.5;">${channelInfo.lastSummary.stats.messages} mensajes revisados · ${channelInfo.lastSummary.stats.flagged} marcados por el sistema · ${channelInfo.lastSummary.stats.confirmedEvents} acuerdos confirmados.</p>
    </div>
  ` : '';

  const upcoming = [...events]
    .filter(ev => ev.status !== 'rechazado')
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);
  const eventsHtml = upcoming.length ? `
    <div class="card">
      <div class="eyebrow">Tus próximos eventos</div>
      ${upcoming.map(ev => {
        const d = new Date(ev.date + 'T00:00:00');
        const dayLabel = d.toLocaleDateString('es-AR', {day:'2-digit', month:'short'}).replace('.','');
        return `<div class="mini-event"><span class="day">${dayLabel}</span><span class="what">${escapeHtml(ev.detail)}</span><span class="ev-pill ${ev.status}">${ev.status}</span></div>`;
      }).join('')}
      <button class="text-link" style="margin-top:8px;" onclick="goTo('calendario')">Ver calendario completo →</button>
    </div>
  ` : '';

  slot.innerHTML = summaryHtml + eventsHtml;
}

// ==================================================================
// SCREEN: CANAL
// ==================================================================
function roleLabelOf(m){
  if(m.role === 'A') return 'Parte A';
  if(m.role === 'B') return 'Parte B';
  return professionalRoleLabel(m.role) || m.role;
}

// contextual — gestión del caso ACTIVO: link para compartir, integrantes,
// invitar mediador/a o estudio. Se llega por el ⚙ de la barra de tabs
// contextual (antes era la pestaña global "Canal").
function renderConfig(){
  const el = document.getElementById('config-content');
  if(!channelInfo){ el.innerHTML = `<p class="empty-hint">Elegí un caso primero.</p>`; return; }

  const other = otherPartyOf(channelInfo);
  const shareUrl = location.origin + location.pathname + '?channel=' + channelInfo.code;
  const guestShareUrl = location.origin + location.pathname + '?guest=' + channelInfo.guestToken;

  const membersListHtml = channelInfo.members.map(m => `
    <div class="member-row">
      <span>${escapeHtml(m.user ? m.user.name : '—')}${m.label ? ' <span style="color:var(--text-faint)">· ' + escapeHtml(m.label) + '</span>' : ''}</span>
      <span class="ev-pill ${m.role === 'A' || m.role === 'B' ? 'confirmado' : 'pendiente'}">${roleLabelOf(m)}</span>
    </div>`).join('');
  const membersCard = `<div class="card"><div class="eyebrow">Integrantes del canal</div>${membersListHtml}</div>`;

  if(isProfessional()){
    const mine = channelInfo.members.find(m => m.user && m.user.id === me.id);
    el.innerHTML = `
      <div class="card">
        <div class="eyebrow">Tu acceso</div>
        <p style="font-size:13px; line-height:1.5;">Estás viendo el canal <strong>${channelInfo.code}</strong> como <strong>${professionalRoleLabel(myRole)}</strong>${mine && mine.label ? ' (' + escapeHtml(mine.label) + ')' : ''}. Es acceso de solo lectura: podés ver mensajes, calendario e historial, pero no escribir en nombre de las partes ni invitar a otras personas.</p>
      </div>
      ${membersCard}
    `;
    return;
  }

  const guestCard = (myRole === 'A' && channelInfo.guestToken) ? `
    <div class="card">
      <div class="eyebrow">Invitar por WhatsApp/SMS</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:10px;">Este enlace no requiere cuenta de Google ni instalar nada — quien lo abre puede leer y responder directo desde el navegador:</p>
      <div class="row-copy">
        <input type="text" readonly value="${guestShareUrl}" id="guest-share-url">
        <button class="ghost small" onclick="copyGuestShareUrl()">Copiar</button>
      </div>
    </div>
  ` : '';
  el.innerHTML = `
    <div class="card">
      <div class="eyebrow">Tu canal</div>
      <div class="code-display">${channelInfo.code}</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:10px;">Compartí este enlace, quien lo abra se une con su propia cuenta de Google:</p>
      <div class="row-copy" style="margin-bottom:12px;">
        <input type="text" readonly value="${shareUrl}" id="share-url">
        <button class="ghost small" onclick="copyShareUrl()">Copiar</button>
      </div>
      <div class="status-banner ${other && other.user ? 'ok' : 'warn'}"><span class="dot"></span>${other && other.user ? escapeHtml(other.user.name) + ' está en el canal' : 'Esperando a que se una'}</div>
      ${(!other?.user && (Date.now() - channelInfo.createdAt > 3*24*60*60*1000)) ? `
        <div class="status-banner warn" style="margin-top:8px;"><span class="dot"></span>Todavía nadie se unió — ¿le reenviás el link de arriba a la otra persona?</div>
      ` : ''}
    </div>
    ${guestCard}
    ${membersCard}
    <div class="card">
      <div class="eyebrow">Invitar a un mediador/a o estudio jurídico</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:12px;">Va a poder ver mensajes, calendario e historial, pero no escribir en tu nombre ni de la otra parte. Su ingreso queda anunciado en el chat y visible acá arriba, para las dos partes.</p>
      <label class="field-label">Rol</label>
      <select id="pro-invite-role" style="margin-bottom:10px;">
        <option value="mediador">Mediador/a</option>
        <option value="estudio">Estudio jurídico</option>
      </select>
      <label class="field-label">Nombre o estudio</label>
      <input type="text" id="pro-invite-label" placeholder="Ej: Estudio Pérez &amp; Asoc." style="margin-bottom:12px;">
      <button class="ghost" style="width:100%" onclick="inviteProfessional()">Generar invitación</button>
      <div id="pro-invite-result"></div>
    </div>
  `;
}

// global — crear un canal, unirse con un código, o vincularse a un caso
// existente como mediador/a o estudio jurídico (antes vivía en "Mis
// casos" — se movió acá porque las tres son formas de "entrar a un caso",
// no algo que dependa de haber uno activo).
// "Nuevo caso" es un modal, no una pantalla del nav — cancelarlo devuelve
// exactamente a donde se estaba, no fuerza una navegación a Inicio.
function openNuevoModal(){
  document.getElementById('nuevo-modal').classList.add('show');
  renderNuevo();
}
function closeNuevoModal(){
  document.getElementById('nuevo-modal').classList.remove('show');
}

function renderNuevo(){
  const el = document.getElementById('nuevo-content');
  el.innerHTML = `
    <div class="card">
      <div class="eyebrow">Crear un canal nuevo</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:12px;">Se crea con tu cuenta de Google (${escapeHtml(me.name)}).</p>
      <button class="primary" style="width:100%" onclick="createChannel()">Generar código</button>
    </div>
    <div class="card">
      <div class="eyebrow">Unirme con un código</div>
      <label class="field-label">Código del canal</label>
      <input type="text" id="join-code" placeholder="Ej: A3K9QZ" value="${pendingJoinCode || ''}" style="margin-bottom:14px; text-transform:uppercase;">
      <button class="ghost" style="width:100%" onclick="joinChannelUI()">Unirme</button>
      <p id="join-error" style="color:var(--danger); font-size:12px; margin-top:8px;"></p>
    </div>
    <div class="card">
      <div class="eyebrow">¿Sos mediador/a o estudio jurídico?</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:10px;">Si tenés un código o link de invitación a un caso, pegalo acá:</p>
      <div style="display:flex; gap:8px;">
        <input id="pro-link-input" type="text" placeholder="Código o link de invitación" style="flex:1;">
        <button class="ghost" onclick="linkProfessionalToken()" id="pro-link-btn">Vincular</button>
      </div>
      <div id="pro-link-result" style="margin-top:8px;"></div>
    </div>
  `;
}
async function inviteProfessional(){
  const role = document.getElementById('pro-invite-role').value;
  const label = document.getElementById('pro-invite-label').value.trim();
  const resultEl = document.getElementById('pro-invite-result');
  if(!label){ resultEl.innerHTML = `<p style="color:var(--danger); font-size:12px; margin-top:8px;">Completá el nombre o estudio.</p>`; return; }
  try{
    const res = await api(`/api/channels/${channelCode}/professionals/invite`, { method:'POST', body: JSON.stringify({ role, label }) });
    resultEl.innerHTML = `
      <div class="row-copy" style="margin-top:12px;">
        <input type="text" readonly value="${res.url}" id="pro-invite-url">
        <button class="ghost small" onclick="copyProInviteUrl()">Copiar</button>
      </div>
      <p class="field-hint">Compartíselo — va a tener que iniciar sesión con su propia cuenta de Google para entrar.</p>
    `;
  }catch(e){
    resultEl.innerHTML = `<p style="color:var(--danger); font-size:12px; margin-top:8px;">${e.error || 'No se pudo generar la invitación.'}</p>`;
  }
}
function copyProInviteUrl(){
  const el = document.getElementById('pro-invite-url');
  el.select();
  document.execCommand('copy');
}
function copyShareUrl(){
  const el = document.getElementById('share-url');
  el.select();
  document.execCommand('copy');
}
function copyGuestShareUrl(){
  const el = document.getElementById('guest-share-url');
  el.select();
  document.execCommand('copy');
}
async function createChannel(){
  try{
    channelInfo = await api('/api/channels', { method:'POST' });
    channelCode = channelInfo.code;
    myRole = 'A';
    calendarLinkCache = null;
    historialMessages = null; // canal nuevo/distinto — el Historial completo se vuelve a pedir la próxima vez que se abra
    updateUrl(channelCode);
    connectSocket();
    await Promise.all([loadMessages(), loadEvents(), loadExpenses()]);
    seen.msgCount = messages.length;
    seen.evCount = events.length;
    closeNuevoModal();
    goTo('config'); // recién creado, lo primero que hace falta es el link para compartir
  }catch(e){ alert('No se pudo crear el canal. Probá de nuevo.'); }
}
async function joinChannelUI(){
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const errEl = document.getElementById('join-error');
  errEl.textContent = '';
  if(!code){ errEl.textContent = 'Completá el código.'; return; }
  try{
    channelInfo = await api('/api/channels/join', { method:'POST', body: JSON.stringify({ code }) });
    channelCode = code;
    const mine = channelInfo.members.find(m => m.user && m.user.id === me.id);
    myRole = mine ? mine.role : null;
    calendarLinkCache = null;
    historialMessages = null; // canal nuevo/distinto — el Historial completo se vuelve a pedir la próxima vez que se abra
    updateUrl(channelCode);
    connectSocket();
    await Promise.all([loadMessages(), loadEvents(), loadExpenses()]);
    seen.msgCount = messages.length;
    seen.evCount = events.length;
    closeNuevoModal();
    goTo('chat'); // ya se unió a un canal existente, va directo a la conversación
  }catch(e){
    errEl.textContent = e.error || 'No se pudo unir al canal.';
  }
}

// ==================================================================
// SCREEN: CHAT
// ==================================================================
function chatGateHtml(){ return `<div class="empty-hint">Primero configurá tu canal en la pestaña "Canal".</div>`; }

function renderChatScreen(){
  const body = document.getElementById('chat-body');
  if(!channelInfo){ body.innerHTML = chatGateHtml(); return; }
  const other = otherPartyOf(channelInfo);
  const otherName = other && other.user ? other.user.name : 'la otra parte';
  document.getElementById('chat-title').textContent = isProfessional() ? 'Chat del canal' : 'Chat con ' + otherName;
  document.getElementById('chat-sub').textContent = isProfessional()
    ? `Estás viendo este canal como ${professionalRoleLabel(myRole).toLowerCase()} — acceso de solo lectura.`
    : (other && other.user)
      ? 'Canal activo. El sistema revisa antes de enviar.'
      : 'Todavía no se unió la otra persona — podés escribir igual, quedará registrado.';

  proposeFormOpen = false;
  proposeCounterFor = null;
  const composerHtml = isProfessional()
    ? `<div class="empty-hint" style="padding:14px 10px;">Como ${professionalRoleLabel(myRole).toLowerCase()} tenés acceso de lectura — no podés enviar mensajes en nombre de las partes.</div>`
    : `
      <div class="quick-templates" id="quick-templates">
        ${CHAT_TEMPLATES.map((t, i) => `<button class="chip" onclick="applyTemplate(${i})">${t.label}</button>`).join('')}
        <button class="chip chip-propose" onclick="toggleProposeForm()">📅 Proponer horario</button>
      </div>
      <div id="propose-form-slot"></div>
      <div class="composer">
        <textarea id="chat-input" placeholder="Escribí tu mensaje..."></textarea>
        <button class="primary" id="send-btn" onclick="handleSend()">Enviar</button>
      </div>`;
  body.innerHTML = `
    <div class="chat-wrap">
      <div class="chat-log" id="chat-log"></div>
      ${composerHtml}
    </div>
  `;
  const chatInput = document.getElementById('chat-input');
  if(chatInput){
    chatInput.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }
    });
  }
  paintMessages();
}

function applyTemplate(i){
  const ta = document.getElementById('chat-input');
  if(!ta) return;
  ta.value = CHAT_TEMPLATES[i].text;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function toggleProposeForm(){
  proposeFormOpen = !proposeFormOpen;
  renderProposeFormSlot();
}
function renderProposeFormSlot(){
  const slot = document.getElementById('propose-form-slot');
  if(!slot) return;
  slot.innerHTML = proposeFormOpen ? `
    <div class="propose-inline">
      <label class="field-label">Fecha</label>
      <input type="date" id="propose-date">
      <label class="field-label">Detalle</label>
      <input type="text" id="propose-detail" placeholder="Ej: La entrega se hará a las 08:30">
      ${repeatFieldsHtml('propose')}
      <div class="inline-form-actions">
        <button class="ghost small" onclick="toggleProposeForm()">Cancelar</button>
        <button class="primary" style="flex:1; padding:9px;" onclick="sendProposal()">Enviar propuesta</button>
      </div>
    </div>
  ` : '';
}

// campos de "Repetir" + "Hasta" compartidos entre el composer del chat y el
// formulario de Calendario — mismo id-prefix, misma lógica de mostrar/ocultar.
function repeatFieldsHtml(prefix){
  return `
    <label class="field-label">Repetir</label>
    <select id="${prefix}-repeat" onchange="toggleUntilField('${prefix}')">
      <option value="none">No repetir</option>
      <option value="weekly">Cada semana</option>
      <option value="biweekly">Cada 2 semanas</option>
      <option value="monthly">Cada mes</option>
    </select>
    <div id="${prefix}-until-wrap" style="display:none; margin-top:8px;">
      <label class="field-label">Repetir hasta</label>
      <input type="date" id="${prefix}-until">
      <p class="field-hint">Se crea una fecha por cada repetición (hasta 52).</p>
    </div>
  `;
}
function toggleUntilField(prefix){
  const repeat = document.getElementById(prefix + '-repeat').value;
  const wrap = document.getElementById(prefix + '-until-wrap');
  if(wrap) wrap.style.display = repeat === 'none' ? 'none' : 'block';
}

async function createProposal(date, detail, repeat, until){
  const body = { date, detail };
  if(repeat && repeat !== 'none' && until){ body.repeat = repeat; body.until = until; }
  const ev = await api(`/api/channels/${channelCode}/events`, { method:'POST', body: JSON.stringify(body) });
  upsertEvent(ev);
  seen.evCount = events.length;
  return ev;
}
async function sendProposal(){
  const date = document.getElementById('propose-date').value;
  const detail = document.getElementById('propose-detail').value.trim();
  const repeat = document.getElementById('propose-repeat').value;
  const until = document.getElementById('propose-until') ? document.getElementById('propose-until').value : '';
  if(!date || !detail) return;
  if(repeat !== 'none' && !until){ alert('Elegí hasta qué fecha se repite.'); return; }
  try{
    await createProposal(date, detail, repeat, until);
    proposeFormOpen = false;
    renderProposeFormSlot();
  }catch(e){ alert(e.error || 'No se pudo enviar la propuesta.'); }
}
function focusComposerReply(){
  const ta = document.getElementById('chat-input');
  if(ta) ta.focus();
}
function toggleCounterForm(eventId){
  proposeCounterFor = eventId;
  paintMessages();
}
async function submitCounterProposal(originalId){
  const date = document.getElementById('counter-date-' + originalId).value;
  const detail = document.getElementById('counter-detail-' + originalId).value.trim();
  if(!date || !detail) return;
  try{
    await respondEvent(originalId, 'rechazado');
    await createProposal(date, detail);
    proposeCounterFor = null;
    paintMessages();
  }catch(e){ alert('No se pudo enviar la contrapropuesta.'); }
}

function buildProposalCard(m){
  const ev = events.find(e => e.id === m.eventId);
  if(!ev){
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = m.text;
    return div;
  }
  const d = new Date(ev.date + 'T00:00:00');
  const dateLabel = d.toLocaleDateString('es-AR', {weekday:'short', day:'2-digit', month:'short'}).replace('.','');
  const mine = ev.requestedBy && ev.requestedBy.id === me.id;
  const iRespond = ev.status === 'pendiente' && !mine && !isProfessional();
  const showingCounter = proposeCounterFor === ev.id;

  let actionsHtml = '';
  if(ev.status === 'pendiente'){
    if(isProfessional()){
      actionsHtml = `<div class="proposal-wait">Pendiente de confirmación entre las partes.</div>`;
    } else if(showingCounter){
      actionsHtml = `
        <div class="counter-form">
          <input type="date" id="counter-date-${ev.id}" value="${ev.date}">
          <input type="text" id="counter-detail-${ev.id}" value="${escapeHtml(ev.detail)}">
          <div class="counter-actions">
            <button class="ghost small" onclick="toggleCounterForm(null)">Cancelar</button>
            <button class="primary" style="flex:1; padding:8px;" onclick="submitCounterProposal('${ev.id}')">Enviar</button>
          </div>
        </div>`;
    } else if(iRespond){
      const seriesBtns = ev.seriesId ? `
        <button class="text-link" onclick="respondSeries('${ev.seriesId}','confirmado')">Confirmar toda la serie</button>
        <button class="text-link" onclick="respondSeries('${ev.seriesId}','rechazado')">Rechazar toda la serie</button>` : '';
      actionsHtml = `
        <div class="proposal-actions">
          <button class="ghost small" onclick="respondEvent('${ev.id}','rechazado')">No</button>
          <button class="ghost small" onclick="toggleCounterForm('${ev.id}')">Proponer otro horario</button>
          <button class="primary" style="padding:7px 14px; font-size:12.5px;" onclick="respondEvent('${ev.id}','confirmado')">Sí</button>
        </div>
        <button class="text-link" onclick="focusComposerReply()">O escribir una respuesta</button>
        ${seriesBtns}`;
    } else {
      actionsHtml = `<div class="proposal-wait">Esperando respuesta de la otra parte…</div>`;
    }
  }

  const seriesCount = ev.seriesId ? events.filter(e => e.seriesId === ev.seriesId).length : 0;
  const seriesNote = ev.seriesId
    ? `<div class="proposal-series">🔁 Parte de una serie de ${seriesCount} fechas — mirá el Calendario para ver todas.</div>`
    : '';

  const card = document.createElement('div');
  card.className = 'proposal-card';
  card.innerHTML = `
    <div class="proposal-head"><span class="ic">📅</span>${mine ? 'Propusiste vos' : escapeHtml(ev.requestedBy ? ev.requestedBy.name : 'Propuesta')}<span class="ev-pill ${ev.status}">${ev.status}</span></div>
    <div class="proposal-detail">${escapeHtml(ev.detail)}</div>
    <div class="proposal-date">${dateLabel}</div>
    ${seriesNote}
    ${actionsHtml}
  `;
  return card;
}
async function respondSeries(seriesId, decision){
  const verb = decision === 'confirmado' ? 'confirmar' : 'rechazar';
  if(!confirm(`¿Seguro que querés ${verb} todas las fechas pendientes de esta serie?`)) return;
  try{
    await api(`/api/channels/${channelCode}/events/series/${seriesId}/respond`, { method:'POST', body: JSON.stringify({ decision }) });
    // las actualizaciones de cada fecha llegan por socket (event:update) y repintan solas
  }catch(e){ alert('No se pudo actualizar la serie.'); }
}

function paintMessages(){
  const log = document.getElementById('chat-log');
  if(!log) return;
  log.innerHTML = '';

  if(hasMoreHistory){
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'load-more-btn';
    loadMoreBtn.className = 'text-link';
    loadMoreBtn.style.cssText = 'align-self:center; margin-bottom:10px;';
    loadMoreBtn.textContent = 'Cargar mensajes anteriores';
    loadMoreBtn.onclick = loadMoreMessages;
    log.appendChild(loadMoreBtn);
  }

  messages.forEach((m, idx)=>{
    if(!m.sender){
      if(m.eventId){
        log.appendChild(buildProposalCard(m));
      } else {
        const div = document.createElement('div');
        div.className = 'msg system' + (m.pattern ? ' pattern' : '');
        div.textContent = (m.pattern ? '⚠ ' : '') + m.text;
        log.appendChild(div);
      }
    } else {
      const mine = m.sender.id === me.id;
      const div = document.createElement('div');
      div.className = 'msg ' + (mine ? 'me' : 'them');
      let inner = escapeHtml(m.text);
      // sin esto, un mediador/estudio viendo el canal no tiene forma de saber
      // quién escribió qué — para las partes sigue implícito (si no es "mío" es "de la otra parte").
      const senderLabel = isProfessional() ? escapeHtml(m.sender.name) + ' · ' : '';
      const readLabel = (mine && m.readAt) ? ' · Visto ' + fmtTs(m.readAt) : '';
      inner += '<div class="meta">' + senderLabel + fmtTs(m.createdAt) + (m.flagged ? ' · marcado por el sistema' : '') + readLabel + '</div>';
      if(m.flagged && m.reason && mine){
        inner += '<div class="flag-note">' + escapeHtml(m.reason) + '</div>';
      }
      if(!mine && !isProfessional()){
        inner += '<div><button class="neutral-btn" onclick="requestNeutralReading(' + idx + ', this)">Ver lectura neutral</button></div>';
        inner += '<div class="neutral-box" id="neutral-' + idx + '" style="display:none"></div>';
      }
      div.innerHTML = inner;
      log.appendChild(div);
    }
  });
  log.scrollTop = log.scrollHeight;
  markVisibleMessagesRead();
}

// marca como "visto" los mensajes ajenos que todavía no lo tenían — solo
// entre las partes (A/B); un mediador/a o estudio que mira el canal no
// genera un "visto" en nombre de nadie.
function markVisibleMessagesRead(){
  if(isProfessional()) return;
  messages
    .filter(m => m.sender && m.sender.id !== me.id && !m.readAt)
    .forEach(m => {
      api(`/api/channels/${channelCode}/messages/${m.id}/read`, { method:'POST' })
        .then(res => { m.readAt = res.readAt; })
        .catch(()=>{ /* si falla, se reintenta la próxima vez que se pinte el chat */ });
    });
}

async function requestNeutralReading(idx, btn){
  const box = document.getElementById('neutral-' + idx);
  const text = messages[idx].text;
  btn.textContent = 'Analizando…';
  btn.disabled = true;
  try{
    const result = await api(`/api/channels/${channelCode}/analyze`, { method:'POST', body: JSON.stringify({ text }) });
    box.style.display = 'block';
    box.innerHTML = (result.flagged && result.reformulation)
      ? '<div class="lab">Lectura neutral</div>' + escapeHtml(result.reformulation)
      : '<div class="lab">Lectura neutral</div>Este mensaje no muestra señales claras de conflicto — parece centrado en el tema práctico.';
  }catch(e){
    box.style.display = 'block';
    box.innerHTML = '<div class="lab">Lectura neutral</div>No se pudo analizar en este momento.';
  }
  btn.textContent = 'Ver lectura neutral';
  btn.disabled = false;
}

async function handleSend(){
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text) return;
  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;
  input.value = '';

  const log = document.getElementById('chat-log');
  const analyzing = document.createElement('div');
  analyzing.className = 'analyzing';
  analyzing.innerHTML = '<span class="spin"></span>revisando mensaje…';
  log.appendChild(analyzing);
  log.scrollTop = log.scrollHeight;

  let result;
  try{ result = await api(`/api/channels/${channelCode}/analyze`, { method:'POST', body: JSON.stringify({ text }) }); }
  catch(e){ result = { flagged:false }; }
  analyzing.remove();

  if(result.flagged && result.reformulation){
    showReformCard(text, result);
  } else {
    await commitMessage(text, false, null);
  }
  sendBtn.disabled = false;
}

function showReformCard(original, result){
  const log = document.getElementById('chat-log');
  const card = document.createElement('div');
  card.className = 'reform-card';
  card.innerHTML = `
    <div class="head">⚠ Mensaje señalado — ${escapeHtml(result.category || 'lenguaje que puede escalar el conflicto')}</div>
    <div class="reason">${escapeHtml(result.reason || '')}</div>
    <div class="block orig"><div class="lab">Tu mensaje original</div><div class="txt">${escapeHtml(original)}</div></div>
    <div class="block alt"><div class="lab">Alternativa sugerida</div><div class="txt">${escapeHtml(result.reformulation)}</div></div>
    <div class="actions">
      <button class="ghost" data-action="original">Enviar original igual</button>
      <button class="primary" data-action="alt">Usar alternativa</button>
    </div>
  `;
  card.querySelector('[data-action="alt"]').onclick = async ()=>{ card.remove(); await commitMessage(result.reformulation, true, result.reason); };
  card.querySelector('[data-action="original"]').onclick = async ()=>{ card.remove(); await commitMessage(original, true, 'Enviado sin cambios pese a la señal del sistema.'); };
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
}

async function commitMessage(text, flagged, reason){
  try{
    const msg = await api(`/api/channels/${channelCode}/messages`, {
      method:'POST', body: JSON.stringify({ text, flagged, reason }),
    });
    if(!messages.find(m=>m.id===msg.id)) messages.push(msg);
    paintMessages();
    seen.msgCount = messages.length;
  }catch(e){
    // el input ya se había vaciado en handleSend() antes de intentar el
    // envío (para que la UI se sienta ágil) — si esto falla, el texto no
    // puede quedar perdido, así que vuelve a la caja en vez de desaparecer.
    const input = document.getElementById('chat-input');
    if(input){
      input.value = text;
      input.focus();
    }
    alert('No se pudo enviar el mensaje — lo dejamos de nuevo en el cuadro de texto. Revisá tu conexión e intentá de nuevo.');
  }
}

// ==================================================================
// SCREEN: CALENDARIO
// ==================================================================
let calView = (() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() }; })();
let calSelectedDay = null; // 'YYYY-MM-DD' o null (sin filtro de día)
const MONTH_NAMES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DOW_LABELS = ['D','L','M','M','J','V','S'];

function changeCalendarMonth(delta){
  calView.month += delta;
  if(calView.month < 0){ calView.month = 11; calView.year--; }
  if(calView.month > 11){ calView.month = 0; calView.year++; }
  calSelectedDay = null;
  renderCalendario();
}
function selectCalendarDay(dateStr){
  calSelectedDay = (calSelectedDay === dateStr) ? null : dateStr;
  renderCalendario();
}

function buildCalendarGrid(){
  const { year, month } = calView;
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  const eventsByDay = {};
  events.forEach(ev => { (eventsByDay[ev.date] = eventsByDay[ev.date] || []).push(ev); });

  let cells = '';
  for(let i = 0; i < firstDow; i++) cells += `<div class="cal-day empty"></div>`;
  for(let day = 1; day <= daysInMonth; day++){
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayEvents = eventsByDay[dateStr] || [];
    const dots = dayEvents.slice(0, 3).map(ev => `<span class="dot ${ev.status}"></span>`).join('');
    const cls = ['cal-day'];
    if(dayEvents.length) cls.push('has-events');
    if(dateStr === todayStr) cls.push('today');
    if(dateStr === calSelectedDay) cls.push('selected');
    cells += `<div class="${cls.join(' ')}" ${dayEvents.length ? `onclick="selectCalendarDay('${dateStr}')"` : ''}>
      <span class="num">${day}</span>${dots ? `<span class="dots">${dots}</span>` : ''}
    </div>`;
  }

  return `
    <div class="cal-nav">
      <button class="ghost small" onclick="changeCalendarMonth(-1)" aria-label="Mes anterior">‹</button>
      <div class="cal-month-label">${MONTH_NAMES[month]} ${year}</div>
      <button class="ghost small" onclick="changeCalendarMonth(1)" aria-label="Mes siguiente">›</button>
    </div>
    <div class="cal-grid">
      ${DOW_LABELS.map(d => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
  `;
}

function renderCalendario(){
  const el = document.getElementById('calendario-content');
  if(!channelInfo){ el.innerHTML = `<div class="empty-hint">Primero configurá tu canal en la pestaña "Canal".</div>`; return; }

  const monthPrefix = `${calView.year}-${String(calView.month + 1).padStart(2, '0')}`;
  let inScope = events.filter(ev => ev.date.startsWith(monthPrefix));
  if(calSelectedDay) inScope = inScope.filter(ev => ev.date === calSelectedDay);
  const sorted = [...inScope].sort((a, b) => a.date.localeCompare(b.date));

  const listLabel = calSelectedDay
    ? `${new Date(calSelectedDay + 'T00:00:00').toLocaleDateString('es-AR', {day:'2-digit', month:'long'})} <button class="text-link" style="display:inline; margin-top:0;" onclick="selectCalendarDay(null)">(ver todo el mes)</button>`
    : `${MONTH_NAMES[calView.month]} ${calView.year}`;

  const listHtml = sorted.length
    ? sorted.map(ev=>{
        const d = new Date(ev.date + 'T00:00:00');
        const dayLabel = d.toLocaleDateString('es-AR', {day:'2-digit', month:'short'}).replace('.','');
        const needsMyConfirm = ev.status === 'pendiente' && ev.requestedBy && ev.requestedBy.id !== me.id && !isProfessional();
        const seriesBtns = (needsMyConfirm && ev.seriesId) ? `
            <button class="text-link" style="display:inline; margin:0 0 0 10px;" onclick="respondSeries('${ev.seriesId}','confirmado')">confirmar toda la serie</button>
            <button class="text-link" style="display:inline; margin:0 0 0 10px;" onclick="respondSeries('${ev.seriesId}','rechazado')">rechazar toda la serie</button>` : '';
        const confirmHtml = needsMyConfirm ? `<div class="confirm-actions">
            <button class="ghost small" onclick="respondEvent('${ev.id}','rechazado')">Rechazar</button>
            <button class="primary" style="padding:6px 12px; font-size:11.5px;" onclick="respondEvent('${ev.id}','confirmado')">Confirmar</button>
          </div>${seriesBtns}` : '';
        return `<div class="event-item">
          <div class="row1"><div class="day">${dayLabel}</div><div class="what">${escapeHtml(ev.detail)}${ev.seriesId ? ' <span class="series-tag" title="Parte de una serie recurrente">🔁</span>' : ''}</div><span class="ev-pill ${ev.status}">${ev.status}</span></div>
          <div class="who">Pedido por ${escapeHtml(ev.requestedBy ? ev.requestedBy.name : '—')}</div>
          ${confirmHtml}
        </div>`;
      }).join('')
    : `<p class="empty-hint" style="padding:8px 0;">Sin eventos ${calSelectedDay ? 'ese día' : 'este mes'}.</p>`;

  const requestFormHtml = isProfessional() ? '' : `
    <div class="card">
      <div class="eyebrow">Solicitar cambio de horario</div>
      <label class="field-label">Fecha</label>
      <input type="date" id="ev-date" style="margin-bottom:10px">
      <label class="field-label">Detalle</label>
      <input type="text" id="ev-detail" placeholder="Ej: Cambio de entrega a las 19hs" style="margin-bottom:12px">
      ${repeatFieldsHtml('ev')}
      <button class="primary" style="width:100%; margin-top:12px;" onclick="addEvent()">Enviar solicitud</button>
    </div>`;

  el.innerHTML = `
    <div class="card">${buildCalendarGrid()}</div>
    <div class="card"><div class="eyebrow">${listLabel}</div>${listHtml}</div>
    ${requestFormHtml}
    <div class="card">
      <div class="eyebrow">Sincronizar con tu calendario</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:12px; line-height:1.4;">Los horarios y entregas ya <strong>confirmados</strong> se agregan solos a tu calendario personal — no hace falta cargarlos dos veces. Es de solo lectura y se actualiza cada una hora aprox.</p>
      <div id="sync-actions" class="sync-actions">
        <button class="sync-link" onclick="setupCalendarSync()">🔗 Sincronizar calendario</button>
      </div>
    </div>
    ${isProfessional() ? '' : `
    <div class="card">
      <div class="eyebrow">Check-in de llegada</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:12px; line-height:1.4;">Confirmá tu llegada al punto de encuentro. Tu ubicación queda en el registro del canal, nunca se muestra como texto en el chat.</p>
      <button class="ghost" style="width:100%; margin-bottom:12px;" onclick="doCheckin()">📍 Confirmar llegada</button>
      <div class="eyebrow">Check-ins recientes</div>
      <div id="checkins-list"><p class="empty-hint">Cargando…</p></div>
    </div>`}
  `;
  if(!isProfessional()) loadCheckins();
}

function doCheckin(){
  if(!navigator.geolocation){ alert('Tu navegador no soporta geolocalización.'); return; }
  navigator.geolocation.getCurrentPosition(
    async (pos)=>{
      try{
        await api(`/api/channels/${channelCode}/checkins`, {
          method:'POST',
          body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        });
        loadCheckins();
      }catch(e){ alert(e.error || 'No se pudo registrar el check-in.'); }
    },
    (err)=>{
      if(err.code === err.PERMISSION_DENIED){
        alert('No se pudo confirmar la llegada: denegaste el permiso de ubicación. Podés habilitarlo desde la configuración del navegador si querés usar esta función.');
      } else {
        alert('No se pudo obtener tu ubicación. Probá de nuevo.');
      }
    },
    { timeout: 10000 }
  );
}

let calendarLinkCache = null;
async function setupCalendarSync(){
  const box = document.getElementById('sync-actions');
  box.innerHTML = `<div class="sync-link">Generando enlace…</div>`;
  try{
    if(!calendarLinkCache) calendarLinkCache = await api(`/api/channels/${channelCode}/calendar-link`);
    const { icsUrl, webcalUrl } = calendarLinkCache;
    box.innerHTML = `
      <a class="sync-link" href="${webcalUrl}"><span class="ic">🍎</span>Agregar en iPhone / Apple Calendar</a>
      <a class="sync-link" href="https://calendar.google.com/calendar/render?cid=${encodeURIComponent(icsUrl)}" target="_blank" rel="noopener"><span class="ic">📆</span>Agregar en Google Calendar</a>
      <button class="sync-link" onclick="copyCalendarLink()"><span class="ic">🔗</span>Copiar enlace (.ics)</button>
    `;
  }catch(e){
    box.innerHTML = `<div class="sync-link" style="color:var(--danger)">No se pudo generar el enlace. Probá de nuevo.</div>`;
  }
}
function copyCalendarLink(){
  if(!calendarLinkCache) return;
  navigator.clipboard.writeText(calendarLinkCache.icsUrl).then(()=>{
    const box = document.getElementById('sync-actions');
    const note = document.createElement('div');
    note.className = 'sync-link';
    note.style.color = 'var(--calm)';
    note.textContent = 'Copiado.';
    box.appendChild(note);
    setTimeout(()=> note.remove(), 2000);
  });
}

async function addEvent(){
  const date = document.getElementById('ev-date').value;
  const detail = document.getElementById('ev-detail').value.trim();
  const repeat = document.getElementById('ev-repeat').value;
  const until = document.getElementById('ev-until') ? document.getElementById('ev-until').value : '';
  if(!date || !detail) return;
  if(repeat !== 'none' && !until){ alert('Elegí hasta qué fecha se repite.'); return; }
  try{
    await createProposal(date, detail, repeat, until);
    renderCalendario();
  }catch(e){ alert(e.error || 'No se pudo guardar la solicitud.'); }
}
async function respondEvent(id, decision){
  try{
    const ev = await api(`/api/channels/${channelCode}/events/${id}/respond`, { method:'POST', body: JSON.stringify({ decision }) });
    upsertEvent(ev);
    renderCalendario();
    if(currentScreen==='chat') paintMessages();
  }catch(e){ alert('No se pudo registrar la respuesta.'); }
}

// ==================================================================
// SCREEN: GASTOS COMPARTIDOS
// ==================================================================
function renderGastos(){
  const el = document.getElementById('gastos-content');
  if(!channelInfo){ el.innerHTML = `<div class="empty-hint">Primero configurá tu canal en la pestaña "Canal".</div>`; return; }

  const sorted = [...expenses].sort((a,b)=> b.createdAt - a.createdAt);
  const confirmedTotal = expenses.filter(e=>e.status==='confirmado').reduce((s,e)=>s+e.amount,0);

  const listHtml = sorted.length
    ? sorted.map(e=>{
        const needsMyConfirm = e.status === 'pendiente' && e.requestedBy && e.requestedBy.id !== me.id && !isProfessional();
        const confirmHtml = needsMyConfirm ? `<div class="confirm-actions">
            <button class="ghost small" onclick="respondExpense('${e.id}','rechazado')">Rechazar</button>
            <button class="primary" style="padding:6px 12px; font-size:11.5px;" onclick="respondExpense('${e.id}','confirmado')">Confirmar</button>
          </div>` : '';
        return `<div class="event-item">
          <div class="row1"><div class="day">$${e.amount}</div><div class="what">${escapeHtml(e.description)}</div><span class="ev-pill ${e.status}">${e.status}</span></div>
          <div class="who">Pedido por ${escapeHtml(e.requestedBy ? e.requestedBy.name : '—')}</div>
          ${confirmHtml}
        </div>`;
      }).join('')
    : `<p class="empty-hint" style="padding:8px 0;">Todavía no hay gastos registrados.</p>`;

  const formHtml = isProfessional() ? '' : `
    <div class="card">
      <div class="eyebrow">Registrar un gasto</div>
      <label class="field-label">Monto</label>
      <input type="number" id="exp-amount" min="0" step="0.01" placeholder="Ej: 5000" style="margin-bottom:10px">
      <label class="field-label">Descripción</label>
      <input type="text" id="exp-desc" placeholder="Ej: Útiles escolares" style="margin-bottom:12px">
      <button class="primary" style="width:100%" onclick="addExpense()">Registrar</button>
    </div>`;

  el.innerHTML = `
    <div class="card"><div class="eyebrow">Total confirmado</div><p style="font-size:22px; font-weight:600;">$${confirmedTotal}</p></div>
    <div class="card">${listHtml}</div>
    ${formHtml}
  `;
}

async function addExpense(){
  const amount = Number(document.getElementById('exp-amount').value);
  const description = document.getElementById('exp-desc').value.trim();
  if(!amount || amount <= 0 || !description) { alert('Completá un monto válido y una descripción.'); return; }
  try{
    const e = await api(`/api/channels/${channelCode}/expenses`, { method:'POST', body: JSON.stringify({ amount, description }) });
    upsertExpense(e);
    renderGastos();
  }catch(err){ alert(err.error || 'No se pudo registrar el gasto.'); }
}
async function respondExpense(id, decision){
  try{
    const e = await api(`/api/channels/${channelCode}/expenses/${id}/respond`, { method:'POST', body: JSON.stringify({ decision }) });
    upsertExpense(e);
    renderGastos();
  }catch(err){ alert('No se pudo registrar la respuesta.'); }
}

// ==================================================================
// SCREEN: HISTORIAL
// ==================================================================
let historialQuery = '';
function filterHistorial(value){
  historialQuery = value;
  renderHistorial(true);
}
// Historial usa SU PROPIO registro completo (historialMessages), separado
// de `messages` (que ahora es solo la ventana en vivo paginada del chat) —
// esta pantalla promete ser el registro completo y buscable, así que no
// puede depender de cuánto historial haya cargado el chat en ese momento.
async function renderHistorial(keepFocus){
  const el = document.getElementById('historial-content');
  if(!channelInfo){ el.innerHTML = `<div class="empty-hint">Primero configurá tu canal en la pestaña "Canal".</div>`; return; }

  if(historialMessages === null){
    el.innerHTML = `<p class="empty-hint">Cargando historial…</p>`;
    const requestedChannel = channelCode;
    try{
      const res = await api(`/api/channels/${channelCode}/messages?all=1`);
      if(requestedChannel !== channelCode) return; // cambió de canal mientras cargaba — no pisar el estado del canal nuevo
      historialMessages = res.messages;
    }catch(e){
      el.innerHTML = `<p class="empty-hint">No se pudo cargar el historial.</p>`;
      return;
    }
  }

  const q = historialQuery.trim().toLowerCase();
  const items = historialMessages.filter(m => (m.sender || m.pattern) && (!q || m.text.toLowerCase().includes(q)));
  const listHtml = items.length
    ? items.map(m=>{
        if(!m.sender && m.pattern){
          return `<div class="hist-item"><div class="txt" style="color:var(--warn)">⚠ ${escapeHtml(m.text)}</div><div class="ts">${fmtTs(m.createdAt)}</div></div>`;
        }
        const who = m.sender.id === me.id ? me.name : m.sender.name;
        return `<div class="hist-item">
          <div class="top"><span class="who">${escapeHtml(who)}</span><span class="ts">${fmtTs(m.createdAt)}</span></div>
          <div class="txt">${escapeHtml(m.text)}</div>
          ${m.flagged ? '<span class="flag">Intervención IA</span>' : ''}
        </div>`;
      }).join('')
    : `<p class="empty-hint">${q ? 'Sin resultados para "' + escapeHtml(historialQuery) + '".' : 'Todavía no hay mensajes registrados.'}</p>`;

  const notesHtml = isProfessional() ? `
    <div class="card" id="case-notes-card" style="margin-top:12px;">
      <div class="eyebrow">Notas privadas del caso</div>
      <p style="font-size:12px; color:var(--text-dim); margin-bottom:10px;">Solo las ven mediador/a, estudio jurídico o administración — nunca las partes.</p>
      <div id="case-notes-list"><p class="empty-hint">Cargando notas…</p></div>
      <textarea id="case-note-input" placeholder="Escribí una nota…" style="width:100%; min-height:70px; margin-top:10px; background:var(--surface-2); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:10px; font-family:var(--sans); font-size:13px;"></textarea>
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="addCaseNote()">Agregar nota</button>
    </div>
  ` : '';

  el.innerHTML = `
    <input type="text" id="historial-search" placeholder="Buscar en el historial…" value="${escapeHtml(historialQuery)}" oninput="filterHistorial(this.value)" style="width:100%; margin-bottom:12px; background:var(--surface-2); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--sans); font-size:13.5px;">
    <div class="card">${listHtml}</div>
    <button class="ghost" style="width:100%; margin-top:12px;" onclick="exportReport()">Descargar informe (.txt)</button>
    <button class="ghost" style="width:100%; margin-top:8px;" onclick="exportCertifiedReport()">Descargar informe certificado (PDF)</button>
    <div class="empty-hint" style="margin-top:4px; text-align:center;">Incluye un código QR para verificar su autenticidad</div>
    ${notesHtml}
  `;
  if(keepFocus){
    const input = document.getElementById('historial-search');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  if(isProfessional()) loadCaseNotes();
}
function exportReport(){
  window.location.href = `/api/channels/${channelCode}/export`;
}
function exportCertifiedReport(){
  window.location.href = `/api/channels/${channelCode}/export/certified`;
}

async function loadCaseNotes(){
  const el = document.getElementById('case-notes-list');
  try{
    const notes = await api(`/api/channels/${channelCode}/notes`);
    el.innerHTML = notes.length
      ? notes.map(n => `
          <div class="hist-item">
            <div class="top"><span class="who">${escapeHtml(n.author ? n.author.name : '—')}</span><span class="ts">${fmtTs(n.createdAt)}</span></div>
            <div class="txt">${escapeHtml(n.text)}</div>
          </div>`).join('')
      : `<p class="empty-hint">Todavía no hay notas en este caso.</p>`;
  }catch(e){
    el.innerHTML = `<p class="empty-hint">No se pudieron cargar las notas.</p>`;
  }
}
async function addCaseNote(){
  const input = document.getElementById('case-note-input');
  const text = input.value.trim();
  if(!text) return;
  try{
    await api(`/api/channels/${channelCode}/notes`, { method:'POST', body: JSON.stringify({ text }) });
    input.value = '';
    loadCaseNotes();
  }catch(e){
    alert(e.error || 'No se pudo guardar la nota.');
  }
}

// ==================================================================
// SCREEN: ASISTENTE
// ==================================================================
const ASSISTANT_QUICK_QUESTIONS = [
  '¿Qué pasó esta semana?',
  '¿Cuál es el próximo evento confirmado?',
  '¿Hay algo pendiente de mi confirmación?',
  'Hacé un resumen del último mes',
];
let assistantLog = []; // { question, answer, pending, error }

function renderAsistenteScreen(){
  const body = document.getElementById('asistente-body');
  if(!channelInfo){ body.innerHTML = chatGateHtml(); return; }
  body.innerHTML = `
    <div class="chat-wrap">
      <div class="chat-log" id="assistant-log"></div>
      <div class="quick-templates">
        ${ASSISTANT_QUICK_QUESTIONS.map((q, i) => `<button class="chip" onclick="askAssistantQuick(${i})">${escapeHtml(q)}</button>`).join('')}
      </div>
      <div class="composer">
        <textarea id="assistant-input" placeholder="Preguntá algo sobre este canal..."></textarea>
        <button class="primary" id="assistant-send-btn" onclick="handleAskAssistant()">Preguntar</button>
      </div>
    </div>
  `;
  document.getElementById('assistant-input').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); handleAskAssistant(); }
  });
  paintAssistantLog();
}

function askAssistantQuick(i){
  document.getElementById('assistant-input').value = ASSISTANT_QUICK_QUESTIONS[i];
  handleAskAssistant();
}

function paintAssistantLog(){
  const log = document.getElementById('assistant-log');
  if(!log) return;
  log.innerHTML = '';
  if(!assistantLog.length){
    log.innerHTML = `<p class="empty-hint">Todavía no le preguntaste nada. Probá con alguna de las opciones de abajo, o escribí tu propia pregunta.</p>`;
    return;
  }
  assistantLog.forEach(item=>{
    const q = document.createElement('div');
    q.className = 'msg me';
    q.textContent = item.question;
    log.appendChild(q);

    const a = document.createElement('div');
    a.className = 'msg them';
    if(item.pending){
      a.innerHTML = `<span class="analyzing" style="padding:0;"><span class="spin"></span>pensando…</span>`;
    } else if(item.error){
      a.innerHTML = `<span style="color:var(--danger)">${escapeHtml(item.error)}</span>`;
    } else {
      a.textContent = item.answer;
    }
    log.appendChild(a);
  });
  log.scrollTop = log.scrollHeight;
}

async function handleAskAssistant(){
  const input = document.getElementById('assistant-input');
  const question = input.value.trim();
  if(!question) return;
  input.value = '';
  const sendBtn = document.getElementById('assistant-send-btn');
  sendBtn.disabled = true;

  const entry = { question, answer: '', pending: true };
  assistantLog.push(entry);
  paintAssistantLog();

  try{
    const res = await api(`/api/channels/${channelCode}/assistant`, { method:'POST', body: JSON.stringify({ question }) });
    entry.answer = res.answer;
  }catch(e){
    entry.error = e.error || 'No se pudo consultar al asistente. Probá de nuevo en un momento.';
  }
  entry.pending = false;
  paintAssistantLog();
  sendBtn.disabled = false;
}

// tarjeta de Inicio (sin casos todavía) según el estado real de
// autoregistro como profesional — mismos tres estados que renderProSignup(),
// pero acá se ve en CUALQUIER login posterior, no solo el primero.
function renderProStatusCard(proStatus){
  if(proStatus && proStatus.verifiedProfessional){
    return `
      <div class="card">
        <div class="eyebrow">Profesional verificado</div>
        <p style="font-size:13px; line-height:1.5;">Ya sos profesional verificado en Puente Digital (${escapeHtml(proStatus.verifiedProfessionalRole === 'estudio' ? 'estudio jurídico' : 'mediador/a')} — ${escapeHtml(proStatus.verifiedProfessionalOrg || '')}). Todavía no tenés ningún caso asignado — te suman a uno cuando una parte te invita, o podés vincularte con un código de invitación.</p>
      </div>
    `;
  }
  if(proStatus && proStatus.application && proStatus.application.status === 'pending'){
    return `
      <div class="card" style="border-color:var(--warn);">
        <div class="eyebrow" style="color:var(--warn);">Solicitud en revisión</div>
        <p style="font-size:13px; line-height:1.5;">Tu solicitud como ${escapeHtml(proStatus.application.roleLabel)} (${escapeHtml(proStatus.application.orgName)}) está en revisión. Te avisamos apenas la veamos — mientras tanto, si ya tenés un código de invitación a un caso, lo podés cargar más abajo.</p>
      </div>
    `;
  }
  if(proStatus && proStatus.application && proStatus.application.status === 'rejected'){
    return `
      <div class="card" style="border-color:var(--danger);">
        <div class="eyebrow" style="color:var(--danger);">Solicitud no aprobada</div>
        <p style="font-size:13px; line-height:1.5;">Tu solicitud anterior como ${escapeHtml(proStatus.application.roleLabel)} (${escapeHtml(proStatus.application.orgName)}) no fue aprobada. Escribinos por WhatsApp si querés más información o volver a intentarlo.</p>
      </div>
    `;
  }
  // sin ninguna solicitud (la mayoría: alguien que recién llega) — el pitch de siempre
  return `
    <div class="hero-demo">
      <div class="eyebrow">Así funciona</div>
      <div class="bubble original"><div class="bubble-label">Mensaje original</div>Otra vez llegás tarde. Sos un desastre y nunca te importa nuestro hijo.</div>
      <div class="bubble suggested"><div class="bubble-label">Alternativa sugerida por la IA</div>Hoy la entrega se realizó 25 minutos después del horario acordado. ¿Podemos confirmar el horario para la próxima entrega?</div>
    </div>
  `;
}

// ==================================================================
// SCREEN: INICIO (= lista de casos, antes "Mis casos" era una pestaña
// aparte — ver NAV-RESTRUCTURE-para-claude-code.md). Tocar un caso lleva
// al nivel 2 (Chat/Calendario/Gastos/Historial/Asistente de ESE caso).
// ==================================================================
async function renderInicio(){
  const el = document.getElementById('inicio-content');
  el.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let list;
  try{ list = await api('/api/channels/mine'); }
  catch(e){ el.innerHTML = `<p class="empty-hint">No se pudieron cargar tus casos.</p>`; return; }
  updateInicioDot(list); // reusa este mismo fetch en vez de pedirlo de nuevo

  if(!list.length){
    // sin casos, puede ser por dos motivos bien distintos: alguien que
    // recién llega (le sirve el pitch de siempre) o un/a profesional que ya
    // se autoregistró y está esperando aprobación — para ese segundo caso,
    // el pitch genérico ("Crear o unirme a un caso") es activamente
    // confuso: ya hizo algo, y esto le dice "empezá de cero". Antes solo se
    // avisaba el estado de la solicitud una única vez, justo al volver del
    // login de Google con ?proSignup=1 — cualquier entrada posterior caía
    // acá sin ningún rastro de que había una solicitud en curso.
    let proStatus = null;
    try{ proStatus = await api('/api/professionals/me'); }catch(e){ /* si falla, se muestra el pitch genérico igual */ }

    el.innerHTML = `
      ${renderProStatusCard(proStatus)}
      <p class="empty-hint">Todavía no sos parte de ningún caso.</p>
      <button class="primary" style="width:100%" onclick="openNuevoModal()">Crear o unirme a un caso</button>
      <p class="disclaimer">Esta app no reemplaza a un abogado, mediador, terapeuta o a la Justicia. En situaciones de violencia o riesgo, contactá a las autoridades correspondientes o a la línea 144 / 137.</p>
    `;
    return;
  }

  const inactive = list.filter(c => c.inactiveDays > 3).length;
  const flaggedTotal = list.reduce((sum, c) => sum + (c.flaggedThisMonth || 0), 0);

  const statsHtml = `
    <div class="card" style="margin-bottom:14px; display:flex; gap:18px; flex-wrap:wrap; font-size:12.5px; color:var(--text-dim);">
      <div><span style="font-size:18px; font-weight:700; color:var(--text);">${list.length}</span><br>caso${list.length === 1 ? '' : 's'}</div>
      <div><span style="font-size:18px; font-weight:700; color:${inactive ? 'var(--warn)' : 'var(--text)'};">${inactive}</span><br>sin actividad hace +3 días</div>
      <div><span style="font-size:18px; font-weight:700; color:var(--text);">${flaggedTotal}</span><br>mensajes moderados este mes</div>
    </div>
  `;

  const listHtml = list.map(c => `
    <div class="card" style="margin-bottom:10px; cursor:pointer;" onclick="openCase('${c.code}')">
      <div class="row1">
        <div class="what" style="font-weight:600;">${escapeHtml(c.code)}</div>
        <div style="display:flex; gap:6px;">
          ${c.inactiveDays > 3 ? `<span class="ev-pill pendiente">sin actividad hace ${c.inactiveDays}d</span>` : ''}
          <span class="ev-pill confirmado">${escapeHtml(c.myRoleLabel)}</span>
        </div>
      </div>
      <div class="who">${c.otherNames.length ? 'Con ' + c.otherNames.map(escapeHtml).join(', ') : 'Esperando a la otra parte'}</div>
      <div class="ts" style="margin-top:6px;">${c.messageCount} mensajes · última actividad ${fmtTs(c.lastActivity)}</div>
    </div>
  `).join('');

  el.innerHTML = statsHtml + listHtml;
}

// extrae el token de invitación tanto si pegaron la URL completa
// (https://.../?pro=XXXX) como si pegaron solo el token pelado
function extractProToken(raw){
  const s = (raw || '').trim();
  if(!s) return null;
  try{
    const u = new URL(s, location.origin);
    const t = u.searchParams.get('pro');
    if(t) return t;
  }catch(e){ /* no era una URL completa, asumimos que ya es el token */ }
  return s;
}

async function linkProfessionalToken(){
  const input = document.getElementById('pro-link-input');
  const resultEl = document.getElementById('pro-link-result');
  const btn = document.getElementById('pro-link-btn');
  const token = extractProToken(input.value);
  if(!token) return;

  btn.disabled = true;
  resultEl.innerHTML = '';
  try{
    const info = await api(`/api/channels/professional/${encodeURIComponent(token)}`);
    if(info.used){
      resultEl.innerHTML = `<p class="empty-hint" style="color:var(--danger)">Esta invitación ya fue utilizada.</p>`;
      btn.disabled = false;
      return;
    }
    const accepted = await api(`/api/channels/professional/${encodeURIComponent(token)}/accept`, { method:'POST' });
    input.value = '';
    closeNuevoModal();
    await openCase(accepted.code);
  }catch(e){
    resultEl.innerHTML = `<p class="empty-hint" style="color:var(--danger)">${escapeHtml(e.error || 'No se pudo procesar la invitación.')}</p>`;
  }
  btn.disabled = false;
}

// ==================================================================
// COPIAR TEXTO — clipboard API con fallback tipo el que ya usa
// copyShareUrl() (execCommand sobre un elemento temporal), para navegadores
// o contextos (ej. http sin TLS en dev) donde navigator.clipboard no está.
// ==================================================================
async function copyText(text, btn){
  const original = btn ? btn.textContent : null;
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error('sin clipboard API');
    }
  }catch(e){
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand('copy'); }catch(e2){ /* último recurso agotado, no hay más fallback */ }
    document.body.removeChild(ta);
  }
  if(btn){
    btn.textContent = 'Copiado ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }
}

// ==================================================================
// TAREA A — BORRADOR PRIVADO (sin canal, sin login de "compartir", nada se guarda)
// ==================================================================
function renderBorrador(){
  const el = document.getElementById('borrador-content');
  el.innerHTML = `
    <div class="card">
      <textarea id="draft-input" placeholder="Escribí el mensaje que le querés mandar a la otra persona…" style="min-height:100px; margin-bottom:10px;"></textarea>
      <button class="primary" style="width:100%" onclick="runDraftAnalyze()" id="draft-btn">Revisar</button>
      <div id="draft-result" style="margin-top:12px;"></div>
    </div>
  `;
}

async function runDraftAnalyze(){
  const input = document.getElementById('draft-input');
  const text = input.value.trim();
  const resultEl = document.getElementById('draft-result');
  const btn = document.getElementById('draft-btn');
  if(!text) return;
  btn.disabled = true;
  btn.textContent = 'Revisando…';
  try{
    const result = await api('/api/draft/analyze', { method:'POST', body: JSON.stringify({ text }) });
    resultEl.innerHTML = renderAnalysisResult(text, result, 'draft-result');
  }catch(e){
    resultEl.innerHTML = renderAnalysisError(e);
  }
  btn.disabled = false;
  btn.textContent = 'Revisar';
}

// (e.status === 429): límite real (cuota mensual o rate limit) — es
// información útil y accionable, se muestra tal cual manda el backend.
// Cualquier otro fallo (sin crédito de la cuenta, error de red, etc.) no es
// algo que el usuario pueda resolver — un tono neutral evita alarmar por
// algo que no depende de él.
function renderAnalysisError(e){
  if(e.status === 429){
    return `<p class="empty-hint" style="color:var(--warn)">${escapeHtml(e.error || 'Llegaste al límite por ahora — probá de nuevo más tarde.')}</p>`;
  }
  return `<p class="empty-hint">La revisión automática no está disponible en este momento. Tu mensaje no se modificó — podés probar de nuevo en un rato.</p>`;
}

// compartido entre el borrador (Tarea A) y la demo pública (Tarea B) — mismo
// shape de respuesta {flagged, category, reason, reformulation}, mismo layout.
function renderAnalysisResult(original, result, scopeId){
  if(!result.flagged){
    return `<p class="empty-hint">Este mensaje no muestra señales de conflicto.</p>`;
  }
  const idOrig = scopeId + '-orig-btn';
  const idRef = scopeId + '-ref-btn';
  return `
    <div class="reform-card">
      <div class="block orig">
        <div class="bubble-label">Mensaje original</div>
        <div class="txt">${escapeHtml(original)}</div>
        <button class="ghost small" id="${idOrig}" onclick="copyText(${JSON.stringify(original)}, document.getElementById('${idOrig}'))" style="margin-top:6px;">Copiar</button>
      </div>
      <div class="block alt" style="margin-top:10px;">
        <div class="bubble-label">Alternativa sugerida (${escapeHtml(result.category || 'lenguaje conflictivo')})</div>
        <div class="txt">${escapeHtml(result.reformulation)}</div>
        <button class="ghost small" id="${idRef}" onclick="copyText(${JSON.stringify(result.reformulation)}, document.getElementById('${idRef}'))" style="margin-top:6px;">Copiar</button>
      </div>
      <p style="font-size:11.5px; color:var(--text-faint); margin-top:8px;">${escapeHtml(result.reason || '')}</p>
    </div>
  `;
}

// ==================================================================
// TAREA B — DEMO PÚBLICA (login-screen, sin sesión)
// ==================================================================
async function runDemo(){
  const input = document.getElementById('demo-input');
  const text = input.value.trim();
  const resultEl = document.getElementById('demo-result');
  const btn = document.getElementById('demo-btn');
  if(!text) return;
  btn.disabled = true;
  btn.textContent = 'Revisando…';
  try{
    const resp = await fetch('/api/draft/demo', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if(!resp.ok) throw { status: resp.status, ...data };
    resultEl.innerHTML = renderAnalysisResult(text, data, 'demo-result');
  }catch(e){
    resultEl.innerHTML = renderAnalysisError(e);
  }
  btn.disabled = false;
  btn.textContent = 'Revisar mensaje';
}
