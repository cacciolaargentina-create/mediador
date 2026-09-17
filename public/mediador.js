// public/mediador.js — página separada, sin tocar public/app.js (Bloque 3)

let me = null;
let currentMediationId = null;
let isPlatformAdmin = false; // Bloque 25 — admin de PLATAFORMA (ADMIN_EMAILS), no admin de estudio. Solo gatilla mostrar/ocultar el link al radar competitivo en el menú de cuenta; el backend (routes/radar.js) es quien realmente lo protege.

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
async function api(path, opts = {}){
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw data;
  return data;
}
function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('es-AR');
}
function fmtDateTime(ms){
  return new Date(ms).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

const STATUS_LABELS = {
  borrador:'Borrador', iniciada:'Iniciada', contactando_partes:'Contactando partes',
  notificaciones:'Notificaciones', audiencia_programada:'Audiencia programada',
  en_mediacion:'En mediación', acuerdo:'Acuerdo', acuerdo_parcial:'Acuerdo parcial',
  sin_acuerdo:'Sin acuerdo', incomparecencia:'Incomparecencia', cerrada:'Cerrada',
};
const NEXT_ACTION_RESPONSIBLE_LABELS = { mediador: 'Mediador/a', party: 'Una parte', lawyer: 'Un abogado' };

(async function boot(){
  try{
    me = await api('/auth/me');
  }catch(e){
    document.getElementById('login-gate').style.display = 'block';
    return;
  }
  document.getElementById('app').style.display = 'block';
  renderAccountButton();
  // Bloque 28 — vuelta del flujo de conexión OAuth de un proveedor de
  // videoconferencia (routes/video-providers.js redirige acá con estos
  // query params, nunca con datos sensibles en la URL).
  const videoParams = new URLSearchParams(location.search);
  if(videoParams.get('videoProvider')){
    const ok = videoParams.get('status') === 'conectado';
    showToast(ok ? 'Cuenta conectada correctamente.' : 'No se pudo conectar la cuenta — probá de nuevo.', ok ? 'success' : 'danger');
    history.replaceState(null, '', location.pathname);
    goTo('videoSettings');
  } else {
    goTo('dashboard');
  }
  maybeShowOnboarding();
  try{ isPlatformAdmin = (await api('/api/admin/am-i-admin')).isAdmin; }catch(e){ isPlatformAdmin = false; }
})();

// ================= GUÍA DE PRIMER USO =================
// 4 pasos cortos, una sola vez por navegador (localStorage) — no es un
// recorrido con flechas apuntando a botones (eso se rompe con cualquier
// cambio de layout futuro): es una tarjeta chica y salteable en cualquier
// momento, con lo mínimo para no perderse las primeras veces.
const ONBOARDING_KEY = 'pd_mediador_onboarding_seen';
const ONBOARDING_STEPS = [
  {
    title: 'Bienvenido/a a Mediador',
    body: 'Acá gestionás tus mediaciones: expedientes, audiencias, documentos y comunicación con las partes y sus abogados, todo en un solo lugar.',
  },
  {
    title: 'Para empezar',
    body: '"+ Nueva mediación" crea un caso en segundos. Después, desde el expediente, cargás partes, abogados y programás (o proponés) la primera audiencia.',
  },
  {
    title: 'Qué tengo que hacer',
    body: 'El Dashboard prioriza lo urgente — vencimientos, audiencias próximas, solicitudes de cambio — para que no tengas que andar buscando qué falta.',
  },
  {
    title: 'Agenda y equipo',
    body: 'Desde el menú de abajo accedés a tu agenda completa. Si trabajás con otros mediadores, armá un estudio desde "Equipo" para compartir el trabajo.',
  },
];
let onboardingStep = 0;

function maybeShowOnboarding(){
  let seen;
  try{ seen = localStorage.getItem(ONBOARDING_KEY); }catch(e){ return; } // modo privado sin storage — no insistir
  if(seen) return;
  onboardingStep = 0;
  renderOnboardingStep();
  document.getElementById('onboarding-backdrop').classList.add('show');
}

function renderOnboardingStep(){
  const step = ONBOARDING_STEPS[onboardingStep];
  const isLast = onboardingStep === ONBOARDING_STEPS.length - 1;
  document.getElementById('onboarding-card').innerHTML = `
    <div class="ob-step">Paso ${onboardingStep + 1} de ${ONBOARDING_STEPS.length}</div>
    <h3>${escapeHtml(step.title)}</h3>
    <p>${escapeHtml(step.body)}</p>
    <div class="ob-dots">${ONBOARDING_STEPS.map((_, i) => `<span class="ob-dot ${i===onboardingStep?'active':''}"></span>`).join('')}</div>
    <div class="ob-actions">
      <button class="ob-skip" onclick="closeOnboarding()">Saltear</button>
      <div style="display:flex; gap:8px;">
        ${onboardingStep > 0 ? `<button class="ghost" onclick="onboardingStep--; renderOnboardingStep();">Atrás</button>` : ''}
        <button class="primary" onclick="${isLast ? 'closeOnboarding()' : 'onboardingStep++; renderOnboardingStep();'}">${isLast ? 'Entendido' : 'Siguiente'}</button>
      </div>
    </div>
  `;
}

function closeOnboarding(){
  document.getElementById('onboarding-backdrop').classList.remove('show');
  try{ localStorage.setItem(ONBOARDING_KEY, '1'); }catch(e){ /* sin storage, se volverá a mostrar la próxima vez — no rompe nada */ }
}

// ================= CUENTA (avatar + menú) =================
// Antes esto era un <span id="user-name"> suelto en el header, sin forma
// de cerrar sesión desde acá — mismo problema y misma solución que ya se
// aplicó en public/index.html (Puente Digital): un solo botón de entrada
// (el avatar) que abre un menú con todo adentro.
function accountInitial(){
  const n = (me && me.name ? me.name.trim() : '') || '?';
  return n.charAt(0).toUpperCase();
}

function renderAccountButton(){
  const av = document.getElementById('account-avatar');
  const nm = document.getElementById('account-name');
  if(!av || !nm || !me) return;
  const next = me.avatar
    ? Object.assign(document.createElement('img'), { className:'avatar', src:me.avatar, alt:'' })
    : Object.assign(document.createElement('span'), { className:'account-btn-initial', textContent:accountInitial() });
  next.id = 'account-avatar';
  av.replaceWith(next);
  nm.textContent = me.name || '';
  document.getElementById('account-btn').setAttribute('aria-label', `Cuenta de ${me.name || 'usuario'} — abrir menú`);
}

function renderAccountMenu(){
  const menu = document.getElementById('account-menu');
  if(!menu || !me) return;
  menu.innerHTML = `
    <div class="account-menu-head">
      <div class="who">${escapeHtml(me.name || '')}</div>
      <div class="sub">${escapeHtml(me.email || '')}</div>
    </div>
    ${isPlatformAdmin ? `<a class="row" role="menuitem" href="/admin-mediador.html">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M6 19V9m4 10V5m4 14v-7m4 7V11"/></svg>
      <span>Centro de control</span>
    </a>` : ''}
    ${isPlatformAdmin ? `<a class="row" role="menuitem" href="/radar.html">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 19 6v5.4c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6l7-2.8Z"/><path d="m9.4 12.1 1.9 1.9 3.4-3.6"/></svg>
      <span>Radar competitivo</span>
    </a>` : ''}
    <button class="row" role="menuitem" onclick="closeAccountMenu(); goTo('videoSettings');">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 10 5-3v10l-5-3"/><rect x="2" y="6" width="13" height="12" rx="2"/></svg>
      <span>Videoconferencias</span>
    </button>
    <button class="row" role="menuitem" onclick="closeAccountMenu(); logoutMediador();">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15.5 16.5 4.5-4.5-4.5-4.5"/><path d="M20 12H9.5"/><path d="M9.5 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h3"/></svg>
      <span>Cerrar sesión</span>
    </button>
  `;
}

function toggleAccountMenu(event){
  if(event) event.stopPropagation();
  const menu = document.getElementById('account-menu');
  const btn = document.getElementById('account-btn');
  if(!menu || !btn) return;
  if(btn.getAttribute('aria-expanded') === 'true'){ closeAccountMenu(); return; }
  renderAccountMenu();
  const backdrop = document.getElementById('account-menu-backdrop');
  menu.classList.add('mounted');
  backdrop.classList.add('mounted');
  requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add('open')));
  btn.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', accountMenuEsc);
}

function closeAccountMenu(){
  const menu = document.getElementById('account-menu');
  const btn = document.getElementById('account-btn');
  const backdrop = document.getElementById('account-menu-backdrop');
  if(!menu || !btn) return;
  menu.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
  backdrop.classList.remove('mounted');
  document.removeEventListener('keydown', accountMenuEsc);
  setTimeout(() => { if(!menu.classList.contains('open')) menu.classList.remove('mounted'); }, 180);
}
function accountMenuEsc(e){
  if(e.key === 'Escape'){ closeAccountMenu(); document.getElementById('account-btn')?.focus(); }
}

async function logoutMediador(){
  await api('/auth/logout', { method:'POST' });
  location.href = '/mediador.html';
}

async function askMediationAI(mediationId){
  const input = document.getElementById('mediation-assistant-question');
  const question = input.value.trim();
  if(!question) return;
  const box = document.getElementById('mediation-assistant-answer');
  box.innerHTML = `<p class="empty-hint">Pensando…</p>`;
  try{
    const { answer } = await api(`/api/mediations/${mediationId}/assistant`, { method:'POST', body: JSON.stringify({ question }) });
    box.innerHTML = `<div class="status-history-item">${escapeHtml(answer)}</div>`;
  }catch(e){ box.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo consultar al asistente.')}</p>`; }
}

async function askDashboardAI(){
  const input = document.getElementById('dashboard-assistant-question');
  const question = input.value.trim();
  if(!question) return;
  const box = document.getElementById('dashboard-assistant-answer');
  box.innerHTML = `<p class="empty-hint">Pensando…</p>`;
  try{
    const { answer } = await api('/api/mediations/assistant', { method:'POST', body: JSON.stringify({ question }) });
    box.innerHTML = `<div class="status-history-item">${escapeHtml(answer)}</div>`;
  }catch(e){ box.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo consultar al asistente.')}</p>`; }
}

// ================= SIDEBAR (drawer en mobile) =================
// Bloque 20 — la sidebar es fixed y se desplaza fuera de pantalla en
// mobile (<=767px, ver responsive.css); acá solo se agrega/quita la clase
// que la trae a la vista y el backdrop para cerrarla al tocar afuera.
function toggleSidebar(){
  document.getElementById('sidebar')?.classList.toggle('open');
  document.getElementById('sidebar-backdrop')?.classList.toggle('show');
}
function closeSidebar(){
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-backdrop')?.classList.remove('show');
}

// Bloque 20 §16 — reemplaza los prompt() que solo servían para copiar un
// link (nunca pedían texto al usuario) por un copy-to-clipboard real +
// confirmación por toast. Si el navegador no tiene Clipboard API (contexto
// no seguro, permiso denegado), cae al prompt() de siempre — nunca deja a
// alguien sin poder copiar el link.
async function copyLinkToClipboard(url, successMessage){
  try{
    await navigator.clipboard.writeText(url);
    showToast(successMessage || 'Link copiado al portapapeles.', 'success');
  }catch(e){
    prompt('Copiá este link:', url);
  }
}

// ================= TOAST =================
// Bloque 20 §13/16 — reemplaza showToast(, 'danger') para errores de flujo normal
// (queda uno mostrando el mensaje corto y se apaga solo). No bloquea la
// pantalla como showToast(, 'danger'), así que no interrumpe lo que se estaba haciendo.
function showToast(message, kind){
  if(!message) return;
  let stack = document.getElementById('toast-stack');
  if(!stack){
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast${kind ? ' toast-' + kind : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3600);
}

// pantallas que no son pestaña propia resaltan la pestaña de la que
// "cuelgan" — el detalle de una mediación resalta Mediaciones, las
// solicitudes de cambio resaltan Agenda, etc. — así el nav inferior
// siempre muestra dónde estás parado/a, no solo en las 5 raíces.
const TAB_FOR_SCREEN = {
  dashboard:'dashboard', list:'list', detail:'list', new:'list',
  stats:'stats', team:'team', studioMediations:'team',
  agenda:'agenda', requests:'agenda',
};
function goTo(screen, id){
  currentMediationId = id || null;
  closeAccountMenu();
  document.querySelectorAll('#tabs .sidebar-item').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === TAB_FOR_SCREEN[screen]);
  });
  closeSidebar();
  // Bloque 22 — devuelve la promesa del render para que quien necesite
  // hacer algo DESPUÉS de que la pantalla esté lista (ej. bajar a una
  // sección puntual) pueda hacer `await goTo(...)` — los llamados
  // existentes que no usan el valor de retorno siguen funcionando igual.
  let renderPromise;
  if(screen === 'dashboard') renderPromise = renderDashboard();
  else if(screen === 'list') renderPromise = renderList();
  else if(screen === 'detail') renderPromise = renderDetail(id);
  else if(screen === 'new') renderPromise = renderNewForm();
  else if(screen === 'stats') renderPromise = renderStats();
  else if(screen === 'team') renderPromise = renderTeam();
  else if(screen === 'studioMediations') renderPromise = renderStudioMediations();
  else if(screen === 'agenda') renderPromise = renderAgenda();
  else if(screen === 'requests') renderPromise = renderRequests();
  else if(screen === 'videoSettings') renderPromise = renderVideoSettings();
  window.scrollTo(0, 0);
  return renderPromise;
}

// ================= DASHBOARD =================
// ================= DASHBOARD =================
// Bloque 22 — "¿Qué requiere tu atención?" ahora es el centro de
// atención calculado en el SERVIDOR (automationEngine.js vía
// GET /api/mediations/dashboard → centroAtencion), no un armado del
// lado del cliente — el motor central es el único lugar que decide qué
// cuenta como "requiere atención", para no tener dos criterios distintos
// si mañana se agrega otra pantalla que también necesite esta lista
// (ej. un widget dentro del expediente, que usa el mismo shape).
let currentAttentionItems = [];

const ATTENTION_PRIORITY_LABELS = { vencido: 'Vencido', critico: 'Crítico', proximo: 'Próximo', pendiente: 'Pendiente' };
const ATTENTION_PRIORITY_BADGE_CLASS = { vencido: 'danger', critico: 'danger', proximo: 'warn', pendiente: 'calm' };
const ATTENTION_ACTION_LABELS = {
  verMediacion: 'Ver mediación', ver: 'Ver', definirProximaAccion: 'Definir próxima acción',
  completarTarea: 'Completar', editarTarea: 'Editar', contactarParte: 'Contactar parte',
  marcarCompletado: 'Marcar completado', enviarAviso: 'Enviar aviso', resolver: 'Resolver',
  crearTarea: 'Crear tarea', verDocumento: 'Ver documento', registrarResultado: 'Registrar resultado',
  verComunicacion: 'Ver comunicación', crearCompromiso: 'Crear compromiso', cerrarMediacion: 'Cerrar mediación',
  registrarActividad: 'Registrar actividad', descartar: 'Descartar', contactar: 'Contactar',
};
// a qué sección del expediente saltar según de dónde salió la alerta —
// mismos anchors (#section-xxx) que ya usa el subnav del expediente.
const ATTENTION_ACTION_SECTION = {
  completarTarea: 'section-tareas', editarTarea: 'section-tareas', crearTarea: 'section-tareas',
  contactarParte: 'section-comunicaciones', verComunicacion: 'section-comunicaciones', contactar: 'section-comunicaciones', crearCompromiso: 'section-compromisos',
  marcarCompletado: 'section-compromisos', verDocumento: 'section-documentos',
  registrarResultado: 'section-audiencias', enviarAviso: 'section-audiencias', resolver: 'section-audiencias',
  cerrarMediacion: 'section-admin',
};

