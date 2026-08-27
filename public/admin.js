// public/admin.js
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(ms){ return new Date(ms).toLocaleString('es-AR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}); }

async function api(path){
  const resp = await fetch(path, { credentials:'same-origin' });
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
    const [overview, users, channels, trend] = await Promise.all([
      api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/channels'), api('/api/admin/trend'),
    ]);
    renderDashboard(app, me, overview, users, channels, trend);
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

function renderDashboard(app, me, ov, users, channels, trend){
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
    </div>
  `;
}

async function logout(){
  await fetch('/auth/logout', { method:'POST', credentials:'same-origin' });
  location.reload();
}
