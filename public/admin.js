// public/admin.js
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(ms){ return new Date(ms).toLocaleString('es-AR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}); }

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
    const [overview, users, channels, trend, professionals, audit, waStatus, waLog, waUsers] = await Promise.all([
      api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/channels'), api('/api/admin/trend'),
      api('/api/admin/professionals'), api('/api/admin/audit'),
      api('/api/admin/whatsapp/status'), api('/api/admin/whatsapp/log'), api('/api/admin/whatsapp/users'),
    ]);
    renderDashboard(app, me, overview, users, channels, trend, professionals, audit, waStatus, waLog, waUsers);
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
};

function renderDashboard(app, me, ov, users, channels, trend, professionals, audit, waStatus, waLog, waUsers){
  app.innerHTML = `
    <div class="wrap">
      <header>
        <div>
          <div class="brand">Puente<em>digital</em></div>
          <div class="brand-sub">Panel de administración</div>
        </div>
        <div class="user-chip">
          ${me.avatar ? `<img src="${me.avatar}" alt="">` : ''}
          <span>${escapeHtml(me.name)}</span>
          <a href="/">Ir a la app</a>
          <button onclick="logout()">Salir</button>
        </div>
      </header>

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

      <section class="block">
        <h2 class="block-title">Actividad reciente</h2>
        <p class="chart-note" style="margin-bottom:12px;">Acciones sensibles: exportar informes, asignar o quitar profesionales. No es un log de cada clic.</p>
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
    </div>
  `;
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
