// public/admin-mediador.js — Bloque 27. Centro de control de Mediador,
// mismo patrón que admin.js/radar.js: auth vía /auth/me + /api/admin/am-i-admin
// (el backend en routes/admin-mediador.js es quien realmente protege cada
// endpoint — esto es solo UX para no mostrar la pantalla a quien no puede
// usarla igual).
function escapeHtml(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(v){ if(!v) return '—'; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleDateString('es-AR'); }
function fmtDateTime(ms){ if(!ms) return '—'; return new Date(ms).toLocaleString('es-AR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}); }
function timeAgo(ts){
  if(!ts) return 'nunca';
  const mins = Math.floor((Date.now()-ts)/60000);
  if(mins < 1) return 'recién';
  if(mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins/60);
  if(hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours/24)} d`;
}

async function api(path, opts){
  const resp = await fetch(path, { credentials:'same-origin', ...opts, headers: opts && opts.body ? {'Content-Type':'application/json'} : undefined });
  let data = null;
  try{ data = await resp.json(); }catch(e){}
  if(!resp.ok) throw { status: resp.status, ...(data || {}) };
  return data;
}
function qs(params){
  const p = new URLSearchParams();
  for(const [k,v] of Object.entries(params||{})) if(v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?'+s : '';
}

// Solo las secciones con datos reales detrás — nada de pantallas vacías
// para completar el menú (§3/§24 de la spec). "Configuración" queda afuera
// a propósito: hoy no hay ningún parámetro de plataforma editable.
const SECTIONS = [
  { id:'dashboard', label:'Inicio' },
  { id:'users', label:'Usuarios' },
  { id:'studios', label:'Estudios' },
  { id:'mediations', label:'Mediaciones' },
  { id:'hearings', label:'Audiencias' },
  { id:'activity', label:'Actividad' },
  { id:'notifications', label:'Notificaciones' },
  { id:'system', label:'Sistema' },
  { id:'billing', label:'Billing' },
  { id:'radar', label:'Radar' },
];

const ROLE_LABELS = { admin:'Admin de estudio', mediador:'Mediador/a', asistente:'Asistente', independiente:'Independiente', admin_plataforma:'Admin de plataforma' };
const ACTIVITY_TYPE_LABELS = {
  USER_REGISTERED:'Usuario registrado', STUDIO_CREATED:'Estudio creado', NOTIFICATION_FAILED:'Notificación fallida',
  MEDIATION_CREATED:'Mediación creada', MEDIATION_CLOSED:'Mediación cerrada', MEDIATION_STATUS_CHANGED:'Cambio de estado',
  HEARING_SCHEDULED:'Audiencia agendada', HEARING_CONFIRMED:'Audiencia confirmada', HEARING_RESCHEDULED:'Audiencia reprogramada',
  DOCUMENT_UPLOADED:'Documento cargado', TASK_CREATED:'Tarea creada', COMMITMENT_OVERDUE:'Compromiso vencido',
};

let STATE = { me:null, section:'dashboard', filters:{}, page:{} };

(async function boot(){
  const app = document.getElementById('app');
  let me;
  try{ me = await api('/auth/me'); }catch(e){ renderLogin(app); return; }
  let check;
  try{ check = await api('/api/admin/am-i-admin'); }catch(e){ renderNoAccess(app, me); return; }
  if(!check.isAdmin){ renderNoAccess(app, me); return; }
  STATE.me = me;
  renderShell();
})();

function renderLogin(app){
  app.innerHTML = `
    <div class="center-note">
      <span class="brand">Mediador</span>
      Centro de control — iniciá sesión con tu cuenta de Google para continuar.
      <div><button class="google-btn" onclick="location.href='/auth/google?next=/admin-mediador.html'">Iniciar sesión con Google</button></div>
    </div>
  `;
}
function renderNoAccess(app, me){
  app.innerHTML = `
    <div class="center-note">
      <span class="brand">Mediador</span>
      La cuenta <strong>${escapeHtml(me.name)}</strong> (${escapeHtml(me.email || '')}) no tiene acceso al centro de control.
      <div><a href="/mediador.html" style="color:var(--calm);">Volver a la app</a></div>
    </div>
  `;
}

function renderShell(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <div class="brand">Mediador <em>Control</em></div>
          <div class="sub">Centro de control · plataforma</div>
        </div>
        <nav class="sidebar-nav">
          ${SECTIONS.map(s => `<button data-section="${s.id}" class="${s.id===STATE.section?'active':''}" onclick="goSection('${s.id}')">${escapeHtml(s.label)}</button>`).join('')}
        </nav>
        <div class="sidebar-foot">
          <a href="/mediador.html">← Volver a la app</a>
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="topbar-menu-btn" onclick="document.getElementById('sidebar').classList.toggle('open')">☰</button>
          <div class="user-chip">${escapeHtml(STATE.me.name)} <a href="#" onclick="event.preventDefault(); document.getElementById('sidebar').classList.remove('open');">${escapeHtml(STATE.me.email||'')}</a></div>
        </div>
        <div class="wrap" id="section-body"><p class="empty-hint">Cargando…</p></div>
      </div>
    </div>
  `;
  renderSection();
}
function goSection(id){ STATE.section = id; STATE.page = {}; renderShell(); }

async function renderSection(){
  const body = document.getElementById('section-body');
  try{
    if(STATE.section==='dashboard') return await renderDashboard(body);
    if(STATE.section==='users') return await renderUsers(body);
    if(STATE.section==='studios') return await renderStudios(body);
    if(STATE.section==='mediations') return await renderMediations(body);
    if(STATE.section==='hearings') return await renderHearings(body);
    if(STATE.section==='activity') return await renderActivity(body);
    if(STATE.section==='notifications') return await renderNotifications(body);
    if(STATE.section==='system') return await renderSystem(body);
    if(STATE.section==='billing') return await renderBilling(body);
    if(STATE.section==='radar') return await renderRadarSummary(body);
  }catch(e){
    body.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo cargar esta sección.')}</p>`;
  }
}

// ================= INICIO / DASHBOARD (§4/§18) =================
async function renderDashboard(body){
  const d = await api('/api/admin-mediador/dashboard');
  const k = d.kpis;
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${k.usuariosRegistrados}</div><div class="lab">usuarios registrados</div></div>
      <div class="stat-card"><div class="num">${k.usuariosActivos30d}</div><div class="lab">usuarios activos (30 días)</div></div>
      <div class="stat-card"><div class="num">${k.estudiosActivos}</div><div class="lab">estudios activos</div></div>
      <div class="stat-card"><div class="num">${k.mediadoresActivos}</div><div class="lab">mediadores activos</div></div>
      <div class="stat-card"><div class="num">${k.mediacionesActivas}</div><div class="lab">mediaciones activas</div></div>
      <div class="stat-card"><div class="num">${k.mediacionesCerradas}</div><div class="lab">mediaciones cerradas</div></div>
      <div class="stat-card"><div class="num">${k.audienciasProximas7d}</div><div class="lab">audiencias próximas (7 días)</div></div>
      <div class="stat-card"><div class="num">${k.tareasVencidas}</div><div class="lab">tareas vencidas</div></div>
      <div class="stat-card"><div class="num">${k.notificacionesFallidas7d}</div><div class="lab">notificaciones fallidas (7 días)</div></div>
      <div class="stat-card"><div class="num">${k.erroresRecientes24h}</div><div class="lab">errores recientes (24h)</div></div>
    </div>
    <section class="block">
      <h2 class="block-title">Requiere atención</h2>
      ${d.requiereAtencion.length ? `
        <div class="table-wrap"><table class="min-w">
          <tr><th>Nivel</th><th>Detalle</th></tr>
          ${d.requiereAtencion.map(a => `<tr><td><span class="pill ${a.level==='HIGH'?'danger':a.level==='MEDIUM'?'warn':'neutral'}">${a.level}</span></td><td>${escapeHtml(a.detail)}</td></tr>`).join('')}
        </table></div>
      ` : '<div class="empty-hint">Sin datos todavía — nada requiere atención ahora mismo.</div>'}
    </section>
    <section class="block">
      <h2 class="block-title">Billing</h2>
      <div class="empty-hint">${escapeHtml(d.billing.note)}</div>
    </section>
    <section class="block">
      <h2 class="block-title">Radar competitivo</h2>
      <p class="block-note">${d.radar.totalSources} fuente(s) monitoreadas · ${d.radar.pendingChanges} cambio(s) sin revisar · ${d.radar.pendingOpportunities} oportunidad(es) pendiente(s). <a href="/radar.html" style="color:var(--calm);">Ver el radar completo →</a></p>
    </section>
  `;
}

// ================= USUARIOS (§6) =================
async function renderUsers(body){
  const f = STATE.filters.users || {};
  const data = await api('/api/admin-mediador/users' + qs({ ...f, offset: STATE.page.users||0, limit:25 }));
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Usuarios</h2>
      <div class="filter-row">
        <input placeholder="Buscar por nombre o email…" value="${escapeHtml(f.q||'')}" onchange="setUserFilter('q', this.value)">
        <select onchange="setUserFilter('estado', this.value)">
          <option value="">Todos los estados</option>
          <option value="activo" ${f.estado==='activo'?'selected':''}>Activo</option>
          <option value="desactivado" ${f.estado==='desactivado'?'selected':''}>Desactivado</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estudio</th><th>Estado</th><th>Alta</th><th>Último acceso</th><th>Mediaciones</th><th>Acciones</th></tr>
          ${data.items.map(u => `
            <tr>
              <td class="strong">${escapeHtml(u.name)}</td>
              <td>${escapeHtml(u.email||'—')}</td>
              <td>${ROLE_LABELS[u.role]||u.role}</td>
              <td>${escapeHtml(u.studioName||'—')}</td>
              <td><span class="pill ${u.estado==='activo'?'ok':'danger'}">${u.estado}</span></td>
              <td>${fmtDate(u.createdAt)}</td>
              <td>${timeAgo(u.lastLoginAt)}</td>
              <td>${u.mediationsCount}</td>
              <td>
                ${u.role==='admin_plataforma' ? '—' : (u.estado==='activo'
                  ? `<button class="ghost danger" onclick="toggleUser('${u.id}', false)">Desactivar</button>`
                  : `<button class="ghost" onclick="toggleUser('${u.id}', true)">Activar</button>`)}
              </td>
            </tr>
          `).join('') || '<tr><td colspan="9" class="empty-hint">Sin datos todavía.</td></tr>'}
        </table>
      </div>
      ${renderPager('users', data)}
    </section>
  `;
}
function setUserFilter(key, value){
  STATE.filters.users = { ...(STATE.filters.users||{}), [key]: value };
  STATE.page.users = 0;
  renderSection();
}
async function toggleUser(id, activate){
  try{ await api(`/api/admin-mediador/users/${id}/${activate?'enable':'disable'}`, { method:'POST' }); }
  catch(e){ alert(e.error || 'No se pudo actualizar el usuario.'); }
  renderSection();
}
function renderPager(key, data){
  const hasPrev = data.offset > 0;
  const hasNext = data.offset + data.limit < data.total;
  return `
    <div class="pager">
      <span>${data.total} resultado(s)</span>
      <button class="ghost" ${hasPrev?'':'disabled'} onclick="pageChange('${key}', ${Math.max(0,data.offset-data.limit)})">← Anterior</button>
      <button class="ghost" ${hasNext?'':'disabled'} onclick="pageChange('${key}', ${data.offset+data.limit})">Siguiente →</button>
    </div>
  `;
}
function pageChange(key, offset){ STATE.page[key] = offset; renderSection(); }

// ================= ESTUDIOS (§7) =================
async function renderStudios(body){
  if(STATE.openStudioId) return renderStudioDetail(body, STATE.openStudioId);
  const data = await api('/api/admin-mediador/studios' + qs({ offset: STATE.page.studios||0, limit:25 }));
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Estudios</h2>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Nombre</th><th>Propietario</th><th>Miembros</th><th>Mediaciones</th><th>Estado</th><th>Alta</th><th></th></tr>
          ${data.items.map(s => `
            <tr>
              <td class="strong">${escapeHtml(s.name)}</td>
              <td>${escapeHtml(s.ownerName||'—')}</td>
              <td>${s.memberCount}</td>
              <td>${s.mediationsCount}</td>
              <td><span class="pill ${s.status==='activo'?'ok':'danger'}">${s.status==='activo'?'ACTIVO':'DESACTIVADO'}</span></td>
              <td>${fmtDate(s.createdAt)}</td>
              <td><button class="ghost" onclick="openStudio('${s.id}')">Ver ficha</button></td>
            </tr>
          `).join('') || '<tr><td colspan="7" class="empty-hint">Sin datos todavía.</td></tr>'}
        </table>
      </div>
      ${renderPager('studios', data)}
    </section>
  `;
}
function openStudio(id){ STATE.openStudioId = id; renderSection(); }
async function renderStudioDetail(body, id){
  const s = await api(`/api/admin-mediador/studios/${id}`);
  body.innerHTML = `
    <span class="back-link" onclick="STATE.openStudioId=null; renderSection();">← Volver a estudios</span>
    <h1 style="font-family:var(--serif); font-size:20px; margin-bottom:4px;">${escapeHtml(s.name)}</h1>
    <p class="block-note">Propietario: ${escapeHtml(s.ownerName||'—')} · <span class="pill ${s.status==='activo'?'ok':'danger'}">${s.status==='activo'?'ACTIVO':'DESACTIVADO'}</span> · alta ${fmtDate(s.createdAt)}</p>
    <section class="block">
      <h2 class="block-title">Miembros</h2>
      <div class="table-wrap"><table class="min-w">
        <tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th></tr>
        ${s.members.map(m => `<tr><td class="strong">${escapeHtml(m.name)}</td><td>${escapeHtml(m.email||'—')}</td><td>${ROLE_LABELS[m.studioRole]||m.studioRole}</td><td><span class="pill ${m.estado==='activo'?'ok':'danger'}">${m.estado}</span></td></tr>`).join('') || '<tr><td colspan="4" class="empty-hint">Sin miembros.</td></tr>'}
      </table></div>
    </section>
    <section class="block">
      <h2 class="block-title">Mediaciones</h2>
      <div class="table-wrap"><table class="min-w">
        <tr><th>Código</th><th>Estado</th><th>Alta</th></tr>
        ${s.mediations.map(m => `<tr><td class="strong">${escapeHtml(m.code)}</td><td>${escapeHtml(m.status)}</td><td>${fmtDate(m.createdAt)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-hint">Sin mediaciones.</td></tr>'}
      </table></div>
    </section>
    <section class="block">
      <h2 class="block-title">Actividad reciente</h2>
      ${s.recentActivity.length ? s.recentActivity.map(e => `<div class="empty-hint" style="text-align:left;">${ACTIVITY_TYPE_LABELS[e.type]||e.type}${e.title?': '+escapeHtml(e.title):''} · ${fmtDateTime(e.createdAt)}</div>`).join('') : '<div class="empty-hint">Sin datos todavía.</div>'}
    </section>
  `;
}

// ================= MEDIACIONES — vista global (§8) =================
async function renderMediations(body){
  const f = STATE.filters.mediations || {};
  const data = await api('/api/admin-mediador/mediations' + qs({ ...f, offset: STATE.page.mediations||0, limit:25 }));
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Mediaciones — vista global</h2>
      <p class="block-note">Solo datos operativos (código, estado, fechas) — nunca el contenido de conversaciones o documentos.</p>
      <div class="filter-row">
        <input placeholder="Buscar por código, mediador, estudio…" value="${escapeHtml(f.q||'')}" onchange="setMedFilter('q', this.value)">
        <select onchange="setMedFilter('alertas', this.value)">
          <option value="">Todas</option>
          <option value="1" ${f.alertas==='1'?'selected':''}>Solo con próxima acción vencida</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Código</th><th>Mediador</th><th>Estudio</th><th>Estado</th><th>Próxima acción</th><th>Vencimiento</th><th>Próxima audiencia</th><th>Alerta</th><th>Alta</th></tr>
          ${data.items.map(m => `
            <tr>
              <td class="strong">${escapeHtml(m.code)}</td>
              <td>${escapeHtml(m.mediadorNombre||'—')}</td>
              <td>${escapeHtml(m.studioName||'—')}</td>
              <td>${escapeHtml(m.status)}</td>
              <td>${escapeHtml(m.nextActionText||'—')}</td>
              <td>${fmtDate(m.nextActionDueDate)}</td>
              <td>${fmtDate(m.proximaAudiencia)}</td>
              <td>${m.vencida ? '<span class="pill danger">VENCIDA</span>' : ''}</td>
              <td>${fmtDate(m.createdAt)}</td>
            </tr>
          `).join('') || '<tr><td colspan="9" class="empty-hint">Sin datos todavía.</td></tr>'}
        </table>
      </div>
      ${renderPager('mediations', data)}
    </section>
  `;
}
function setMedFilter(key, value){ STATE.filters.mediations = { ...(STATE.filters.mediations||{}), [key]: value }; STATE.page.mediations = 0; renderSection(); }

// ================= AUDIENCIAS — agenda global (§9) =================
async function renderHearings(body){
  const f = STATE.filters.hearings || {};
  const data = await api('/api/admin-mediador/hearings' + qs({ ...f, offset: STATE.page.hearings||0, limit:25 }));
  const rows = data.items;
  const s = data.summary;
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${s.hoy}</div><div class="lab">audiencias hoy</div></div>
      <div class="stat-card"><div class="num">${s.reprogramaciones}</div><div class="lab">reprogramaciones</div></div>
      <div class="stat-card"><div class="num">${s.canceladas}</div><div class="lab">canceladas</div></div>
      <div class="stat-card"><div class="num">${s.confirmacionesPendientes}</div><div class="lab">confirmaciones pendientes</div></div>
      <div class="stat-card"><div class="num">${s.sinResultado}</div><div class="lab">sin resultado</div></div>
      <div class="stat-card"><div class="num">${s.realizadasSinProximaAccion}</div><div class="lab">realizadas sin próxima acción</div></div>
    </div>
    <section class="block">
      <h2 class="block-title">Agenda global</h2>
      <div class="filter-row">
        <select onchange="setHearingFilter('fecha', this.value)">
          <option value="">Todas las fechas</option>
          <option value="hoy" ${f.fecha==='hoy'?'selected':''}>Hoy</option>
          <option value="proximas" ${f.fecha==='proximas'?'selected':''}>Próximas</option>
        </select>
        <select onchange="setHearingFilter('modalidad', this.value)">
          <option value="">Todas las modalidades</option>
          <option value="presencial" ${f.modalidad==='presencial'?'selected':''}>Presencial</option>
          <option value="virtual" ${f.modalidad==='virtual'?'selected':''}>Virtual</option>
          <option value="hibrida" ${f.modalidad==='hibrida'?'selected':''}>Híbrida</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Fecha</th><th>Hora</th><th>Mediación</th><th>Modalidad</th><th>Estado</th><th>Confirmaciones pendientes</th></tr>
          ${rows.items.map(h => `
            <tr>
              <td>${fmtDate(h.date)}</td><td>${escapeHtml(h.startTime||'—')}</td>
              <td class="strong">${escapeHtml(h.mediationCode||'—')}</td><td>${escapeHtml(h.modality)}</td>
              <td>${escapeHtml(h.status)}</td><td>${h.pendingConfirmations}</td>
            </tr>
          `).join('') || '<tr><td colspan="6" class="empty-hint">Sin datos todavía.</td></tr>'}
        </table>
      </div>
      ${renderPager('hearings', rows)}
    </section>
  `;
}
function setHearingFilter(key, value){ STATE.filters.hearings = { ...(STATE.filters.hearings||{}), [key]: value }; STATE.page.hearings = 0; renderSection(); }

// ================= ACTIVIDAD (§5) =================
async function renderActivity(body){
  const f = STATE.filters.activity || {};
  const data = await api('/api/admin-mediador/activity' + qs({ ...f, offset: STATE.page.activity||0, limit:40 }));
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Actividad reciente</h2>
      <div class="filter-row">
        <select onchange="setActivityFilter('type', this.value)">
          <option value="">Todos los tipos</option>
          ${Object.entries(ACTIVITY_TYPE_LABELS).map(([k,v]) => `<option value="${k}" ${f.type===k?'selected':''}>${v}</option>`).join('')}
        </select>
        <select onchange="setActivityFilter('resultado', this.value)">
          <option value="">Todos los resultados</option>
          <option value="ok" ${f.resultado==='ok'?'selected':''}>OK</option>
          <option value="error" ${f.resultado==='error'?'selected':''}>Error</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Fecha</th><th>Tipo</th><th>Actor</th><th>Entidad</th><th>Resultado</th><th>Detalle</th></tr>
          ${data.items.map(e => `
            <tr>
              <td>${fmtDateTime(e.createdAt)}</td>
              <td>${ACTIVITY_TYPE_LABELS[e.type]||e.type}</td>
              <td>${escapeHtml(e.actorName||'—')}</td>
              <td>${escapeHtml(e.entityLabel||'—')}</td>
              <td><span class="pill ${e.resultado==='error'?'danger':'ok'}">${e.resultado}</span></td>
              <td>${escapeHtml(e.detail||'')}</td>
            </tr>
          `).join('') || '<tr><td colspan="6" class="empty-hint">Sin datos todavía.</td></tr>'}
        </table>
      </div>
      ${renderPager('activity', data)}
    </section>
  `;
}
function setActivityFilter(key, value){ STATE.filters.activity = { ...(STATE.filters.activity||{}), [key]: value }; STATE.page.activity = 0; renderSection(); }

// ================= NOTIFICACIONES (§10) =================
async function renderNotifications(body){
  const data = await api('/api/admin-mediador/notifications' + qs({ offset: STATE.page.notifications||0, limit:40 }));
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${data.pushSubscriptionsCount}</div><div class="lab">dispositivos con push activo</div></div>
    </div>
    <section class="block">
      <h2 class="block-title">Notificaciones (WhatsApp)</h2>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Fecha</th><th>Destinatario</th><th>Mediación</th><th>Canal</th><th>Estado</th><th>Detalle</th></tr>
          ${data.items.map(n => `
            <tr>
              <td>${fmtDateTime(n.createdAt)}</td><td>${escapeHtml(n.destinatario||'—')}</td>
              <td>${escapeHtml(n.mediationCode||'—')}</td><td>${escapeHtml(n.canal)}</td>
              <td><span class="pill ${n.estado==='fallida'?'danger':n.estado==='enviada'?'ok':'neutral'}">${n.estado}</span></td>
              <td>${escapeHtml(n.detail||'')}</td>
            </tr>
          `).join('') || '<tr><td colspan="6" class="empty-hint">Sin datos todavía.</td></tr>'}
        </table>
      </div>
      ${renderPager('notifications', data)}
    </section>
  `;
}

// ================= SISTEMA (§11/§12) =================
async function renderSystem(body){
  const [sys, health] = await Promise.all([api('/api/admin-mediador/system'), api('/api/admin-mediador/system/health')]);
  const healthPill = (s) => s==='OK' ? '<span class="pill ok">OK</span>' : s==='ATENCION' ? '<span class="pill warn">ATENCIÓN</span>' : s==='ERROR' ? '<span class="pill danger">ERROR</span>' : '<span class="pill neutral">NO IMPLEMENTADO</span>';
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Health check</h2>
      <div class="stat-grid">
        <div class="card">API ${healthPill(health.api.status)}</div>
        <div class="card">Base de datos ${healthPill(health.db.status)}</div>
        <div class="card">Jobs ${healthPill(health.jobs.status)}${health.jobs.detail?`<div class="block-note" style="margin-top:6px;">${escapeHtml(health.jobs.detail)}</div>`:''}</div>
        <div class="card">WhatsApp ${healthPill(health.whatsapp.status)}${health.whatsapp.detail?`<div class="block-note" style="margin-top:6px;">${escapeHtml(health.whatsapp.detail)}</div>`:''}</div>
        <div class="card">WebSocket ${healthPill(health.websocket.status)}${health.websocket.clientsConnected!=null?`<div class="block-note" style="margin-top:6px;">${health.websocket.clientsConnected} conectado(s)</div>`:''}</div>
        <div class="card">Almacenamiento ${healthPill(health.almacenamiento.status)}<div class="block-note" style="margin-top:6px;">${escapeHtml(health.almacenamiento.detail)}</div></div>
        <div class="card">Google OAuth ${health.integraciones.google?'<span class="pill ok">Configurado</span>':'<span class="pill neutral">Sin configurar</span>'}</div>
        <div class="card">WhatsApp API ${health.integraciones.whatsapp?'<span class="pill ok">Configurado</span>':'<span class="pill neutral">Sin configurar</span>'}</div>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">Jobs — último estado conocido</h2>
      <p class="block-note">En memoria del proceso — se reinicia con cada deploy, no es un historial persistente.</p>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Job</th><th>Última corrida</th><th>Último OK</th><th>Último error</th></tr>
          ${Object.entries(sys.jobs).map(([name, s]) => `
            <tr><td class="strong">${escapeHtml(name)}</td><td>${timeAgo(s.lastRunAt)}</td><td>${timeAgo(s.lastOkAt)}</td><td>${s.lastError ? escapeHtml(s.lastError) : '—'}</td></tr>
          `).join('') || '<tr><td colspan="4" class="empty-hint">Sin datos todavía.</td></tr>'}
        </table>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">Errores recientes</h2>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Fecha</th><th>Origen</th><th>Mensaje</th></tr>
          ${sys.recentErrors.map(e => `<tr><td>${fmtDateTime(e.at)}</td><td>${escapeHtml(e.source)}</td><td>${escapeHtml(e.message)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-hint">Sin errores recientes.</td></tr>'}
        </table>
      </div>
    </section>
  `;
}

// ================= BILLING (§13) =================
async function renderBilling(body){
  const b = await api('/api/admin-mediador/billing');
  body.innerHTML = `<section class="block"><h2 class="block-title">Billing</h2><div class="empty-hint">${escapeHtml(b.message)}</div></section>`;
}

// ================= RADAR — resumen (§14) =================
async function renderRadarSummary(body){
  const r = await api('/api/admin-mediador/radar-summary');
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Radar competitivo</h2>
      <div class="stat-grid">
        <div class="stat-card"><div class="num">${r.totalSources}</div><div class="lab">fuentes totales</div></div>
        <div class="stat-card"><div class="num">${r.activeSources}</div><div class="lab">fuentes activas</div></div>
        <div class="stat-card"><div class="num">${r.pendingChanges}</div><div class="lab">cambios sin revisar</div></div>
        <div class="stat-card"><div class="num">${r.pendingOpportunities}</div><div class="lab">oportunidades pendientes</div></div>
      </div>
      <p class="block-note">El detalle completo (fuentes, matriz competitiva, precios, oportunidades) vive en su propio módulo.</p>
      <a href="/radar.html" class="ghost" style="display:inline-block; text-decoration:none; padding:9px 14px;">Abrir el radar completo →</a>
    </section>
  `;
}
