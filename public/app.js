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
let peerPresence = {};   // userId -> { online: bool, lastSeenAt: ms|null } — en memoria, se resetea al recargar la página
let peerTyping = {};     // userId -> bool
let typingActive = false; // si ya avisé "estoy escribiendo" en esta tanda, para no emitir en cada tecla
let replyingTo = null;   // { id, senderName, text } del mensaje al que se está por responder, o null — se limpia al enviar o cancelar

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
// solo hora — para la hora chica dentro de cada burbuja del chat, donde
// la fecha ya la da el separador de día (ver dateSeparatorLabel), no
// hace falta repetirla mensaje por mensaje como sí hace fmtTs().
function fmtTimeOnly(iso){ return new Date(iso).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' }); }
// clave de día en horario local (no un slice de ISO en UTC) — dos
// mensajes cerca de medianoche en zona horaria local tienen que quedar
// en el separador correcto, no el de UTC.
function dayKeyOf(ts){ const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
function dateSeparatorLabel(ts){
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if(diffDays === 0) return 'Hoy';
  if(diffDays === 1) return 'Ayer';
  const label = d.toLocaleDateString('es-AR', { day:'numeric', month:'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  return label.charAt(0).toUpperCase() + label.slice(1);
}
// tildes estilo WhatsApp: un tilde gris = enviado, doble tilde celeste =
// leído. No hay un estado "entregado" separado de "leído" en esta app
// (solo se sabe si se mandó y si readAt quedó marcado), así que no se
// inventa un tercer estado que no existe de verdad.
// insignia de "profesional verificado" — mismo celeste que el tilde de
// leído (--wa-tick-read), la idea es que se lea como "esto está
// confirmado por la plataforma", el mismo lenguaje visual que ya
// entiende cualquiera que use WhatsApp (el check azul de WhatsApp
// Business). currentColor + una clase con el color, no un fill fijo,
// para no tener que duplicar el valor del color acá.
function verifiedBadgeHtml(){
  return '<svg class="verified-badge" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M4.5 8.2l2.2 2.2L11.5 5.6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function msgTicksHtml(mine, readAt){
  if(!mine) return '';
  // recíproco, igual que WhatsApp: si YO apagué "confirmaciones de
  // lectura" (ver #app-settings-modal), no veo el "leído" de nadie
  // tampoco, aunque el server sí haya guardado un readAt de antes de
  // apagarlo — es la misma regla del otro lado (routes/channels.js).
  if(me && me.readReceiptsEnabled === false){
    return `<span class="ticks" title="Enviado"><svg viewBox="0 0 12 11" width="11" height="10.5" fill="none"><path d="M1 5.3L4.4 8.7L10.8 1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }
  if(readAt){
    return `<span class="ticks read" title="Visto ${fmtTs(readAt)}"><svg viewBox="0 0 16 11" width="15" height="10.5" fill="none"><path d="M1 5.3L4.4 8.7L10.8 1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.3 5.3L8.7 8.7L15.1 1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }
  return `<span class="ticks" title="Enviado"><svg viewBox="0 0 12 11" width="11" height="10.5" fill="none"><path d="M1 5.3L4.4 8.7L10.8 1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}
function fmtRelative(ms){
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if(diffMin < 1) return 'hace un momento';
  if(diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if(diffH < 24) return `hace ${diffH}h`;
  return `hace ${Math.round(diffH/24)}d`;
}

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
// LOGO ANIMADO — un puentecito se dibuja bajo "Puentedigital" (login y
// header de la app), con un punto que lo cruza, en loop. La SVG usa
// viewBox fijo + width:100%/height:0.5em, así escala sola con cada lugar
// donde se usa (18px en el header, 25-32px en el login) sin medir nada
// por JS ni necesitar que el elemento esté visible en ese momento.
// ==================================================================
function initBridgeLogos(){
  const ns = 'http://www.w3.org/2000/svg';

  document.querySelectorAll('.bridge-logo').forEach(wrap => {
    if(wrap.dataset.bridgeInit) return; // no duplicar si se llama más de una vez
    wrap.dataset.bridgeInit = '1';

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'bridge-arc');
    svg.setAttribute('viewBox', '0 0 200 32');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 4 Q100 30 196 4');
    path.setAttribute('fill', 'none');
    // color por CSS var (no atributo fijo) para que el logo cambie solo de
    // color al alternar modo claro/oscuro, sin tener que reconstruirlo.
    path.style.stroke = 'var(--calm)';
    path.setAttribute('stroke-width', '3');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);

    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('r', '4');
    dot.style.fill = 'var(--text)';
    svg.appendChild(dot);

    wrap.appendChild(svg);

    const totalLen = path.getTotalLength();
    path.setAttribute('stroke-dasharray', totalLen);

    let t = Math.random() * Math.PI * 2; // fase inicial al azar — si hay dos en pantalla, no laten sincronizados
    (function frame(){
      t += 0.008;
      const p = Math.min(1, ((Math.sin(t) + 1) / 2) * 1.35);
      path.setAttribute('stroke-dashoffset', totalLen - totalLen * p);
      const pt = path.getPointAtLength(p * totalLen);
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);
      requestAnimationFrame(frame);
    })();
  });
}
initBridgeLogos();

// ==================================================================
// MODO CLARO/OSCURO — toggle manual, persistido en localStorage. El valor
// inicial ya se aplicó en un <script> inline en el <head> (antes de pintar,
// para no flashear oscuro un instante si alguien eligió claro) — acá solo
// se sincroniza el ícono de los botones con ese estado inicial y se maneja
// el toggle en caliente.
// ==================================================================
function currentTheme(){ return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

function applyTheme(theme, persist){
  if(theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  if(persist){ try{ localStorage.setItem('pd_theme', theme); }catch(e){ /* modo privado sin storage — el toggle sigue andando, solo no se recuerda */ } }
  const metaTheme = document.querySelector('meta[name=theme-color]');
  if(metaTheme) metaTheme.content = theme === 'light' ? '#F4F7F6' : '#12181A';
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.textContent = theme === 'light' ? '🌙' : '☀️';
    b.title = theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro';
  });
  // fila "Apariencia" del drawer de la hamburguesa — mismo estado, mismo ícono.
  const navIc = document.getElementById('site-nav-theme-ic');
  const navLabel = document.getElementById('site-nav-theme-label');
  if(navIc) navIc.textContent = theme === 'light' ? '🌙' : '☀️';
  if(navLabel) navLabel.textContent = theme === 'light' ? 'Apariencia: claro' : 'Apariencia: oscuro';
}

function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem('pd_theme'); }catch(e){ /* sin storage disponible */ }
  // arranca siempre en oscuro por default — no se sigue la preferencia del
  // sistema (prefers-color-scheme); el claro es opt-in, solo si alguien lo
  // eligió antes con el toggle (ahí sí queda guardado y se respeta).
  const theme = saved === 'light' ? 'light' : 'dark';
  applyTheme(theme, false); // false: no reescribir localStorage solo por sincronizar el ícono
}

function toggleTheme(){
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.classList.add('theme-anim');
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.add('animating'));
  applyTheme(next, true);
  setTimeout(() => {
    document.documentElement.classList.remove('theme-anim');
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('animating'));
  }, 520);
}

// ==================================================================
// "BAÑO" — cambio de tema desde el botón "Apariencia" de la hamburguesa:
// en vez del crossfade parejo de toggleTheme(), un círculo sólido del
// color de fondo del tema nuevo crece desde el punto donde se tocó el
// botón hasta cubrir toda la pantalla (como una ola/baño de pintura), y
// recién cuando la cubre por completo se aplica el cambio de tema real
// por debajo — así lo que se ve "empujando" el tema viejo es la propia
// animación, no un cambio de color instantáneo. Con reduced-motion, cae
// directo al toggle de siempre (sin el círculo).
// ==================================================================
const THEME_BG = { dark: '#12181A', light: '#F4F7F6' };
function toggleThemeWash(event){
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(prefersReduced || !document.body.animate){ toggleTheme(); return; }

  const next = currentTheme() === 'light' ? 'dark' : 'light';
  const btn = event && event.currentTarget;
  const rect = btn ? btn.getBoundingClientRect() : null;
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 40;
  const y = rect ? rect.top + rect.height / 2 : 40;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  const wash = document.createElement('div');
  wash.style.cssText = `position:fixed; left:${x - radius}px; top:${y - radius}px; width:${radius * 2}px; height:${radius * 2}px; border-radius:50%; background:${THEME_BG[next]}; z-index:9999; pointer-events:none; transform:scale(0); will-change:transform;`;
  document.body.appendChild(wash);

  const anim = wash.animate(
    [{ transform: 'scale(0)' }, { transform: 'scale(1)' }],
    { duration: 620, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
  );
  anim.onfinish = () => {
    applyTheme(next, true); // se aplica tapado por el círculo ya del color nuevo — no se nota el salto
    wash.remove();
  };
}
initTheme();

// ==================================================================
// BLOQUEO DE LA APP CON PIN / FACE ID-TOUCH ID — mismo criterio que el
// bloqueo con PIN de WhatsApp: NO es autenticación de verdad (la sesión
// del server sigue activa igual), es un cerrojo LOCAL de este
// dispositivo/navegador para que alguien que agarra el teléfono ya
// desbloqueado no pueda abrir la app directo — acá el contenido
// (coordinación de un conflicto familiar) es más sensible que un chat
// cualquiera. Todo vive en localStorage, atado a este navegador — no es
// una config de la cuenta, es del aparato.
//
// El PIN se guarda hasheado (SHA-256 + salt propia, Web Crypto) — no en
// texto plano, pero tampoco pretende ser una bóveda: el modelo de
// amenaza es "alguien con el teléfono ya desbloqueado en la mano", no
// un atacante remoto con acceso al localStorage.
//
// La biometría usa WebAuthn con un authenticator de plataforma
// (Face ID/Touch ID/Windows Hello): se registra un credential una vez
// (navigator.credentials.create) y para desbloquear alcanza con que
// navigator.credentials.get() no tire error — el propio sistema
// operativo ya validó la huella/cara antes de devolver algo, no hace
// falta (ni hay) un server que verifique la firma, porque no se está
// autenticando contra nada remoto, solo destrabando la pantalla local.
// ==================================================================
const LOCK_STORAGE_KEY = 'pd_lock_config';
const LOCK_REARM_MS = 30 * 1000; // volver a pedir el PIN si la app estuvo oculta más de esto

function getLockConfig(){
  try{ return JSON.parse(localStorage.getItem(LOCK_STORAGE_KEY) || 'null'); }
  catch(e){ return null; }
}
function setLockConfig(cfg){
  try{ localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(cfg)); }catch(e){ /* sin storage disponible — el bloqueo simplemente no persiste */ }
}
function isLockEnabled(){
  const cfg = getLockConfig();
  return !!(cfg && cfg.enabled && cfg.pinHash);
}
async function sha256Hex(text){
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function randomHex(bytes){
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}
async function enableAppLock(pin){
  const salt = randomHex(16);
  const pinHash = await sha256Hex(salt + pin);
  const prev = getLockConfig() || {};
  setLockConfig({ ...prev, enabled: true, pinHash, salt });
}
function disableAppLock(){
  setLockConfig(null);
}
async function verifyLockPin(pin){
  const cfg = getLockConfig();
  if(!cfg || !cfg.pinHash) return false;
  const hash = await sha256Hex(cfg.salt + pin);
  return hash === cfg.pinHash;
}

// ---- biometría (WebAuthn, opcional además del PIN) ----
async function biometricAvailable(){
  if(!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try{ return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch(e){ return false; }
}
function hasBiometricRegistered(){
  const cfg = getLockConfig();
  return !!(cfg && cfg.webauthnCredId);
}
async function registerBiometric(){
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Puente Digital' },
      user: { id: userId, name: 'bloqueo-local', displayName: 'Bloqueo del dispositivo' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
    },
  });
  if(!cred) throw new Error('No se pudo registrar');
  const credIdB64 = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
  const prev = getLockConfig() || {};
  setLockConfig({ ...prev, webauthnCredId: credIdB64 });
}
function clearBiometric(){
  const prev = getLockConfig();
  if(!prev) return;
  setLockConfig({ ...prev, webauthnCredId: null });
}
async function attemptBiometricUnlock(){
  const cfg = getLockConfig();
  if(!cfg || !cfg.webauthnCredId) return;
  try{
    const idBytes = Uint8Array.from(atob(cfg.webauthnCredId), c => c.charCodeAt(0));
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await navigator.credentials.get({
      publicKey: { challenge, allowCredentials: [{ id: idBytes, type: 'public-key' }], userVerification: 'required', timeout: 60000 },
    });
    unlockApp(); // si get() no tiró error, el sistema ya validó la huella/cara
  }catch(e){
    // cancelado o no coincide — se queda en la pantalla de PIN, no es un error para mostrar
  }
}

// ---- pantalla de bloqueo ----
let lockPinBuffer = '';
function showLockScreen(){
  document.getElementById('app-lock-screen').classList.add('show');
  lockPinBuffer = '';
  renderLockPinDots();
  renderLockKeypad();
  document.getElementById('lock-pin-error').textContent = '';
  biometricAvailable().then(avail => {
    document.getElementById('lock-biometric-btn').style.display = (avail && hasBiometricRegistered()) ? 'block' : 'none';
    if(avail && hasBiometricRegistered()) attemptBiometricUnlock(); // ofrece la biometría sola, sin esperar a que toquen el botón
  });
}
function hideLockScreen(){
  document.getElementById('app-lock-screen').classList.remove('show');
}
function unlockApp(){
  hideLockScreen();
  lastAppVisibleUnlockedAt = Date.now();
}
function renderLockPinDots(){
  const wrap = document.getElementById('lock-pin-dots');
  wrap.innerHTML = Array.from({length:4}).map((_, i) => `<span class="dot${i < lockPinBuffer.length ? ' filled' : ''}"></span>`).join('');
}
function renderLockKeypad(){
  const keys = ['1','2','3','4','5','6','7','8','9','','0','del'];
  document.getElementById('lock-keypad').innerHTML = keys.map(k => {
    if(k === '') return '<span class="lock-key lock-key-ghost"></span>';
    if(k === 'del') return '<button class="lock-key lock-key-del" onclick="pressLockDelete()" aria-label="Borrar">⌫</button>';
    return `<button class="lock-key" onclick="pressLockDigit('${k}')">${k}</button>`;
  }).join('');
}
async function pressLockDigit(d){
  if(lockPinBuffer.length >= 4) return;
  lockPinBuffer += d;
  renderLockPinDots();
  if(lockPinBuffer.length === 4){
    const ok = await verifyLockPin(lockPinBuffer);
    if(ok){
      unlockApp();
    }else{
      document.getElementById('lock-pin-error').textContent = 'PIN incorrecto';
      document.getElementById('lock-pin-dots').classList.add('shake');
      setTimeout(() => {
        document.getElementById('lock-pin-dots').classList.remove('shake');
        lockPinBuffer = '';
        renderLockPinDots();
      }, 400);
    }
  }
}
function pressLockDelete(){
  lockPinBuffer = lockPinBuffer.slice(0, -1);
  renderLockPinDots();
}

// se llama una vez al arrancar boot() — si el bloqueo está activo, tapa
// todo hasta que se resuelva; boot() sigue su curso normal por debajo,
// la pantalla de bloqueo solo se superpone visualmente.
function checkLockOnBoot(){
  if(isLockEnabled()) showLockScreen();
}

// re-bloquear al volver de estar oculta un rato — no en cada cambio de
// pestaña (molesto), solo si pasó bastante tiempo (LOCK_REARM_MS),
// como hace WhatsApp.
let lastAppVisibleUnlockedAt = Date.now();
let hiddenSinceAt = null;
document.addEventListener('visibilitychange', () => {
  if(!isLockEnabled()) return;
  if(document.hidden){
    hiddenSinceAt = Date.now();
    return;
  }
  if(hiddenSinceAt && Date.now() - hiddenSinceAt > LOCK_REARM_MS) showLockScreen();
  hiddenSinceAt = null;
});

// ==================================================================
// MODAL DE CONFIGURACIÓN — bloqueo de la app + confirmaciones de
// lectura, las dos son preferencias que no encajan en "Configurar caso"
// (esa es por canal; estas son de la cuenta/dispositivo).
// ==================================================================
function openAppSettingsModal(){
  document.getElementById('app-settings-modal').classList.add('show');
  renderAppSettings();
}
function closeAppSettingsModal(){
  document.getElementById('app-settings-modal').classList.remove('show');
}
async function renderAppSettings(){
  const el = document.getElementById('app-settings-content');
  if(!el) return;
  const lockOn = isLockEnabled();
  const bioAvail = await biometricAvailable();
  const bioOn = hasBiometricRegistered();
  el.innerHTML = `
    <div class="settings-row">
      <div>
        <div class="st-label">Confirmaciones de lectura</div>
        <div class="st-desc">El "✓✓ leído" en los chats. Si lo apagás, tampoco vas a ver el de los demás — es recíproco, igual que en WhatsApp.</div>
      </div>
      <label class="switch"><input type="checkbox" id="settings-read-receipts" ${me.readReceiptsEnabled !== false ? 'checked' : ''} onchange="onToggleReadReceipts(this.checked)"><span class="slider"></span></label>
    </div>
    <div class="settings-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
        <div>
          <div class="st-label">Bloqueo de la app</div>
          <div class="st-desc">Pedir un PIN${bioAvail ? ' (o Face ID / Touch ID)' : ''} para abrir la app en este dispositivo — es de este navegador, no de tu cuenta.</div>
        </div>
        <label class="switch"><input type="checkbox" id="settings-app-lock" ${lockOn ? 'checked' : ''} onchange="onToggleAppLock(this.checked)"><span class="slider"></span></label>
      </div>
      <div id="app-lock-setup-slot" style="margin-top:10px;"></div>
      ${lockOn && bioAvail ? `
        <label style="display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--text-dim); margin-top:10px; cursor:pointer;">
          <input type="checkbox" id="settings-biometric" ${bioOn ? 'checked' : ''} onchange="onToggleBiometric(this.checked)" style="width:auto;">
          Usar Face ID / Touch ID además del PIN
        </label>
      ` : ''}
    </div>
  `;
}
async function onToggleReadReceipts(checked){
  try{
    const res = await api('/auth/me/preferences', { method:'POST', body: JSON.stringify({ readReceiptsEnabled: checked }) });
    me.readReceiptsEnabled = res.readReceiptsEnabled;
    if(currentScreen === 'chat') paintMessages(); // los tildes de los mensajes ya pintados cambian con esto
  }catch(e){
    alert('No se pudo guardar. Probá de nuevo.');
    renderAppSettings(); // revierte el switch a lo que realmente quedó guardado
  }
}
function onToggleAppLock(checked){
  if(!checked){
    disableAppLock();
    renderAppSettings();
    return;
  }
  // no se activa todavía — primero hay que elegir el PIN
  document.getElementById('settings-app-lock').checked = false;
  document.getElementById('app-lock-setup-slot').innerHTML = `
    <div class="card" style="padding:12px; margin:0;">
      <label class="field-label">Elegí un PIN de 4 dígitos</label>
      <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" id="lock-setup-pin" placeholder="····" style="margin-bottom:8px; letter-spacing:6px; text-align:center;">
      <label class="field-label">Repetilo</label>
      <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" id="lock-setup-pin2" placeholder="····" style="margin-bottom:10px; letter-spacing:6px; text-align:center;">
      <div id="lock-setup-error" style="color:var(--danger); font-size:12px; margin-bottom:8px;"></div>
      <button class="primary" style="width:100%;" onclick="confirmAppLockSetup()">Guardar PIN</button>
    </div>
  `;
}
async function confirmAppLockSetup(){
  const pin = document.getElementById('lock-setup-pin').value;
  const pin2 = document.getElementById('lock-setup-pin2').value;
  const errEl = document.getElementById('lock-setup-error');
  if(!/^\d{4}$/.test(pin)){ errEl.textContent = 'Tiene que ser un PIN de 4 números.'; return; }
  if(pin !== pin2){ errEl.textContent = 'Los dos PIN no coinciden.'; return; }
  await enableAppLock(pin);
  renderAppSettings();
}
async function onToggleBiometric(checked){
  if(checked){
    try{ await registerBiometric(); }
    catch(e){ alert('No se pudo activar Face ID / Touch ID en este dispositivo. Probá de nuevo o seguí usando el PIN.'); }
  } else {
    clearBiometric();
  }
  renderAppSettings();
}

// ==================================================================
// MENÚ HAMBURGUESA (landing, responsive) — solo esconde/muestra los links
// de .site-nav por debajo de 640px (ver CSS); arriba de eso el CSS ya los
// muestra en fila y el botón queda oculto, así que este JS no hace nada ahí.
// ==================================================================
function toggleMobileNav(){
  const nav = document.getElementById('site-nav');
  const btn = document.getElementById('hamburger-btn');
  const backdrop = document.getElementById('site-nav-backdrop');
  if(!nav) return;
  const open = nav.classList.toggle('open');
  if(backdrop) backdrop.classList.toggle('open', open);
  if(btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
document.addEventListener('click', (e) => {
  const nav = document.getElementById('site-nav');
  if(!nav || !nav.classList.contains('open')) return;
  // clic en un link del propio menú → lo cierra (por si es un ancla tipo
  // #faq que no recarga la página); clic afuera (o en el backdrop) → también.
  if(e.target.closest('#site-nav a') || (!e.target.closest('#site-nav') && !e.target.closest('#hamburger-btn'))){
    nav.classList.remove('open');
    document.getElementById('site-nav-backdrop')?.classList.remove('open');
    const btn = document.getElementById('hamburger-btn');
    if(btn) btn.setAttribute('aria-expanded', 'false');
  }
});

// ==================================================================
// INSTALAR APP — Android/desktop Chrome dispara beforeinstallprompt y ahí
// se puede pedir el diálogo nativo; iOS Safari NUNCA dispara ese evento (la
// Push API tampoco existe ahí fuera de modo standalone, ver push.js), así
// que para iOS el botón abre un modal con los pasos manuales en vez de
// intentar un prompt que no existe.
// ==================================================================
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.querySelectorAll('.install-btn').forEach(b => b.style.display = 'flex');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.querySelectorAll('.install-btn').forEach(b => b.style.display = 'none');
});

function initInstallButton(){
  if(isStandalone()) return; // ya la tiene instalada — no hay nada que ofrecer
  if(isIOS()){
    document.querySelectorAll('.install-btn').forEach(b => b.style.display = 'flex');
  }
  // en Android/desktop Chrome el botón se muestra recién cuando llega
  // beforeinstallprompt (arriba) — antes de eso no hay nada que ofrecer.
}
initInstallButton();

async function promptInstall(){
  if(isIOS()){
    document.getElementById('install-modal')?.classList.add('show');
    return;
  }
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.querySelectorAll('.install-btn').forEach(b => b.style.display = 'none');
}
function closeInstallModal(){ document.getElementById('install-modal')?.classList.remove('show'); }

// ==================================================================
// BOOT
// ==================================================================
(async function boot(){
  checkLockOnBoot(); // tapa la pantalla ANTES de que se llegue a pintar nada, si el bloqueo está activo en este dispositivo
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
  initScrollReveal(); // recién ahora login-screen es visible — antes los elementos .reveal medían 0 y el observer nunca disparaba
  setupStickyGoogleBar();
  initShowcase();
}

// ==================================================================
// SHOWCASE ANIMADO — ejemplos reales del "antes / después" de la
// moderación, en loop automático, para que se entienda el valor del
// producto con solo mirar (sin tener que escribir nada en el demo de al
// lado). Con reduced-motion no rota sola: se queda en el primer ejemplo,
// entero, sin fades — la idea ya se entiende igual de una imagen fija.
// ==================================================================
const SHOWCASE_PAIRS = [
  { orig: 'Sos un desastre, siempre llegás tarde.', sug: 'Llegaste 15 minutos tarde a la entrega de hoy. ¿Podemos coordinar un margen para la próxima vez?' },
  { orig: 'Como siempre, no te importa nada de lo que quedamos.', sug: 'Habíamos acordado retirarlo a las 18. ¿Qué pasó hoy? Necesito saber para organizarme.' },
  { orig: 'No pienso pagar la mitad de eso, es un curro tuyo.', sug: 'No estoy de acuerdo con dividir este gasto. ¿Podemos hablar del detalle antes de confirmarlo?' },
];
let showcaseTimer = null;
function initShowcase(){
  if(showcaseTimer) return; // no duplicar el intervalo si showLogin() se llama de nuevo
  const origEl = document.getElementById('showcase-orig');
  const sugEl = document.getElementById('showcase-sug');
  if(!origEl || !sugEl) return;
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(prefersReduced) return; // se queda en el primer ejemplo, quieto

  let i = 0;
  showcaseTimer = setInterval(() => {
    i = (i + 1) % SHOWCASE_PAIRS.length;
    origEl.classList.add('swap');
    sugEl.classList.add('swap');
    setTimeout(() => {
      origEl.textContent = SHOWCASE_PAIRS[i].orig;
      sugEl.textContent = SHOWCASE_PAIRS[i].sug;
      origEl.classList.remove('swap');
      sugEl.classList.remove('swap');
    }, 350);
  }, 4200);
}

// Barra flotante de "Continuar con Google" — aparece recién después de
// pasar el CTA principal (así no se pisan al ver la landing por primera
// vez), y se mantiene visible mientras se sigue bajando, para no obligar a
// volver a subir para loguearse. Solo vive dentro de #login-screen, así que
// desaparece sola cuando esa pantalla se oculta (display:none la tapa).
let stickyGoogleBarReady = false;
function setupStickyGoogleBar(){
  if(stickyGoogleBarReady) return; // evita atar el listener de nuevo cada vez que se llama showLogin()
  stickyGoogleBarReady = true;
  const bar = document.getElementById('sticky-google-bar');
  const scroller = document.getElementById('login-screen'); // el que scrollea de verdad es #login-screen (overflow-y:auto), no window
  const mainCta = document.querySelector('.cta-block');
  if(!bar || !scroller) return;
  const threshold = () => (mainCta ? mainCta.offsetTop + mainCta.offsetHeight : 400);
  scroller.addEventListener('scroll', () => {
    bar.classList.toggle('show', scroller.scrollTop > threshold());
  }, { passive:true });
}

// ==================================================================
// ANIMACIÓN DE ENTRADA AL SCROLLEAR (solo landing, sin sesión) — cada
// bloque marcado con .reveal en el HTML empieza invisible/corrido y se
// asienta en su lugar la primera vez que entra en pantalla. Con
// prefers-reduced-motion el CSS ni siquiera aplica el estado inicial
// oculto, así que ese público ve todo el contenido de entrada sin esperar
// ninguna animación.
// ==================================================================
let scrollRevealInitialized = false;
function initScrollReveal(){
  if(scrollRevealInitialized) return; // showLogin() puede llamarse más de una vez en la sesión
  scrollRevealInitialized = true;
  const els = document.querySelectorAll('.reveal');
  if(!els.length) return;
  if(!('IntersectionObserver' in window)){ els.forEach(el => el.classList.add('reveal-visible')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting){
        entry.target.classList.add('reveal-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
  els.forEach(el => io.observe(el));
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
  updateAppBadge(0);
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
function isIOS(){ return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }
function isStandalone(){ return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; }

function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for(let i=0; i<rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr;
}

async function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return null;
  try{ return await navigator.serviceWorker.register('/sw.js'); }
  catch(e){ console.error('No se pudo registrar el service worker', e); return null; }
}

// En iOS, la Push API directamente no existe fuera del modo standalone —
// no es que falle, es que ni siquiera está — así que sin esto la persona
// toca "activar notificaciones" y no pasa nada, sin ninguna pista de por qué.
async function subscribeToPush(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if(isIOS() && !isStandalone()){
    alert('Para recibir notificaciones en iPhone, primero agregá esta app a tu pantalla de inicio (compartir → "Agregar a inicio") y abrila desde ahí.');
    return false;
  }
  try{
    const reg = await registerServiceWorker();
    if(!reg) return false;
    const { publicKey } = await api('/api/push/vapid-public-key');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('/api/push/subscribe', { method:'POST', body: JSON.stringify(sub.toJSON()) });
    return true;
  }catch(e){
    console.error('No se pudo suscribir a push', e);
    return false; // no bloquea el resto — sigue quedando el aviso sonoro mientras la pestaña está abierta
  }
}

async function unsubscribeFromPush(){
  if(!('serviceWorker' in navigator)) return;
  try{
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = reg && await reg.pushManager.getSubscription();
    if(sub){
      await api('/api/push/unsubscribe', { method:'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
  }catch(e){ console.error('No se pudo dar de baja la suscripción push', e); }
}

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
    unsubscribeFromPush(); // en segundo plano, no hace falta esperarla para actualizar la UI
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
    subscribeToPush(); // no bloquea — si falla (ej. iOS sin standalone), el sonido en pestaña abierta sigue andando igual
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
  socket.on('channel:update', (info)=>{
    channelInfo = info;
    if(currentScreen==='config') renderConfig();
    if(currentScreen==='chat'){
      renderCaseTabsInfo();
      // si un mediador/a se sumó SIN mensaje de sistema (invitación
      // silenciosa), esto es lo único que lo hace aparecer al toque en la
      // fila de presencia de arriba, sin esperar a que se reabra el chat.
      updateChatPresenceLine();
    }
  });
  socket.on('expense:new', (e)=>{ upsertExpense(e); if(currentScreen==='gastos') renderGastos(); });
  socket.on('expense:update', (e)=>{ upsertExpense(e); if(currentScreen==='gastos') renderGastos(); });
  socket.on('checkin:new', ()=>{ if(currentScreen==='calendario') loadCheckins(); });
  socket.on('message:read', ({id, readAt})=>{
    const m = messages.find(x=>x.id===id);
    if(m){ m.readAt = readAt; if(currentScreen==='chat') paintMessages(); }
  });
  socket.on('channel:status', ({code, status})=>{
    if(channelInfo && channelInfo.code === code){ channelInfo.status = status; }
    if(currentScreen === 'inicio') renderInicio();
    if(currentScreen === 'chat') renderCaseTabsInfo();
  });
  socket.on('peer:presence', ({userId, online, lastSeenAt})=>{
    peerPresence[userId] = { online, lastSeenAt: lastSeenAt || (peerPresence[userId]?.lastSeenAt ?? null) };
    if(currentScreen === 'chat') updateChatPresenceLine();
  });
  socket.on('peer:typing', ({userId, typing})=>{
    peerTyping[userId] = typing;
    if(currentScreen === 'chat') updateChatPresenceLine();
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
// ------------------------------------------------------------------
// Badge API — el numerito sobre el ícono de la app en el celular
// (soportado desde iOS 16.4 y en Chrome/Android). Feature-detectado:
// en navegadores sin soporte, estas funciones no hacen nada, sin romper
// nada — el resto de los avisos (push, WhatsApp, puntito en Inicio)
// sigue andando igual.
// ------------------------------------------------------------------
function updateAppBadge(count){
  if(!('setAppBadge' in navigator)) return;
  try{
    if(count > 0) navigator.setAppBadge(count).catch(()=>{});
    else navigator.clearAppBadge().catch(()=>{});
  }catch(e){ /* algunos navegadores tiran si se llama antes de tiempo — no es crítico */ }
}

function updateInicioDot(list){
  const withNews = list.filter(c => c.lastActivity > getLastVisited(c.code));
  const dot = document.getElementById('dot-inicio');
  if(dot) dot.classList.toggle('show', withNews.length > 0 && currentScreen !== 'inicio');
  updateAppBadge(withNews.length); // mismo cálculo que ya existía, ahora también refleja en el ícono
}
async function refreshInicioBadge(){
  let list = [];
  try{ list = await api('/api/channels/mine'); }catch(e){ return list; }
  updateInicioDot(list);
  return list;
}

// ------------------------------------------------------------------
// Tarjeta de caso — UNA sola función para las dos listas que existen (la
// de Inicio y la del selector rápido de abajo): antes cada una tenía su
// propio HTML a mano, y la del selector era una versión pelada (sin
// estado, sin "con quién", sin recibo de lectura) — se veía como una cosa
// distinta en vez de la misma lista en otro lugar. Ahora las dos arman la
// tarjeta con esto, así que si una cambia, cambian las dos.
// ------------------------------------------------------------------
const STATUS_LABELS = { abierto: 'Abierto', en_proceso: 'En proceso', cerrado: 'Cerrado' };
const STATUS_PILL_CLASS = { abierto: 'confirmado', en_proceso: 'pendiente', cerrado: 'rechazado' };
const READ_RECEIPT = { enviado: '✓ enviado', leido: '✓✓ leído' };

function othersLineHtml(others){
  if(!others || !others.length) return 'Esperando a la otra parte';
  return 'Con ' + others.map(o => escapeHtml(o.name) + (o.verified ? verifiedBadgeHtml() : '') + (o.roleLabel ? ` (${escapeHtml(o.roleLabel)})` : '')).join(', ');
}

// showStatusButtons: Inicio deja cambiar el estado directo desde la
// tarjeta, sin entrar al caso — el selector rápido (más compacto, ya con
// bastante info) se queda sin esto para no recargarlo.
function caseCardHtml(c, onclickExpr, { showStatusButtons } = {}){
  const statusButtonsHtml = showStatusButtons ? `
    <div class="status-select-row" style="margin-top:10px;" onclick="event.stopPropagation()">
      <button class="status-opt ${c.status === 'abierto' ? 'active' : ''}" onclick="setCaseStatusFromList('${c.code}','abierto',event)">Abierto</button>
      <button class="status-opt ${c.status === 'en_proceso' ? 'active' : ''}" onclick="setCaseStatusFromList('${c.code}','en_proceso',event)">En proceso</button>
      <button class="status-opt ${c.status === 'cerrado' ? 'active' : ''}" onclick="setCaseStatusFromList('${c.code}','cerrado',event)">Cerrado</button>
    </div>
  ` : '';
  return `
    <div class="card case-card" style="margin-bottom:10px; cursor:pointer;" onclick="${onclickExpr}">
      <div class="row1">
        <div class="what" style="font-weight:600;">${escapeHtml(c.code)}</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <span class="ev-pill ${STATUS_PILL_CLASS[c.status] || 'confirmado'}">${STATUS_LABELS[c.status] || 'Abierto'}</span>
          ${c.inactiveDays > 3 ? `<span class="ev-pill pendiente">sin actividad hace ${c.inactiveDays}d</span>` : ''}
          <span class="ev-pill confirmado">${escapeHtml(c.myRoleLabel)}</span>
        </div>
      </div>
      <div class="who">${othersLineHtml(c.others)}${c.otherOnline ? ' <span class="presence-dot online" title="Hay alguien conectado ahora"></span> en línea ahora' : ''}</div>
      <div class="ts" style="margin-top:6px;">${c.messageCount} mensajes · última actividad ${fmtTs(c.lastActivity)}${c.lastOwnMessageStatus ? ' · ' + READ_RECEIPT[c.lastOwnMessageStatus] : ''}</div>
      ${statusButtonsHtml}
    </div>
  `;
}

// ------------------------------------------------------------------
// Selector rápido de caso: tocar el nombre del caso actual (Nivel 2)
// despliega los otros casos sin tener que volver a Inicio. Backdrop +
// transición + encabezado para que se note que es un panel propio (antes
// aparecía de golpe, superpuesto arriba del chat, sin ningún indicio de
// qué era ni cómo cerrarlo salvo tocar el mismo botón de nuevo).
// ------------------------------------------------------------------
let caseSwitcherOpen = false;
function caseSwitcherHeadingHtml(){
  return `
    <div class="case-switcher-head">
      <span class="case-switcher-heading">Cambiar de caso</span>
      <button class="modal-close" onclick="closeCaseSwitcher()" aria-label="Cerrar" style="font-size:16px;">✕</button>
    </div>
  `;
}
async function loadCaseSwitcherList(){
  const el = document.getElementById('case-switcher');
  if(!el) return;
  el.innerHTML = caseSwitcherHeadingHtml() + `<p class="empty-hint">Cargando…</p>`;
  let list;
  try{ list = await api('/api/channels/mine'); }
  catch(e){
    el.innerHTML = caseSwitcherHeadingHtml() + `<p class="empty-hint">No se pudo cargar. <button class="text-link" style="display:inline; margin:0;" onclick="loadCaseSwitcherList()">Reintentar</button></p>`;
    return;
  }
  const others = list.filter(c => c.code !== channelCode);
  el.innerHTML = caseSwitcherHeadingHtml() + (others.length
    ? others.map(c => caseCardHtml(c, `switchToCase('${c.code}')`)).join('')
    : `<p class="empty-hint">No tenés otros casos activos.</p>`);
}
function toggleCaseSwitcher(){
  caseSwitcherOpen ? closeCaseSwitcher() : openCaseSwitcher();
}
function openCaseSwitcher(){
  caseSwitcherOpen = true;
  const el = document.getElementById('case-switcher');
  const backdrop = document.getElementById('case-switcher-backdrop');
  const btn = document.querySelector('.case-switch-btn');
  if(!el || !backdrop) return;
  el.style.display = 'block';
  backdrop.style.display = 'block';
  if(btn) btn.classList.add('open');
  void el.offsetHeight; // fuerza el reflow — si no, el navegador puede saltarse la transición de "display:none a visible"
  requestAnimationFrame(() => { el.classList.add('open'); backdrop.classList.add('open'); });
  loadCaseSwitcherList();
}
function closeCaseSwitcher(){
  caseSwitcherOpen = false;
  const el = document.getElementById('case-switcher');
  const backdrop = document.getElementById('case-switcher-backdrop');
  const btn = document.querySelector('.case-switch-btn');
  if(!el || !backdrop) return;
  el.classList.remove('open');
  backdrop.classList.remove('open');
  if(btn) btn.classList.remove('open');
  setTimeout(() => {
    if(!caseSwitcherOpen){ el.style.display = 'none'; backdrop.style.display = 'none'; }
  }, 200);
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
    <button class="gear-btn" onclick="goTo('config')" title="Configurar este caso"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></button>
  `;
}

// mismo criterio que jobs.js del lado del servidor (que arma el texto para
// WhatsApp/push): los acuerdos confirmados van primero porque son el
// resultado más concreto, y "marcados por el sistema" — que suena a nota
// de mala conducta — se reencuadra como que la herramienta ayudó a bajar
// la tensión. Si algo dio 0, no se menciona.
function summaryLineHtml(stats){
  const parts = [`${stats.messages} mensaje${stats.messages === 1 ? '' : 's'}`];
  if(stats.confirmedEvents > 0){
    parts.push(`${stats.confirmedEvents} acuerdo${stats.confirmedEvents === 1 ? '' : 's'} confirmado${stats.confirmedEvents === 1 ? '' : 's'}`);
  }
  if(stats.flagged > 0){
    parts.push(`el sistema ayudó a bajar la tensión en ${stats.flagged} mensaje${stats.flagged === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

function renderCaseSummary(){
  const slot = document.getElementById('case-summary-slot');
  if(!slot) return;
  if(!channelInfo){ slot.innerHTML = ''; return; }

  const summaryHtml = channelInfo.lastSummary ? `
    <div class="card">
      <div class="eyebrow">Resumen de la semana</div>
      <p style="font-size:13px; line-height:1.5;">${summaryLineHtml(channelInfo.lastSummary.stats)}.</p>
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

  // colapsado por default: esto es información de contexto, no el chat en
  // sí — que le coma lugar a la conversación por default es justo lo que
  // hace sentir apretado el módulo principal de la app.
  slot.innerHTML = (summaryHtml || eventsHtml) ? `
    <details class="case-summary-toggle">
      <summary>Resumen y próximos eventos</summary>
      ${summaryHtml}${eventsHtml}
    </details>
  ` : '';
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
async function setCaseStatus(status){
  if(!channelInfo || channelInfo.status === status) return;
  const previous = channelInfo.status;
  channelInfo.status = status; // optimista — se revierte abajo si el POST falla
  renderConfig();
  try{
    await api(`/api/channels/${channelInfo.code}/status`, { method:'POST', body: JSON.stringify({ status }) });
    // el propio servidor emite channel:status por socket, que ya actualiza
    // Inicio/tabs si están abiertos en otra pestaña o en el otro celular —
    // acá no hace falta nada más que lo que ya hizo el render optimista.
  }catch(e){
    channelInfo.status = previous;
    renderConfig();
    alert('No se pudo cambiar el estado del caso. Probá de nuevo.');
  }
}

function renderConfig(){
  const el = document.getElementById('config-content');
  if(!channelInfo){ el.innerHTML = `<p class="empty-hint">Elegí un caso primero.</p>`; return; }

  const other = otherPartyOf(channelInfo);
  const shareUrl = location.origin + location.pathname + '?channel=' + channelInfo.code;
  const guestShareUrl = location.origin + location.pathname + '?guest=' + channelInfo.guestToken;

  const membersListHtml = channelInfo.members.map(m => `
    <div class="member-row">
      <span>${escapeHtml(m.user ? m.user.name : '—')}${m.verified ? verifiedBadgeHtml() : ''}${m.label ? ' <span style="color:var(--text-faint)">· ' + escapeHtml(m.label) + '</span>' : ''}</span>
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
      <div class="eyebrow">Estado del caso</div>
      <div class="status-select-row">
        <button class="status-opt ${channelInfo.status === 'abierto' ? 'active' : ''}" onclick="setCaseStatus('abierto')">Abierto</button>
        <button class="status-opt ${channelInfo.status === 'en_proceso' ? 'active' : ''}" onclick="setCaseStatus('en_proceso')">En proceso</button>
        <button class="status-opt ${channelInfo.status === 'cerrado' ? 'active' : ''}" onclick="setCaseStatus('cerrado')">Cerrado</button>
      </div>
    </div>
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
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:12px;">Va a poder ver mensajes, calendario e historial, pero no escribir en tu nombre ni de la otra parte. Su ingreso nunca queda oculto — siempre va a estar en "Integrantes del canal" acá abajo y en el estado de arriba del chat — pero podés elegir si además se anuncia con un mensaje en medio de la conversación.</p>
      <label class="field-label">Rol</label>
      <select id="pro-invite-role" style="margin-bottom:6px;" onchange="document.getElementById('pro-invite-role-hint').style.display = this.value==='estudio' ? 'block' : 'none';">
        <option value="mediador">Mediador/a</option>
        <option value="estudio">Estudio jurídico</option>
      </select>
      <p class="field-hint" id="pro-invite-role-hint" style="display:none; margin-bottom:10px;">Este link se puede compartir con más de un abogado/a del estudio — cada uno se suma con su propia cuenta de Google, no hace falta generar una invitación por persona.</p>
      <label class="field-label">Nombre o estudio</label>
      <input type="text" id="pro-invite-label" placeholder="Ej: Estudio Pérez &amp; Asoc." style="margin-bottom:12px;">
      <label style="display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--text-dim); margin-bottom:12px; cursor:pointer;">
        <input type="checkbox" id="pro-invite-announce" checked style="width:auto;">
        Avisar en el chat cuando se una
      </label>
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
  const announceInChat = document.getElementById('pro-invite-announce').checked;
  const resultEl = document.getElementById('pro-invite-result');
  if(!label){ resultEl.innerHTML = `<p style="color:var(--danger); font-size:12px; margin-top:8px;">Completá el nombre o estudio.</p>`; return; }
  try{
    const res = await api(`/api/channels/${channelCode}/professionals/invite`, { method:'POST', body: JSON.stringify({ role, label, announceInChat }) });
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

// "en línea" / "escribiendo..." / "última vez hace X" — en ese orden de
// prioridad. Si nunca llegó un evento de socket para esta persona (recién
// se abrió el chat), se arranca desde el lastSeenAt persistido que ya viene
// en channelInfo, en vez de mostrar nada hasta el primer evento en vivo.
// una fila compacta con CADA otro miembro del canal (la otra parte, y
// también un/a mediador/a o invitado/a si ya se sumó) — antes esto solo
// sabía mostrar a "la otra parte" (un único rol A/B), así que en cuanto
// había un tercero en el canal (mediador/a, estudio) esa persona quedaba
// invisible acá: para verla había que abrir la ⚙ de Configurar caso.
// Sin esto, "¿quién está conectado?" solo se podía responder abriendo esa
// pantalla — ahora queda a la vista arriba del chat todo el tiempo.
function updateChatPresenceLine(){
  const el = document.getElementById('chat-sub');
  if(!el || isProfessional()) return; // el texto fijo de mediador/a ya cubre ese caso, no lo pisamos acá
  const others = (channelInfo.members || []).filter(m => m.user && m.user.id !== me.id);
  if(!others.length){
    el.innerHTML = '';
    el.textContent = 'Todavía no se unió nadie más — podés escribir igual, quedará registrado.';
    return;
  }
  el.innerHTML = others.map(m => {
    const uid = m.user.id;
    if(!(uid in peerPresence)){
      peerPresence[uid] = { online: false, lastSeenAt: m.lastSeenAt || null };
    }
    const roleTag = (m.role === 'A' || m.role === 'B') ? '' : ` · ${escapeHtml(professionalRoleLabel(m.role) || m.role)}`;
    let statusClass = 'offline', statusText;
    if(peerTyping[uid]){
      statusClass = 'typing'; statusText = 'escribiendo...';
    } else if(peerPresence[uid].online){
      statusClass = 'online'; statusText = 'en línea';
    } else if(peerPresence[uid].lastSeenAt){
      statusText = fmtRelative(peerPresence[uid].lastSeenAt);
    } else {
      statusText = 'sin conectar todavía';
    }
    return `<span class="presence-chip"><span class="presence-dot ${statusClass}"></span>${escapeHtml(m.user.name)}${m.verified ? verifiedBadgeHtml() : ''}${roleTag} · ${statusText}</span>`;
  }).join('');
}

function renderChatScreen(){
  const body = document.getElementById('chat-body');
  if(!channelInfo){ body.innerHTML = chatGateHtml(); return; }
  const other = otherPartyOf(channelInfo);
  const otherName = other && other.user ? other.user.name : 'la otra parte';
  document.getElementById('chat-title').textContent = isProfessional() ? 'Chat del canal' : 'Chat con ' + otherName;
  if(isProfessional()){
    // caso fijo, no depende de presencia — updateChatPresenceLine() no lo toca (ver el return temprano ahí).
    document.getElementById('chat-sub').textContent = `Estás viendo este canal como ${professionalRoleLabel(myRole).toLowerCase()} — acceso de solo lectura.`;
  }
  updateChatPresenceLine(); // arma la fila de "quién más está y su estado" — ver el comentario en la función

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
      <div id="reply-preview-slot"></div>
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
  replyingTo = null; // pantalla de chat recién montada — no arrastrar una respuesta pendiente de antes
  renderReplyPreview();
  const chatInput = document.getElementById('chat-input');
  if(chatInput){
    chatInput.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }
    });
    chatInput.addEventListener('input', ()=>{
      if(!socket || isProfessional()) return;
      if(chatInput.value.trim()){
        if(!typingActive){ typingActive = true; socket.emit('typing:start', channelCode); }
      } else if(typingActive){
        typingActive = false; socket.emit('typing:stop', channelCode);
      }
    });
  }
  paintMessages();
}

// ==================================================================
// RESPONDER A UN MENSAJE — hilo estilo WhatsApp: mientras replyingTo
// esté seteado, se manda como replyToId junto con el próximo mensaje
// (ver commitMessage). La franja de arriba del composer y la cita
// dentro de la burbuja usan el mismo escapeHtml para lo que ya viene
// truncado/preparado desde acá o desde el server (replyTo del socket).
// ==================================================================
function startReply(msgId){
  const m = messages.find(x => x.id === msgId);
  if(!m || !m.sender) return; // no se responde a mensajes de sistema
  replyingTo = {
    id: m.id,
    senderName: m.sender.id === me.id ? 'Vos' : m.sender.name,
    text: m.text.length > 140 ? m.text.slice(0, 140) + '…' : m.text,
  };
  renderReplyPreview();
  const input = document.getElementById('chat-input');
  if(input) input.focus();
}
function cancelReply(){
  replyingTo = null;
  renderReplyPreview();
}
function renderReplyPreview(){
  const slot = document.getElementById('reply-preview-slot');
  if(!slot) return;
  slot.innerHTML = replyingTo ? `
    <div class="reply-preview-bar">
      <div class="rp-body">
        <div class="rp-name">Respondiendo a ${escapeHtml(replyingTo.senderName)}</div>
        <div class="rp-text">${escapeHtml(replyingTo.text)}</div>
      </div>
      <button class="rp-close" onclick="cancelReply()" aria-label="Cancelar respuesta">✕</button>
    </div>
  ` : '';
}
// salto al mensaje original al tocar la cita — solo funciona si todavía
// está en la ventana de mensajes ya cargada (el chat no trae todo el
// historial completo, ver hasMoreHistory); si no está, no hace nada.
function scrollToMessage(msgId){
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if(!el) return;
  el.scrollIntoView({ block:'center', behavior:'smooth' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1200);
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
    <div class="proposal-head"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg></span>${mine ? 'Propusiste vos' : escapeHtml(ev.requestedBy ? ev.requestedBy.name : 'Propuesta')}<span class="ev-pill ${ev.status}">${ev.status}</span></div>
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

async function respondSwap(swapId, decision){
  const verb = decision === 'confirmado' ? 'aceptar' : 'rechazar';
  if(!confirm(`¿Seguro que querés ${verb} este intercambio? Las dos fechas se confirman o rechazan juntas.`)) return;
  try{
    await api(`/api/channels/${channelCode}/events/swap/${swapId}/respond`, { method:'POST', body: JSON.stringify({ decision }) });
  }catch(e){ alert('No se pudo actualizar el intercambio.'); }
}

function toggleSwapForm(){
  const el = document.getElementById('swap-form');
  if(el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function proposeSwap(){
  const dateA = document.getElementById('swap-date-a').value;
  const detailA = document.getElementById('swap-detail-a').value.trim();
  const dateB = document.getElementById('swap-date-b').value;
  const detailB = document.getElementById('swap-detail-b').value.trim();
  if(!dateA || !detailA || !dateB || !detailB){ alert('Completá las dos fechas y sus detalles.'); return; }
  try{
    await api(`/api/channels/${channelCode}/events/swap`, { method:'POST', body: JSON.stringify({ dateA, detailA, dateB, detailB }) });
    toggleSwapForm();
    document.getElementById('swap-date-a').value = '';
    document.getElementById('swap-detail-a').value = '';
    document.getElementById('swap-date-b').value = '';
    document.getElementById('swap-detail-b').value = '';
  }catch(e){ alert(e.error || 'No se pudo proponer el intercambio.'); }
}

function paintMessages(){
  const log = document.getElementById('chat-log');
  if(!log) return;
  log.innerHTML = '';

  // el orden de llegada (socket vs. respuesta REST de tu propio envío) no
  // siempre coincide con el orden real de creación — sobre todo con
  // conexiones lentas, donde el mensaje del otro puede llegar por socket
  // antes de que se confirme el tuyo que en realidad salió primero. Sin
  // este sort, eso se traduce en mensajes fuera de orden en pantalla — es
  // exactamente la queja más repetida sobre apps de este rubro.
  messages.sort((a, b) => a.createdAt - b.createdAt);

  if(hasMoreHistory){
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'load-more-btn';
    loadMoreBtn.className = 'text-link';
    loadMoreBtn.style.cssText = 'align-self:center; margin-bottom:10px;';
    loadMoreBtn.textContent = 'Cargar mensajes anteriores';
    loadMoreBtn.onclick = loadMoreMessages;
    log.appendChild(loadMoreBtn);
  }

  // separador de fecha entre días, estilo WhatsApp ("Hoy" / "Ayer" / la
  // fecha) — se compara contra el día del mensaje anterior a medida que
  // se recorre la lista, ya ordenada por createdAt más arriba.
  let lastDayKey = null;

  messages.forEach((m, idx)=>{
    const thisDayKey = dayKeyOf(m.createdAt);
    if(thisDayKey !== lastDayKey){
      lastDayKey = thisDayKey;
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      sep.textContent = dateSeparatorLabel(m.createdAt);
      log.appendChild(sep);
    }

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
      div.dataset.msgId = m.id; // usado por scrollToMessage() al tocar una cita
      let inner = '';
      // el nombre de quien escribió va siempre en los mensajes que no son
      // míos — antes solo se mostraba para mediador/a o estudio, y las
      // partes tenían que adivinar por "no es mío = es de la otra
      // persona"; eso deja de alcanzar en cuanto hay más de dos
      // participantes viendo el canal (invitado/a, mediador/a).
      if(!mine){
        const senderMember = channelInfo && channelInfo.members && channelInfo.members.find(mem => mem.user && mem.user.id === m.sender.id);
        inner += '<div class="msg-sender">' + escapeHtml(m.sender.name) + (senderMember && senderMember.verified ? verifiedBadgeHtml() : '') + '</div>';
      }
      // cita del mensaje al que responde, si corresponde — replyTo llega
      // armado del server (serializeMessage); si el original ya no está
      // (raro), se avisa en vez de mostrar una cita vacía o rota.
      if(m.replyTo){
        inner += '<button type="button" class="msg-quote" onclick="scrollToMessage(\'' + m.replyTo.id + '\')">'
          + '<span class="qname">' + escapeHtml(m.replyTo.senderName || 'Sistema') + '</span>'
          + '<span class="qtext">' + escapeHtml(m.replyTo.text) + '</span>'
          + '</button>';
      }
      inner += '<div class="msg-text">' + escapeHtml(m.text) + '</div>';
      if(m.flagged && m.reason && mine){
        inner += '<div class="flag-note">' + escapeHtml(m.reason) + '</div>';
      }
      // hora + tildes de leído, siempre pegadas abajo a la derecha de la
      // burbuja — el patrón visual más reconocible de WhatsApp.
      inner += '<div class="msg-meta"><span class="msg-time">' + fmtTimeOnly(m.createdAt) + (m.flagged ? ' · marcado' : '') + '</span>' + msgTicksHtml(mine, m.readAt) + '</div>';
      const actionLinks = [];
      if(!mine && !isProfessional()){
        actionLinks.push('<button class="neutral-btn" onclick="requestNeutralReading(' + idx + ', this)">Ver lectura neutral</button>');
      }
      if(!isProfessional()){
        actionLinks.push('<button class="reply-btn" onclick="startReply(\'' + m.id + '\')">↩ Responder</button>');
      }
      // reportar: solo tiene sentido en un mensaje ajeno — la moderación
      // de IA ya filtra lo que uno mismo manda, esto es para lo que
      // preocupa del OTRO lado. Se ofrece también a profesionales: son
      // quienes a veces detectan un patrón que a la parte se le pasa.
      if(!mine){
        actionLinks.push('<button class="reply-btn" onclick="toggleReportBox(\'' + m.id + '\', ' + idx + ')">🚩 Reportar</button>');
      }
      if(actionLinks.length) inner += '<div style="display:flex; gap:12px; flex-wrap:wrap;">' + actionLinks.join('') + '</div>';
      if(!mine && !isProfessional()){
        inner += '<div class="neutral-box" id="neutral-' + idx + '" style="display:none"></div>';
      }
      if(!mine){
        inner += '<div class="neutral-box" id="report-box-' + idx + '" style="display:none"></div>';
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

// ==================================================================
// REPORTAR UN MENSAJE — no bloquea nada ni le avisa a la otra parte,
// solo le llega al admin con el contexto del caso (ver
// POST .../messages/:id/report). La moderación de IA solo filtra lo
// que uno mismo manda; esto es el canal para lo que preocupa del otro
// lado.
// ==================================================================
function toggleReportBox(msgId, idx){
  const box = document.getElementById('report-box-' + idx);
  if(!box) return;
  const open = box.style.display !== 'none';
  if(open){ box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = `
    <div class="lab">Reportar este mensaje</div>
    <p style="font-size:11.5px; color:var(--text-dim); margin-bottom:6px;">Le llega a un administrador de la plataforma con el contexto del caso — no bloquea el mensaje ni avisa a la otra parte.</p>
    <textarea id="report-reason-${idx}" placeholder="¿Qué te preocupa de este mensaje?" style="width:100%; min-height:56px; margin-bottom:8px; background:var(--surface); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:8px; font-family:var(--sans); font-size:12.5px;"></textarea>
    <div id="report-result-${idx}" style="font-size:12px; margin-bottom:6px;"></div>
    <button class="ghost small" onclick="submitReport('${msgId}', ${idx})" id="report-submit-${idx}">Enviar reporte</button>
  `;
}
async function submitReport(msgId, idx){
  const reason = document.getElementById(`report-reason-${idx}`).value.trim();
  const resultEl = document.getElementById(`report-result-${idx}`);
  const btn = document.getElementById(`report-submit-${idx}`);
  if(!reason){ resultEl.innerHTML = '<span style="color:var(--danger)">Contanos brevemente qué te preocupa.</span>'; return; }
  btn.disabled = true;
  try{
    await api(`/api/channels/${channelCode}/messages/${msgId}/report`, { method:'POST', body: JSON.stringify({ reason }) });
    document.getElementById('report-box-' + idx).innerHTML = '<div class="lab">Reportar este mensaje</div><span style="color:var(--calm); font-size:12.5px;">✓ Reportado — un administrador lo va a revisar.</span>';
  }catch(e){
    resultEl.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.error || 'No se pudo enviar el reporte.')}</span>`;
    btn.disabled = false;
  }
}

async function handleSend(){
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text) return;
  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;
  input.value = '';
  if(typingActive && socket){ typingActive = false; socket.emit('typing:stop', channelCode); }

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
      <button class="ghost" data-action="draft">🖊 Probarlo en el borrador</button>
      <button class="primary" data-action="alt">Usar alternativa</button>
    </div>
  `;
  card.querySelector('[data-action="alt"]').onclick = async ()=>{ card.remove(); await commitMessage(result.reformulation, true, result.reason); };
  card.querySelector('[data-action="original"]').onclick = async ()=>{ card.remove(); await commitMessage(original, true, 'Enviado sin cambios pese a la señal del sistema.'); };
  // no manda nada — lleva el texto señalado al Borrador privado en vez de
  // forzar acá mismo, bajo presión, la decisión entre "mandalo igual" o
  // "usá la sugerencia": a veces lo que hace falta es un lugar aparte para
  // reescribirlo con calma, sin que nada quede registrado en el canal
  // mientras tanto.
  card.querySelector('[data-action="draft"]').onclick = ()=>{ card.remove(); openInDraft(original); };
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
}

let draftPrefill = null; // texto que trae el Borrador precargado la próxima vez que se renderice — se usa una sola vez
function openInDraft(text){
  draftPrefill = text;
  goTo('borrador');
}

async function commitMessage(text, flagged, reason){
  const replyToId = replyingTo ? replyingTo.id : null;
  try{
    const msg = await api(`/api/channels/${channelCode}/messages`, {
      method:'POST', body: JSON.stringify({ text, flagged, reason, replyToId }),
    });
    if(!messages.find(m=>m.id===msg.id)) messages.push(msg);
    replyingTo = null; renderReplyPreview(); // se limpia recién al confirmarse el envío, no antes
    paintMessages();
    seen.msgCount = messages.length;
  }catch(e){
    // el input ya se había vaciado en handleSend() antes de intentar el
    // envío (para que la UI se sienta ágil) — si esto falla, el texto no
    // puede quedar perdido, así que vuelve a la caja en vez de desaparecer.
    // replyingTo se deja como estaba (sigue respondiendo a lo mismo si reintenta).
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
    const dots = dayEvents.slice(0, 3).map(ev => `<span class="dot ${ev.kind === 'vencimiento' ? 'vencimiento' : ev.status}"></span>`).join('');
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
        const confirmHtml = needsMyConfirm
          ? (ev.swapId ? `<div class="confirm-actions">
              <button class="ghost small" onclick="respondSwap('${ev.swapId}','rechazado')">Rechazar intercambio</button>
              <button class="primary" style="padding:6px 12px; font-size:11.5px;" onclick="respondSwap('${ev.swapId}','confirmado')">Aceptar intercambio</button>
            </div>` : `<div class="confirm-actions">
              <button class="ghost small" onclick="respondEvent('${ev.id}','rechazado')">Rechazar</button>
              <button class="primary" style="padding:6px 12px; font-size:11.5px;" onclick="respondEvent('${ev.id}','confirmado')">Confirmar</button>
            </div>${seriesBtns}`)
          : '';
        const isVencimiento = ev.kind === 'vencimiento';
        return `<div class="event-item${isVencimiento ? ' event-vencimiento' : ''}">
          <div class="row1"><div class="day">${dayLabel}</div><div class="what">${isVencimiento ? '⚖️ ' : ''}${escapeHtml(ev.detail)}${ev.seriesId ? ' <span class="series-tag" title="Parte de una serie recurrente">🔁</span>' : ''}${ev.swapId ? ' <span class="series-tag" title="Parte de un intercambio de fechas">🔄</span>' : ''}</div><span class="ev-pill ${isVencimiento ? 'vencimiento' : ev.status}">${isVencimiento ? 'vencimiento' : ev.status}</span></div>
          <div class="who">${isVencimiento ? 'Cargado' : 'Pedido'} por ${escapeHtml(ev.requestedBy ? ev.requestedBy.name : '—')}</div>
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
    </div>
    <div class="card">
      <div class="eyebrow">Intercambiar dos fechas</div>
      <button class="ghost" style="width:100%;" onclick="toggleSwapForm()">🔄 Proponer un intercambio</button>
      <div id="swap-form" style="display:none; margin-top:12px;">
        <p style="font-size:11.5px; color:var(--text-dim); margin-bottom:10px;">Las dos fechas se confirman o rechazan juntas — no hay intercambio a medias.</p>
        <label class="field-label">Cedés (tu fecha)</label>
        <input type="date" id="swap-date-a" style="margin-bottom:6px;">
        <input type="text" id="swap-detail-a" placeholder="Ej: Mi finde del 15" style="margin-bottom:12px;">
        <label class="field-label">A cambio de (la fecha que recibís)</label>
        <input type="date" id="swap-date-b" style="margin-bottom:6px;">
        <input type="text" id="swap-detail-b" placeholder="Ej: Su finde del 22" style="margin-bottom:12px;">
        <button class="primary" style="width:100%;" onclick="proposeSwap()">Proponer intercambio</button>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="card">${buildCalendarGrid()}</div>
    <div class="card"><div class="eyebrow">${listLabel}</div>${listHtml}</div>
    ${requestFormHtml}
    <div class="card" style="border-color:var(--warn-dim);">
      <div class="eyebrow" style="color:var(--warn);">⚖️ Vencimiento procesal</div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:12px; line-height:1.4;">Un plazo legal del caso (presentación, audiencia, apelación…), no una entrega de coparentalidad. Queda registrado directo — no hace falta que nadie lo confirme — y avisa un día antes a todos los que tienen acceso al canal.</p>
      <label class="field-label">Fecha de vencimiento</label>
      <input type="date" id="venc-date" style="margin-bottom:10px">
      <label class="field-label">Detalle</label>
      <input type="text" id="venc-detail" placeholder="Ej: Vence el plazo para presentar la contestación" style="margin-bottom:12px">
      <button class="primary" style="width:100%" onclick="addVencimiento()">Registrar vencimiento</button>
      <div id="venc-result" style="margin-top:8px; font-size:12.5px;"></div>
    </div>
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
async function addVencimiento(){
  const date = document.getElementById('venc-date').value;
  const detail = document.getElementById('venc-detail').value.trim();
  const resultEl = document.getElementById('venc-result');
  if(!date || !detail){ resultEl.innerHTML = `<span style="color:var(--danger)">Falta la fecha o el detalle.</span>`; return; }
  try{
    const ev = await api(`/api/channels/${channelCode}/events/vencimiento`, { method:'POST', body: JSON.stringify({ date, detail }) });
    upsertEvent(ev);
    seen.evCount = events.length;
    renderCalendario();
    if(currentScreen==='chat') paintMessages();
  }catch(e){ resultEl.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.error || 'No se pudo registrar el vencimiento.')}</span>`; }
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
        const eventBadge = e.event ? `<div class="who" style="margin-top:2px;">🔗 Vinculado a: ${escapeHtml(e.event.detail)} (${e.event.date})</div>` : '';
        return `<div class="event-item">
          <div class="row1"><div class="day">$${e.amount}</div><div class="what">${escapeHtml(e.description)}</div><span class="ev-pill ${e.status}">${e.status}</span></div>
          <div class="who">Pedido por ${escapeHtml(e.requestedBy ? e.requestedBy.name : '—')}</div>
          ${eventBadge}
          ${confirmHtml}
        </div>`;
      }).join('')
    : `<p class="empty-hint" style="padding:8px 0;">Todavía no hay gastos registrados.</p>`;

  // eventos de este mismo canal, más recientes primero, para elegir a cuál
  // vincular el gasto — opcional, no todo gasto tiene por qué atarse a una
  // fecha puntual del calendario.
  const eventOptions = [...events].sort((a,b)=> b.date.localeCompare(a.date))
    .map(ev => `<option value="${ev.id}">${escapeHtml(ev.detail)} (${ev.date})</option>`).join('');

  const formHtml = isProfessional() ? '' : `
    <div class="card">
      <div class="eyebrow">Registrar un gasto</div>
      <label class="field-label">Monto</label>
      <input type="number" id="exp-amount" min="0" step="0.01" placeholder="Ej: 5000" style="margin-bottom:10px">
      <label class="field-label">Descripción</label>
      <input type="text" id="exp-desc" placeholder="Ej: Útiles escolares" style="margin-bottom:10px">
      <label class="field-label">Vincular a un evento del calendario (opcional)</label>
      <select id="exp-event" style="width:100%; background:var(--surface-2); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 10px; font-family:var(--sans); font-size:13.5px; margin-bottom:12px;">
        <option value="">— Sin vincular —</option>
        ${eventOptions}
      </select>
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
  const eventId = document.getElementById('exp-event')?.value || null;
  if(!amount || amount <= 0 || !description) { alert('Completá un monto válido y una descripción.'); return; }
  try{
    const e = await api(`/api/channels/${channelCode}/expenses`, { method:'POST', body: JSON.stringify({ amount, description, eventId }) });
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

  historialMessages.sort((a, b) => a.createdAt - b.createdAt); // mismo resguardo que en paintMessages()
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

  const otherForExport = otherPartyOf(channelInfo);
  const exportTargetLabel = `${channelInfo.code}${otherForExport?.user ? ' — con ' + escapeHtml(otherForExport.user.name) : ''}`;

  el.innerHTML = `
    <input type="text" id="historial-search" placeholder="Buscar en el historial…" value="${escapeHtml(historialQuery)}" oninput="filterHistorial(this.value)" style="width:100%; margin-bottom:12px; background:var(--surface-2); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--sans); font-size:13.5px;">
    <div class="card">${listHtml}</div>
    <div class="card" style="margin-top:12px;">
      <div class="eyebrow">Exportar — ${exportTargetLabel}</div>
      <p style="font-size:11.5px; color:var(--text-dim); margin-bottom:10px;">¿No es el caso que buscabas? Tocá "${exportTargetLabel.split(' — ')[0]} ▾" arriba para cambiar de caso antes de exportar.</p>
      <label class="field-label" style="font-size:11px;">Rango de fechas (opcional — vacío exporta todo el historial)</label>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <input type="date" id="export-desde" style="flex:1;">
        <input type="date" id="export-hasta" style="flex:1;">
      </div>
      ${isProfessional() ? `
      <details style="margin-bottom:10px;">
        <summary style="cursor:pointer; font-size:11.5px; color:var(--calm); list-style:none;">▸ Formato para escrito judicial (opcional)</summary>
        <p style="font-size:11px; color:var(--text-dim); margin:8px 0;">Completá esto si vas a adjuntar el informe a un escrito — agrega una carátula con los datos del expediente al PDF. Vacío, sale igual que siempre.</p>
        <label class="field-label" style="font-size:11px;">Juzgado</label>
        <input type="text" id="export-juzgado" placeholder="Ej: Juzgado de Familia N° 3" style="margin-bottom:8px;">
        <label class="field-label" style="font-size:11px;">N° de expediente</label>
        <input type="text" id="export-expediente" placeholder="Ej: FAM 12345/2026" style="margin-bottom:8px;">
        <label class="field-label" style="font-size:11px;">Carátula</label>
        <input type="text" id="export-caratula" placeholder="Ej: Pérez, Juan c/ Gómez, Ana s/ Régimen de comunicación" style="margin-bottom:4px;">
      </details>` : ''}
      <button class="ghost" style="width:100%;" onclick="exportReport()">Descargar informe (.txt)</button>
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="exportCertifiedReport()">Descargar informe certificado (PDF)</button>
      <div class="empty-hint" style="margin-top:4px; text-align:center;">Incluye un código QR para verificar su autenticidad</div>
    </div>
    ${notesHtml}
  `;
  if(keepFocus){
    const input = document.getElementById('historial-search');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  if(isProfessional()) loadCaseNotes();
}
function buildExportQuery(){
  const desde = document.getElementById('export-desde')?.value;
  const hasta = document.getElementById('export-hasta')?.value;
  const params = new URLSearchParams();
  if(desde) params.set('desde', desde);
  if(hasta) params.set('hasta', hasta);
  return params;
}
function exportReport(){
  const params = buildExportQuery();
  const qs = params.toString();
  window.location.href = `/api/channels/${channelCode}/export${qs ? '?' + qs : ''}`;
}
function exportCertifiedReport(){
  const params = buildExportQuery();
  // solo están en el DOM cuando isProfessional() mostró el <details> — con
  // optional chaining, para las partes (que no ven ese bloque) esto no
  // rompe nada, simplemente no agrega los campos.
  const juzgado = document.getElementById('export-juzgado')?.value.trim();
  const expediente = document.getElementById('export-expediente')?.value.trim();
  const caratula = document.getElementById('export-caratula')?.value.trim();
  if(juzgado) params.set('juzgado', juzgado);
  if(expediente) params.set('expediente', expediente);
  if(caratula) params.set('caratula', caratula);
  const qs = params.toString();
  window.location.href = `/api/channels/${channelCode}/export/certified${qs ? '?' + qs : ''}`;
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
  // sin ninguna solicitud (la mayoría: alguien que recién llega) — el pitch
  // de siempre, más un link chico y secundario para quien en realidad es
  // mediador/a o estudio pero entró por el login general en vez del CTA
  // aparte del landing — puerta de salida discreta, no un paso obligatorio
  // para todo el mundo (el caso común sigue sin fricción agregada).
  return `
    <div class="hero-demo">
      <div class="eyebrow">Así funciona</div>
      <div class="bubble original"><div class="bubble-label">Mensaje original</div>Otra vez llegás tarde. Sos un desastre y nunca te importa nuestro hijo.</div>
      <div class="bubble suggested"><div class="bubble-label">Alternativa sugerida por la IA</div>Hoy la entrega se realizó 25 minutos después del horario acordado. ¿Podemos confirmar el horario para la próxima entrega?</div>
    </div>
    <p class="empty-hint" style="margin-top:-6px;">¿Sos mediador/a o estudio jurídico? <a href="#" onclick="event.preventDefault(); location.href='/?proSignup=1';" style="color:var(--calm);">Registrate acá</a>.</p>
  `;
}

// ==================================================================
// SCREEN: INICIO (= lista de casos, antes "Mis casos" era una pestaña
// aparte — ver NAV-RESTRUCTURE-para-claude-code.md). Tocar un caso lleva
// al nivel 2 (Chat/Calendario/Gastos/Historial/Asistente de ESE caso).
// ==================================================================
let inicioStatusFilter = 'todos'; // en memoria nomás — vuelve a 'todos' al recargar, no hace falta persistirlo
let inicioSearchQuery = '';       // buscador por nombre de cliente/parte o código de caso — mismo criterio, en memoria
let lastInicioList = [];          // último /mine ya resuelto, para que filtrar/buscar no dispare un fetch nuevo por cada tecla

function setInicioFilter(filter){
  inicioStatusFilter = filter;
  renderInicioList();
}

// buscador por nombre de cliente (o código de caso) — filtra sobre la
// lista ya cargada, sin volver a pedir /mine. Vive en un input aparte del
// contenedor que se re-renderiza (#inicio-list-wrap), así cada tecla no
// recrea el <input> y no se pierde el foco/cursor a mitad de escribir.
function filterInicioBySearch(value){
  inicioSearchQuery = value;
  renderInicioList();
}

async function setCaseStatusFromList(code, status, ev){
  if(ev) ev.stopPropagation(); // si no, el click en el botón de estado también dispara openCase() por burbujeo
  try{
    await api(`/api/channels/${code}/status`, { method:'POST', body: JSON.stringify({ status }) });
    if(channelInfo && channelInfo.code === code) channelInfo.status = status; // por si es el caso activo, para que Config no quede desincronizado
    renderInicio();
  }catch(e){
    alert('No se pudo cambiar el estado del caso. Probá de nuevo.');
  }
}

async function renderInicio(){
  const el = document.getElementById('inicio-content');
  el.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let list;
  try{ list = await api('/api/channels/mine'); }
  catch(e){
    el.innerHTML = `<p class="empty-hint">No se pudieron cargar tus casos. <button class="text-link" style="display:inline; margin:0;" onclick="renderInicio()">Reintentar</button></p>`;
    return;
  }
  updateInicioDot(list); // reusa este mismo fetch en vez de pedirlo de nuevo
  lastInicioList = list;

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
      <div><span style="font-size:18px; font-weight:700; color:var(--text);">${flaggedTotal}</span><br>veces que bajamos la tensión este mes</div>
    </div>
  `;

  const filterChips = ['todos', 'abierto', 'en_proceso', 'cerrado'].map(f => {
    const label = f === 'todos' ? 'Todos' : STATUS_LABELS[f];
    const count = f === 'todos' ? list.length : list.filter(c => c.status === f).length;
    return `<button class="status-opt ${inicioStatusFilter === f ? 'active' : ''}" onclick="setInicioFilter('${f}')" style="flex:none; padding:6px 12px;">${label} (${count})</button>`;
  }).join('');
  const filterHtml = `<div class="status-select-row" style="overflow-x:auto; margin-bottom:12px; padding-bottom:2px;">${filterChips}</div>`;

  // buscador por nombre de cliente/parte o código — solo vale la pena
  // mostrarlo con unos pocos casos ya cargados; con 1-2 es ruido de más.
  const searchHtml = list.length > 3
    ? `<input type="text" id="inicio-search-input" placeholder="Buscar por nombre o código de caso…" value="${escapeHtml(inicioSearchQuery)}" oninput="filterInicioBySearch(this.value)" style="margin-bottom:12px;">`
    : '';

  el.innerHTML = statsHtml + filterHtml + searchHtml + `<div id="inicio-list-wrap"></div>`;
  renderInicioList();
}

// re-renderiza SOLO la lista de casos (no el buscador ni las stats) a
// partir de lastInicioList — así cambiar el filtro de estado o tipear en
// el buscador no vuelve a pedir /mine ni recrea el <input> de búsqueda.
function renderInicioList(){
  const wrap = document.getElementById('inicio-list-wrap');
  if(!wrap) return;
  const list = lastInicioList;

  const STATUS_ORDER = { abierto: 0, en_proceso: 1, cerrado: 2 };
  // "siempre primero los abiertos" — orden por estado, y dentro de cada
  // estado, el más activo recientemente primero.
  const sorted = [...list].sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0);
    return byStatus !== 0 ? byStatus : b.lastActivity - a.lastActivity;
  });
  let filtered = inicioStatusFilter === 'todos' ? sorted : sorted.filter(c => c.status === inicioStatusFilter);

  const q = inicioSearchQuery.trim().toLowerCase();
  if(q){
    filtered = filtered.filter(c =>
      c.code.toLowerCase().includes(q) ||
      (c.others || []).some(o => o.name && o.name.toLowerCase().includes(q))
    );
  }

  wrap.innerHTML = filtered.length
    ? filtered.map(c => caseCardHtml(c, `openCase('${c.code}')`, { showStatusButtons: c.myRole === 'A' || c.myRole === 'B' })).join('')
    : `<p class="empty-hint">${q ? 'Ningún caso coincide con la búsqueda.' : 'Ningún caso con este filtro.'}</p>`;
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
  const prefill = draftPrefill;
  draftPrefill = null; // se usa una sola vez — no se repite en la próxima visita a esta pantalla
  el.innerHTML = `
    <div class="card">
      <textarea id="draft-input" placeholder="Escribí el mensaje que le querés mandar a la otra persona…" style="min-height:100px; margin-bottom:10px;">${prefill ? escapeHtml(prefill) : ''}</textarea>
      <button class="primary" style="width:100%" onclick="runDraftAnalyze()" id="draft-btn">Revisar</button>
      <div id="draft-result" style="margin-top:12px;"></div>
    </div>
  `;
  // si vino desde el chat con un mensaje ya señalado, mostramos el
  // análisis de una — no tiene sentido hacer que toque "Revisar" de nuevo
  // para algo que el sistema ya le acababa de marcar.
  if(prefill) runDraftAnalyze();
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
    // antes usaba .empty-hint (pensada para listas vacías: mucho padding,
    // texto chico y apagado) — adentro de la demo, chica y compacta, eso
    // se sentía como un bache en blanco en vez de una confirmación. Un
    // check + texto en el color de marca lee como "todo bien", no como
    // "acá no hay nada".
    return `<p style="display:flex; align-items:center; gap:7px; font-size:13px; color:var(--calm); padding:4px 2px 0;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>Este mensaje no muestra señales de conflicto.</p>`;
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