// Bloque 22 §15 — "Tu día en Mediador": panorama rápido, ordenado por
// urgencia operativa (audiencias de hoy primero), sin rankings ni
// puntajes — son conteos y una lista corta, nada más. Separado del
// centro de atención: esto es "qué tenés en el radar hoy", no "qué está
// mal" (una audiencia de hoy ya confirmada no es un problema, pero sigue
// siendo relevante saber que es hoy).
function renderTuDiaCard(d){
  const todayStr = new Date().toISOString().slice(0, 10);
  const hoy = d.proximasAudiencias.filter(h => h.date === todayStr);
  const proximas = d.proximasAudiencias.filter(h => h.date !== todayStr).slice(0, 3);
  const counts = [
    { n: hoy.length, label: hoy.length === 1 ? 'audiencia hoy' : 'audiencias hoy' },
    { n: d.necesitanAtencion.tareasVencidas.length, label: 'tareas vencidas' },
    { n: d.necesitanAtencion.compromisosVencidos.length, label: 'compromisos vencidos' },
    { n: d.alertasAgenda.solicitudesCambioPendientes.length, label: 'solicitudes pendientes' },
    { n: d.necesitanAtencion.sinProximaAccion.length, label: 'sin próxima acción' },
    { n: d.necesitanAtencion.documentosPendientesRevision.length, label: 'documentos por revisar' },
  ].filter(c => c.n > 0);
  if(!counts.length && !hoy.length && !proximas.length) return '';
  return `
    <div class="card">
      <h2>Tu día en Mediador</h2>
      ${counts.length ? `<div class="stat-row" style="margin-bottom:10px;">${counts.map(c => `<div><div class="stat" style="font-size:20px;">${c.n}</div><div class="stat-label">${c.label}</div></div>`).join('')}</div>` : ''}
      ${hoy.map(h => `
        <div class="alert-row" onclick="goTo('detail','${h.mediationId}')">
          <div><div style="font-weight:600; font-size:13.5px;">Audiencia hoy${h.startTime ? ' ' + h.startTime : ''}</div><div class="code">${escapeHtml(h.mediationCode || '')}</div></div>
          <span class="pill calm">hoy</span>
        </div>
      `).join('')}
      ${proximas.map(h => `
        <div class="alert-row" onclick="goTo('detail','${h.mediationId}')">
          <div><div style="font-weight:600; font-size:13.5px;">Audiencia ${fmtDate(h.date)}${h.startTime ? ' ' + h.startTime : ''}</div><div class="code">${escapeHtml(h.mediationCode || '')}</div></div>
          <span class="pill calm">próxima</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderAttentionItem(item, idx){
  const badgeClass = ATTENTION_PRIORITY_BADGE_CLASS[item.priority] || 'calm';
  return `
    <div class="alert-row" style="cursor:default; flex-direction:column; align-items:stretch; gap:6px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div style="cursor:pointer;" onclick="goTo('detail','${item.mediationId}')">
          <div class="code">${escapeHtml(item.mediationCode || '')}</div>
          <div style="font-weight:600; font-size:13.5px;">${escapeHtml(item.title || '')}</div>
          ${item.detail ? `<div style="font-size:12px; color:var(--text-dim); margin-top:2px;">${escapeHtml(item.detail)}</div>` : ''}
        </div>
        <span class="pill ${badgeClass}" style="flex-shrink:0;">${ATTENTION_PRIORITY_LABELS[item.priority] || item.priority}</span>
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${(item.suggestedActions || []).map(a => `<button class="ghost" style="padding:5px 10px; font-size:11.5px;" onclick="handleAttentionAction(${idx},'${a}')">${ATTENTION_ACTION_LABELS[a] || a}</button>`).join('')}
      </div>
    </div>
  `;
}

// DETECTAR → PROPONER → CONFIRMAR → EJECUTAR — este dispatcher es el
// "CONFIRMAR": el mediador ya vio la sugerencia y tocó un botón puntual.
// "descartar"/"completarTarea"/"marcarCompletado" ejecutan sin navegar
// (Bloque 22 §16 — no obligar a cinco pantallas para algo simple); el
// resto lleva al expediente, a la sección correspondiente, porque
// requieren más contexto del que entra en una card del dashboard.
async function handleAttentionAction(idx, action){
  const item = currentAttentionItems[idx];
  if(!item) return;
  if(action === 'descartar'){
    try{
      await api(`/api/mediations/${item.mediationId}/attention/${item.type}/${item.refId}/dismiss`, { method:'POST' });
      showToast('Alerta descartada.', 'success');
      renderDashboard();
    }catch(e){ showToast(e.error || 'No se pudo descartar la alerta.', 'danger'); }
    return;
  }
  if(action === 'completarTarea'){
    try{ await api(`/api/mediations/${item.mediationId}/tasks/${item.refId}`, { method:'PATCH', body: JSON.stringify({ status:'completada' }) }); showToast('Tarea completada.', 'success'); renderDashboard(); }
    catch(e){ showToast(e.error || 'No se pudo completar la tarea.', 'danger'); }
    return;
  }
  if(action === 'marcarCompletado'){
    try{ await api(`/api/mediations/${item.mediationId}/commitments/${item.refId}`, { method:'PATCH', body: JSON.stringify({ status:'cumplido' }) }); showToast('Compromiso marcado como cumplido.', 'success'); renderDashboard(); }
    catch(e){ showToast(e.error || 'No se pudo actualizar el compromiso.', 'danger'); }
    return;
  }
  // el resto: ir al expediente y, cuando la acción tiene una sección
  // asociada, bajar directo ahí en vez de dejar al mediador buscarla.
  await goTo('detail', item.mediationId);
  const sectionId = ATTENTION_ACTION_SECTION[action];
  if(sectionId) setTimeout(() => document.getElementById(sectionId)?.scrollIntoView({ behavior:'smooth' }), 150);
}

async function renderDashboard(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let d;
  try{ d = await api('/api/mediations/dashboard'); }
  catch(e){ main.innerHTML = `<p class="empty-hint">No se pudo cargar el dashboard.</p>`; return; }

  currentAttentionItems = d.centroAtencion || [];
  const moreHearings = d.proximasAudiencias.length > 3;

  main.innerHTML = `
    <h1>Hola, ${escapeHtml((me.name || '').split(' ')[0] || me.name)}</h1>
    <p style="color:var(--text-dim); font-size:15px; margin-bottom:18px;">¿Qué requiere tu atención?</p>

    <div class="card">
      <div class="stat-row">
        <div><div class="stat">${d.counts.activas}</div><div class="stat-label">activas</div></div>
        <div><div class="stat">${d.counts.cerradas}</div><div class="stat-label">cerradas</div></div>
        <div><div class="stat">${d.counts.total}</div><div class="stat-label">total</div></div>
      </div>
    </div>

    ${d.comunicacionesPendientes ? `
    <div class="card">
      <div class="alert-row" onclick="goTo('list')" style="cursor:pointer;">
        <div style="font-weight:600; font-size:13.5px;">Comunicaciones sin leer</div>
        <span class="pill warn">${d.comunicacionesPendientes}</span>
      </div>
    </div>
    ` : ''}

    ${renderTuDiaCard(d)}

    <div class="card">
      <h2>¿Qué requiere tu atención?${currentAttentionItems.length ? ` <span class="pill warn" style="font-weight:400;">${currentAttentionItems.length}</span>` : ''}</h2>
      ${currentAttentionItems.length ? currentAttentionItems.map((item, idx) => renderAttentionItem(item, idx)).join('') : `<p class="empty-hint">Estás al día — nada pendiente por ahora. Podés crear una mediación nueva o revisar la agenda.</p>`}
      ${moreHearings ? `<p class="empty-hint" style="margin-top:6px;"><a href="#" onclick="event.preventDefault(); goTo('agenda');" style="color:var(--calm);">Ver todas las audiencias en la agenda</a></p>` : ''}
    </div>

    ${(d.vencenProximamente.tareas.length || d.vencenProximamente.compromisos.length) ? `
    <div class="card">
      <h2>Vencen próximamente</h2>
      ${d.vencenProximamente.tareas.map(t => `
        <div class="alert-row" onclick="goTo('detail','${t.mediationId}')">
          <div><div style="font-weight:600; font-size:13.5px;">${escapeHtml(t.title)}</div><div class="code">${escapeHtml(t.mediationCode)}</div></div>
          <span class="pill calm">vence ${fmtDate(t.dueDate)}</span>
        </div>
      `).join('')}
      ${d.vencenProximamente.compromisos.map(c => `
        <div class="alert-row" onclick="goTo('detail','${c.mediationId}')">
          <div><div style="font-weight:600; font-size:13.5px;">${escapeHtml(c.partyName)}: ${escapeHtml(c.description)}</div><div class="code">${escapeHtml(c.mediationCode)}</div></div>
          <span class="pill calm">vence ${fmtDate(c.dueDate)}</span>
        </div>
      `).join('')}
    </div>
    ` : ''}

    <div class="card">
      <h2>Qué pasó</h2>
      ${d.actividadReciente.length ? d.actividadReciente.map(e => `
        <div class="status-history-item">
          <strong>${escapeHtml(e.mediationCode)}</strong> —
          ${escapeHtml(EVENT_TYPE_LABELS[e.type] || e.type)}${e.title ? ': ' + escapeHtml(e.title) : ''}
          <span style="color:var(--text-faint);">· ${fmtDateTime(e.createdAt)}</span>
        </div>
      `).join('') : `<p class="empty-hint">Todavía no hay actividad.</p>`}
    </div>

    <div class="card">
      <h2>Preguntale al asistente</h2>
      <div id="dashboard-assistant-answer" style="margin-bottom:8px;"></div>
      <div style="display:flex; gap:6px;">
        <input id="dashboard-assistant-question" placeholder="Ej: ¿qué tengo pendiente esta semana?" style="flex:1; margin:0;">
        <button class="primary" style="flex-shrink:0;" onclick="askDashboardAI()">Preguntar</button>
      </div>
    </div>

    <button class="primary" style="width:100%;" onclick="goTo('new')">+ Nueva mediación</button>
  `;
}

// ================= LISTA =================
// ================= ESTADÍSTICAS =================
const CLOSE_RESULT_LABELS = { acuerdo_total:'Acuerdo total', acuerdo_parcial:'Acuerdo parcial', sin_acuerdo:'Sin acuerdo', incomparecencia:'Incomparecencia', desistimiento:'Desistimiento', otro:'Otro' };

async function renderStats(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let s;
  try{ s = await api('/api/mediations/stats'); }
  catch(e){ main.innerHTML = `<p class="empty-hint">No se pudieron cargar las estadísticas.</p>`; return; }

  const maxMonthly = Math.max(1, ...s.productividadMensual.map(m => m.count));
  const monthLabel = (ym) => { const [y,m] = ym.split('-'); return ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][Number(m)-1] + ' ' + y.slice(2); };

  main.innerHTML = `
    <h1>Estadísticas</h1>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:18px;">Sobre todas tus mediaciones.</p>

    <div class="card">
      <div class="stat-row">
        <div><div class="stat">${s.counts.total}</div><div class="stat-label">total</div></div>
        <div><div class="stat">${s.counts.activas}</div><div class="stat-label">activas</div></div>
        <div><div class="stat">${s.counts.cerradas}</div><div class="stat-label">cerradas</div></div>
      </div>
    </div>

    <div class="card">
      <h2>Tasa de acuerdo</h2>
      ${s.tasaDeAcuerdo === null ? `<p class="empty-hint">Todavía no hay mediaciones cerradas.</p>` : `
        <div class="stat">${Math.round(s.tasaDeAcuerdo*100)}%</div>
        <div class="stat-label" style="margin-bottom:10px;">de las cerradas terminaron en algún acuerdo</div>
        ${Object.keys(s.porResultado).map(r => `
          <div style="display:flex; justify-content:space-between; font-size:12px; padding:4px 0; border-bottom:1px solid var(--line);">
            <span>${CLOSE_RESULT_LABELS[r] || r}</span><span>${s.porResultado[r]}</span>
          </div>
        `).join('')}
      `}
    </div>

    <div class="card">
      <h2>Duración promedio</h2>
      ${s.duracionPromedioDias === null ? `<p class="empty-hint">Todavía no hay mediaciones cerradas.</p>` : `
        <div class="stat">${s.duracionPromedioDias < 1 ? '< 1' : Math.round(s.duracionPromedioDias)}</div>
        <div class="stat-label">días, desde que se crea hasta que se cierra</div>
      `}
    </div>

    <div class="card">
      <h2>Productividad — mediaciones creadas por mes</h2>
      <div style="display:flex; align-items:flex-end; gap:8px; height:100px; margin-top:10px;">
        ${s.productividadMensual.map(m => `
          <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:4px;">
            <div style="width:100%; background:var(--calm); border-radius:4px 4px 0 0; height:${Math.max(4, (m.count/maxMonthly)*80)}px;"></div>
            <span style="font-size:9px; color:var(--text-faint);">${monthLabel(m.month)}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Tareas y compromisos</h2>
      <div class="stat-row">
        <div><div class="stat">${s.tareas.completadas}/${s.tareas.total}</div><div class="stat-label">tareas completadas</div></div>
        <div><div class="stat">${s.compromisos.cumplidos}/${s.compromisos.total}</div><div class="stat-label">compromisos cumplidos</div></div>
        <div><div class="stat">${s.compromisos.vencidos}</div><div class="stat-label">compromisos vencidos</div></div>
      </div>
    </div>
  `;
}

let listFilters = { estado: '', responsable: '', responsableNombre: '', mediador: '', vencidas: '' };

// ================= EQUIPO / ESTUDIO =================
const STUDIO_ROLE_LABELS = { admin:'Administrador/a', mediador:'Mediador/a', asistente:'Asistente' };

let studioMediationFilters = { mediador: '', asistente: '', estado: '', nextActionVencida: '', audienciaProxima: '', sinAsignar: '' };

async function renderStudioMediations(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let studio;
  try{ studio = await api('/api/studios/me'); }catch(e){ studio = null; }
  if(!studio || studio.myRole !== 'admin'){
    main.innerHTML = `<p class="empty-hint">Esta vista es solo para administradores de estudio.</p>`;
    return;
  }

  const params = new URLSearchParams();
  if(studioMediationFilters.mediador) params.set('mediador', studioMediationFilters.mediador);
  if(studioMediationFilters.asistente) params.set('asistente', studioMediationFilters.asistente);
  if(studioMediationFilters.estado) params.set('estado', studioMediationFilters.estado);
  if(studioMediationFilters.nextActionVencida) params.set('nextActionVencida', '1');
  if(studioMediationFilters.audienciaProxima) params.set('audienciaProxima', '1');
  if(studioMediationFilters.sinAsignar) params.set('sinAsignar', '1');

  let list;
  try{ list = await api('/api/mediations/studio?' + params.toString()); }
  catch(e){ main.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo cargar la vista.')}</p>`; return; }

  main.innerHTML = `
    <span class="back-link" onclick="goTo('team')">← Equipo</span>
    <h1>Mediaciones del estudio</h1>

    <div class="card">
      <label>Mediador/a responsable</label>
      <select id="filter-sm-mediador" onchange="applyStudioMediationFilters()">
        <option value="">Todos</option>
        ${studio.members.map(m => `<option value="${m.id}" ${studioMediationFilters.mediador===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}
      </select>
      <label>Estado</label>
      <select id="filter-sm-estado" onchange="applyStudioMediationFilters()">
        <option value="">Todos</option>
        ${Object.keys(STATUS_LABELS).map(s => `<option value="${s}" ${studioMediationFilters.estado===s?'selected':''}>${STATUS_LABELS[s]}</option>`).join('')}
      </select>
      <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
        <input type="checkbox" id="filter-sm-vencida" style="width:auto;" ${studioMediationFilters.nextActionVencida?'checked':''} onchange="applyStudioMediationFilters()">
        Próxima acción vencida
      </label>
      <label style="display:flex; align-items:center; gap:6px; margin-top:4px;">
        <input type="checkbox" id="filter-sm-audiencia" style="width:auto;" ${studioMediationFilters.audienciaProxima?'checked':''} onchange="applyStudioMediationFilters()">
        Con audiencia próxima
      </label>
      <label style="display:flex; align-items:center; gap:6px; margin-top:4px;">
        <input type="checkbox" id="filter-sm-sinasignar" style="width:auto;" ${studioMediationFilters.sinAsignar?'checked':''} onchange="applyStudioMediationFilters()">
        Sin usuario asignado adicional
      </label>
    </div>

    ${list.length ? list.map(m => `
      <div class="card">
        <div class="eyebrow">${escapeHtml(m.code)}</div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px; cursor:pointer;" onclick="goTo('detail','${m.id}')">${escapeHtml(m.object)}</strong>
          <span class="pill calm">${STATUS_LABELS[m.status] || m.status}</span>
        </div>
        <div style="font-size:12px; color:var(--text-dim); margin-top:4px;">
          Propietario/a: ${escapeHtml(m.mediatorName || '—')}
          ${m.upcomingHearingDate ? `<br>Próxima audiencia: ${fmtDate(m.upcomingHearingDate)}${m.alerts.hearingUnconfirmed ? ' <span class="pill warn">sin confirmar</span>' : ''}` : ''}
          ${m.nextActionText ? `<br>Próxima acción: ${escapeHtml(m.nextActionText)}${m.alerts.nextActionVencida ? ' <span class="pill danger">vencida</span>' : ''}` : ''}
        </div>
        <div style="margin-top:8px;">
          ${m.assigned.length ? m.assigned.map(a => `
            <span class="pill calm" style="margin-right:4px;">${escapeHtml(a.userName)} (${STUDIO_ROLE_LABELS[a.role]}) <a href="#" onclick="revokeFromStudioView('${m.id}','${a.accessId}'); return false;" style="color:var(--danger); text-decoration:none;">✕</a></span>
          `).join('') : `<span class="empty-hint">Sin asignaciones adicionales</span>`}
        </div>
        <div style="margin-top:8px; display:flex; gap:6px;">
          <select id="assign-sm-${m.id}" style="width:auto;">
            ${studio.members.filter(mem => mem.id !== m.mediatorUserId && !m.assigned.some(a => a.userId === mem.id)).map(mem => `<option value="${mem.id}">${escapeHtml(mem.name)}</option>`).join('')}
          </select>
          <select id="assign-sm-role-${m.id}" style="width:auto;">
            <option value="mediador">Mediador/a</option>
            <option value="asistente">Asistente</option>
          </select>
          <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="assignFromStudioView('${m.id}')">Asignar</button>
        </div>
      </div>
    `).join('') : `<p class="empty-hint">Ninguna mediación coincide con estos filtros.</p>`}
  `;
}

function applyStudioMediationFilters(){
  studioMediationFilters.mediador = document.getElementById('filter-sm-mediador').value;
  studioMediationFilters.estado = document.getElementById('filter-sm-estado').value;
  studioMediationFilters.nextActionVencida = document.getElementById('filter-sm-vencida').checked;
  studioMediationFilters.audienciaProxima = document.getElementById('filter-sm-audiencia').checked;
  studioMediationFilters.sinAsignar = document.getElementById('filter-sm-sinasignar').checked;
  renderStudioMediations();
}

async function assignFromStudioView(mediationId){
  const userId = document.getElementById(`assign-sm-${mediationId}`).value;
  const role = document.getElementById(`assign-sm-role-${mediationId}`).value;
  if(!userId){ showToast('No hay nadie más del estudio para asignar.', 'danger'); return; }
  try{
    await api(`/api/mediations/${mediationId}/access`, { method:'POST', body: JSON.stringify({ userId, role }) });
    renderStudioMediations();
  }catch(e){ showToast(e.error || 'No se pudo asignar.', 'danger'); }
}

async function revokeFromStudioView(mediationId, accessId){
  try{
    await api(`/api/mediations/${mediationId}/access/${accessId}`, { method:'DELETE' });
    renderStudioMediations();
  }catch(e){ showToast(e.error || 'No se pudo quitar el acceso.', 'danger'); }
}

// ================= AGENDA =================
const DAY_NAMES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
let agendaState = { view: 'week', date: new Date().toISOString().slice(0,10), mediador:'', estado:'', modalidad:'', confirmacionPendiente:'' };

function todayISO(){ return new Date().toISOString().slice(0,10); }

async function renderAgenda(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;

  const params = new URLSearchParams({ view: agendaState.view, date: agendaState.date });
  if(agendaState.mediador) params.set('mediador', agendaState.mediador);
  if(agendaState.estado) params.set('estado', agendaState.estado);
  if(agendaState.modalidad) params.set('modalidad', agendaState.modalidad);
  if(agendaState.confirmacionPendiente) params.set('confirmacionPendiente', '1');

  let data;
  try{ data = await api('/api/agenda?' + params.toString()); }
  catch(e){ main.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo cargar la agenda.')}</p>`; return; }

  let studio = null;
  try{ studio = await api('/api/studios/me'); }catch(e){}

  // agrupar por dia para la vista semanal
  const byDate = {};
  data.hearings.forEach(h => { (byDate[h.date] = byDate[h.date] || []).push(h); });
  const days = agendaState.view === 'week'
    ? Array.from({length:7}, (_,i) => { const d = new Date(data.rangeStart+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+i); return d.toISOString().slice(0,10); })
    : [agendaState.date];

  main.innerHTML = `
    <h1>Agenda</h1>
    <div class="card">
      <div style="display:flex; gap:6px; margin-bottom:10px;">
        <button class="ghost" style="flex:1; ${agendaState.view==='day'?'background:var(--calm-dim); color:var(--calm);':''}" onclick="setAgendaView('day')">Día</button>
        <button class="ghost" style="flex:1; ${agendaState.view==='week'?'background:var(--calm-dim); color:var(--calm);':''}" onclick="setAgendaView('week')">Semana</button>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <button class="ghost" onclick="shiftAgendaDate(${agendaState.view==='week'?-7:-1})">←</button>
        <input type="date" id="agenda-date" value="${agendaState.date}" onchange="jumpAgendaDate(this.value)" style="flex:1; margin:0;">
        <button class="ghost" onclick="shiftAgendaDate(${agendaState.view==='week'?7:1})">→</button>
      </div>
      <p class="empty-hint" style="margin-top:6px;">${data.rangeStart === data.rangeEnd ? fmtDate(data.rangeStart) : fmtDate(data.rangeStart) + ' – ' + fmtDate(data.rangeEnd)}</p>
    </div>

    <div class="card">
      <h2>Ver en tu calendario</h2>
      <p class="empty-hint" style="margin-top:-4px; margin-bottom:10px;">Suscribite una vez y tus audiencias (programadas, confirmadas o realizadas) aparecen solas en Google Calendar, Apple Calendar u Outlook — de solo lectura, se actualiza sola.</p>
      <button class="ghost" style="width:100%;" onclick="openIcsFeedLink()">Suscribirme en mi calendario</button>
      <p style="margin-top:8px; text-align:center;"><a href="#" onclick="event.preventDefault(); regenerateIcsFeedLink();" style="color:var(--text-faint); font-size:11px;">¿Se filtró el link? Generar uno nuevo</a></p>
    </div>

    <div class="card">
      ${studio ? `
        <label>Mediador/a responsable</label>
        <select id="filter-ag-mediador" onchange="applyAgendaFilters()">
          <option value="">Todos</option>
          ${studio.members.map(m => `<option value="${m.id}" ${agendaState.mediador===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
      ` : ''}
      <label>Estado</label>
      <select id="filter-ag-estado" onchange="applyAgendaFilters()">
        <option value="">Todos</option>
        ${Object.keys(HEARING_STATUS_LABELS).map(s => `<option value="${s}" ${agendaState.estado===s?'selected':''}>${HEARING_STATUS_LABELS[s]}</option>`).join('')}
      </select>
      <label>Modalidad</label>
      <select id="filter-ag-modalidad" onchange="applyAgendaFilters()">
        <option value="">Todas</option>
        <option value="presencial" ${agendaState.modalidad==='presencial'?'selected':''}>Presencial</option>
        <option value="virtual" ${agendaState.modalidad==='virtual'?'selected':''}>Virtual</option>
        <option value="hibrida" ${agendaState.modalidad==='hibrida'?'selected':''}>Híbrida</option>
      </select>
      <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
        <input type="checkbox" id="filter-ag-pendiente" style="width:auto;" ${agendaState.confirmacionPendiente?'checked':''} onchange="applyAgendaFilters()">
        Solo con confirmación pendiente
      </label>
    </div>

    ${days.map(day => `
      <div class="card">
        <h2>${DAY_NAMES[new Date(day+'T00:00:00Z').getUTCDay()]} ${fmtDate(day)}</h2>
        ${(byDate[day]||[]).length ? byDate[day].map(h => `
          <div class="status-history-item" style="cursor:pointer;" onclick="goTo('detail','${h.mediationId}')">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>${h.startTime || '—'}${h.endTime ? '–'+h.endTime : ''}</strong>
              <span class="pill calm">${HEARING_STATUS_LABELS[h.status] || h.status}</span>
            </div>
            <div style="font-size:12px; color:var(--text-dim);">
              ${escapeHtml(h.mediationCode)} — ${escapeHtml(h.mediationObject)}
              <br>${h.mediatorName ? 'Responsable: '+escapeHtml(h.mediatorName)+' · ' : ''}${h.modality}
            </div>
            <div style="margin-top:4px;">
              <span class="pill ${h.confirmationSummary==='todas'?'calm':h.confirmationSummary==='ninguna'||h.confirmationSummary==='pendientes'?'warn':'warn'}">${AGENDA_CONFIRMATION_LABELS[h.confirmationSummary]||h.confirmationSummary}</span>
              ${h.alerts.recentlyRescheduled ? '<span class="pill warn">reprogramada</span>' : ''}
            </div>
          </div>
        `).join('') : `<p class="empty-hint">Sin audiencias.</p>`}
      </div>
    `).join('')}

    <div class="card">
      <button class="primary" style="width:100%;" onclick="goTo('requests')">Solicitudes de cambio</button>
    </div>

    <div class="card">
      <h2>Disponibilidad y bloqueos</h2>
      <button class="ghost" style="width:100%;" onclick="toggleAvailabilityPanel()">Configurar</button>
      <div id="availability-panel" style="display:none; margin-top:10px;"></div>
    </div>
  `;
}

const AGENDA_CONFIRMATION_LABELS = { todas:'Todas confirmaron', algunas:'Algunas confirmaron', ninguna:'Ninguna confirmó', pendientes:'Pendientes' };

function setAgendaView(view){ agendaState.view = view; renderAgenda(); }
function shiftAgendaDate(days){
  const d = new Date(agendaState.date+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+days);
  agendaState.date = d.toISOString().slice(0,10);
  renderAgenda();
}
function jumpAgendaDate(value){ agendaState.date = value; renderAgenda(); }
function applyAgendaFilters(){
  const medField = document.getElementById('filter-ag-mediador');
  agendaState.mediador = medField ? medField.value : '';
  agendaState.estado = document.getElementById('filter-ag-estado').value;
  agendaState.modalidad = document.getElementById('filter-ag-modalidad').value;
  agendaState.confirmacionPendiente = document.getElementById('filter-ag-pendiente').checked;
  renderAgenda();
}

// feed ICS de solo lectura — el token se genera server-side la primera vez
// que se pide (GET /feed-token es idempotente: si ya existe, devuelve el
// mismo). Mismo patrón de "mostrar el link en un prompt para copiar" que
// ya se usa para los links de portal de parte/abogado y de invitación a
// estudio, no hace falta inventar un modal nuevo para esto.
async function openIcsFeedLink(){
  let data;
  try{ data = await api('/api/agenda/feed-token'); }
  catch(e){ showToast(e.error || 'No se pudo generar el link.', 'danger'); return; }
  const fullUrl = location.origin + data.url;
  copyLinkToClipboard(fullUrl, 'Link copiado — agregalo en tu calendario como "suscribirse por URL".');
}

// invalida la URL vieja — para cuando se compartió por error o el
// mediador simplemente quiere cortar una suscripción activa.
async function regenerateIcsFeedLink(){
  if(!confirm('¿Generar un link nuevo? El anterior deja de funcionar — cualquier calendario ya suscripto con ese link va a dejar de actualizarse.')) return;
  let data;
  try{ data = await api('/api/agenda/feed-token/regenerate', { method:'POST' }); }
  catch(e){ showToast(e.error || 'No se pudo generar el link.', 'danger'); return; }
  copyLinkToClipboard(location.origin + data.url, 'Link nuevo copiado — el anterior ya no funciona.');
}

// ================= BANDEJA DE SOLICITUDES =================
let requestsFilter = { estado: 'pendientes' };
const REQUEST_STATUS_LABELS = { pendiente:'Pendiente', aceptada:'Aceptada', rechazada:'Rechazada', resuelta:'Resuelta sin cambio' };

async function renderRequests(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  const params = new URLSearchParams();
  if(requestsFilter.estado) params.set('estado', requestsFilter.estado);
  let list;
  try{ list = await api('/api/agenda/requests?' + params.toString()); }
  catch(e){ main.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo cargar.')}</p>`; return; }

  main.innerHTML = `
    <span class="back-link" onclick="goTo('agenda')">← Agenda</span>
    <h1>Solicitudes de cambio</h1>
    <div class="card">
      <select id="filter-req-estado" onchange="applyRequestsFilter()">
        <option value="pendientes" ${requestsFilter.estado==='pendientes'?'selected':''}>Pendientes</option>
        <option value="resueltas" ${requestsFilter.estado==='resueltas'?'selected':''}>Resueltas</option>
        <option value="" ${requestsFilter.estado===''?'selected':''}>Todas</option>
      </select>
    </div>
    ${list.length ? list.map(r => `
      <div class="card">
        <div class="eyebrow">${escapeHtml(r.mediationCode)}</div>
        <strong style="font-size:13.5px;">${escapeHtml(r.mediationObject)}</strong>
        <div style="font-size:12px; color:var(--text-dim); margin-top:4px;">
          Audiencia: ${fmtDate(r.hearingDate)}${r.hearingStartTime ? ' ' + r.hearingStartTime : ''} · pedido por ${escapeHtml(r.requestedByPartyName || '—')} (${r.requestedByType === 'lawyer' ? 'abogado' : 'parte'})
          <br>Antigüedad: ${Math.floor(r.ageMs / (1000*60*60))}h
        </div>
        ${r.reason ? `<p style="font-size:12.5px; margin:6px 0 0;">Motivo: ${escapeHtml(r.reason)}</p>` : ''}
        ${r.comment ? `<p style="font-size:12.5px; margin:2px 0 0;">Comentario: ${escapeHtml(r.comment)}</p>` : ''}
        ${r.preferredDayText || r.preferredTimeText ? `<p style="font-size:12.5px; margin:2px 0 0;">Preferencia: ${escapeHtml(r.preferredDayText||'')} ${escapeHtml(r.preferredTimeText||'')}</p>` : ''}
        ${r.proposedDate ? `<p style="font-size:12.5px; margin:2px 0 0;">Propuso: ${fmtDate(r.proposedDate)}${r.proposedStartTime ? ' ' + r.proposedStartTime : ''}</p>` : ''}
        <span class="pill ${r.status==='pendiente'?'warn':r.status==='rechazada'?'danger':'calm'}" style="margin-top:6px; display:inline-block;">${REQUEST_STATUS_LABELS[r.status]}</span>
        ${r.status === 'pendiente' ? `
          <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            ${r.proposedDate ? `<button class="primary" style="padding:6px 10px; font-size:11px;" onclick="resolveFromInbox('${r.mediationId}','${r.hearingId}','${r.id}','aceptar')">Aceptar fecha propuesta</button>` : ''}
            <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="resolveFromInbox('${r.mediationId}','${r.hearingId}','${r.id}','rechazar')">Rechazar</button>
            <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="resolveFromInbox('${r.mediationId}','${r.hearingId}','${r.id}','resolver_sin_cambio')">Resolver sin cambio</button>
            <input id="propose-inbox-date-${r.id}" type="date" style="width:auto;">
            <input id="propose-inbox-time-${r.id}" type="time" style="width:auto;">
            <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="resolveFromInbox('${r.mediationId}','${r.hearingId}','${r.id}','proponer')">Proponer esta fecha</button>
          </div>
        ` : ''}
      </div>
    `).join('') : `<p class="empty-hint">Sin solicitudes.</p>`}
  `;
}

