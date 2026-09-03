// public/admin.js
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(ms){ return new Date(ms).toLocaleString('es-AR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}); }
function timeAgo(ts){
  if(!ts) return 'nunca';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if(mins < 1) return 'recién';
  if(mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if(hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

async function api(path, opts){
  const resp = await fetch(path, {
    credentials:'same-origin',
    ...opts,
    headers: opts && opts.body ? { 'Content-Type':'application/json' } : undefined,
  });
  let data = null;
  try{ data = await resp.json(); }catch(e){}
  if(!resp.ok) throw { status: resp.status, ...(data || {}) };
  return data;
}

// ==================================================================
// NAV — ocho secciones, todas "globales" (nada contextual a un caso
// puntual, a diferencia del nav de dos niveles de la app de usuarios
// finales) — un nav horizontal simple alcanza. En pantallas angostas
// (el admin también se puede abrir desde el celular) se cambia a un
// <select>, para no forzar 8 ítems en una fila.
// ==================================================================
const SECTIONS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'users', label: 'Usuarios y Canales' },
  { id: 'professionals', label: 'Profesionales' },
  { id: 'subscriptions', label: 'Suscripciones' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'costs', label: 'Costos y Salud' },
  { id: 'support', label: 'Soporte' },
  { id: 'activity', label: 'Actividad' },
];

let STATE = {};
let currentSection = restoreSection();

function persistSection(id){ try{ sessionStorage.setItem('pd_admin_section', id); }catch(e){} }
function restoreSection(){
  try{ return sessionStorage.getItem('pd_admin_section') || 'dashboard'; }
  catch(e){ return 'dashboard'; }
}

(async function boot(){
  const app = document.getElementById('app');
  let me;
  try{ me = await api('/auth/me'); }
  catch(e){ renderLogin(app); return; }

  let check;
  try{ check = await api('/api/admin/am-i-admin'); }
  catch(e){ renderNoAccess(app, me); return; }
  if(!check.isAdmin){ renderNoAccess(app, me); return; }

  try{
    const [overview, users, channels, trend, professionals, applications, audit, waStatus, waLog, waUsers, costs, subscriptions] = await Promise.all([
      api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/channels'), api('/api/admin/trend'),
      api('/api/admin/professionals'), api('/api/admin/professional-applications'), api('/api/admin/audit'),
      api('/api/admin/whatsapp/status'), api('/api/admin/whatsapp/log'), api('/api/admin/whatsapp/users'),
      api('/api/admin/costs'), api('/api/admin/subscriptions'),
    ]);
    STATE = { me, overview, users, channels, trend, professionals, applications, audit, waStatus, waLog, waUsers, costs, subscriptions };
    renderShell();
  }catch(e){
    app.innerHTML = `<div class="center-note"><span class="brand">Puente<em>digital</em></span>No se pudo cargar el panel. Probá recargar la página.</div>`;
  }
})();

// gráfico de barras apiladas hecho a mano (sin librerías): altura total = mensajes
// de la semana, el segmento naranja de abajo = cuántos de esos marcó la IA.
function buildTrendChart(data){
  const w = 720, h = 240, padL = 8, padR = 8, padT = 16, padB = 30;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const maxVal = Math.max(1, ...data.map(d => d.messages));
  const gap = 14;
  const barW = Math.max(6, (chartW / data.length) - gap);

  const bars = data.map((d, i) => {
    const x = padL + i * (chartW / data.length) + (chartW / data.length - barW) / 2;
    const totalH = (d.messages / maxVal) * chartH;
    const flaggedH = (d.flagged / maxVal) * chartH;
    const yTotal = padT + chartH - totalH;
    const yFlagged = padT + chartH - flaggedH;
    return `
      <rect x="${x.toFixed(1)}" y="${yTotal.toFixed(1)}" width="${barW.toFixed(1)}" height="${totalH.toFixed(1)}" rx="3" style="fill:var(--calm-dim)"></rect>
      ${d.flagged > 0 ? `<rect x="${x.toFixed(1)}" y="${yFlagged.toFixed(1)}" width="${barW.toFixed(1)}" height="${flaggedH.toFixed(1)}" rx="3" style="fill:var(--warn)"></rect>` : ''}
      ${d.messages > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(yTotal - 5).toFixed(1)}" text-anchor="middle" style="font:9px var(--mono); fill:var(--text-dim)">${d.messages}</text>` : ''}
      <text x="${(x + barW / 2).toFixed(1)}" y="${h - 10}" text-anchor="middle" style="font:9px var(--mono); fill:var(--text-faint)">${escapeHtml(d.week)}</text>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%; height:auto; display:block;">
      <line x1="${padL}" y1="${padT + chartH}" x2="${padL + chartW}" y2="${padT + chartH}" style="stroke:var(--line); stroke-width:1"></line>
      ${bars}
    </svg>
  `;
}

function renderLogin(app){
  app.innerHTML = `
    <div class="center-note">
      <span class="brand">Puente<em>digital</em></span>
      Panel de administración — iniciá sesión con tu cuenta de Google para continuar.
      <div><button class="google-btn" onclick="location.href='/auth/google?next=/admin.html'">Iniciar sesión con Google</button></div>
    </div>
  `;
}
function renderNoAccess(app, me){
  app.innerHTML = `
    <div class="center-note">
      <span class="brand">Puente<em>digital</em></span>
      La cuenta <strong>${escapeHtml(me.name)}</strong> (${escapeHtml(me.email || '')}) no tiene acceso al panel de administración.
      <div><a href="/" style="color:var(--calm);">Volver a la app</a></div>
    </div>
  `;
}

const AUDIT_ACTION_LABELS = {
  export_txt: 'Descargó informe (.txt)',
  export_certified: 'Descargó informe certificado (PDF)',
  assign_professional: 'Asignó un/a profesional',
  unassign_professional: 'Quitó un/a profesional',
  approve_professional_application: 'Aprobó una solicitud de profesional',
  reject_professional_application: 'Rechazó una solicitud de profesional',
  adjust_usage: 'Ajustó el uso mensual de IA de un usuario',
  view_invite_link: 'Vio/copió el link de invitación de un canal',
};

// ==================================================================
// SHELL — header + nav + contenedor de la sección activa
// ==================================================================
function renderShell(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="wrap">
      <header>
        <div>
          <div class="brand">Puente<em>digital</em></div>
          <div class="brand-sub">Panel de administración</div>
        </div>
        <div class="user-chip">
          <button class="icon-btn theme-btn" onclick="toggleTheme()" title="${currentTheme() === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}" aria-label="Cambiar tema">${currentTheme() === 'light' ? '🌙' : '☀️'}</button>
          ${STATE.me.avatar ? `<img src="${STATE.me.avatar}" alt="">` : ''}
          <span>${escapeHtml(STATE.me.name)}</span>
          <a href="/api/admin/backup" title="Descarga un snapshot completo de la base de datos (.sqlite)">Descargar backup</a>
          <a href="/">Ir a la app</a>
          <button onclick="logout()">Salir</button>
        </div>
      </header>

      <nav class="admin-nav" id="admin-nav">
        ${SECTIONS.map(s => `<button data-section="${s.id}" class="${s.id === currentSection ? 'active' : ''}" onclick="showSection('${s.id}')">${s.label}</button>`).join('')}
      </nav>
      <select class="admin-nav-select" id="admin-nav-select" onchange="showSection(this.value)">
        ${SECTIONS.map(s => `<option value="${s.id}" ${s.id === currentSection ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>

      <div id="admin-section-content"></div>
    </div>
  `;
  renderSection(currentSection);
}

function showSection(id){
  currentSection = id;
  persistSection(id);
  document.querySelectorAll('.admin-nav button').forEach(b => b.classList.toggle('active', b.dataset.section === id));
  const sel = document.getElementById('admin-nav-select');
  if(sel) sel.value = id;
  renderSection(id);
}

function renderSection(id){
  const el = document.getElementById('admin-section-content');
  if(id === 'dashboard') el.innerHTML = renderDashboardSection();
  else if(id === 'users') el.innerHTML = renderUsersSection();
  else if(id === 'professionals') el.innerHTML = renderProfessionalsSection();
  else if(id === 'subscriptions') el.innerHTML = renderSubscriptionsSection();
  else if(id === 'whatsapp') el.innerHTML = renderWhatsappSection();
  else if(id === 'costs') el.innerHTML = renderCostsSection();
  else if(id === 'support') el.innerHTML = renderSupportSection();
  else if(id === 'activity') el.innerHTML = renderActivitySection();
  window.scrollTo(0, 0);
}

// ==================================================================
// DASHBOARD — las 7 tarjetas + tendencia de 8 semanas, tal cual estaban
// ==================================================================
function renderDashboardSection(){
  const ov = STATE.overview, trend = STATE.trend;
  return `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="num">${ov.totalUsers}</div>
        <div class="lab">Usuarios registrados</div>
        <div class="sub">${ov.guestUsers} sin cuenta Google (invitados)</div>
      </div>
      <div class="stat-card">
        <div class="num">${ov.totalChannels}</div>
        <div class="lab">Canales creados</div>
        <div class="sub">${ov.activeChannels} con las dos partes activas</div>
      </div>
      <div class="stat-card">
        <div class="num">${ov.totalMessages}</div>
        <div class="lab">Mensajes totales</div>
        <div class="sub">${ov.messagesLast7d} en los últimos 7 días</div>
      </div>
      <div class="stat-card">
        <div class="num">${ov.moderation.flaggedCount}</div>
        <div class="lab">Intervenciones de la IA</div>
        <div class="sub">${ov.moderation.usedReformulation} usaron la alternativa · ${ov.moderation.overrode} enviaron igual</div>
      </div>
      <div class="stat-card">
        <div class="num">${ov.moderation.patternAlerts}</div>
        <div class="lab">Alertas de patrón</div>
        <div class="sub">3+ mensajes marcados de la misma persona en un canal</div>
      </div>
      <div class="stat-card">
        <div class="num">${ov.events.confirmado}</div>
        <div class="lab">Acuerdos confirmados</div>
        <div class="sub">${ov.events.pendiente} pendientes · ${ov.events.rechazado} rechazados</div>
      </div>
      <div class="stat-card">
        <div class="num">${ov.professionals.totalProfessionals}</div>
        <div class="lab">Mediadores/estudios activos</div>
        <div class="sub">${ov.professionals.mediadores} mediador/a · ${ov.professionals.estudios} estudio jurídico · en ${ov.professionals.channelsWithProfessional} canales</div>
      </div>
    </div>

    <section class="block">
      <h2 class="block-title">Tendencia — últimas 8 semanas</h2>
      <div class="chart-card">
        <div class="chart-legend">
          <span><span class="sw" style="background:var(--calm-dim)"></span>Mensajes enviados</span>
          <span><span class="sw" style="background:var(--warn)"></span>Marcados por la IA</span>
        </div>
        ${buildTrendChart(trend)}
        <p class="chart-note">${trend.reduce((a,d)=>a+d.eventsConfirmed,0)} acuerdos confirmados en el período · cada barra es una semana (lunes a domingo, UTC).</p>
      </div>
    </section>
  `;
}

// ==================================================================
// USUARIOS Y CANALES — las dos tablas, tal cual estaban
// ==================================================================
function renderUsersSection(){
  const users = STATE.users, channels = STATE.channels;
  return `
    <section class="block">
      <h2 class="block-title">Usuarios (${users.length})</h2>
      <div class="table-wrap">
        <table class="min-w">
          <thead><tr><th>Nombre</th><th>Email</th><th>Tipo</th><th>Canales</th><th>Alta</th></tr></thead>
          <tbody>
            ${users.length ? users.map(u => `<tr>
              <td class="strong">${escapeHtml(u.name)}</td>
              <td>${u.email ? escapeHtml(u.email) : '—'}</td>
              <td><span class="pill ${u.guest ? 'guest' : 'google'}">${u.guest ? 'invitado' : 'google'}</span></td>
              <td>${u.channelCount}</td>
              <td>${fmtDate(u.createdAt)}</td>
            </tr>`).join('') : `<tr><td colspan="5"><div class="empty-hint">Todavía no hay usuarios registrados.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section class="block">
      <h2 class="block-title">Canales (${channels.length})</h2>
      <div class="table-wrap">
        <table class="min-w">
          <thead><tr><th>Código</th><th>Integrantes</th><th>Mensajes</th><th>Marcados IA</th><th>Acuerdos (✓/⋯/✕)</th><th>Última actividad</th></tr></thead>
          <tbody>
            ${channels.length ? channels.map(c => `<tr>
              <td class="strong">${escapeHtml(c.code)}</td>
              <td>${c.members.map(m => escapeHtml(m.name)).join(' · ') || '—'}</td>
              <td>${c.messageCount}</td>
              <td>${c.flaggedCount}</td>
              <td>${c.events.confirmado} / ${c.events.pendiente} / ${c.events.rechazado}</td>
              <td>${fmtDate(c.lastActivity)}</td>
            </tr>`).join('') : `<tr><td colspan="6"><div class="empty-hint">Todavía no hay canales creados.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ==================================================================
// PROFESIONALES — solicitudes + mediadores/estudios + asignar, tal cual
// ==================================================================
function renderProfessionalsSection(){
  const applications = STATE.applications, professionals = STATE.professionals;
  const pendingCount = applications.filter(a => a.status === 'pending').length;
  return `
    <section class="block">
      <h2 class="block-title">Solicitudes de profesionales ${pendingCount ? `(${pendingCount} pendiente${pendingCount === 1 ? '' : 's'})` : ''}</h2>
      <p class="chart-note" style="margin-bottom:12px;">
        Autoregistro desde el formulario público — a diferencia de la invitación desde un canal, acá el profesional todavía no tiene ningún caso. Aprobar lo marca como profesional verificado.
      </p>
      <div class="table-wrap">
        <table class="min-w">
          <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estudio/organización</th><th>Solicitado</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            ${applications.length ? applications.map(a => `<tr>
              <td class="strong">${escapeHtml(a.userName)}</td>
              <td>${a.userEmail ? escapeHtml(a.userEmail) : '—'}</td>
              <td>${escapeHtml(a.roleLabel)}</td>
              <td>${escapeHtml(a.orgName)}</td>
              <td>${fmtDate(a.createdAt)}</td>
              <td><span class="pill ${a.status === 'approved' ? 'google' : a.status === 'rejected' ? 'danger' : 'guest'}">${a.status === 'pending' ? 'pendiente' : a.status === 'approved' ? 'aprobada' : 'rechazada'}</span></td>
              <td>${a.status === 'pending' ? `
                <button class="ghost" style="padding:4px 10px; font-size:11.5px;" onclick="decideApplication('${a.id}','approve','${escapeHtml(a.userName)}')">Aprobar</button>
                <button class="danger-link" style="margin-left:8px;" onclick="decideApplication('${a.id}','reject','${escapeHtml(a.userName)}')">Rechazar</button>
              ` : '—'}</td>
            </tr>`).join('') : `<tr><td colspan="7"><div class="empty-hint">Todavía no hay solicitudes.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section class="block">
      <h2 class="block-title">Mediadores/as y estudios jurídicos (${professionals.length})</h2>
      <p class="chart-note" style="margin-bottom:12px;">
        Las partes ya pueden invitar a su propio profesional desde el chat del canal. Acá podés ver a todos los que
        ya participan, y asignar uno directamente a un canal si hace falta (tiene que haber iniciado sesión con Google al menos una vez).
      </p>
      <div class="table-wrap">
        <table class="min-w">
          <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Canales asignados</th></tr></thead>
          <tbody>
            ${professionals.length ? professionals.map(p => `<tr>
              <td class="strong">${escapeHtml(p.name)}</td>
              <td>${p.email ? escapeHtml(p.email) : '—'}</td>
              <td>${[...new Set(p.channels.map(c=>c.roleLabel))].map(escapeHtml).join(', ')}</td>
              <td>${p.channels.map(c => `
                <span class="pill google" title="${escapeHtml(c.label||'')}" style="display:inline-flex; align-items:center; gap:5px; margin:2px 4px 2px 0;">
                  ${escapeHtml(c.code)}
                  <button onclick="unassignProfessional('${c.code}','${p.id}','${escapeHtml(p.name)}','${escapeHtml(c.code)}')" title="Quitar de este canal" style="background:none; border:none; color:inherit; cursor:pointer; font-size:11px; line-height:1; padding:0;">✕</button>
                </span>`).join('')}</td>
            </tr>`).join('') : `<tr><td colspan="4"><div class="empty-hint">Todavía no hay mediadores ni estudios jurídicos vinculados a ningún canal.</div></td></tr>`}
          </tbody>
        </table>
      </div>

      <div class="card" style="margin-top:16px; max-width:480px;">
        <div class="eyebrow">Asignar mediador/a o estudio a un canal</div>
        <label class="field-label">Código de canal</label>
        <input type="text" id="assign-code" placeholder="Ej: AB12CD" style="margin-bottom:10px; text-transform:uppercase;">
        <label class="field-label">Email del usuario (ya tiene que haberse logueado alguna vez)</label>
        <input type="email" id="assign-email" placeholder="mediador@ejemplo.com" style="margin-bottom:10px;">
        <label class="field-label">Rol</label>
        <select id="assign-role" style="margin-bottom:10px;">
          <option value="mediador">Mediador/a</option>
          <option value="estudio">Estudio jurídico</option>
        </select>
        <label class="field-label">Nombre o estudio a mostrar</label>
        <input type="text" id="assign-label" placeholder="Ej: Estudio Pérez &amp; Asoc." style="margin-bottom:12px;">
        <button class="ghost" style="width:100%" onclick="assignProfessional()">Asignar al canal</button>
        <div id="assign-result" style="margin-top:10px; font-size:12.5px;"></div>
      </div>
    </section>
  `;
}

// ==================================================================
// SUSCRIPCIONES (nueva) — honesta: sin sistema de cobro conectado
// todavía. Lo único real para mostrar es quién agotó el free tier.
// ==================================================================
function renderSubscriptionsSection(){
  const s = STATE.subscriptions;
  return `
    <section class="block">
      <h2 class="block-title">Suscripciones</h2>
      <div class="card" style="border-color:var(--warn); margin-bottom:20px;">
        <div class="eyebrow" style="color:var(--warn);">Sin sistema de cobro conectado</div>
        <p style="font-size:13px; color:var(--text-dim); line-height:1.55;">Todavía no hay ningún proveedor de pagos integrado (ni Mercado Pago ni otro) — esta sección se completa el día que eso exista. Por ahora se muestra el uso del free tier: quién ya lo agotó es la señal más cercana a "candidato a un plan pago" que hay disponible hoy.</p>
      </div>
      <div class="stat-grid" style="margin-bottom:20px;">
        <div class="stat-card"><div class="num">${s.freeTierLimit}</div><div class="lab">Límite gratuito mensual (análisis de IA)</div></div>
        <div class="stat-card"><div class="num">${s.usersWithUsageThisMonth}</div><div class="lab">Usuarios con uso este mes</div></div>
        <div class="stat-card"><div class="num">${s.usersAtLimit.length}</div><div class="lab">Llegaron al límite</div></div>
      </div>
      <div class="table-wrap">
        <table class="min-w">
          <thead><tr><th>Nombre</th><th>Email</th><th>Uso este mes</th></tr></thead>
          <tbody>
            ${s.usersAtLimit.length ? s.usersAtLimit.map(u => `<tr>
              <td class="strong">${escapeHtml(u.name)}</td>
              <td>${u.email ? escapeHtml(u.email) : '—'}</td>
              <td>${u.count}/${s.freeTierLimit}</td>
            </tr>`).join('') : `<tr><td colspan="3"><div class="empty-hint">Nadie llegó al límite este mes.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ==================================================================
// WHATSAPP — estado + usuarios vinculados + actividad + debug, tal cual
// ==================================================================
function renderWhatsappSection(){
  const waStatus = STATE.waStatus, waUsers = STATE.waUsers, waLog = STATE.waLog;
  return `
    <section class="block">
      <h2 class="block-title">WhatsApp</h2>
      <div class="stat-grid" style="margin-bottom:16px;">
        <div class="stat-card">
          <div class="num" style="font-size:18px; color:${waStatus.configured ? 'var(--calm)' : 'var(--danger)'}">${waStatus.configured ? '✓ Configurado' : '✗ Sin configurar'}</div>
          <div class="lab">Envío de mensajes (token/número)</div>
        </div>
        <div class="stat-card">
          <div class="num" style="font-size:18px; color:${waStatus.webhookConfigured ? 'var(--calm)' : 'var(--danger)'}">${waStatus.webhookConfigured ? '✓ Configurado' : '✗ Sin configurar'}</div>
          <div class="lab">Webhook (verify token/app secret)</div>
        </div>
        <div class="stat-card">
          <div class="num">${waStatus.usersWithPhone}</div>
          <div class="lab">Usuarios vinculados por teléfono</div>
        </div>
        <div class="stat-card">
          <div class="num">${waStatus.pendingNotifications + waStatus.pendingConfirmations}</div>
          <div class="lab">En cola ahora mismo</div>
          <div class="sub">${waStatus.pendingNotifications} notificación/es agrupándose · ${waStatus.pendingConfirmations} confirmación/es esperando respuesta</div>
        </div>
      </div>

      <h3 style="font-size:13px; margin-bottom:8px; color:var(--text-dim);">Usuarios vinculados por teléfono (${waUsers.length})</h3>
      <div class="table-wrap" style="margin-bottom:16px;">
        <table class="min-w">
          <thead><tr><th>Nombre</th><th>Teléfono</th><th>Canales</th><th>Vinculado</th></tr></thead>
          <tbody>
            ${waUsers.length ? waUsers.map(u => `<tr>
              <td class="strong">${escapeHtml(u.name)}</td>
              <td>${escapeHtml(u.phone)}</td>
              <td>${u.channels.map(escapeHtml).join(', ') || '—'}</td>
              <td>${fmtDate(u.createdAt)}</td>
            </tr>`).join('') : `<tr><td colspan="4"><div class="empty-hint">Nadie se vinculó por WhatsApp todavía.</div></td></tr>`}
          </tbody>
        </table>
      </div>

      <h3 style="font-size:13px; margin-bottom:8px; color:var(--text-dim);">Actividad reciente de WhatsApp (${waLog.length})</h3>
      <div class="table-wrap" style="margin-bottom:16px;">
        <table class="min-w">
          <thead><tr><th>Cuándo</th><th>Evento</th><th>Teléfono</th><th>Nombre</th><th>Canal</th><th>Detalle</th></tr></thead>
          <tbody>
            ${waLog.length ? waLog.map(e => `<tr>
              <td>${fmtDate(e.createdAt)}</td>
              <td>${escapeHtml(e.kindLabel)}</td>
              <td>${e.phone ? escapeHtml(e.phone) : '—'}</td>
              <td>${e.userName ? escapeHtml(e.userName) : '—'}</td>
              <td>${e.channelCode ? escapeHtml(e.channelCode) : '—'}</td>
              <td>${e.detail ? escapeHtml(e.detail) : '—'}</td>
            </tr>`).join('') : `<tr><td colspan="6"><div class="empty-hint">Todavía no hay actividad de WhatsApp.</div></td></tr>`}
          </tbody>
        </table>
      </div>

      <details>
        <summary style="cursor:pointer; font-size:12.5px; color:var(--text-dim); margin-bottom:10px;">Debug: payloads crudos del webhook</summary>
        <div id="wa-webhook-log" style="margin-top:10px;"><button class="ghost" onclick="loadWebhookRawLog()">Cargar</button></div>
      </details>
    </section>
  `;
}

// ==================================================================
// COSTOS Y SALUD (nueva) — todo sale de contadores/logs que ya existen
// ==================================================================
function renderCostsSection(){
  const c = STATE.costs;
  return `
    <section class="block">
      <h2 class="block-title">Costos y Salud</h2>

      <h3 style="font-size:13px; margin-bottom:10px; color:var(--text-dim);">Moderación por IA (Anthropic)</h3>
      <div class="stat-grid" style="margin-bottom:8px;">
        <div class="stat-card">
          <div class="num" style="font-size:18px; color:${c.anthropic.configured ? 'var(--calm)' : 'var(--danger)'}">${c.anthropic.configured ? '✓ Configurado' : '✗ Sin configurar'}</div>
          <div class="lab">ANTHROPIC_API_KEY</div>
        </div>
        <div class="stat-card">
          <div class="num">${c.anthropic.today.calls}</div>
          <div class="lab">Llamadas hoy</div>
          <div class="sub">≈ $${c.anthropic.today.estimatedCost.toFixed(2)} estimado</div>
        </div>
        <div class="stat-card">
          <div class="num">${c.anthropic.last7d.calls}</div>
          <div class="lab">Últimos 7 días</div>
          <div class="sub">≈ $${c.anthropic.last7d.estimatedCost.toFixed(2)} estimado</div>
        </div>
        <div class="stat-card">
          <div class="num">${c.anthropic.last30d.calls}</div>
          <div class="lab">Últimos 30 días</div>
          <div class="sub">≈ $${c.anthropic.last30d.estimatedCost.toFixed(2)} estimado</div>
        </div>
        <div class="stat-card">
          <div class="num" style="color:${c.anthropic.errorRate.failPct > 5 ? 'var(--danger)' : 'var(--text)'}">${c.anthropic.errorRate.failPct}%</div>
          <div class="lab">Tasa de error (30 días)</div>
          <div class="sub">${c.anthropic.errorRate.failCount} fallidas / ${c.anthropic.errorRate.successCount} exitosas</div>
        </div>
      </div>
      <p class="chart-note" style="margin-bottom:24px;">Estimación a partir de las llamadas registradas, a $${c.anthropic.costPerCall} por llamada — no es la factura real de Anthropic, y no cuenta llamadas hechas sin ANTHROPIC_API_KEY configurada (esas nunca le pegaron a la API real).</p>

      <h3 style="font-size:13px; margin-bottom:10px; color:var(--text-dim);">WhatsApp</h3>
      <div class="stat-grid" style="margin-bottom:8px;">
        <div class="stat-card">
          <div class="num" style="font-size:18px; color:${c.whatsapp.configured ? 'var(--calm)' : 'var(--danger)'}">${c.whatsapp.configured ? '✓ Configurado' : '✗ Sin configurar'}</div>
          <div class="lab">Envío de mensajes</div>
        </div>
        <div class="stat-card"><div class="num">${c.whatsapp.today}</div><div class="lab">Notificaciones hoy</div></div>
        <div class="stat-card"><div class="num">${c.whatsapp.last7d}</div><div class="lab">Últimos 7 días</div></div>
        <div class="stat-card"><div class="num">${c.whatsapp.last30d}</div><div class="lab">Últimos 30 días</div></div>
      </div>
      <p class="chart-note" style="margin-bottom:24px;">Conteo real de notificaciones enviadas. Sin monto en $: todavía no hay un precio por mensaje confirmado (Meta cambia el pricing de WhatsApp en octubre) — mejor no estimar un costo que podría estar mal.</p>

      <h3 style="font-size:13px; margin-bottom:10px; color:var(--text-dim);">Salud de webhooks</h3>
      <div class="stat-grid" style="margin-bottom:24px;">
        <div class="stat-card">
          <div class="num" style="font-size:16px;">${timeAgo(c.webhookHealth.whatsappLastActivityAt)}</div>
          <div class="lab">Última actividad de WhatsApp</div>
        </div>
        <div class="stat-card">
          <div class="num" style="font-size:16px; color:var(--text-faint);">No configurado</div>
          <div class="lab">Webhook de Mercado Pago</div>
          <div class="sub">Sin integración de pagos todavía</div>
        </div>
      </div>

      <h3 style="font-size:13px; margin-bottom:10px; color:var(--text-dim);">Volumen anormal por canal (últimos 7 días)</h3>
      <p class="chart-note" style="margin-bottom:10px;">Canales con más del triple del promedio de llamadas a /analyze del resto — protección extra contra abuso, además del rate limiting por request.</p>
      <div class="table-wrap">
        <table class="min-w">
          <thead><tr><th>Canal</th><th>Llamadas (7 días)</th><th>Promedio del resto</th></tr></thead>
          <tbody>
            ${c.abnormalChannels.length ? c.abnormalChannels.map(a => `<tr>
              <td class="strong">${escapeHtml(a.code)}</td>
              <td>${a.count}</td>
              <td>${a.avgOtherChannels}</td>
            </tr>`).join('') : `<tr><td colspan="3"><div class="empty-hint">Sin canales con volumen fuera de lo normal.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ==================================================================
// SOPORTE (nueva) — buscar por email/teléfono, vista consolidada,
// acciones sensibles (quedan en el log de Actividad).
// ==================================================================
function renderSupportSection(){
  return `
    <section class="block">
      <h2 class="block-title">Soporte</h2>
      <div class="card" style="max-width:480px; margin-bottom:20px;">
        <label class="field-label">Buscar por email o teléfono</label>
        <div style="display:flex; gap:8px;">
          <input type="text" id="support-search-input" placeholder="usuario@ejemplo.com o +54911...">
          <button class="ghost" onclick="runSupportSearch()">Buscar</button>
        </div>
      </div>
      <div id="support-results"></div>
    </section>
  `;
}

async function runSupportSearch(){
  const input = document.getElementById('support-search-input');
  const q = input.value.trim();
  const el = document.getElementById('support-results');
  if(!q){ el.innerHTML = ''; return; }
  el.innerHTML = `<p class="empty-hint">Buscando…</p>`;
  try{
    const results = await api(`/api/admin/support/search?q=${encodeURIComponent(q)}`);
    el.innerHTML = results.length
      ? results.map(renderSupportUserCard).join('')
      : `<p class="empty-hint">Sin resultados para "${escapeHtml(q)}".</p>`;
  }catch(e){
    el.innerHTML = `<p class="empty-hint">No se pudo buscar.</p>`;
  }
}
// Enter en el buscador dispara la búsqueda, sin tener que tocar el botón
document.addEventListener('keydown', (e) => {
  if(e.key === 'Enter' && document.activeElement && document.activeElement.id === 'support-search-input') runSupportSearch();
});

function renderSupportUserCard(u){
  return `
    <div class="card" style="margin-bottom:14px;">
      <div class="eyebrow">
        ${escapeHtml(u.name)}
        ${u.guest ? '<span class="pill guest">invitado</span>' : '<span class="pill google">google</span>'}
        ${u.verifiedProfessional ? '<span class="pill google">profesional verificado</span>' : ''}
      </div>
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:10px;">${u.email ? escapeHtml(u.email) : 'sin email'}${u.phone ? ' · ' + escapeHtml(u.phone) : ''}</p>
      <p style="font-size:12.5px; margin-bottom:12px;">Uso de IA este mes: <strong>${u.usageThisMonth}/${u.freeTierLimit}</strong> · Suscripción: <span style="color:var(--text-faint)">sin sistema de pagos conectado</span></p>

      <div class="field-label">Casos</div>
      ${u.channels.length ? u.channels.map(c => `
        <div class="member-row">
          <span>${escapeHtml(c.code)} — ${escapeHtml(c.roleLabel)}${c.otherNames.length ? ' · con ' + c.otherNames.map(escapeHtml).join(', ') : ''}</span>
          <button class="ghost" style="padding:4px 8px; font-size:11px;" onclick="showInviteLink('${c.code}', this)">Ver link</button>
        </div>
        <div id="invite-link-result-${c.code}"></div>
      `).join('') : `<p class="empty-hint" style="padding:8px 0;">Sin casos.</p>`}

      <div style="display:flex; gap:8px; align-items:flex-end; margin-top:14px;">
        <div style="flex:1;">
          <label class="field-label">Ajustar uso del mes</label>
          <input type="number" min="0" id="adjust-usage-${u.id}" value="${u.usageThisMonth}">
        </div>
        <button class="ghost" onclick="adjustUsage('${u.id}')">Guardar</button>
      </div>
      <div id="support-action-result-${u.id}" style="margin-top:8px; font-size:12px;"></div>
    </div>
  `;
}

async function showInviteLink(code, btn){
  btn.disabled = true;
  const resultEl = document.getElementById(`invite-link-result-${code}`);
  resultEl.innerHTML = `<p class="empty-hint" style="padding:6px 0;">Cargando…</p>`;
  try{
    const res = await api(`/api/admin/support/channels/${code}/invite-link`);
    resultEl.innerHTML = `
      <div class="row-copy" style="margin:4px 0;">
        <input type="text" readonly value="${escapeHtml(res.url)}" onclick="this.select()">
      </div>
      ${res.guestUrl ? `
        <div class="row-copy" style="margin:4px 0;">
          <input type="text" readonly value="${escapeHtml(res.guestUrl)}" onclick="this.select()">
          <span style="font-size:10px; color:var(--text-faint); align-self:center; white-space:nowrap;">invitado</span>
        </div>
      ` : ''}
    `;
  }catch(e){
    resultEl.innerHTML = `<p class="empty-hint" style="color:var(--danger); padding:6px 0;">${escapeHtml(e.error || 'No se pudo obtener el link.')}</p>`;
  }
  btn.disabled = false;
}

async function adjustUsage(userId){
  const input = document.getElementById(`adjust-usage-${userId}`);
  const resultEl = document.getElementById(`support-action-result-${userId}`);
  const count = Number(input.value);
  if(!Number.isFinite(count) || count < 0){
    resultEl.innerHTML = `<span style="color:var(--danger)">Cantidad inválida.</span>`;
    return;
  }
  resultEl.textContent = 'Guardando...';
  try{
    await api(`/api/admin/support/users/${userId}/adjust-usage`, { method:'POST', body: JSON.stringify({ count }) });
    resultEl.innerHTML = `<span style="color:var(--calm)">Guardado — queda en el log de Actividad.</span>`;
  }catch(e){
    resultEl.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.error || 'No se pudo guardar.')}</span>`;
  }
}

// ==================================================================
// ACTIVIDAD — el log de auditoría, ahora como sección propia
// ==================================================================
function renderActivitySection(){
  const audit = STATE.audit;
  return `
    <section class="block">
      <h2 class="block-title">Actividad reciente</h2>
      <p class="chart-note" style="margin-bottom:12px;">Acciones sensibles: exportar informes, asignar o quitar profesionales, ajustes de soporte. No es un log de cada clic.</p>
      <div class="table-wrap">
        <table class="min-w">
          <thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Canal</th></tr></thead>
          <tbody>
            ${audit.length ? audit.map(a => `<tr>
              <td>${fmtDate(a.createdAt)}</td>
              <td class="strong">${escapeHtml(a.actorName)}</td>
              <td>${escapeHtml(AUDIT_ACTION_LABELS[a.action] || a.action)}</td>
              <td>${a.channelCode ? escapeHtml(a.channelCode) : '—'}</td>
            </tr>`).join('') : `<tr><td colspan="4"><div class="empty-hint">Todavía no hay actividad registrada.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ==================================================================
// ACCIONES (sin cambios de comportamiento respecto de antes)
// ==================================================================
async function decideApplication(id, action, name){
  const verb = action === 'approve' ? 'aprobar' : 'rechazar';
  if(!confirm(`¿Seguro que querés ${verb} la solicitud de ${name}?`)) return;
  try{
    await api(`/api/admin/professional-applications/${id}/${action}`, { method:'POST' });
    location.reload();
  }catch(e){
    alert(e.error || `No se pudo ${verb} la solicitud.`);
  }
}

async function unassignProfessional(code, userId, name, channelCode){
  if(!confirm(`¿Quitar a ${name} del canal ${channelCode}? Queda avisado en el chat de ese canal.`)) return;
  try{
    await api(`/api/admin/channels/${code}/professionals/${userId}`, { method:'DELETE' });
    location.reload();
  }catch(e){
    alert(e.error || 'No se pudo quitar.');
  }
}

async function loadWebhookRawLog(){
  const el = document.getElementById('wa-webhook-log');
  el.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  try{
    const list = await api('/api/admin/whatsapp/webhook-log');
    el.innerHTML = list.length
      ? list.map(r => `
          <div class="card" style="margin-bottom:8px;">
            <div class="chart-note" style="margin-bottom:6px;">${fmtDate(r.createdAt)}</div>
            <pre style="white-space:pre-wrap; word-break:break-all; font-family:var(--mono); font-size:10.5px; color:var(--text-dim); max-height:200px; overflow:auto;">${escapeHtml(r.payload)}</pre>
          </div>`).join('')
      : `<p class="empty-hint">Sin payloads registrados todavía.</p>`;
  }catch(e){
    el.innerHTML = `<p class="empty-hint">No se pudo cargar.</p>`;
  }
}

async function assignProfessional(){
  const code = document.getElementById('assign-code').value.trim().toUpperCase();
  const email = document.getElementById('assign-email').value.trim();
  const role = document.getElementById('assign-role').value;
  const label = document.getElementById('assign-label').value.trim();
  const resultEl = document.getElementById('assign-result');
  if(!code || !email || !label){
    resultEl.innerHTML = `<span style="color:var(--danger)">Completá código de canal, email y nombre.</span>`;
    return;
  }
  resultEl.textContent = 'Asignando...';
  try{
    await api(`/api/admin/channels/${code}/assign-professional`, {
      method:'POST', body: JSON.stringify({ email, role, label }),
    });
    resultEl.innerHTML = `<span style="color:var(--calm)">Listo — se avisó en el canal ${escapeHtml(code)}.</span>`;
    setTimeout(() => location.reload(), 1200);
  }catch(e){
    resultEl.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.error || 'No se pudo asignar.')}</span>`;
  }
}

async function logout(){
  await fetch('/auth/logout', { method:'POST', credentials:'same-origin' });
  location.reload();
}