function applyRequestsFilter(){
  requestsFilter.estado = document.getElementById('filter-req-estado').value;
  renderRequests();
}

async function resolveFromInbox(mediationId, hearingId, requestId, action){
  const body = { action };
  if(action === 'proponer'){
    body.newDate = document.getElementById(`propose-inbox-date-${requestId}`).value;
    body.newStartTime = document.getElementById(`propose-inbox-time-${requestId}`).value || null;
    if(!body.newDate){ showToast('Falta la fecha para proponer.', 'danger'); return; }
  }
  try{
    const result = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/reschedule-requests/${requestId}/resolve`, { method:'POST', body: JSON.stringify(body) });
    const notifText = describeNotifications(result.notifications);
    if(notifText) alert(`Solicitud resuelta.\n\n${notifText}`);
    renderRequests();
  }catch(e){ showToast(e.error || 'No se pudo resolver la solicitud.', 'danger'); }
}

async function toggleAvailabilityPanel(){
  const box = document.getElementById('availability-panel');
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  await loadAvailabilityPanel();
}

async function loadAvailabilityPanel(){
  const box = document.getElementById('availability-panel');
  let availability, blocks;
  try{
    [availability, blocks] = await Promise.all([api('/api/agenda/availability'), api('/api/agenda/blocks')]);
  }catch(e){ box.innerHTML = `<p class="empty-hint">No se pudo cargar.</p>`; return; }

  box.innerHTML = `
    <h2 style="font-size:14px;">Disponibilidad semanal</h2>
    ${availability.length ? availability.map(a => `
      <div class="status-history-item" style="display:flex; justify-content:space-between; align-items:center;">
        <span>${DAY_NAMES[a.dayOfWeek]}: ${a.startTime}–${a.endTime}</span>
        <button class="ghost" style="padding:4px 8px; font-size:10px;" onclick="deleteAvailability('${a.id}')">✕</button>
      </div>
    `).join('') : `<p class="empty-hint">Sin disponibilidad configurada — no se restringe ningún horario.</p>`}
    <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center;">
      <select id="avail-day" style="width:auto;">
        ${DAY_NAMES.map((d,i) => `<option value="${i}">${d}</option>`).join('')}
      </select>
      <input id="avail-start" type="time" style="width:auto;" value="09:00">
      <input id="avail-end" type="time" style="width:auto;" value="18:00">
      <button class="ghost" onclick="addAvailability()">Agregar</button>
    </div>

    <h2 style="font-size:14px; margin-top:16px;">Bloqueos puntuales</h2>
    ${blocks.length ? blocks.map(b => `
      <div class="status-history-item" style="display:flex; justify-content:space-between; align-items:center;">
        <span>${fmtDate(b.date)} ${b.startTime}–${b.endTime}${b.reason ? ' · '+escapeHtml(b.reason) : ''}</span>
        <button class="ghost" style="padding:4px 8px; font-size:10px;" onclick="deleteBlock('${b.id}')">✕</button>
      </div>
    `).join('') : `<p class="empty-hint">Sin bloqueos cargados.</p>`}
    <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center;">
      <input id="block-date" type="date" style="width:auto;">
      <input id="block-start" type="time" style="width:auto;">
      <input id="block-end" type="time" style="width:auto;">
      <input id="block-reason" placeholder="Motivo (interno)" style="width:auto;">
      <button class="ghost" onclick="addBlock()">Bloquear</button>
    </div>
  `;
}

async function addAvailability(){
  try{
    await api('/api/agenda/availability', { method:'POST', body: JSON.stringify({
      dayOfWeek: Number(document.getElementById('avail-day').value),
      startTime: document.getElementById('avail-start').value,
      endTime: document.getElementById('avail-end').value,
    })});
    loadAvailabilityPanel();
  }catch(e){ showToast(e.error || 'No se pudo agregar.', 'danger'); }
}
async function deleteAvailability(id){
  try{ await api(`/api/agenda/availability/${id}`, { method:'DELETE' }); loadAvailabilityPanel(); }
  catch(e){ showToast(e.error || 'No se pudo quitar.', 'danger'); }
}
async function addBlock(){
  try{
    await api('/api/agenda/blocks', { method:'POST', body: JSON.stringify({
      date: document.getElementById('block-date').value,
      startTime: document.getElementById('block-start').value,
      endTime: document.getElementById('block-end').value,
      reason: document.getElementById('block-reason').value.trim() || null,
    })});
    loadAvailabilityPanel();
  }catch(e){ showToast(e.error || 'No se pudo bloquear.', 'danger'); }
}
async function deleteBlock(id){
  try{ await api(`/api/agenda/blocks/${id}`, { method:'DELETE' }); loadAvailabilityPanel(); }
  catch(e){ showToast(e.error || 'No se pudo quitar.', 'danger'); }
}

async function renderTeam(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let studio;
  try{ studio = await api('/api/studios/me'); }
  catch(e){ main.innerHTML = `<p class="empty-hint">No se pudo cargar el equipo.</p>`; return; }

  if(!studio){
    main.innerHTML = `
      <h1>Equipo</h1>
      <p style="color:var(--text-dim); font-size:13px; margin-bottom:18px;">Todavía trabajás como mediador/a independiente.</p>
      <div class="card">
        <h2>Crear un estudio</h2>
        <label>Nombre del estudio</label>
        <input id="new-studio-name" placeholder="Ej: Estudio Pérez & Asociados">
        <button class="primary" style="width:100%;" onclick="createStudio()">Crear</button>
      </div>
    `;
    return;
  }

  const isAdmin = studio.myRole === 'admin';
  const isOwner = me && me.id === studio.ownerId;
  const isInactive = studio.status !== 'activo';
  let invitations = [];
  if(isAdmin && !isInactive){
    try{ invitations = await api('/api/studios/invitations'); }catch(e){}
  }
  const ownerMember = studio.members.find(m => m.id === studio.ownerId);

  main.innerHTML = `
    <h1>${escapeHtml(studio.name)} ${isInactive ? '<span class="pill danger">Dado de baja</span>' : '<span class="pill calm">Activo</span>'}</h1>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:18px;">
      Tu rol: ${STUDIO_ROLE_LABELS[studio.myRole] || studio.myRole}${ownerMember ? ' · Propietario/a: ' + escapeHtml(ownerMember.name) : ''}
    </p>

    ${isAdmin && !isInactive ? `<button class="primary" style="width:100%; margin-bottom:14px;" onclick="goTo('studioMediations')">Ver mediaciones del estudio</button>` : ''}

    <div class="card">
      <h2>Miembros</h2>
      ${studio.members.map(m => `
        <div class="status-history-item">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${escapeHtml(m.name)}</strong>
              <br><span style="color:var(--text-faint);">${escapeHtml(m.email)} · ${STUDIO_ROLE_LABELS[m.studioRole] || m.studioRole}</span>
            </div>
            ${isAdmin && m.id !== studio.ownerId ? `
              <div style="display:flex; gap:6px;">
                <select onchange="changeStudioRole('${m.id}',this.value)" style="width:auto; margin:0;">
                  ${Object.keys(STUDIO_ROLE_LABELS).map(r => `<option value="${r}" ${r===m.studioRole?'selected':''}>${STUDIO_ROLE_LABELS[r]}</option>`).join('')}
                </select>
                <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="removeStudioMember('${m.id}')">Quitar</button>
              </div>
            ` : m.id === studio.ownerId ? `<span class="pill calm">Propietario/a</span>` : ''}
          </div>
        </div>
      `).join('')}
    </div>

    ${isOwner && !isInactive ? `
    <div class="card">
      <h2>Transferir propiedad</h2>
      <p class="empty-hint" style="margin-bottom:8px;">La persona elegida pasa a ser propietaria y admin. Vos te quedás como admin, no perdés acceso.</p>
      <select id="transfer-target">
        ${studio.members.filter(m => m.id !== studio.ownerId).map(m => `<option value="${m.id}">${escapeHtml(m.name)} (${STUDIO_ROLE_LABELS[m.studioRole]})</option>`).join('')}
      </select>
      <button class="ghost" style="width:100%;" onclick="transferOwnership()">Transferir</button>
    </div>

    <div class="card">
      <h2>Dar de baja el estudio</h2>
      <p class="empty-hint" style="margin-bottom:8px;">No se borra nada — el estudio queda inactivo, los datos históricos se conservan. Se bloquea si hay mediaciones activas sin cerrar.</p>
      <button class="ghost" style="width:100%; background:var(--danger-dim); color:var(--danger); border-color:var(--danger);" onclick="deactivateStudio()">Dar de baja</button>
    </div>
    ` : ''}

    ${me && me.id !== studio.ownerId && !isInactive ? `
    <div class="card">
      <h2>Abandonar el estudio</h2>
      <p class="empty-hint" style="margin-bottom:8px;">Si tenés mediaciones activas a tu nombre, primero hay que reasignarlas — te vamos a avisar cuáles si corresponde.</p>
      <button class="ghost" style="width:100%; background:var(--danger-dim); color:var(--danger); border-color:var(--danger);" onclick="leaveStudio()">Abandonar estudio</button>
    </div>
    ` : ''}

    ${isAdmin && !isInactive ? `
    <div class="card">
      <h2>Invitar a alguien</h2>
      <label>Email (tiene que ser su cuenta de Google)</label>
      <input id="invite-email" placeholder="persona@estudio.com">
      <label>Rol</label>
      <select id="invite-role">
        <option value="mediador">Mediador/a</option>
        <option value="asistente">Asistente</option>
        <option value="admin">Administrador/a</option>
      </select>
      <button class="primary" style="width:100%;" onclick="inviteToStudio()">Invitar</button>
    </div>

    <div class="card">
      <h2>Invitaciones</h2>
      ${invitations.length ? invitations.map(i => `
        <div class="status-history-item">
          ${escapeHtml(i.email)} — ${STUDIO_ROLE_LABELS[i.role] || i.role}
          <span class="pill ${i.status==='pendiente'?'warn':i.status==='rechazada'?'danger':'calm'}">${i.status}</span>
        </div>
      `).join('') : `<p class="empty-hint">Sin invitaciones enviadas.</p>`}
    </div>
    ` : ''}
  `;
}

async function transferOwnership(){
  const targetId = document.getElementById('transfer-target').value;
  if(!targetId){ showToast('No hay nadie más en el estudio para transferir la propiedad.', 'danger'); return; }
  if(!confirm('¿Seguro que querés transferir la propiedad del estudio a esta persona? No vas a poder deshacerlo vos mismo.')) return;
  try{
    await api('/api/studios/transfer-ownership', { method:'POST', body: JSON.stringify({ newOwnerId: targetId }) });
    renderTeam();
  }catch(e){ showToast(e.error || 'No se pudo transferir la propiedad.', 'danger'); }
}

async function deactivateStudio(){
  if(!confirm('¿Seguro que querés dar de baja el estudio? No se borra nada, pero no se van a poder hacer más invitaciones ni asignaciones.')) return;
  try{
    await api('/api/studios/deactivate', { method:'POST' });
    renderTeam();
  }catch(e){
    if(e.mediations){
      alert('No se puede dar de baja todavía — hay mediaciones activas en el estudio:\n\n' + e.mediations.map(m => `${m.code}: ${m.object}`).join('\n'));
    } else {
      showToast(e.error || 'No se pudo dar de baja el estudio.', 'danger');
    }
  }
}

async function leaveStudio(){
  if(!confirm('¿Seguro que querés abandonar el estudio?')) return;
  try{
    await api('/api/studios/leave', { method:'POST' });
    showToast('Abandonaste el estudio.', 'success');
    renderTeam();
  }catch(e){
    if(e.mediations){
      alert('No podés abandonar todavía — tenés estas mediaciones activas a tu nombre, hay que reasignarlas primero:\n\n' + e.mediations.map(m => `${m.code}: ${m.object}`).join('\n'));
    } else {
      showToast(e.error || 'No se pudo abandonar el estudio.', 'danger');
    }
  }
}

async function createStudio(){
  const name = document.getElementById('new-studio-name').value.trim();
  if(!name){ showToast('Falta el nombre.', 'danger'); return; }
  try{
    await api('/api/studios', { method:'POST', body: JSON.stringify({ name }) });
    renderTeam();
  }catch(e){ showToast(e.error || 'No se pudo crear el estudio.', 'danger'); }
}

async function inviteToStudio(){
  const email = document.getElementById('invite-email').value.trim();
  const role = document.getElementById('invite-role').value;
  if(!email){ showToast('Falta el email.', 'danger'); return; }
  try{
    const result = await api('/api/studios/invitations', { method:'POST', body: JSON.stringify({ email, role }) });
    const fullUrl = location.origin + result.invitationUrl;
    copyLinkToClipboard(fullUrl, 'Link de invitación copiado.');
    renderTeam();
  }catch(e){ showToast(e.error || 'No se pudo enviar la invitación.', 'danger'); }
}

async function changeStudioRole(userId, role){
  try{
    await api(`/api/studios/members/${userId}/role`, { method:'PATCH', body: JSON.stringify({ role }) });
    renderTeam();
  }catch(e){ showToast(e.error || 'No se pudo cambiar el rol.', 'danger'); renderTeam(); }
}

async function removeStudioMember(userId){
  if(!confirm('¿Quitar a esta persona del estudio?')) return;
  try{
    await api(`/api/studios/members/${userId}`, { method:'DELETE' });
    renderTeam();
  }catch(e){ showToast(e.error || 'No se pudo quitar a la persona.', 'danger'); }
}

async function renderList(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  const params = new URLSearchParams();
  if(listFilters.estado) params.set('estado', listFilters.estado);
  if(listFilters.responsable) params.set('responsable', listFilters.responsable);
  if(listFilters.responsableNombre) params.set('responsableNombre', listFilters.responsableNombre);
  if(listFilters.mediador) params.set('mediador', listFilters.mediador);
  if(listFilters.vencidas) params.set('vencidas', '1');
  let list;
  try{ list = await api('/api/mediations?' + params.toString()); }
  catch(e){ main.innerHTML = `<p class="empty-hint">No se pudo cargar la lista.</p>`; return; }
  let studio = null;
  try{ studio = await api('/api/studios/me'); }catch(e){}

  main.innerHTML = `
    <h1>Mediaciones</h1>
    <button class="primary" style="width:100%; margin-bottom:16px;" onclick="goTo('new')">+ Nueva mediación</button>

    <div class="card">
      <label>Estado</label>
      <select id="filter-estado" onchange="applyListFilters()">
        <option value="">Todos</option>
        ${Object.keys(STATUS_LABELS).map(s => `<option value="${s}" ${listFilters.estado===s?'selected':''}>${STATUS_LABELS[s]}</option>`).join('')}
      </select>
      ${studio && studio.members.length > 1 ? `
        <label>Mediador/a responsable</label>
        <select id="filter-mediador" onchange="applyListFilters()">
          <option value="">Todos</option>
          ${studio.members.map(m => `<option value="${m.id}" ${listFilters.mediador===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
      ` : ''}
      <label>Responsable de la próxima acción</label>
      <select id="filter-responsable" onchange="applyListFilters()">
        <option value="">Todos</option>
        <option value="mediador" ${listFilters.responsable==='mediador'?'selected':''}>Mediador/a</option>
        <option value="party" ${listFilters.responsable==='party'?'selected':''}>Una parte</option>
        <option value="lawyer" ${listFilters.responsable==='lawyer'?'selected':''}>Un abogado</option>
      </select>
      ${listFilters.responsable==='party' || listFilters.responsable==='lawyer' ? `
        <label>Buscar por nombre puntual (opcional)</label>
        <input id="filter-responsable-nombre" value="${escapeHtml(listFilters.responsableNombre)}" placeholder="Ej: Rodríguez" onkeyup="if(event.key==='Enter') applyListFilters()">
      ` : ''}
      <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
        <input type="checkbox" id="filter-vencidas" style="width:auto;" ${listFilters.vencidas?'checked':''} onchange="applyListFilters()">
        Solo con próxima acción vencida
      </label>
    </div>

    <div class="card">
      ${list.length ? list.map(m => `
        <div class="mediation-row" onclick="goTo('detail','${m.id}')">
          <div class="top">
            <div style="font-weight:600; font-size:13.5px;">${escapeHtml(m.object)}</div>
            <span class="pill calm">${STATUS_LABELS[m.status] || m.status}</span>
          </div>
          <div class="code">${escapeHtml(m.code)}${m.internalNumber ? ' · ' + escapeHtml(m.internalNumber) : ''}</div>
          ${m.nextActionText ? `
            <div style="font-size:11.5px; color:var(--text-dim); margin-top:4px;">
              → ${escapeHtml(m.nextActionText)}${m.nextActionDueDate ? ` <span style="color:${new Date(m.nextActionDueDate).getTime()<Date.now()?'var(--danger)':'var(--text-faint)'};">· vence ${fmtDate(m.nextActionDueDate)}</span>` : ''}
            </div>
          ` : `<div style="font-size:11.5px; color:var(--warn); margin-top:4px;">Sin próxima acción cargada</div>`}
        </div>
      `).join('') : `<p class="empty-hint">Ninguna mediación coincide con estos filtros.</p>`}
    </div>
  `;
}

function applyListFilters(){
  listFilters.estado = document.getElementById('filter-estado').value;
  listFilters.responsable = document.getElementById('filter-responsable').value;
  const nombreField = document.getElementById('filter-responsable-nombre');
  listFilters.responsableNombre = nombreField ? nombreField.value.trim() : '';
  const mediadorField = document.getElementById('filter-mediador');
  listFilters.mediador = mediadorField ? mediadorField.value : '';
  listFilters.vencidas = document.getElementById('filter-vencidas').checked;
  renderList();
}

// ================= NUEVA MEDIACIÓN =================
function renderNewForm(){
  const main = document.getElementById('main');
  main.innerHTML = `
    <span class="back-link" onclick="goTo('dashboard')">← Volver</span>
    <h1>Nueva mediación</h1>
    <div class="card">
      <label>Objeto de la mediación *</label>
      <input id="new-object" placeholder="Ej: Reclamo por reparación de vehículo">
      <label>Tipo</label>
      <input id="new-type" placeholder="Ej: civil, laboral, familia…">
      <label>Número interno propio (opcional)</label>
      <input id="new-internal" placeholder="Ej: 42/2026">
      <label>Descripción (opcional)</label>
      <textarea id="new-description" rows="3"></textarea>
      <button class="primary" style="width:100%;" onclick="createMediation()">Crear</button>
    </div>
  `;
}
async function createMediation(){
  const object = document.getElementById('new-object').value.trim();
  if(!object){ showToast('Falta el objeto de la mediación.', 'danger'); return; }
  try{
    const m = await api('/api/mediations', { method:'POST', body: JSON.stringify({
      object,
      type: document.getElementById('new-type').value.trim() || null,
      internalNumber: document.getElementById('new-internal').value.trim() || null,
      description: document.getElementById('new-description').value.trim() || null,
    })});
    goTo('detail', m.id);
  }catch(e){ showToast(e.error || 'No se pudo crear la mediación.', 'danger'); }
}

// ================= EXPEDIENTE (detalle) =================
let currentParties = []; // cache para no tener que resolver nombre de parte a mano en cada lugar que lo necesita (abogados, confirmaciones de audiencia)
let currentDocuments = []; // Bloque 19 — para el selector de "adjuntar documento existente" en Comunicaciones, sin otro fetch
let currentHearings = []; // Bloque 19 — para el selector de audiencia en "Gestionar cambio" desde un mensaje

const PARTY_ROLE_LABELS = { requirente: 'Requirente', requerido: 'Requerido', otro: 'Otro' };
const HEARING_MODALITY_LABELS = { presencial: 'Presencial', virtual: 'Virtual', hibrida: 'Híbrida' };
const HEARING_STATUS_LABELS = { programada: 'Programada', confirmada: 'Confirmada', realizada: 'Realizada', cancelada: 'Cancelada', no_realizada: 'No realizada' };
const CONFIRMATION_LABELS = { pendiente: 'Pendiente', confirma: 'Confirma', no_puede: 'No puede', pide_cambio: 'Pide cambio' };

// ================= VIDEOCONFERENCIAS (Bloque 28) =================
const VIDEO_PROVIDER_LABELS = { google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', manual: 'Enlace manual' };
const VIDEO_PROVIDER_OPTIONS = `
  <option value="google_meet">Google Meet</option>
  <option value="zoom">Zoom</option>
  <option value="teams">Microsoft Teams</option>
`;
const MEETING_STATUS_LABELS = {
  no_configurada: 'Sin configurar', creando: 'Creando…', creada: 'Reunión creada',
  actualizando: 'Actualizando…', actualizada: 'Reunión actualizada', error: 'Requiere atención', cancelada: 'Cancelada',
};

// se muestra/oculta según la modalidad elegida — solo tiene sentido pedir
// proveedor/link cuando la audiencia no es puramente presencial. Mismo
// patrón para el form de "agendar audiencia" (hearing-*) y el de
// "proponer varios horarios" (propose-*) — prefijo como parámetro para
// no duplicar la función dos veces con IDs distintos.
function updateVideoFieldsVisibility(prefix){
  const modality = document.getElementById(`${prefix}-modality`)?.value;
  const videoFields = document.getElementById(`${prefix}-video-fields`);
  if(!videoFields) return;
  videoFields.style.display = (modality === 'virtual' || modality === 'hibrida') ? 'block' : 'none';
  const providerField = document.getElementById(`${prefix}-provider`);
  const manualField = document.getElementById(`${prefix}-manual-link-field`);
  if(providerField && manualField){
    manualField.style.display = providerField.value ? 'none' : 'block';
  }
}
function updateHearingFormVideoVisibility(){ updateVideoFieldsVisibility('hearing'); }
function updateProposeFormVideoVisibility(){ updateVideoFieldsVisibility('propose'); }

// ---------- Configuración → Videoconferencias (spec §23) ----------
async function renderVideoSettings(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let providers;
  try{ providers = await api('/api/video-providers'); }
  catch(e){ main.innerHTML = `<p class="empty-hint">No se pudo cargar el estado de los proveedores.</p>`; return; }

  const STATUS_LABELS_VP = { conectado: 'Conectado', requiere_autorizacion: 'No conectado', no_configurada: 'No configurado', error: 'Error' };
  const STATUS_PILL_CLASS = { conectado: 'calm', requiere_autorizacion: 'warn', no_configurada: 'warn', error: 'danger' };

  main.innerHTML = `
    <span class="back-link" onclick="goTo('dashboard')">← Volver</span>
    <h1 style="font-size:21px;">Videoconferencias</h1>
    <p class="empty-hint" style="margin-bottom:16px;">Conectá los proveedores que vas a usar para crear reuniones automáticamente desde las audiencias. Sin conectar nada, Mediador sigue funcionando igual — siempre podés cargar un enlace manualmente.</p>
    ${providers.map(p => `
      <div class="card" style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <strong>${escapeHtml(p.label)}</strong>
          <br><span class="pill ${STATUS_PILL_CLASS[p.status] || 'warn'}">${STATUS_LABELS_VP[p.status] || p.status}</span>
          ${p.accountEmail ? `<span style="color:var(--text-faint); font-size:12px; margin-left:6px;">${escapeHtml(p.accountEmail)}</span>` : ''}
          ${!p.perMediatorAccount ? `<p class="empty-hint" style="margin-top:4px;">Se configura una sola vez para toda la instalación (variables de entorno del servidor).</p>` : ''}
        </div>
        ${p.perMediatorAccount ? (
          p.status === 'conectado'
            ? `<button class="ghost" onclick="disconnectVideoProvider('${p.provider}')">Desconectar</button>`
            : (p.status === 'no_configurada'
                ? `<span class="empty-hint">Falta configurar credenciales en el servidor</span>`
                : `<a href="/api/video-providers/${p.provider}/connect" class="primary" style="text-decoration:none; padding:8px 16px;">Conectar cuenta</a>`)
        ) : ''}
      </div>
    `).join('')}
  `;
}

async function disconnectVideoProvider(provider){
  if(!confirm('¿Desconectar esta cuenta? Las audiencias que ya tienen una reunión creada no se ven afectadas.')) return;
  try{
    await api(`/api/video-providers/${provider}/disconnect`, { method: 'POST' });
    showToast('Cuenta desconectada.', 'success');
    renderVideoSettings();
  }catch(e){ showToast(e.error || 'No se pudo desconectar la cuenta.', 'danger'); }
}

async function createHearingMeetingNow(mediationId, hearingId, provider){
  try{
    await api(`/api/mediations/${mediationId}/hearings/${hearingId}/meeting`, { method:'POST', body: JSON.stringify({ provider }) });
    showToast('Reunión creada.', 'success');
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo crear la reunión.', 'danger'); }
}

async function removeHearingMeeting(mediationId, hearingId){
  if(!confirm('¿Quitar la videoconferencia de esta audiencia? Si hay una reunión creada en el proveedor externo, se intenta cancelar.')) return;
  try{
    await api(`/api/mediations/${mediationId}/hearings/${hearingId}/meeting`, { method:'DELETE' });
    showToast('Videoconferencia quitada.', 'success');
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo quitar la videoconferencia.', 'danger'); }
}

// tarjeta "VIDEOCONFERENCIA" del detalle de audiencia (spec §11): solo
// aparece si hay algo que mostrar — una audiencia presencial sin ningún
// intento de video no muestra nada acá.
function renderHearingVideoCard(m, h){
  if(!h.modality || h.modality === 'presencial') return '';
  if(!h.video && !h.meetingUrl) {
    return `
      <div style="margin-top:8px; background:var(--surface-2); border-radius:8px; padding:10px 12px;">
        <div style="font-size:12px; color:var(--text-faint);">Videoconferencia no configurada</div>
        <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
          ${['google_meet','zoom','teams'].map(p => `<button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="createHearingMeetingNow('${m.id}','${h.id}','${p}')">Crear con ${VIDEO_PROVIDER_LABELS[p]}</button>`).join('')}
        </div>
      </div>
    `;
  }
  const v = h.video || { provider: 'manual', providerLabel: 'Enlace manual', meetingStatus: 'creada', joinUrl: h.meetingUrl };
  const isError = v.meetingStatus === 'error';
  return `
    <div style="margin-top:8px; background:var(--surface-2); border-radius:8px; padding:10px 12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div>
          <div style="font-size:12px; font-weight:600;">Videoconferencia · ${escapeHtml(v.providerLabel || VIDEO_PROVIDER_LABELS[v.provider] || v.provider)}</div>
          <div style="font-size:11px; color:${isError ? 'var(--danger)' : 'var(--text-faint)'};">${MEETING_STATUS_LABELS[v.meetingStatus] || v.meetingStatus || ''}</div>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${v.joinUrl ? `<a href="${escapeHtml(v.joinUrl)}" target="_blank" class="primary" style="padding:4px 10px; font-size:11px; text-decoration:none;">Entrar a audiencia</a>` : ''}
          ${v.joinUrl ? `<button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="copyLinkToClipboard('${escapeHtml(v.joinUrl)}', 'Enlace de la reunión copiado.')">Copiar enlace</button>` : ''}
          ${isError && v.provider !== 'manual' ? `<button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="createHearingMeetingNow('${m.id}','${h.id}','${v.provider}')">Reintentar</button>` : ''}
          <button class="ghost" style="padding:4px 10px; font-size:11px; color:var(--danger);" onclick="removeHearingMeeting('${m.id}','${h.id}')">Quitar</button>
        </div>
      </div>
    </div>
  `;
}
const DOCUMENT_TYPE_LABELS = { dni:'DNI', poder:'Poder', notificacion:'Notificación', presupuesto:'Presupuesto', contrato:'Contrato', acta:'Acta', acuerdo:'Acuerdo', constancia:'Constancia', otro:'Otro' };
const DOCUMENT_STATUS_LABELS = { pendiente_escaneo:'Pendiente de escaneo', recibido:'Recibido — sin revisar', pendiente_revision:'Pendiente de revisión', revisado:'Revisado', observado:'Observado', final:'Final' };
const TASK_PRIORITY_LABELS = { baja:'Baja', media:'Media', alta:'Alta', urgente:'Urgente' };
const TASK_STATUS_LABELS = { pendiente:'Pendiente', en_proceso:'En proceso', completada:'Completada', cancelada:'Cancelada' };
const COMMITMENT_STATUS_LABELS = { pendiente:'Pendiente', cumplido:'Cumplido', vencido:'Vencido', cancelado:'Cancelado' };
const EVENT_TYPE_LABELS = {
  MEDIATION_CREATED:'Mediación creada', MEDIATION_STATUS_CHANGED:'Cambio de estado', MEDIATION_CLOSED:'Mediación cerrada',
  PARTY_ADDED:'Parte agregada', PARTY_INVITED:'Invitación al portal', LAWYER_ADDED:'Abogado agregado', LAWYER_INVITED:'Invitación al portal (abogado)',
  MEDIATION_ACCESS_GRANTED:'Persona asignada', MEDIATION_ACCESS_REVOKED:'Acceso quitado',
  HEARING_SCHEDULED:'Audiencia agendada', HEARING_CONFIRMED:'Audiencia confirmada',
  HEARING_HELD:'Audiencia realizada', HEARING_CANCELLED:'Audiencia cancelada',
  HEARING_NOT_HELD:'Audiencia no realizada', HEARING_CONFIRMATION_MISSING:'Confirmación pendiente',
  HEARING_RESCHEDULE_REQUESTED:'Pedido de cambio de audiencia', HEARING_RESCHEDULE_REJECTED:'Pedido de cambio resuelto', HEARING_RESCHEDULED:'Audiencia reprogramada',
  HEARING_PROPOSED:'Horarios propuestos', HEARING_RESCHEDULE_REMINDER:'Recordatorio de solicitud pendiente',
  HEARING_REMINDER:'Recordatorio de audiencia',
  DOCUMENT_UPLOADED:'Documento subido', TASK_CREATED:'Tarea creada', TASK_COMPLETED:'Tarea completada',
  TASK_UPDATED:'Tarea actualizada', TASK_OVERDUE:'Tarea vencida', COMMITMENT_CREATED:'Compromiso creado',
  COMMITMENT_COMPLETED:'Compromiso cumplido', COMMITMENT_OVERDUE:'Compromiso vencido',
  COMMITMENT_UPDATED:'Compromiso actualizado', MESSAGE_SENT:'Mensaje enviado', MESSAGE_RECEIVED:'Mensaje recibido',
};
function fmtFileSize(bytes){
  if(bytes < 1024) return bytes + ' B';
  if(bytes < 1024*1024) return (bytes/1024).toFixed(0) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

// Bloque 26 — banner de "audiencia en curso/por empezar" en Comunicaciones.
// Cálculo EN VIVO a partir de los mismos `hearings` que ya se pidieron para
// esta pantalla (nunca un endpoint nuevo, nunca depende de un job). Reusa
// meetingUrl tal cual — nunca genera un link propio. Es a nivel de la
// MEDIACIÓN (no de una parte puntual): la audiencia es una sola para todas
// las partes, así que el banner es el mismo sin importar qué hilo esté
// abierto (§1 de la spec).
function findActiveHearingForBanner(hearings){
  if(!hearings || !hearings.length) return null;
  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0,10);
  for(const h of hearings){
    if(h.date !== todayStr) continue;
    if(!['programada','confirmada'].includes(h.status)) continue;
    if(!h.meetingUrl) continue;
    if(h.modality !== 'virtual' && h.modality !== 'hibrida') continue;
    if(!h.startTime) continue;
    const startMs = new Date(`${h.date}T${h.startTime}`).getTime();
    if(isNaN(startMs)) continue;
    let durationMs = 60*60*1000; // default: 60 min si no hay endTime cargado
    if(h.endTime){
      const endMs = new Date(`${h.date}T${h.endTime}`).getTime();
      if(!isNaN(endMs) && endMs > startMs) durationMs = endMs - startMs;
    }
    const windowStart = startMs - 30*60*1000;
    const windowEnd = startMs + durationMs;
    if(now >= windowStart && now <= windowEnd) return h;
  }
  return null;
}
function renderHearingBanner(codeOrObject, hearings){
  const h = findActiveHearingForBanner(hearings);
  if(!h) return '';
  return `
    <div class="card-highlight" style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
      <div>Audiencia con <strong>${escapeHtml(codeOrObject)}</strong> — hoy a las ${escapeHtml(h.startTime)}</div>
      <a href="${escapeHtml(h.meetingUrl)}" target="_blank" class="primary" style="text-decoration:none; padding:8px 16px; flex-shrink:0;">Entrar a la audiencia</a>
    </div>
  `;
}

function partyName(partyId){
  const p = currentParties.find(x => x.id === partyId);
  if(!p) return '—';
  return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || '—';
}

// Bloque 24 — asistente de carga guiada. El paso actual dentro del wizard es
// puramente de sesión del browser (no se persiste en el servidor): si se
// recarga la página a mitad de camino, lo que ya se guardó sigue existiendo,
// pero el wizard no "recuerda" en qué paso estaba — se recalcula desde cero
// (parties.length===0 → arranca en el paso 1; si ya hay una parte, ya no
// se muestra, ver §7 test 6). onboardingWizardMediationId es lo único que
// permite seguir avanzando de paso 1→2→3→4 SIN que el wizard se cierre solo
// apenas se crea la primera parte (que haría que parties.length===0 deje de
// ser cierto a mitad del wizard).
let onboardingWizardMediationId = null;
let onboardingWizardStep = 1;

function wizardAdvance(id, step){
  onboardingWizardStep = step;
  renderDetail(id);
}

function finishOnboardingWizard(id){
  onboardingWizardMediationId = null;
  renderDetail(id);
}

async function dismissOnboardingWizard(id){
  try{
    await api(`/api/mediations/${id}`, { method:'PATCH', body: JSON.stringify({ dismissOnboarding: true }) });
  }catch(e){ showToast(e.error || 'No se pudo descartar la guía.', 'danger'); return; }
  onboardingWizardMediationId = null;
  renderDetail(id);
}

function renderOnboardingWizard(m, parties){
  const main = document.getElementById('main');
  const step = onboardingWizardStep;
  const skipLink = `<div style="text-align:center; margin-top:16px;"><a href="#" onclick="event.preventDefault(); dismissOnboardingWizard('${m.id}')" style="color:var(--text-faint); font-size:12.5px;">Saltar, prefiero cargar todo desde las pestañas</a></div>`;

  let stepBody = '';
  if(step === 1){
    // único paso obligatorio — mismo formulario/endpoint que la pestaña
    // Partes (POST /:id/parties), sin ningún campo nuevo.
    stepBody = `
      <h2 style="text-align:center;">¿Quién inicia la mediación?</h2>
      <p class="empty-hint" style="text-align:center; margin-bottom:16px;">Cargá la parte requirente para arrancar el expediente.</p>
      <label>Rol</label>
      <select id="party-role"><option value="requirente" selected>Requirente</option><option value="requerido">Requerido</option><option value="otro">Otro</option></select>
      <label>Nombre</label>
      <input id="party-first-name" placeholder="Nombre">
      <label>Apellido</label>
      <input id="party-last-name" placeholder="Apellido">
      <label>Documento</label>
      <input id="party-document" placeholder="Ej: 30111222">
      <label>Email (opcional)</label>
      <input id="party-email" placeholder="nombre@correo.com">
      <label>Teléfono (opcional)</label>
      <input id="party-phone">
      <button class="primary" style="width:100%; margin-top:10px;" onclick="addParty('${m.id}', () => wizardAdvance('${m.id}', 2))">Guardar y seguir</button>
    `;
  } else if(step === 2){
    stepBody = `
      <h2 style="text-align:center;">¿Contra quién se dirige?</h2>
      <p class="empty-hint" style="text-align:center; margin-bottom:16px;">Parte requerida — si todavía no la tenés, se puede cargar después desde la pestaña Partes.</p>
      <label>Rol</label>
      <select id="party-role"><option value="requirente">Requirente</option><option value="requerido" selected>Requerido</option><option value="otro">Otro</option></select>
      <label>Nombre</label>
      <input id="party-first-name" placeholder="Nombre">
      <label>Apellido</label>
      <input id="party-last-name" placeholder="Apellido">
      <label>Documento</label>
      <input id="party-document" placeholder="Ej: 30111222">
      <label>Email (opcional)</label>
      <input id="party-email" placeholder="nombre@correo.com">
      <label>Teléfono (opcional)</label>
      <input id="party-phone">
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="ghost" style="flex:1;" onclick="wizardAdvance('${m.id}', 3)">Saltar este paso</button>
        <button class="primary" style="flex:1;" onclick="addParty('${m.id}', () => wizardAdvance('${m.id}', 3))">Guardar y seguir</button>
      </div>
    `;
  } else if(step === 3){
    stepBody = `
      <h2 style="text-align:center;">¿Tienen abogado?</h2>
      <p class="empty-hint" style="text-align:center; margin-bottom:16px;">Podés vincularlo a una de las partes que ya cargaste.</p>
      <label>Email (opcional)</label>
      <input id="lawyer-email" placeholder="abogado@estudio.com">
      <label>Nombre</label>
      <input id="lawyer-name" placeholder="Ej: Dr. Rodríguez">
      <label>Matrícula (opcional)</label>
      <input id="lawyer-enrollment">
      <label>Representa a</label>
      <select id="lawyer-party">
        <option value="">— Sin asignar —</option>
        ${parties.map(p => `<option value="${p.id}">${escapeHtml(partyName(p.id))}</option>`).join('')}
      </select>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="ghost" style="flex:1;" onclick="wizardAdvance('${m.id}', 4)">Saltar este paso</button>
        <button class="primary" style="flex:1;" onclick="addLawyer('${m.id}', () => wizardAdvance('${m.id}', 4))">Guardar y seguir</button>
      </div>
    `;
  } else {
    stepBody = `
      <h2 style="text-align:center;">¿Ya tenés fecha de audiencia?</h2>
      <p class="empty-hint" style="text-align:center; margin-bottom:16px;">Si todavía no la coordinaste, se puede agendar después desde la pestaña Audiencias.</p>
      <label>Fecha</label>
      <input id="hearing-date" type="date">
      <label>Hora (opcional)</label>
      <input id="hearing-time" type="time">
      <label>Modalidad</label>
      <select id="hearing-modality">
        <option value="presencial">Presencial</option>
        <option value="virtual">Virtual</option>
        <option value="hibrida">Híbrida</option>
      </select>
      <label>Lugar o link de reunión (opcional)</label>
      <input id="hearing-location" placeholder="Dirección o URL">
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="ghost" style="flex:1;" onclick="finishOnboardingWizard('${m.id}')">Saltar este paso</button>
        <button class="primary" style="flex:1;" onclick="addHearing('${m.id}', () => finishOnboardingWizard('${m.id}'))">Guardar y seguir</button>
      </div>
    `;
  }

  main.innerHTML = `
    <div style="max-width:460px; margin:32px auto 0;">
      <div class="eyebrow" style="text-align:center;">${escapeHtml(m.code)} · Paso ${step} de 4</div>
      <h1 style="text-align:center; font-size:21px; margin-bottom:18px;">Carga guiada del expediente</h1>
      <div class="card">
        ${stepBody}
      </div>
      ${skipLink}
    </div>
  `;
}

async function renderDetail(id){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let m, history, parties, lawyers, hearings, documents, timeline, tasks, commitments, access, communications, myStudio;
  try{
    [m, history, parties, lawyers, hearings, documents, timeline, tasks, commitments, access, communications] = await Promise.all([
      api(`/api/mediations/${id}`),
      api(`/api/mediations/${id}/status-history`),
      api(`/api/mediations/${id}/parties`),
      api(`/api/mediations/${id}/lawyers`),
      api(`/api/mediations/${id}/hearings`),
      api(`/api/mediations/${id}/documents`),
      api(`/api/mediations/${id}/timeline`),
      api(`/api/mediations/${id}/tasks`),
      api(`/api/mediations/${id}/commitments`),
      api(`/api/mediations/${id}/access`),
      api(`/api/mediations/${id}/communications`),
    ]);
  }catch(e){ main.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo cargar la mediación.')}</p>`; return; }
  try{ myStudio = await api('/api/studios/me'); }catch(e){ myStudio = null; }
  currentParties = parties;
  currentDocuments = documents;
  currentHearings = hearings;

  // Bloque 24 — el wizard se muestra si es un ALTA sin partes todavía (nunca
  // si ya hay al menos una, ni por primera vez ni al recargar — spec §1/§7
  // test 2), O si ya estábamos navegándolo en esta misma sesión de pantalla
  // (isWizardActive), que es lo que permite llegar hasta el paso 4 aunque el
  // paso 1 ya haya hecho que parties.length deje de ser 0.
  const isWizardActive = onboardingWizardMediationId === id;
  const shouldShowWizard = (parties.length === 0 && !m.onboardingDismissedAt) || isWizardActive;
  if(shouldShowWizard){
    if(!isWizardActive){ onboardingWizardMediationId = id; onboardingWizardStep = 1; }
    renderOnboardingWizard(m, parties);
    return;
  }
  onboardingWizardMediationId = null;

  const statusOptions = Object.keys(STATUS_LABELS).map(s =>
    `<option value="${s}" ${s === m.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`
  ).join('');

  // Bloque 17 §3 — "entro a esta mediación, ¿sé en menos de 10 segundos
  // qué está pasando?". Antes el encabezado solo tenía estado/próxima
  // acción/responsable/vencimiento — faltaba lo primero que un mediador
  // busca al abrir un caso: cuándo es la próxima audiencia, y si hay algo
  // puntual que atender ACÁ (no solo en el dashboard general). Todo esto
  // sale de datos que ya se pidieron arriba — no hace falta otro endpoint.
  const now = Date.now();
  const proximaAudiencia = hearings
    .filter(h => ['programada','confirmada'].includes(h.status) && h.date >= new Date(now).toISOString().slice(0,10))
    .sort((a,b) => a.date.localeCompare(b.date) || (a.startTime||'').localeCompare(b.startTime||''))[0] || null;
  const audienciasSinConfirmarCount = hearings.filter(h =>
    ['programada','confirmada'].includes(h.status) && h.confirmations.some(c => c.response === 'pendiente')
  ).length;
  const documentosSinRevisarCount = documents.filter(d => d.status === 'recibido').length;
  const detailAlerts = [
    audienciasSinConfirmarCount ? `<span class="pill warn">${audienciasSinConfirmarCount} audiencia${audienciasSinConfirmarCount===1?'':'s'} sin confirmar</span>` : '',
    documentosSinRevisarCount ? `<span class="pill warn">${documentosSinRevisarCount} documento${documentosSinRevisarCount===1?'':'s'} sin revisar</span>` : '',
  ].filter(Boolean).join(' ');

  const nextActionOverdue = m.nextActionDueDate && new Date(m.nextActionDueDate).getTime() < Date.now();

  main.innerHTML = `
    <span class="back-link" onclick="goTo('list')">← Volver a mediaciones</span>
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:4px;">
      <div class="eyebrow" style="margin-bottom:0;">${escapeHtml(m.code)}${m.internalNumber ? ' · ' + escapeHtml(m.internalNumber) : ''}</div>
      <span class="badge badge-neutral">${STATUS_LABELS[m.status] || m.status}</span>
    </div>
    <h1>${escapeHtml(m.object)}</h1>

    <div class="card-highlight${nextActionOverdue ? ' is-overdue' : ''}" style="margin-top:16px;">
      <div class="eyebrow" style="color:inherit; opacity:.7; margin-bottom:6px;">Próxima acción</div>
      <div style="display:flex; justify-content:space-between; align-items:flex-end; gap:14px; flex-wrap:wrap;">
        <div>
          <div style="font-size:19px; font-weight:700;">${m.nextActionText ? escapeHtml(m.nextActionText) : 'Sin cargar'}</div>
          <div style="font-size:13px; margin-top:4px; opacity:.8;">
            ${m.nextActionDueDate ? `Vence ${fmtDate(m.nextActionDueDate)}` : 'Sin vencimiento cargado'}
            ${m.nextActionResponsibleType ? ` · Responsable: ${NEXT_ACTION_RESPONSIBLE_LABELS[m.nextActionResponsibleType] || '—'}` : ''}
          </div>
        </div>
        <a href="#section-audiencias" class="btn-secondary" style="text-decoration:none; height:36px; padding:0 14px; font-size:13px;">Ver audiencia</a>
      </div>
      <div style="font-size:12.5px; margin-top:10px; opacity:.75;">
        Próxima audiencia: ${proximaAudiencia ? `${fmtDate(proximaAudiencia.date)}${proximaAudiencia.startTime ? ' ' + proximaAudiencia.startTime : ''}` : 'sin agendar'}
      </div>
      ${detailAlerts ? `<div style="margin-top:10px;">${detailAlerts}</div>` : ''}
    </div>

    <nav class="detail-subnav">
      <a href="#section-partes">Partes</a>
      <a href="#section-abogados">Abogados</a>
      <a href="#section-audiencias">Audiencias</a>
      <a href="#section-documentos">Documentos</a>
      <a href="#section-comunicaciones">Comunicaciones</a>
      <a href="#section-tareas">Tareas</a>
      <a href="#section-compromisos">Compromisos</a>
      <a href="#section-timeline">Timeline</a>
      <a href="#section-admin">Administración</a>
    </nav>

    <div class="card" id="section-partes">
      <h2>Partes</h2>
      ${parties.length ? parties.map(p => `
        <div class="status-history-item">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${escapeHtml(partyName(p.id))}</strong> — ${PARTY_ROLE_LABELS[p.role] || p.role}
              ${p.documentNumber ? ` · ${escapeHtml(p.documentType || 'Doc.')} ${escapeHtml(p.documentNumber)}` : ''}
              ${p.email ? `<br><span style="color:var(--text-faint);">${escapeHtml(p.email)}</span>` : ''}
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              ${p.portalToken ? `<button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="openPartyChat('${m.id}','${p.id}')">Mensajes</button>` : ''}
              <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="inviteParty('${m.id}','${p.id}')">
                ${p.portalToken ? 'Reenviar portal' : 'Invitar al portal'}
              </button>
            </div>
          </div>
          ${p.portalToken ? `
            <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:11px; color:var(--text-dim);">
              <input type="checkbox" style="width:auto;" ${p.allowDocumentUpload?'checked':''} onchange="toggleAllowUpload('${m.id}','${p.id}',this.checked)">
              Permitir que suba documentos desde el portal
            </label>
          ` : ''}
          <div id="chat-${p.id}" style="display:none; margin-top:10px;"></div>
        </div>
      `).join('') : `<p class="empty-hint">Todavía no hay partes cargadas — agregá al menos una para poder programar audiencias.</p>`}
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="toggleForm('party-form')">+ Agregar parte</button>
      <div id="party-form" style="display:none; margin-top:10px;">
        <label>Rol</label>
        <select id="party-role">
          <option value="requirente">Requirente</option>
          <option value="requerido">Requerido</option>
          <option value="otro">Otro</option>
        </select>
        <label>Nombre</label>
        <input id="party-first-name" placeholder="Nombre">
        <label>Apellido</label>
        <input id="party-last-name" placeholder="Apellido">
        <label>Documento</label>
        <input id="party-document" placeholder="Ej: 30111222">
        <label>Email (opcional)</label>
        <input id="party-email" placeholder="nombre@correo.com">
        <label>Teléfono (opcional)</label>
        <input id="party-phone">
        <button class="primary" style="width:100%;" onclick="addParty('${m.id}')">Guardar parte</button>
      </div>
    </div>

    <div class="card" id="section-abogados">
      <h2>Abogados</h2>
      ${lawyers.length ? lawyers.map(l => `
        <div class="status-history-item">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${escapeHtml(l.name)}</strong>${l.enrollmentNumber ? ` · Matrícula ${escapeHtml(l.enrollmentNumber)}` : ''}
              ${l.partyId ? `<br><span style="color:var(--text-faint);">Representa a ${escapeHtml(partyName(l.partyId))}</span>` : ''}
            </div>
            <button class="ghost" style="flex-shrink:0; padding:6px 10px; font-size:11px;" onclick="inviteLawyer('${m.id}','${l.id}')">
              ${l.portalToken ? 'Reenviar portal' : 'Invitar al portal'}
            </button>
          </div>
        </div>
      `).join('') : `<p class="empty-hint">Todavía no hay abogados cargados.</p>`}
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="toggleForm('lawyer-form')">+ Agregar abogado</button>
      <div id="lawyer-form" style="display:none; margin-top:10px;">
        <label>Email (opcional — si el mismo abogado ya tiene portal en otra mediación, se reusa su acceso)</label>
        <input id="lawyer-email" placeholder="abogado@estudio.com">
        <label>Nombre</label>
        <input id="lawyer-name" placeholder="Ej: Dr. Rodríguez">
        <label>Matrícula (opcional)</label>
        <input id="lawyer-enrollment">
        <label>Representa a</label>
        <select id="lawyer-party">
          <option value="">— Sin asignar —</option>
          ${parties.map(p => `<option value="${p.id}">${escapeHtml(partyName(p.id))}</option>`).join('')}
        </select>
        <button class="primary" style="width:100%;" onclick="addLawyer('${m.id}')">Guardar abogado</button>
      </div>
    </div>

    <div class="card" id="section-audiencias">
      <h2>Audiencias</h2>
      ${hearings.length ? hearings.map(h => renderHearingRow(m, h, timeline)).join('') : `<p class="empty-hint">Todavía no hay audiencias agendadas — agendá una fecha o proponé varios horarios para que las partes elijan.</p>`}
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="toggleForm('hearing-form')">+ Agendar audiencia</button>
      <button class="ghost" style="width:100%; margin-top:6px;" onclick="toggleForm('propose-form')">+ Proponer varios horarios</button>
      <div id="propose-form" style="display:none; margin-top:10px;">
        <p class="empty-hint">Cargá una o más opciones — la parte puede confirmar la que le sirva, y vos elegís cuál queda.</p>
        <label>¿A quién se le propone?</label>
        <select id="propose-target">
          <option value="">Todas las partes</option>
          ${parties.map(p => `<option value="${p.id}">${escapeHtml(partyName(p.id))} (solo a esta parte)</option>`).join('')}
        </select>
        <label>Modalidad</label>
        <select id="propose-modality" onchange="updateProposeFormVideoVisibility()">
          <option value="presencial">Presencial</option>
          <option value="virtual">Virtual</option>
          <option value="hibrida">Híbrida</option>
        </select>
        <div id="propose-video-fields" style="display:none;">
          <label>Videoconferencia</label>
          <select id="propose-provider" onchange="updateProposeFormVideoVisibility()">
            <option value="">— Cargar enlace manualmente —</option>
            ${VIDEO_PROVIDER_OPTIONS}
          </select>
          <div id="propose-manual-link-field">
            <input id="propose-meeting-url" placeholder="Enlace de la reunión (Zoom, Meet, Teams, etc.)">
          </div>
          <p class="empty-hint">Con un proveedor real, la reunión se crea recién cuando se elige cuál horario queda — nunca una por cada opción propuesta.</p>
        </div>
        <div id="propose-slots">
          <div class="propose-slot-row" style="display:flex; gap:6px; margin-bottom:6px;">
            <input type="date" class="propose-slot-date" style="flex:1;">
            <input type="time" class="propose-slot-time" style="flex:1;">
          </div>
        </div>
        <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="addProposeSlotRow()">+ Otra opción</button>
        <button class="primary" style="width:100%; margin-top:8px;" onclick="submitProposal('${m.id}')">Proponer</button>
      </div>
      <div id="hearing-form" style="display:none; margin-top:10px;">
        <label>Fecha</label>
        <input id="hearing-date" type="date">
        <label>Hora (opcional)</label>
        <input id="hearing-time" type="time">
        <label>Modalidad</label>
        <select id="hearing-modality" onchange="updateHearingFormVideoVisibility()">
          <option value="presencial">Presencial</option>
          <option value="virtual">Virtual</option>
          <option value="hibrida">Híbrida</option>
        </select>
        <label>Lugar (si es presencial o híbrida)</label>
        <input id="hearing-location" placeholder="Dirección">
        <div id="hearing-video-fields" style="display:none;">
          <label>Videoconferencia</label>
          <select id="hearing-provider" onchange="updateHearingFormVideoVisibility()">
            <option value="">— Cargar enlace manualmente —</option>
            ${VIDEO_PROVIDER_OPTIONS}
          </select>
          <div id="hearing-manual-link-field">
            <input id="hearing-meeting-url" placeholder="Enlace de la reunión (Zoom, Meet, Teams, etc.)">
          </div>
        </div>
        <button class="primary" style="width:100%;" onclick="addHearing('${m.id}')">Guardar audiencia</button>
      </div>
    </div>

    <div class="card" id="section-documentos">
      <h2>Documentos</h2>
      ${documents.length ? documents.map(d => `
        <div class="status-history-item">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${escapeHtml(d.originalFilename)}</strong> ${d.version > 1 ? `<span class="pill calm">v${d.version}</span>` : ''}
              <br><span style="color:var(--text-faint);">${DOCUMENT_TYPE_LABELS[d.type] || d.type} · ${fmtFileSize(d.size)} · ${fmtDateTime(d.createdAt)}${d.uploadedByName ? ' · subido por ' + escapeHtml(d.uploadedByName) : ''}</span>
            </div>
            <a href="/api/mediations/${m.id}/documents/${d.id}/download" class="ghost" style="padding:6px 12px; font-size:11.5px; text-decoration:none; color:var(--text); flex-shrink:0;">Descargar</a>
          </div>
          <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            <select onchange="changeDocumentStatus('${m.id}','${d.id}',this.value)" style="width:auto; margin:0;">
              ${Object.keys(DOCUMENT_STATUS_LABELS).map(s => `<option value="${s}" ${s===d.status?'selected':''}>${DOCUMENT_STATUS_LABELS[s]}</option>`).join('')}
            </select>
            <button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="toggleVersionUpload('${d.id}')">Subir nueva versión</button>
            <button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="toggleVersionHistory('${m.id}','${d.id}')">Ver versiones</button>
          </div>
          <div id="version-upload-${d.id}" style="display:none; margin-top:8px;">
            <input id="version-file-${d.id}" type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx">
            <button class="primary" style="margin-top:6px;" onclick="uploadNewVersion('${m.id}','${d.id}')">Subir</button>
          </div>
          <div id="version-history-${d.id}" style="display:none; margin-top:8px;"></div>
        </div>
      `).join('') : `<p class="empty-hint">Todavía no hay documentos cargados.</p>`}
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="toggleForm('document-form')">+ Subir documento</button>
      <div id="document-form" style="display:none; margin-top:10px;">
        <label>Archivo (PDF, JPG, PNG, DOC o DOCX — hasta 15MB)</label>
        <input id="document-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx">
        <label>Tipo de documento</label>
        <select id="document-type">
          ${Object.keys(DOCUMENT_TYPE_LABELS).map(t => `<option value="${t}">${DOCUMENT_TYPE_LABELS[t]}</option>`).join('')}
        </select>
        <button class="primary" style="width:100%;" onclick="uploadDocument('${m.id}')" id="upload-btn">Subir</button>
      </div>
    </div>

    <div class="card" id="section-comunicaciones">
      <h2>Comunicaciones</h2>
      <p class="empty-hint" style="margin-top:-4px; margin-bottom:10px;">Qué se dijo, quién lo dijo y a quién estaba dirigido — separado del Timeline, que es lo que pasó operativamente.</p>
      ${renderHearingBanner(m.code, hearings)}
      <div id="communications-list">${renderCommunicationsList(m.id, communications)}</div>
      <div id="communications-chat" style="margin-top:10px;"></div>
    </div>

    <div class="card" id="section-tareas">
      <h2>Tareas</h2>
      ${tasks.length ? tasks.map(t => `
        <div class="status-history-item">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${escapeHtml(t.title)}</strong>
              ${t.dueDate ? ` · vence ${fmtDate(t.dueDate)}` : ''}
              <br><span class="pill ${t.priority === 'urgente' || t.priority === 'alta' ? 'danger' : 'calm'}">${TASK_PRIORITY_LABELS[t.priority]}</span>
            </div>
            <select onchange="changeTaskStatus('${m.id}','${t.id}',this.value)" style="width:auto; margin:0;">
              ${Object.keys(TASK_STATUS_LABELS).map(s => `<option value="${s}" ${s===t.status?'selected':''}>${TASK_STATUS_LABELS[s]}</option>`).join('')}
            </select>
          </div>
        </div>
      `).join('') : `<p class="empty-hint">Sin tareas cargadas.</p>`}
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="toggleForm('task-form')">+ Nueva tarea</button>
      <div id="task-form" style="display:none; margin-top:10px;">
        <label>Título</label>
        <input id="task-title" placeholder="Ej: Llamar al requerido">
        <label>Vencimiento (opcional)</label>
        <input id="task-due" type="date">
        <label>Prioridad</label>
        <select id="task-priority">
          ${Object.keys(TASK_PRIORITY_LABELS).map(p => `<option value="${p}" ${p==='media'?'selected':''}>${TASK_PRIORITY_LABELS[p]}</option>`).join('')}
        </select>
        <button class="primary" style="width:100%;" onclick="addTask('${m.id}')">Guardar tarea</button>
      </div>
    </div>

    <div class="card" id="section-compromisos">
      <h2>Compromisos</h2>
      ${commitments.length ? commitments.map(c => `
        <div class="status-history-item">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${escapeHtml(partyName(c.partyId))}</strong>: ${escapeHtml(c.description)}
              ${c.dueDate ? ` · vence ${fmtDate(c.dueDate)}` : ''}
            </div>
            <select onchange="changeCommitmentStatus('${m.id}','${c.id}',this.value)" style="width:auto; margin:0;">
              ${Object.keys(COMMITMENT_STATUS_LABELS).map(s => `<option value="${s}" ${s===c.status?'selected':''}>${COMMITMENT_STATUS_LABELS[s]}</option>`).join('')}
            </select>
          </div>
        </div>
      `).join('') : `<p class="empty-hint">Sin compromisos cargados.</p>`}
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="toggleForm('commitment-form')">+ Nuevo compromiso</button>
      <div id="commitment-form" style="display:none; margin-top:10px;">
        <label>Parte responsable</label>
        <select id="commitment-party">
          ${parties.map(p => `<option value="${p.id}">${escapeHtml(partyName(p.id))}</option>`).join('')}
        </select>
        <label>Descripción</label>
        <input id="commitment-description" placeholder="Ej: Enviar presupuesto">
        <label>Vencimiento</label>
        <input id="commitment-due" type="date">
        <button class="primary" style="width:100%;" onclick="addCommitment('${m.id}')">Guardar compromiso</button>
      </div>
    </div>

    <div class="card" id="section-timeline">
      <h2>Timeline</h2>
      ${timeline.length ? timeline.map(e => `
        <div class="status-history-item" style="${e.causedByEventId ? 'padding-left:16px; border-left:2px solid var(--calm-dim);' : ''}">
          <strong>${EVENT_TYPE_LABELS[e.type] || e.type}</strong>${e.title ? ': ' + escapeHtml(e.title) : ''}
          ${e.description ? `<br><span style="color:var(--text-faint);">${escapeHtml(e.description)}</span>` : ''}
          <br><span style="color:var(--text-faint);">${fmtDateTime(e.createdAt)}</span>
        </div>
      `).join('') : `<p class="empty-hint">Sin actividad todavía.</p>`}
    </div>

    <div class="card">
      <h2>Preguntale al asistente</h2>
      <div id="mediation-assistant-answer" style="margin-bottom:8px;"></div>
      <div style="display:flex; gap:6px;">
        <input id="mediation-assistant-question" placeholder="Ej: preparame un resumen de esta mediación" style="flex:1; margin:0;">
        <button class="primary" style="flex-shrink:0;" onclick="askMediationAI('${m.id}')">Preguntar</button>
      </div>
    </div>

    <div class="eyebrow" style="margin:22px 2px 6px; scroll-margin-top:52px;" id="section-admin">Administración del caso</div>

    <div class="card">
      <h2>Estado</h2>
      <select id="status-select">${statusOptions}</select>
      <textarea id="status-note" placeholder="Nota sobre el cambio (opcional)" rows="2"></textarea>
      <button class="ghost" style="width:100%;" onclick="changeStatus('${m.id}')">Actualizar estado</button>
    </div>

    <div class="card">
      <h2>Próxima acción</h2>
      <label>Qué hay que hacer</label>
      <input id="next-text" value="${escapeHtml(m.nextActionText || '')}" placeholder="Ej: Esperar presupuesto">
      <label>Responsable</label>
      <select id="next-responsible-type" onchange="toggleResponsibleIdField()">
        <option value="mediador" ${m.nextActionResponsibleType==='mediador'||!m.nextActionResponsibleType?'selected':''}>Mediador/a</option>
        <option value="party" ${m.nextActionResponsibleType==='party'?'selected':''}>Una parte</option>
        <option value="lawyer" ${m.nextActionResponsibleType==='lawyer'?'selected':''}>Un abogado</option>
      </select>
      <div id="next-responsible-id-wrap" style="display:${m.nextActionResponsibleType==='party'||m.nextActionResponsibleType==='lawyer'?'block':'none'};">
        <label>¿Cuál?</label>
        <select id="next-responsible-id">
          ${parties.map(p => `<option value="${p.id}" data-kind="party" ${m.nextActionResponsibleId===p.id?'selected':''}>${escapeHtml(partyName(p.id))}</option>`).join('')}
          ${lawyers.map(l => `<option value="${l.id}" data-kind="lawyer" ${m.nextActionResponsibleId===l.id?'selected':''}>${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>
      <label>Vencimiento</label>
      <input id="next-due" type="date" value="${m.nextActionDueDate || ''}">
      <button class="ghost" style="width:100%;" onclick="saveNextAction('${m.id}')">Guardar próxima acción</button>
    </div>

    <div class="card">
      <h2>Datos generales</h2>
      <label>Tipo</label>
      <input id="edit-type" value="${escapeHtml(m.type || '')}">
      <label>Descripción</label>
      <textarea id="edit-description" rows="3">${escapeHtml(m.description || '')}</textarea>
      <button class="ghost" style="width:100%;" onclick="saveGeneralData('${m.id}')">Guardar</button>
    </div>

    <div class="card">
      <h2>Equipo asignado</h2>
      ${(() => {
        const ownerMember = myStudio?.members?.find(mem => mem.id === m.mediatorUserId);
        return ownerMember ? `<p class="empty-hint" style="margin-bottom:8px;">Responsable principal: ${escapeHtml(ownerMember.name)}</p>` : '';
      })()}
      ${access.length ? access.map(a => `
        <div class="status-history-item">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div><strong>${escapeHtml(a.userName || '—')}</strong><br><span style="color:var(--text-faint);">${STUDIO_ROLE_LABELS[a.role] || a.role}</span></div>
            ${myStudio && myStudio.myRole === 'admin' ? `<button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="revokeMediationAccess('${m.id}','${a.id}')">Quitar</button>` : ''}
          </div>
        </div>
      `).join('') : `<p class="empty-hint">Sin gente adicional asignada — solo el responsable principal.</p>`}
      ${myStudio && myStudio.myRole === 'admin' ? `
        <div style="margin-top:10px;">
          <label>Asignar a alguien del estudio</label>
          <select id="assign-user">
            ${myStudio.members.filter(mem => mem.id !== m.mediatorUserId && !access.some(a => a.userId === mem.id)).map(mem => `<option value="${mem.id}">${escapeHtml(mem.name)} (${STUDIO_ROLE_LABELS[mem.studioRole] || mem.studioRole})</option>`).join('')}
          </select>
          <select id="assign-role">
            <option value="mediador">Como mediador/a</option>
            <option value="asistente">Como asistente</option>
          </select>
          <button class="ghost" style="width:100%;" onclick="assignMediationAccess('${m.id}')">Asignar</button>
        </div>
      ` : ''}
    </div>

    <div class="card">
      <h2>Historial de estados</h2>
      ${history.map(h => `
        <div class="status-history-item">
          ${h.fromStatus ? `${STATUS_LABELS[h.fromStatus]} → ` : 'Alta: '}${STATUS_LABELS[h.toStatus] || h.toStatus}
          ${h.note ? ' — ' + escapeHtml(h.note) : ''}
          <span style="color:var(--text-faint);">· ${fmtDateTime(h.createdAt)}</span>
        </div>
      `).join('')}
    </div>

    <div class="card">
      <h2>Avisos automáticos</h2>
      <label>Anticipación para audiencias (horas)</label>
      <input id="reminder-hours" type="number" min="1" max="336" value="${m.reminderHoursBefore}">
      <label>"Vencen próximamente" para tareas y compromisos (días)</label>
      <input id="upcoming-window-days" type="number" min="1" max="60" value="${m.upcomingDueWindowDays}">
      <label>Por dónde avisar</label>
      <select id="reminder-channels">
        <option value="push,whatsapp" ${m.reminderChannels === 'push,whatsapp' ? 'selected' : ''}>Push y WhatsApp</option>
        <option value="push" ${m.reminderChannels === 'push' ? 'selected' : ''}>Solo push</option>
        <option value="whatsapp" ${m.reminderChannels === 'whatsapp' ? 'selected' : ''}>Solo WhatsApp</option>
      </select>
      <button class="ghost" style="width:100%;" onclick="saveReminderSettings('${m.id}')">Guardar</button>
    </div>

    <div class="card">
      <h2>Exportar</h2>
      <a class="ghost" style="display:block; text-align:center; text-decoration:none; padding:10px; color:var(--text); margin-bottom:8px;" href="/api/mediations/${m.id}/export">Descargar informe certificado (PDF)</a>
      <a class="ghost" style="display:block; text-align:center; text-decoration:none; padding:10px; color:var(--text); margin-bottom:8px;" href="/api/mediations/${m.id}/export/constancia">Descargar constancia corta</a>
      <a class="ghost" style="display:block; text-align:center; text-decoration:none; padding:10px; color:var(--text);" href="/api/mediations/${m.id}/export/package">Descargar paquete completo (.zip)</a>
      ${!m.closedAt ? `<p class="empty-hint" style="margin-top:8px;">Revisar antes: <a href="#" onclick="showCloseChecklist('${m.id}'); return false;" style="color:var(--calm);">ver checklist de cierre</a></p>` : ''}
    </div>

    ${!m.closedAt ? `
    <div class="card">
      <h2>Cerrar mediación</h2>
      <label>Resultado</label>
      <select id="close-result">
        <option value="acuerdo_total">Acuerdo total</option>
        <option value="acuerdo_parcial">Acuerdo parcial</option>
        <option value="sin_acuerdo">Sin acuerdo</option>
        <option value="incomparecencia">Incomparecencia</option>
        <option value="desistimiento">Desistimiento</option>
        <option value="otro">Otro</option>
      </select>
      <label>Notas (opcional)</label>
      <textarea id="close-notes" rows="2"></textarea>
      <button class="ghost" style="width:100%; background:var(--danger-dim); color:var(--danger); border-color:var(--danger);" onclick="closeMediation('${m.id}')">Cerrar mediación</button>
    </div>
    ` : `
    <div class="card">
      <h2>Mediación cerrada</h2>
      <p class="empty-hint">Resultado: ${escapeHtml(m.closedResult)} · ${fmtDateTime(m.closedAt)}${m.closedByName ? ' · cerrada por ' + escapeHtml(m.closedByName) : ''}</p>
      ${m.closedNotes ? `<p class="empty-hint">${escapeHtml(m.closedNotes)}</p>` : ''}
    </div>
    `}
  `;
}
async function saveReminderSettings(id){
  try{
    await api(`/api/mediations/${id}`, { method:'PATCH', body: JSON.stringify({
      reminderHoursBefore: Number(document.getElementById('reminder-hours').value),
      reminderChannels: document.getElementById('reminder-channels').value,
      upcomingDueWindowDays: Number(document.getElementById('upcoming-window-days').value),
    })});
    renderDetail(id);
  }catch(e){ showToast(e.error || 'No se pudo guardar la configuración.', 'danger'); }
}

async function showCloseChecklist(mediationId){
  try{
    const c = await api(`/api/mediations/${mediationId}/close-checklist`);
    const lines = [
      `Audiencias registradas: ${c.hearingsRegistered ? 'sí' : 'no'}`,
      `Documentos finales: ${c.hasFinalDocuments ? 'sí' : 'no'}`,
      c.unresolvedHearings.length ? `Audiencias sin resolver: ${c.unresolvedHearings.length}` : 'Audiencias sin resolver: ninguna',
      c.pendingTasks.length ? `Tareas pendientes: ${c.pendingTasks.map(t=>t.title).join(', ')}` : 'Tareas pendientes: ninguna',
      c.documentsPendingReview.length ? `Documentos sin revisar: ${c.documentsPendingReview.map(d=>d.originalFilename).join(', ')}` : 'Documentos sin revisar: ninguno',
      c.pendingCommitments.length ? `Compromisos pendientes: ${c.pendingCommitments.map(p=>p.description).join(', ')}` : 'Compromisos pendientes: ninguno',
      `Próxima acción todavía cargada: ${c.hasPendingNextAction ? 'sí' : 'no'}`,
    ];
    showToast(lines.join('\n'), 'danger');
  }catch(e){ showToast(e.error || 'No se pudo cargar el checklist.', 'danger'); }
}

async function closeMediation(id){
  const result = document.getElementById('close-result').value;
  const notes = document.getElementById('close-notes').value.trim() || undefined;
  if(!confirm(`¿Cerrar esta mediación con resultado "${CLOSE_RESULT_LABELS[result] || result}"? No hay forma de reabrirla después desde acá.`)) return;
  try{
    await api(`/api/mediations/${id}/close`, { method:'POST', body: JSON.stringify({ result, notes }) });
    renderDetail(id);
  }catch(e){
    if(e.needsConfirmation){
      const pending = e.checklist.pendingCommitments.map(c => `- ${c.partyName}: ${c.description}`).join('\n');
      if(confirm(`Hay compromisos pendientes sin resolver:\n${pending}\n\n¿Cerrar igual?`)){
        try{
          await api(`/api/mediations/${id}/close`, { method:'POST', body: JSON.stringify({ result, notes, confirmDespiteWarnings:true }) });
          renderDetail(id);
        }catch(e2){ showToast(e2.error || 'No se pudo cerrar la mediación.', 'danger'); }
      }
    } else {
      showToast(e.error || 'No se pudo cerrar la mediación.', 'danger');
    }
  }
}
async function changeStatus(id){
  const status = document.getElementById('status-select').value;
  const note = document.getElementById('status-note').value.trim() || undefined;
  try{
    await api(`/api/mediations/${id}/status`, { method:'POST', body: JSON.stringify({ status, note }) });
    renderDetail(id);
  }catch(e){ showToast(e.error || 'No se pudo cambiar el estado.', 'danger'); }
}
function toggleResponsibleIdField(){
  const type = document.getElementById('next-responsible-type').value;
  document.getElementById('next-responsible-id-wrap').style.display = (type === 'party' || type === 'lawyer') ? 'block' : 'none';
}

async function saveNextAction(id){
  const responsibleType = document.getElementById('next-responsible-type').value;
  const responsibleIdField = document.getElementById('next-responsible-id');
  try{
    await api(`/api/mediations/${id}`, { method:'PATCH', body: JSON.stringify({
      nextActionText: document.getElementById('next-text').value.trim(),
      nextActionDueDate: document.getElementById('next-due').value || null,
      nextActionResponsibleType: responsibleType,
      nextActionResponsibleId: (responsibleType === 'party' || responsibleType === 'lawyer') ? responsibleIdField.value : null,
    })});
    renderDetail(id);
  }catch(e){ showToast(e.error || 'No se pudo guardar.', 'danger'); }
}
async function assignMediationAccess(mediationId){
  const userId = document.getElementById('assign-user').value;
  const role = document.getElementById('assign-role').value;
  if(!userId){ showToast('No hay nadie más del estudio para asignar.', 'danger'); return; }
  try{
    await api(`/api/mediations/${mediationId}/access`, { method:'POST', body: JSON.stringify({ userId, role }) });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo asignar.', 'danger'); }
}

async function revokeMediationAccess(mediationId, accessId){
  if(!confirm('¿Quitar el acceso de esta persona a la mediación?')) return;
  try{
    await api(`/api/mediations/${mediationId}/access/${accessId}`, { method:'DELETE' });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo quitar el acceso.', 'danger'); }
}

async function saveGeneralData(id){
  try{
    await api(`/api/mediations/${id}`, { method:'PATCH', body: JSON.stringify({
      type: document.getElementById('edit-type').value.trim(),
      description: document.getElementById('edit-description').value.trim(),
    })});
    renderDetail(id);
  }catch(e){ showToast(e.error || 'No se pudo guardar.', 'danger'); }
}

function toggleForm(id){
  const el = document.getElementById(id);
  if(el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function openPartyChat(mediationId, partyId){
  const box = document.getElementById(`chat-${partyId}`);
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  await loadPartyChat(mediationId, partyId);
}

async function loadPartyChat(mediationId, partyId){
  const box = document.getElementById(`chat-${partyId}`);
  let messages;
  try{ messages = await api(`/api/mediations/${mediationId}/parties/${partyId}/messages`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudo cargar el chat.</p>`; return; }
  box.innerHTML = `
    <div style="max-height:220px; overflow-y:auto; background:var(--surface-2); border-radius:8px; padding:8px; margin-bottom:8px;">
      ${messages.length ? messages.map(m => `
        <div style="margin-bottom:6px; font-size:12px;">
          <strong>${escapeHtml(m.sender ? m.sender.name : 'Sistema')}:</strong> ${escapeHtml(m.text)}
          <br><span style="color:var(--text-faint); font-size:10px;">${fmtDateTime(m.createdAt)}</span>
        </div>
      `).join('') : `<p class="empty-hint">Sin mensajes todavía.</p>`}
    </div>
    <div style="display:flex; gap:6px;">
      <input id="chat-input-${partyId}" placeholder="Escribí un mensaje…" style="flex:1; margin:0;">
      <button class="primary" style="flex-shrink:0;" onclick="sendPartyMessage('${mediationId}','${partyId}')">Enviar</button>
    </div>
  `;
}

async function sendPartyMessage(mediationId, partyId){
  const input = document.getElementById(`chat-input-${partyId}`);
  const text = input.value.trim();
  if(!text) return;
  try{
    await api(`/api/mediations/${mediationId}/parties/${partyId}/messages`, { method:'POST', body: JSON.stringify({ text }) });
    await loadPartyChat(mediationId, partyId);
  }catch(e){ showToast(e.error || 'No se pudo enviar el mensaje.', 'danger'); }
}

// ================= COMUNICACIONES (Bloque 19) =================
// Principio: MENSAJE → CONTEXTO → ACCIÓN → TRAZABILIDAD. Reusa
// exactamente los mismos endpoints que ya arma routes/mediations.js
// sobre channels/members/messages — nada de esto es una tabla ni un
// socket paralelo. El chat rápido dentro de "Partes" (openPartyChat)
// se deja intacto para no romper nada que ya funciona; esta sección es
// la vista completa, con no-leídos, adjuntos y acciones.
let currentConversation = null; // { mediationId, type, participantId, code }

const CONVERSATION_TYPE_LABELS = { parte: 'Parte', abogado: 'Abogado', interno: 'Interno' };

function renderCommunicationsList(mediationId, conversations){
  if(!conversations || !conversations.length) return `<p class="empty-hint">Todavía no hay conversaciones — invitá a una parte o a un abogado al portal para empezar una.</p>`;
  return conversations.map(c => `
    <div class="status-history-item" style="cursor:pointer; display:flex; gap:10px; align-items:flex-start;" onclick="openConversation('${mediationId}','${c.type}',${c.participantId ? `'${c.participantId}'` : 'null'},${c.code ? `'${c.code}'` : 'null'})">
      <div style="width:34px; height:34px; border-radius:50%; background:var(--color-brand-soft); color:var(--color-brand-dark); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; flex-shrink:0;">${escapeHtml((c.participantName || '?').charAt(0).toUpperCase())}</div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
          <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><strong>${escapeHtml(c.participantName)}</strong> <span class="pill calm" style="margin-left:2px;">${CONVERSATION_TYPE_LABELS[c.type] || c.type}</span></div>
          ${c.unreadCount ? `<span class="pill warn" style="flex-shrink:0;">${c.unreadCount} nuevo${c.unreadCount===1?'':'s'}</span>` : ''}
        </div>
        <div style="font-size:12px; color:var(--text-dim); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${c.lastMessage ? escapeHtml(c.lastMessage.text) + ` <span style="color:var(--text-faint);">· ${fmtDateTime(c.lastMessage.createdAt)}</span>` : '<span class="empty-hint">Sin mensajes todavía.</span>'}
        </div>
      </div>
    </div>
  `).join('');
}

function conversationEndpoint(mediationId, type, participantId){
  if(type === 'parte') return `/api/mediations/${mediationId}/parties/${participantId}/messages`;
  if(type === 'abogado') return `/api/mediations/${mediationId}/lawyers/${participantId}/messages`;
  return `/api/mediations/${mediationId}/internal/messages`;
}

async function openConversation(mediationId, type, participantId, code){
  const box = document.getElementById('communications-chat');
  const isSameAlreadyOpen = currentConversation && currentConversation.mediationId === mediationId && currentConversation.type === type && currentConversation.participantId === participantId;
  if(isSameAlreadyOpen){ box.innerHTML = ''; currentConversation = null; return; }
  currentConversation = { mediationId, type, participantId, code };
  box.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  await loadConversation();
  // marcar como leído recién al ABRIR la conversación, nunca solo por
  // haber cargado el expediente (Bloque 19 §"mensajes no leídos") — y
  // solo si ya existe un canal real (code), no tiene sentido marcar
  // leído un hilo interno que todavía no se creó.
  if(code){
    try{
      await api(`/api/mediations/${mediationId}/communications/${code}/read-all`, { method:'POST' });
      // refresca el badge "N nuevo" de la lista — si no, queda marcado
      // como leído en el servidor pero se ve sin leer hasta recargar todo.
      const list = await api(`/api/mediations/${mediationId}/communications`);
      document.getElementById('communications-list').innerHTML = renderCommunicationsList(mediationId, list);
    }catch(e){ /* no bloquea la lectura si falla */ }
  }
}

async function loadConversation(){
  const { mediationId, type, participantId } = currentConversation;
  const box = document.getElementById('communications-chat');
  let messages;
  try{ messages = await api(conversationEndpoint(mediationId, type, participantId)); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudo cargar la conversación.</p>`; return; }

  box.innerHTML = `
    <div style="background:var(--surface-2); border-radius:8px; padding:10px;">
      <div id="conversation-messages" style="max-height:320px; overflow-y:auto; margin-bottom:8px;">
        ${messages.length ? messages.map(m => renderConversationMessage(m)).join('') : `<p class="empty-hint">Sin mensajes todavía.</p>`}
      </div>
      <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
        <select id="conversation-attach-doc" style="width:auto; margin:0; flex:1; font-size:11px;">
          <option value="">Sin adjuntar documento</option>
          ${currentDocuments.map(d => `<option value="${d.id}">${escapeHtml(d.originalFilename)}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex; gap:6px;">
        <input id="conversation-input" placeholder="Escribí un mensaje…" style="flex:1; margin:0;" onkeyup="if(event.key==='Enter') sendConversationMessage()">
        <button class="primary" style="flex-shrink:0;" onclick="sendConversationMessage()">Enviar</button>
      </div>
    </div>
  `;
  const list = document.getElementById('conversation-messages');
  list.scrollTop = list.scrollHeight;
}

function renderConversationMessage(m){
  const isSystem = !m.sender;
  const isMine = !isSystem && m.sender.id === me.id;
  const isInternal = currentConversation.type === 'interno';
  const who = isSystem ? 'Sistema' : escapeHtml(m.sender.name);
  const canAct = !isSystem && (currentConversation.type === 'parte' || currentConversation.type === 'abogado');
  // Bloque 20 §21 — mensaje propio: fondo suave de marca; recibido: blanco;
  // interno: gris neutro discreto (que se note que no es cara a la parte).
  // Nunca alineado tipo WhatsApp — es una lista, no burbujas flotantes.
  const bubbleStyle = isInternal
    ? 'background:var(--color-surface-2); border:1px solid var(--color-border-light);'
    : isMine
      ? 'background:var(--color-brand-soft); border:1px solid transparent;'
      : 'background:var(--color-surface); border:1px solid var(--color-border-light);';
  return `
    <div id="msg-${m.id}" style="border-radius:var(--radius-md); padding:8px 10px; margin-bottom:6px; ${bubbleStyle}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
        <div style="flex:1;">
          <strong style="font-size:12.5px;">${who}</strong> <span style="font-size:13px;">${escapeHtml(m.text)}</span>
          ${m.document ? `
            <div style="margin-top:4px;">
              <a href="/api/mediations/${currentConversation.mediationId}/documents/${m.document.id}/download" class="pill calm" style="text-decoration:none;">📎 ${escapeHtml(m.document.originalFilename)}${m.document.version > 1 ? ` (v${m.document.version})` : ''}</a>
            </div>
          ` : ''}
          <div style="color:var(--text-faint); font-size:10px; margin-top:2px;">${fmtDateTime(m.createdAt)}</div>
        </div>
        ${canAct ? `<button class="ghost" style="padding:2px 8px; font-size:11px; flex-shrink:0;" onclick="toggleMessageActions('${m.id}')">⋯</button>` : ''}
      </div>
      <div id="msg-actions-${m.id}" style="display:none; margin-top:6px; gap:6px; flex-wrap:wrap;">
        <button class="ghost" style="padding:4px 8px; font-size:11px;" onclick="startConvertToTask('${m.id}', '${escapeHtml(m.text).replace(/'/g,"\\'")}')">Convertir en tarea</button>
        ${currentConversation.type === 'parte' ? `<button class="ghost" style="padding:4px 8px; font-size:11px;" onclick="startConvertToCommitment('${m.id}', '${escapeHtml(m.text).replace(/'/g,"\\'")}')">Crear compromiso</button>` : ''}
        ${currentHearings.length ? `<button class="ghost" style="padding:4px 8px; font-size:11px;" onclick="startManageReschedule('${m.id}')">Gestionar cambio de audiencia</button>` : ''}
      </div>
      <div id="msg-reschedule-${m.id}" style="display:none; margin-top:6px;"></div>
    </div>
  `;
}

function toggleMessageActions(messageId){
  const box = document.getElementById(`msg-actions-${messageId}`);
  box.style.display = box.style.display === 'flex' ? 'none' : 'flex';
}

async function sendConversationMessage(){
  const input = document.getElementById('conversation-input');
  const text = input.value.trim();
  if(!text) return;
  const docSelect = document.getElementById('conversation-attach-doc');
  const documentId = docSelect.value || null;
  input.value = '';
  try{
    await api(conversationEndpoint(currentConversation.mediationId, currentConversation.type, currentConversation.participantId), {
      method:'POST', body: JSON.stringify({ text, documentId }),
    });
    docSelect.value = '';
    await loadConversation();
    // refresca la lista de conversaciones (último mensaje / no-leídos) sin
    // recargar todo el expediente.
    const list = await api(`/api/mediations/${currentConversation.mediationId}/communications`);
    document.getElementById('communications-list').innerHTML = renderCommunicationsList(currentConversation.mediationId, list);
  }catch(e){ showToast(e.error || 'No se pudo enviar el mensaje.', 'danger'); }
}

// "Convertir en tarea" — abre el formulario de Tareas YA existente,
// precompletado, en vez de crear la tarea sola. Nunca automático.
function startConvertToTask(messageId, messageText){
  pendingSourceMessageId = messageId;
  pendingSourceDocumentId = null;
  const form = document.getElementById('task-form');
  form.style.display = 'block';
  document.getElementById('task-title').value = messageText.length > 80 ? messageText.slice(0, 80) + '…' : messageText;
  document.getElementById('section-tareas').scrollIntoView({ behavior:'smooth', block:'start' });
}

function startConvertToCommitment(messageId, messageText){
  pendingSourceMessageId = messageId;
  const form = document.getElementById('commitment-form');
  form.style.display = 'block';
  document.getElementById('commitment-description').value = messageText.length > 80 ? messageText.slice(0, 80) + '…' : messageText;
  if(currentConversation.type === 'parte'){
    const select = document.getElementById('commitment-party');
    if(select) select.value = currentConversation.participantId;
  }
  document.getElementById('section-compromisos').scrollIntoView({ behavior:'smooth', block:'start' });
}

// "Gestionar cambio de audiencia" — NUNCA reprograma sola. Solo arma la
// SOLICITUD (misma tabla/estados que ya usan los portales de parte y
// abogado) para que el mediador la resuelva después con el flujo de
// siempre, desde Audiencias → Solicitudes de cambio.
function startManageReschedule(messageId){
  const box = document.getElementById(`msg-reschedule-${messageId}`);
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = `
    <label>¿Qué audiencia?</label>
    <select id="reschedule-hearing-${messageId}">
      ${currentHearings.map(h => `<option value="${h.id}">${fmtDate(h.date)}${h.startTime ? ' ' + h.startTime : ''}</option>`).join('')}
    </select>
    <button class="primary" style="width:100%;" onclick="submitRescheduleFromMessage('${messageId}')">Registrar pedido de cambio</button>
  `;
}

async function submitRescheduleFromMessage(messageId){
  const hearingId = document.getElementById(`reschedule-hearing-${messageId}`).value;
  const body = { sourceMessageId: messageId };
  if(currentConversation.type === 'parte') body.partyId = currentConversation.participantId;
  else body.lawyerId = currentConversation.participantId;
  try{
    await api(`/api/mediations/${currentConversation.mediationId}/hearings/${hearingId}/reschedule-requests`, { method:'POST', body: JSON.stringify(body) });
    showToast('Pedido de cambio registrado — lo vas a encontrar en "Solicitudes de cambio" desde Audiencias.', 'success');
    document.getElementById(`msg-reschedule-${messageId}`).style.display = 'none';
  }catch(e){ showToast(e.error || 'No se pudo registrar el pedido.', 'danger'); }
}

async function toggleAllowUpload(mediationId, partyId, allow){
  try{
    await api(`/api/mediations/${mediationId}/parties/${partyId}`, { method:'PATCH', body: JSON.stringify({ allowDocumentUpload: allow }) });
  }catch(e){ showToast(e.error || 'No se pudo actualizar el permiso.', 'danger'); renderDetail(mediationId); }
}

async function inviteParty(mediationId, partyId){
  try{
    const result = await api(`/api/mediations/${mediationId}/parties/${partyId}/invite`, { method:'POST' });
    const fullUrl = location.origin + result.portalUrl;
    copyLinkToClipboard(fullUrl, 'Link del portal copiado — compartíselo a la parte.');
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo generar la invitación.', 'danger'); }
}

// Bloque 24 — el segundo parámetro (afterSave) es opcional: lo usa
// únicamente el asistente de carga guiada para avanzar de paso en vez de
// re-renderizar el expediente normal. Sin él, el comportamiento es
// exactamente el de siempre (llamado desde la pestaña Partes).
async function addParty(mediationId, afterSave){
  const firstName = document.getElementById('party-first-name').value.trim();
  const lastName = document.getElementById('party-last-name').value.trim();
  if(!firstName){ showToast('Falta el nombre de la parte.', 'danger'); return; }
  try{
    await api(`/api/mediations/${mediationId}/parties`, { method:'POST', body: JSON.stringify({
      role: document.getElementById('party-role').value,
      firstName, lastName,
      documentNumber: document.getElementById('party-document').value.trim() || null,
      email: document.getElementById('party-email').value.trim() || null,
      phone: document.getElementById('party-phone').value.trim() || null,
    })});
    if(afterSave) afterSave(); else renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo guardar la parte.', 'danger'); }
}

async function inviteLawyer(mediationId, lawyerId){
  try{
    const result = await api(`/api/mediations/${mediationId}/lawyers/${lawyerId}/invite`, { method:'POST' });
    const fullUrl = location.origin + result.portalUrl;
    copyLinkToClipboard(fullUrl, 'Link del portal copiado — compartíselo al abogado.');
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo generar la invitación.', 'danger'); }
}

async function addLawyer(mediationId, afterSave){
  const name = document.getElementById('lawyer-name').value.trim();
  if(!name){ showToast('Falta el nombre del abogado.', 'danger'); return; }
  try{
    await api(`/api/mediations/${mediationId}/lawyers`, { method:'POST', body: JSON.stringify({
      name,
      enrollmentNumber: document.getElementById('lawyer-enrollment').value.trim() || null,
      partyId: document.getElementById('lawyer-party').value || null,
      email: document.getElementById('lawyer-email').value.trim() || null,
    })});
    if(afterSave) afterSave(); else renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo guardar el abogado.', 'danger'); }
}

async function addHearing(mediationId, afterSave){
  const date = document.getElementById('hearing-date').value;
  if(!date){ showToast('Falta la fecha de la audiencia.', 'danger'); return; }
  const modality = document.getElementById('hearing-modality').value;
  // Bloque 28 — el form principal tiene un campo de link dedicado
  // (hearing-meeting-url) y un selector de proveedor; el wizard rápido
  // (Bloque 24) solo tiene el campo combinado "Lugar" de siempre — en ese
  // caso, si la modalidad es virtual, ese texto ES el link (nunca se
  // mandaba antes: el bug real era que esta función solo lo mandaba como
  // `location`, jamás como `meetingUrl`, así que crear una audiencia
  // virtual desde el wizard siempre fallaba con 400).
  const locationValue = document.getElementById('hearing-location').value.trim() || null;
  const meetingUrlField = document.getElementById('hearing-meeting-url');
  const providerField = document.getElementById('hearing-provider');
  const provider = providerField && providerField.value ? providerField.value : null;
  const meetingUrl = meetingUrlField
    ? (meetingUrlField.value.trim() || null)
    : (modality === 'virtual' ? locationValue : null);
  const location = meetingUrlField ? locationValue : (modality === 'virtual' ? null : locationValue);
  const body = { date, startTime: document.getElementById('hearing-time').value || null, modality, location };
  if(provider) body.provider = provider; else if(meetingUrl) body.meetingUrl = meetingUrl;
  try{
    await api(`/api/mediations/${mediationId}/hearings`, { method:'POST', body: JSON.stringify(body) });
    if(afterSave) afterSave(); else renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo agendar la audiencia.', 'danger'); }
}

// Bloque 17 §4 — la audiencia necesita UNA acción principal que cambie
// según el estado, no siempre la misma fila de controles. El resto
// (cambiar estado a mano, registrar confirmaciones por teléfono,
// solicitudes de cambio) sigue existiendo, pero como fila secundaria
// debajo — no compite en peso visual con la acción principal.
function renderHearingRow(m, h, timelineList){
  const now = Date.now();
  const hearingMs = new Date(h.date + 'T' + (h.startTime || '00:00')).getTime();
  const within48h = !isNaN(hearingMs) && (hearingMs - now) <= 48*60*60*1000 && (hearingMs - now) > -24*60*60*1000;

  let primaryHtml = '';
  let motivoHtml = '';
  if(h.status === 'propuesta'){
    primaryHtml = `<button class="primary" style="padding:6px 10px; font-size:11px;" onclick="confirmProposal('${m.id}','${h.id}')">Elegir este horario</button>`;
  } else if(h.status === 'realizada'){
    primaryHtml = `<button class="primary" style="padding:6px 10px; font-size:11px;" onclick="toggleSummary('${m.id}','${h.id}')">Ver resumen</button>`;
  } else if(h.status === 'cancelada' || h.status === 'no_realizada'){
    const ev = (timelineList||[]).find(e => ['HEARING_CANCELLED','HEARING_NOT_HELD'].includes(e.type) && e.entityId === h.id);
    if(ev && ev.description) motivoHtml = `<p class="empty-hint" style="margin-top:4px;">Motivo: ${escapeHtml(ev.description)}</p>`;
    primaryHtml = `<button class="primary" style="padding:6px 10px; font-size:11px;" onclick="toggleForm('propose-form')">+ Proponer de nuevo</button>`;
  } else if(h.modality === 'virtual' && h.meetingUrl && within48h){
    primaryHtml = `<a href="${escapeHtml(h.meetingUrl)}" target="_blank" class="primary" style="padding:6px 10px; font-size:11px; text-decoration:none; display:inline-block;">Entrar a audiencia</a>`;
  } else {
    primaryHtml = `<button class="primary" style="padding:6px 10px; font-size:11px;" onclick="togglePreparation('${m.id}','${h.id}')">Preparar audiencia</button>`;
  }
  const primaryIsPreparacion = primaryHtml.includes('togglePreparation');
  const primaryIsResumen = primaryHtml.includes('toggleSummary');

  return `
    <div class="status-history-item">
      <strong>${fmtDate(h.date)}${h.startTime ? ' ' + h.startTime : ''}</strong> —
      ${HEARING_MODALITY_LABELS[h.modality] || h.modality} · <span class="pill ${h.status==='propuesta'?'warn':(h.status==='cancelada'||h.status==='no_realizada')?'danger':'calm'}">${h.status==='propuesta'?'Propuesta':(HEARING_STATUS_LABELS[h.status] || h.status)}</span>
      ${motivoHtml}
      ${renderHearingVideoCard(m, h)}
      <div style="margin-top:4px;">
        ${h.confirmations.map(c => `
          <span class="pill ${c.response === 'confirma' ? 'calm' : c.response === 'no_puede' ? 'danger' : 'warn'}" style="margin-right:4px;">
            ${escapeHtml(partyName(c.partyId))}: ${CONFIRMATION_LABELS[c.response] || c.response}
          </span>
        `).join('')}
      </div>
      <div style="margin-top:8px;">${primaryHtml}</div>
      <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        <select onchange="changeHearingStatus('${m.id}','${h.id}',this.value)" style="width:auto; margin:0; font-size:11px; color:var(--text-faint);" title="Cambiar estado manualmente">
          ${Object.keys(HEARING_STATUS_LABELS).map(s => `<option value="${s}" ${s===h.status?'selected':''}>${HEARING_STATUS_LABELS[s]}</option>`).join('')}
        </select>
        ${h.confirmations.map(c => `
          <select onchange="recordConfirmation('${m.id}','${h.id}','${c.partyId}',this.value)" style="width:auto; margin:0; font-size:11px;">
            <option value="">${escapeHtml(partyName(c.partyId))} responde…</option>
            ${Object.keys(CONFIRMATION_LABELS).map(r => `<option value="${r}">${CONFIRMATION_LABELS[r]}</option>`).join('')}
          </select>
        `).join('')}
        <button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="toggleRescheduleRequests('${m.id}','${h.id}')">Solicitudes de cambio</button>
        ${!primaryIsPreparacion && h.status !== 'propuesta' ? `<button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="togglePreparation('${m.id}','${h.id}')">Preparación</button>` : ''}
        ${!primaryIsResumen && h.status !== 'propuesta' ? `<button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="toggleSummary('${m.id}','${h.id}')">Resumen</button>` : ''}
      </div>
      <div id="reschedule-${h.id}" style="display:none; margin-top:8px;"></div>
      <div id="preparation-${h.id}" style="display:none; margin-top:8px;"></div>
      <div id="summary-${h.id}" style="display:none; margin-top:8px;"></div>
    </div>
  `;
}

const PREPARATION_ITEM_LABELS = {
  partesIdentificadas: 'Partes identificadas', datosDeContacto: 'Datos de contacto', abogadosVinculados: 'Abogados vinculados',
  confirmaciones: 'Confirmaciones', documentosPendientesRevision: 'Documentos sin revisar', tareasPendientes: 'Tareas pendientes',
  compromisosPendientes: 'Compromisos pendientes', modalidadDatos: 'Datos de modalidad', solicitudesDeCambio: 'Solicitudes de cambio',
};
const PREPARATION_ITEM_STATUS_LABELS = { realizado: 'Listo', pendiente: 'Pendiente', no_corresponde: 'No corresponde' };
const PREPARATION_ESTADO_LABELS = { preparada: 'Preparada', pendiente: 'Pendiente', critica: 'Crítica' };

async function togglePreparation(mediationId, hearingId){
  const box = document.getElementById(`preparation-${hearingId}`);
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let prep;
  try{ prep = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/preparation`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudo cargar.</p>`; return; }

  box.innerHTML = `
    <div style="background:var(--surface-2); border-radius:8px; padding:8px 10px;">
      <span class="pill ${prep.estado==='preparada'?'calm':prep.estado==='critica'?'danger':'warn'}">${PREPARATION_ESTADO_LABELS[prep.estado]}</span>
      <p style="font-size:12px; margin:6px 0 0; color:var(--text-dim);">${escapeHtml(prep.motivo)}</p>
      <div style="margin-top:8px;">
        ${Object.keys(prep.items).map(k => `
          <div style="display:flex; justify-content:space-between; font-size:11.5px; padding:3px 0; border-top:1px solid var(--line);">
            <span>${PREPARATION_ITEM_LABELS[k] || k}</span>
            <span class="pill ${prep.items[k].status==='realizado'?'calm':prep.items[k].status==='pendiente'?'warn':''}">${PREPARATION_ITEM_STATUS_LABELS[prep.items[k].status]}${prep.items[k].detail ? ' · ' + escapeHtml(String(prep.items[k].detail)) : ''}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function toggleSummary(mediationId, hearingId){
  const box = document.getElementById(`summary-${hearingId}`);
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let s;
  try{ s = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/summary`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudo cargar.</p>`; return; }

  box.innerHTML = `
    <div style="background:var(--surface-2); border-radius:8px; padding:8px 10px;">
      <h3 style="font-size:12.5px; margin:0 0 6px;">Por parte</h3>
      ${s.perParty.map(p => `
        <div style="font-size:11.5px; padding:4px 0; border-top:1px solid var(--line);">
          <strong>${escapeHtml(p.partyName)}</strong> — ${CONFIRMATION_LABELS[p.confirmation] || 'sin confirmación'}
          ${p.lawyerName ? ' · abogado: ' + escapeHtml(p.lawyerName) : ''}
          ${p.pendingRequests ? ` · <span style="color:var(--warn);">${p.pendingRequests} solicitud(es) pendiente(s)</span>` : ''}
          ${p.pendingCommitments ? ` · ${p.pendingCommitments} compromiso(s) pendiente(s)` : ''}
        </div>
      `).join('') || `<p class="empty-hint">Sin partes cargadas.</p>`}
      <h3 style="font-size:12.5px; margin:10px 0 6px;">Documentos vigentes</h3>
      ${s.documentosRelevantes.length ? s.documentosRelevantes.map(d => `<div style="font-size:11.5px;">${escapeHtml(d.originalFilename)}</div>`).join('') : `<p class="empty-hint">Ninguno.</p>`}
      <h3 style="font-size:12.5px; margin:10px 0 6px;">Tareas pendientes</h3>
      ${s.tareasPendientes.length ? s.tareasPendientes.map(t => `<div style="font-size:11.5px;">${escapeHtml(t.title)}</div>`).join('') : `<p class="empty-hint">Ninguna.</p>`}
      ${s.proximaAccion.text ? `<h3 style="font-size:12.5px; margin:10px 0 6px;">Próxima acción</h3><p style="font-size:11.5px;">${escapeHtml(s.proximaAccion.text)}</p>` : ''}
    </div>
  `;
}

async function confirmProposal(mediationId, hearingId){
  try{
    const result = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/confirm-proposal`, { method:'POST' });
    const notifText = describeNotifications(result.notifications);
    if(notifText) alert(`Audiencia confirmada.\n\n${notifText}`);
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo confirmar la propuesta.', 'danger'); }
}

async function toggleRescheduleRequests(mediationId, hearingId){
  const box = document.getElementById(`reschedule-${hearingId}`);
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  await loadRescheduleRequests(mediationId, hearingId);
}

const RESCHEDULE_STATUS_LABELS = { pendiente:'Pendiente', aceptada:'Aceptada', rechazada:'Rechazada', reprogramada:'Reprogramada' };

async function loadRescheduleRequests(mediationId, hearingId){
  const box = document.getElementById(`reschedule-${hearingId}`);
  let requests;
  try{ requests = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/reschedule-requests`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudieron cargar las solicitudes.</p>`; return; }

  box.innerHTML = requests.length ? requests.map(r => `
    <div class="status-history-item" style="background:var(--surface-2); border-radius:8px; padding:8px; margin-bottom:6px;">
      <strong>${r.requestedByType === 'lawyer' ? 'Abogado' : 'Parte'}</strong> pidió cambio
      ${r.reason ? ` — "${escapeHtml(r.reason)}"` : ''}
      ${r.proposedDate ? `<br>Propuso: ${fmtDate(r.proposedDate)}${r.proposedStartTime ? ' ' + r.proposedStartTime : ''}` : '<br>Sin fecha propuesta'}
      <br><span class="pill ${r.status==='pendiente'?'warn':r.status==='rechazada'?'danger':'calm'}">${RESCHEDULE_STATUS_LABELS[r.status]}</span>
      ${r.status === 'pendiente' ? `
        <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          ${r.proposedDate ? `<button class="primary" style="padding:6px 10px; font-size:11px;" onclick="resolveReschedule('${mediationId}','${hearingId}','${r.id}','aceptar')">Aceptar fecha propuesta</button>` : ''}
          <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="resolveReschedule('${mediationId}','${hearingId}','${r.id}','rechazar')">Rechazar</button>
          <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="resolveReschedule('${mediationId}','${hearingId}','${r.id}','resolver_sin_cambio')">Resolver sin cambio</button>
          <input id="propose-date-${r.id}" type="date" style="width:auto;">
          <input id="propose-time-${r.id}" type="time" style="width:auto;">
          <button class="ghost" style="padding:6px 10px; font-size:11px;" onclick="resolveReschedule('${mediationId}','${hearingId}','${r.id}','proponer')">Proponer esta fecha</button>
        </div>
      ` : ''}
    </div>
  `).join('') : `<p class="empty-hint">Sin solicitudes de cambio para esta audiencia.</p>`;
}

async function resolveReschedule(mediationId, hearingId, requestId, action){
  const body = { action };
  if(action === 'proponer'){
    body.newDate = document.getElementById(`propose-date-${requestId}`).value;
    body.newStartTime = document.getElementById(`propose-time-${requestId}`).value || null;
    if(!body.newDate){ showToast('Falta la fecha para proponer.', 'danger'); return; }
  }
  try{
    const result = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/reschedule-requests/${requestId}/resolve`, { method:'POST', body: JSON.stringify(body) });
    const notifText = describeNotifications(result.notifications);
    if(notifText) alert(`Solicitud resuelta.\n\n${notifText}`);
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo resolver la solicitud.', 'danger'); }
}

async function changeHearingStatus(mediationId, hearingId, status){
  // cancelar/marcar no realizada avisa por WhatsApp a partes y abogados y
  // no tiene vuelta atrás desde acá (Bloque 17 §17: confirmar acciones
  // consecuentes, no solo las que borran datos).
  if(status === 'cancelada' && !confirm('¿Cancelar esta audiencia? Se les va a avisar a las partes y abogados por WhatsApp.')){ renderDetail(mediationId); return; }
  if(status === 'no_realizada' && !confirm('¿Marcar esta audiencia como no realizada?')){ renderDetail(mediationId); return; }
  try{
    const result = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/status`, { method:'POST', body: JSON.stringify({ status }) });
    await renderDetail(mediationId);
    const notifText = describeNotifications(result.notifications);
    if(notifText) alert(`Audiencia ${status}.\n\n${notifText}`);
    // el backend solo SUGIERE, nunca crea el compromiso solo (ver
    // IMPLEMENTATION_PLAN.md §3.11) — acá simplemente mostramos el aviso
    // y abrimos el formulario de compromisos si el mediador quiere cargarlo.
    if(result.suggestion?.type === 'CREATE_COMMITMENTS'){
      setTimeout(() => {
        if(confirm(result.suggestion.message)) toggleForm('commitment-form');
      }, 300);
    }
    // Bloque 22 §11 — "¿Qué sigue?" apenas se marca una audiencia como
    // realizada. Todo lo que ofrece ya existe (cambiar el estado de la
    // mediación, agendar, tareas, compromisos, próxima acción) — esto
    // solo evita que el mediador tenga que ir a buscarlo por su cuenta.
    if(status === 'realizada') showWhatNextPrompt(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo actualizar el estado de la audiencia.', 'danger'); }
}

function showWhatNextPrompt(mediationId){
  const main = document.getElementById('main');
  if(!main) return;
  const banner = document.createElement('div');
  banner.className = 'alert alert-info';
  banner.id = 'what-next-prompt';
  banner.innerHTML = `
    <div style="flex:1;">
      <div style="font-weight:600; margin-bottom:6px;">¿Qué sigue?</div>
      <div style="font-size:12.5px; margin-bottom:8px;">Registrá el resultado de la audiencia, o seguí con la mediación.</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
        <button class="btn-secondary btn-sm" onclick="startWhatNextResult('${mediationId}','acuerdo')">Registrar acuerdo</button>
        <button class="btn-secondary btn-sm" onclick="startWhatNextResult('${mediationId}','acuerdo_parcial')">Acuerdo parcial</button>
        <button class="btn-secondary btn-sm" onclick="startWhatNextResult('${mediationId}','sin_acuerdo')">Sin acuerdo</button>
        <button class="btn-secondary btn-sm" onclick="startWhatNextResult('${mediationId}','incomparecencia')">Incomparecencia</button>
      </div>
      <div style="font-size:11.5px; color:var(--text-dim); margin-bottom:4px;">O continuar la mediación:</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button class="btn-ghost btn-sm" onclick="dismissWhatNextPrompt(); toggleForm('hearing-form'); document.getElementById('section-audiencias')?.scrollIntoView({behavior:'smooth'});">Programar próxima audiencia</button>
        <button class="btn-ghost btn-sm" onclick="dismissWhatNextPrompt(); toggleForm('task-form'); document.getElementById('section-tareas')?.scrollIntoView({behavior:'smooth'});">Crear tarea</button>
        <button class="btn-ghost btn-sm" onclick="dismissWhatNextPrompt(); toggleForm('commitment-form'); document.getElementById('section-compromisos')?.scrollIntoView({behavior:'smooth'});">Crear compromiso</button>
        <button class="btn-ghost btn-sm" onclick="dismissWhatNextPrompt(); document.getElementById('section-admin')?.scrollIntoView({behavior:'smooth'});">Definir próxima acción</button>
      </div>
    </div>
    <button class="modal-close" style="align-self:flex-start;" onclick="dismissWhatNextPrompt()" aria-label="Cerrar">×</button>
  `;
  banner.style.display = 'flex';
  banner.style.alignItems = 'flex-start';
  banner.style.gap = '8px';
  main.prepend(banner);
  banner.scrollIntoView({ behavior:'smooth', block:'start' });
}
function dismissWhatNextPrompt(){ document.getElementById('what-next-prompt')?.remove(); }
// "Registrar acuerdo/parcial/sin acuerdo/incomparecencia" reusa el
// cambio de estado de MEDIACIÓN ya existente (changeStatus) — nunca un
// endpoint nuevo, nunca se decide solo: el mediador sigue confirmando
// desde el selector de estado de siempre, esto solo lo deja seleccionado.
function startWhatNextResult(mediationId, status){
  dismissWhatNextPrompt();
  const select = document.getElementById('status-select');
  if(select){ select.value = status; changeStatus(mediationId); }
  document.getElementById('section-admin')?.scrollIntoView({ behavior:'smooth' });
}

async function recordConfirmation(mediationId, hearingId, partyId, response){
  if(!response) return; // el select tiene una opción vacía de placeholder, no hacer nada si la elige de nuevo
  try{
    await api(`/api/mediations/${mediationId}/hearings/${hearingId}/confirmations/${partyId}`, { method:'POST', body: JSON.stringify({ response }) });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo registrar la respuesta.', 'danger'); }
}

function addProposeSlotRow(){
  const container = document.getElementById('propose-slots');
  const row = document.createElement('div');
  row.className = 'propose-slot-row';
  row.style.cssText = 'display:flex; gap:6px; margin-bottom:6px;';
  row.innerHTML = `<input type="date" class="propose-slot-date" style="flex:1;"><input type="time" class="propose-slot-time" style="flex:1;">`;
  container.appendChild(row);
}

function describeNotifications(notifications){
  if(!notifications || !notifications.length) return null;
  return notifications.map(n => {
    const who = n.recipient === 'party' ? (partyName(n.partyId) || 'una parte') : 'un abogado';
    const statusLabel = n.status === 'enviado' ? 'notificado' : n.status === 'no_disponible' ? 'sin canal disponible' : 'error al notificar';
    return `${who}: ${statusLabel}`;
  }).join('\n');
}

async function submitProposal(mediationId){
  const dates = document.querySelectorAll('.propose-slot-date');
  const times = document.querySelectorAll('.propose-slot-time');
  const slots = [];
  for(let i=0; i<dates.length; i++){
    if(dates[i].value) slots.push({ date: dates[i].value, startTime: times[i].value || null, durationMinutes: 60 });
  }
  if(!slots.length){ showToast('Cargá al menos una fecha.', 'danger'); return; }
  const targetSelect = document.getElementById('propose-target');
  const targetPartyId = targetSelect.value || null;
  const targetLabel = targetPartyId ? targetSelect.options[targetSelect.selectedIndex].text : 'todas las partes';
  const modality = document.getElementById('propose-modality').value;
  const provider = document.getElementById('propose-provider').value || null;
  const meetingUrl = document.getElementById('propose-meeting-url').value.trim() || null;
  if(modality !== 'presencial' && !provider && !meetingUrl){
    showToast('Modalidad virtual o híbrida requiere un proveedor de videoconferencia o un enlace manual.', 'danger');
    return;
  }
  if(!confirm(`Se va a proponer ${slots.length} horario(s) a: ${targetLabel}. ¿Confirmás?`)) return;
  try{
    const body = { slots, targetPartyId, modality };
    if(provider) body.provider = provider; else if(meetingUrl) body.meetingUrl = meetingUrl;
    const result = await api(`/api/mediations/${mediationId}/hearings/propose`, { method:'POST', body: JSON.stringify(body) });
    const notifText = describeNotifications(result.notifications);
    if(notifText) alert(`Propuesta enviada.\n\n${notifText}`);
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo proponer.', 'danger'); }
}

function toggleVersionUpload(docId){
  const box = document.getElementById(`version-upload-${docId}`);
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
}

async function uploadNewVersion(mediationId, docId){
  const file = document.getElementById(`version-file-${docId}`).files[0];
  if(!file){ showToast('Elegí un archivo primero.', 'danger'); return; }
  const formData = new FormData();
  formData.append('file', file);
  try{
    const res = await fetch(`/api/mediations/${mediationId}/documents/${docId}/versions`, { method:'POST', credentials:'same-origin', body: formData });
    const data = await res.json();
    if(!res.ok) throw data;
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo subir la nueva versión.', 'danger'); }
}

async function toggleVersionHistory(mediationId, docId){
  const box = document.getElementById(`version-history-${docId}`);
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  try{
    const versions = await api(`/api/mediations/${mediationId}/documents/${docId}/versions`);
    box.innerHTML = versions.slice().reverse().map(v => `
      <div style="background:var(--surface-2); border-radius:8px; padding:6px 10px; margin-bottom:4px; font-size:11.5px; display:flex; justify-content:space-between; align-items:center;">
        <span>v${v.version}${v.isCurrentVersion ? ' (vigente)' : ''} — ${fmtDateTime(v.createdAt)}${v.uploadedByName ? ' · ' + escapeHtml(v.uploadedByName) : ''}</span>
        <a href="/api/mediations/${mediationId}/documents/${v.id}/download" style="color:var(--calm);">Descargar</a>
      </div>
    `).join('');
  }catch(e){ box.innerHTML = `<p class="empty-hint">No se pudieron cargar las versiones.</p>`; }
}

async function changeDocumentStatus(mediationId, docId, status){
  try{
    await api(`/api/mediations/${mediationId}/documents/${docId}`, { method:'PATCH', body: JSON.stringify({ status }) });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo actualizar el documento.', 'danger'); }
}

async function uploadDocument(mediationId){
  const fileInput = document.getElementById('document-file');
  const file = fileInput.files[0];
  if(!file){ showToast('Elegí un archivo primero.', 'danger'); return; }

  const btn = document.getElementById('upload-btn');
  btn.disabled = true;
  btn.textContent = 'Subiendo…';

  // multipart, no JSON — por eso no se usa el helper api() de siempre, que
  // siempre manda Content-Type: application/json.
  const formData = new FormData();
  formData.append('file', file);
  formData.append('type', document.getElementById('document-type').value);

  try{
    const res = await fetch(`/api/mediations/${mediationId}/documents`, {
      method: 'POST', credentials: 'same-origin', body: formData,
    });
    const data = await res.json();
    if(!res.ok) throw data;
    await renderDetail(mediationId);
    // Bloque 22 §6 — sugerencia, nunca automática: el mediador confirma o
    // descarta. Si confirma, la tarea real se crea por el endpoint YA
    // existente (addTask), solo que con sourceDocumentId precargado.
    showDocumentTaskSuggestion(mediationId, data.id, data.originalFilename);
  }catch(e){
    showToast(e.error || 'No se pudo subir el archivo.', 'danger');
    btn.disabled = false;
    btn.textContent = 'Subir';
  }
}

// Bloque 19 — "mensaje → acción": cuando se abre el formulario de tarea/
// compromiso desde un mensaje puntual (ver startConvertToTask/
// startConvertToCommitment), se guarda acá cuál fue el mensaje de
// origen, y addTask/addCommitment lo mandan si está seteado. Se limpia
// después de usarlo una vez — un formulario abierto "en blanco" nunca
// debe arrastrar la referencia de la conversión anterior.
let pendingSourceMessageId = null;
// Bloque 22 §6 — mismo mecanismo que pendingSourceMessageId, pero para
// "documento recibido → ¿crear tarea de revisión?".
let pendingSourceDocumentId = null;

async function addTask(mediationId){
  const title = document.getElementById('task-title').value.trim();
  if(!title){ showToast('Falta el título de la tarea.', 'danger'); return; }
  try{
    const result = await api(`/api/mediations/${mediationId}/tasks`, { method:'POST', body: JSON.stringify({
      title,
      dueDate: document.getElementById('task-due').value || null,
      priority: document.getElementById('task-priority').value,
      sourceMessageId: pendingSourceMessageId,
      sourceDocumentId: pendingSourceDocumentId,
    })});
    pendingSourceMessageId = null;
    pendingSourceDocumentId = null;
    if(result.alreadyExisted) showToast('Ya existía una tarea activa para este documento — no se creó una duplicada.', 'success');
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo guardar la tarea.', 'danger'); }
}

// Bloque 22 §6 — banner de sugerencia tras subir un documento. Usa el
// componente .alert-info ya existente (Bloque 20 design system), nunca
// un popup nuevo. [Ahora no] simplemente lo cierra — no queda ningún
// rastro ni se vuelve a mostrar para ESE documento (no hay reintento
// automático: es una sugerencia de una sola vez, en el momento de subir).
function showDocumentTaskSuggestion(mediationId, docId, filename){
  const section = document.getElementById('section-documentos');
  if(!section) return;
  const banner = document.createElement('div');
  banner.className = 'alert alert-info';
  banner.id = 'doc-task-suggestion';
  banner.innerHTML = `
    <div style="flex:1;">
      <div>Documento recibido. ¿Querés crear una tarea para revisarlo?</div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        <button class="btn-primary btn-sm" onclick="confirmDocumentTaskSuggestion('${mediationId}','${docId}','${escapeHtml(filename).replace(/'/g, "\\'")}')">Crear tarea</button>
        <button class="btn-ghost btn-sm" onclick="document.getElementById('doc-task-suggestion')?.remove()">Ahora no</button>
      </div>
    </div>
  `;
  const h2 = section.querySelector('h2');
  if(h2) h2.insertAdjacentElement('afterend', banner); else section.prepend(banner);
  section.scrollIntoView({ behavior:'smooth', block:'start' });
}

function confirmDocumentTaskSuggestion(mediationId, docId, filename){
  document.getElementById('doc-task-suggestion')?.remove();
  pendingSourceMessageId = null;
  pendingSourceDocumentId = docId;
  const form = document.getElementById('task-form');
  form.style.display = 'block';
  document.getElementById('task-title').value = `Revisar documento: ${filename}`;
  document.getElementById('section-tareas').scrollIntoView({ behavior:'smooth', block:'start' });
}

async function changeTaskStatus(mediationId, taskId, status){
  try{
    await api(`/api/mediations/${mediationId}/tasks/${taskId}`, { method:'PATCH', body: JSON.stringify({ status }) });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo actualizar la tarea.', 'danger'); }
}

async function addCommitment(mediationId){
  const description = document.getElementById('commitment-description').value.trim();
  if(!description){ showToast('Falta la descripción del compromiso.', 'danger'); return; }
  const partySelect = document.getElementById('commitment-party');
  if(!partySelect.value){ showToast('Cargá al menos una parte antes de crear un compromiso.', 'danger'); return; }
  try{
    await api(`/api/mediations/${mediationId}/commitments`, { method:'POST', body: JSON.stringify({
      partyId: partySelect.value, description,
      dueDate: document.getElementById('commitment-due').value || null,
      sourceMessageId: pendingSourceMessageId,
    })});
    pendingSourceMessageId = null;
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo guardar el compromiso.', 'danger'); }
}

async function changeCommitmentStatus(mediationId, commitmentId, status){
  try{
    await api(`/api/mediations/${mediationId}/commitments/${commitmentId}`, { method:'PATCH', body: JSON.stringify({ status }) });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo actualizar el compromiso.', 'danger'); }
}
