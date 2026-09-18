// public/radar.js — Bloque 25. Panel interno del radar competitivo, mismo
// patrón que admin.js (auth vía /auth/me + chequeo de admin, sin esto el
// backend igual devuelve 403 en cada endpoint — esto es solo UX).
function escapeHtml(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(ms){ return ms ? new Date(ms).toLocaleString('es-AR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}) : '—'; }

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

const SECTIONS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'sources', label: 'Fuentes' },
  { id: 'changes', label: 'Cambios recientes' },
  { id: 'opportunities', label: 'Oportunidades' },
  { id: 'matrix', label: 'Matriz competitiva' },
];

const CATEGORY_LABELS = { competidor: 'Competidor', oficial: 'Oficial', regulatorio: 'Regulatorio', mercado: 'Mercado' };
const LEVEL_CLASS = { HIGH: 'danger', MEDIUM: 'warn', LOW: 'neutral' };
const STATUS_CLASS = { nueva: 'warn', revisada: 'ok', descartada: 'neutral', convertida_en_oportunidad: 'ok', pendiente: 'warn', confirmada: 'ok' };
const FEATURE_STATUS_CLASS = { confirmada: 'ok', posible: 'warn', no_confirmada: 'neutral' };
const FEATURE_STATUS_LABELS = { confirmada: 'Confirmada', posible: 'Posible', no_confirmada: 'No confirmada' };

let STATE = {};
let currentSection = 'dashboard';
let currentCompetitorId = null;

(async function boot(){
  const app = document.getElementById('app');
  let me;
  try{ me = await api('/auth/me'); }
  catch(e){ renderLogin(app); return; }

  let check;
  try{ check = await api('/api/admin/am-i-admin'); }
  catch(e){ renderNoAccess(app, me); return; }
  if(!check.isAdmin){ renderNoAccess(app, me); return; }

  STATE.me = me;
  try{ await loadDashboard(); renderShell(); }
  catch(e){
    app.innerHTML = `<div class="center-note"><span class="brand">Mediador</span>No se pudo cargar el radar. Probá recargar la página.</div>`;
  }
})();

function renderLogin(app){
  app.innerHTML = `
    <div class="center-note">
      <span class="brand">Mediador</span>
      Radar competitivo — iniciá sesión con tu cuenta de Google para continuar.
      <div><button class="google-btn" onclick="location.href='/auth/google?next=/radar.html'">Iniciar sesión con Google</button></div>
    </div>
  `;
}
function renderNoAccess(app, me){
  app.innerHTML = `
    <div class="center-note">
      <span class="brand">Mediador</span>
      La cuenta <strong>${escapeHtml(me.name)}</strong> (${escapeHtml(me.email || '')}) no tiene acceso al radar competitivo.
      <div><a href="/" style="color:var(--calm);">Volver a la app</a></div>
    </div>
  `;
}

async function loadDashboard(){
  const [dashboard, matrix] = await Promise.all([api('/api/radar/dashboard'), api('/api/radar/matrix')]);
  STATE.dashboard = dashboard;
  STATE.matrix = matrix;
}

function renderShell(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="wrap">
      <header>
        <div>
          <div class="brand">Mediador <em>Radar</em></div>
          <div class="brand-sub">Herramienta interna — no visible para mediadores</div>
        </div>
        <div class="user-chip">${escapeHtml(STATE.me.name)} <a href="/">Volver a la app</a></div>
      </header>
      <nav class="radar-nav">
        ${SECTIONS.map(s => `<button class="${s.id===currentSection?'active':''}" onclick="goSection('${s.id}')">${s.label}</button>`).join('')}
      </nav>
      <div id="section-body"></div>
    </div>
  `;
  renderSection();
}

function goSection(id){ currentSection = id; currentCompetitorId = null; renderSection(); }

async function renderSection(){
  const body = document.getElementById('section-body');
  document.querySelectorAll('.radar-nav button').forEach((b, i) => b.classList.toggle('active', SECTIONS[i].id === currentSection));
  if(currentCompetitorId){ await renderCompetitorDetail(body, currentCompetitorId); return; }
  if(currentSection === 'dashboard') return renderDashboardSection(body);
  if(currentSection === 'sources') return renderSourcesSection(body);
  if(currentSection === 'changes') return renderChangesSection(body);
  if(currentSection === 'opportunities') return renderOpportunitiesSection(body);
  if(currentSection === 'matrix') return renderMatrixSection(body);
}

// ================= DASHBOARD (§14) =================
function renderDashboardSection(body){
  const d = STATE.dashboard;
  const c = d.counts;
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${c.activeSources}</div><div class="lab">fuentes activas de ${c.totalSources}</div></div>
      <div class="stat-card"><div class="num">${c.changesLast30d}</div><div class="lab">cambios detectados (30 días)</div></div>
      <div class="stat-card"><div class="num">${c.priceChangesLast30d}</div><div class="lab">cambios de precio (30 días)</div></div>
      <div class="stat-card"><div class="num">${c.newFeaturesLast30d}</div><div class="lab">funcionalidades/integraciones nuevas (30 días)</div></div>
      <div class="stat-card"><div class="num">${c.pendingChanges}</div><div class="lab">cambios sin revisar</div></div>
      <div class="stat-card"><div class="num">${c.pendingOpportunities}</div><div class="lab">oportunidades pendientes</div></div>
    </div>
    <section class="block">
      <h2 class="block-title">Cambios recientes</h2>
      ${renderChangesTable(d.recentChanges)}
    </section>
    <section class="block">
      <h2 class="block-title">Oportunidades</h2>
      ${renderOpportunitiesTable(d.opportunities.slice(0,10))}
    </section>
    <section class="block">
      <h2 class="block-title">Precios — últimos detectados</h2>
      ${renderPricesTable(d.recentPrices)}
    </section>
  `;
}

// ================= FUENTES (§1/§2/§17) =================
async function renderSourcesSection(body){
  const sources = await api('/api/radar/sources');
  STATE.sources = sources;
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Fuentes monitoreadas</h2>
      <p class="block-note">Solo fuentes públicas verificadas a mano — el radar nunca inventa ni descubre URLs solo.</p>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Nombre</th><th>Categoría</th><th>Frecuencia</th><th>Activa</th><th>Última revisión</th><th>Acciones</th></tr>
          ${sources.map(s => `
            <tr>
              <td class="strong">${escapeHtml(s.name)}<br><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" style="color:var(--text-faint); font-size:11px;">${escapeHtml(s.url)}</a></td>
              <td>${CATEGORY_LABELS[s.category] || s.category}</td>
              <td>${s.checkFrequency}</td>
              <td>${s.active ? '<span class="pill ok">Sí</span>' : '<span class="pill neutral">No</span>'}</td>
              <td>${fmtDate(s.lastCheckedAt)}</td>
              <td class="btn-row">
                <button class="ghost" onclick="openCompetitor('${s.id}')">Ver ficha</button>
                <button class="ghost" onclick="checkSourceNow('${s.id}')">Chequear ahora</button>
                <button class="ghost" onclick="toggleSourceActive('${s.id}', ${!s.active})">${s.active ? 'Desactivar' : 'Activar'}</button>
              </td>
            </tr>
          `).join('') || '<tr><td colspan="6" class="empty-hint">Sin fuentes cargadas.</td></tr>'}
        </table>
      </div>
    </section>
    <section class="block">
      <h2 class="block-title">Agregar fuente</h2>
      <div class="card" style="max-width:480px;">
        <label class="field-label">Nombre</label>
        <input id="new-source-name" placeholder="Ej: medi.ar">
        <label class="field-label">URL pública</label>
        <input id="new-source-url" placeholder="https://...">
        <label class="field-label">Categoría</label>
        <select id="new-source-category">
          <option value="competidor">Competidor</option>
          <option value="oficial">Oficial / benchmark</option>
          <option value="regulatorio">Regulatorio</option>
          <option value="mercado">Mercado</option>
        </select>
        <label class="field-label">Frecuencia</label>
        <select id="new-source-frequency">
          <option value="weekly" selected>Semanal</option>
          <option value="daily">Diaria</option>
          <option value="manual">Manual</option>
        </select>
        <label class="field-label">Notas (opcional)</label>
        <input id="new-source-notes" placeholder="Por qué se agregó esta fuente">
        <button class="ghost" onclick="addSource()">Guardar fuente</button>
      </div>
    </section>
  `;
}

async function addSource(){
  const name = document.getElementById('new-source-name').value.trim();
  const url = document.getElementById('new-source-url').value.trim();
  const category = document.getElementById('new-source-category').value;
  const checkFrequency = document.getElementById('new-source-frequency').value;
  const notes = document.getElementById('new-source-notes').value.trim();
  try{
    await api('/api/radar/sources', { method:'POST', body: JSON.stringify({ name, url, category, checkFrequency, notes: notes || null }) });
    renderSourcesSection(document.getElementById('section-body'));
  }catch(e){ alert(e.error || 'No se pudo agregar la fuente.'); }
}
async function toggleSourceActive(id, active){
  try{ await api(`/api/radar/sources/${id}`, { method:'PATCH', body: JSON.stringify({ active }) }); }
  catch(e){ alert(e.error || 'No se pudo actualizar.'); }
  renderSourcesSection(document.getElementById('section-body'));
}
async function checkSourceNow(id){
  try{
    const result = await api(`/api/radar/sources/${id}/check`, { method:'POST' });
    if(!result.ok) alert('No se pudo chequear: ' + (result.error || 'error desconocido'));
    else if(result.changed) alert('Se detectó un cambio: ' + result.change.title);
    else alert('Chequeado — sin cambios.');
  }catch(e){ alert(e.error || 'No se pudo chequear la fuente.'); }
  renderSourcesSection(document.getElementById('section-body'));
}

// ================= CAMBIOS (§4/§6/§12/§13) =================
function renderChangesTable(list){
  if(!list.length) return '<div class="empty-hint">Sin cambios detectados todavía.</div>';
  return `
    <div class="table-wrap">
      <table class="min-w">
        <tr><th>Fecha</th><th>Nivel</th><th>Tipo</th><th>Título</th><th>Evidencia</th><th>Estado</th><th>Acciones</th></tr>
        ${list.map(c => `
          <tr>
            <td>${fmtDate(c.detectedAt)}</td>
            <td><span class="pill ${LEVEL_CLASS[c.level]||'neutral'}">${c.level}</span></td>
            <td>${escapeHtml(c.type)}</td>
            <td class="strong">${escapeHtml(c.title)}</td>
            <td class="evidence">${escapeHtml((c.evidenceText||'').slice(0,180))}</td>
            <td><span class="pill ${STATUS_CLASS[c.status]||'neutral'}">${c.status}</span></td>
            <td class="btn-row">
              ${c.status === 'nueva' ? `
                <button class="ghost" onclick="confirmChange('${c.id}')">Confirmar</button>
                <button class="ghost danger" onclick="dismissChange('${c.id}')">Descartar</button>
                <button class="ghost" onclick="createOpportunityFromChange('${c.id}')">Crear oportunidad</button>
              ` : ''}
            </td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
}
async function renderChangesSection(body){
  const changes = await api('/api/radar/changes');
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Cambios recientes (también funcionan como alertas del radar)</h2>
      <p class="block-note">Ningún cambio se convierte solo en decisión de producto — cada uno se confirma, descarta o pasa a oportunidad a mano.</p>
      ${renderChangesTable(changes)}
    </section>
  `;
}
async function confirmChange(id){
  try{ await api(`/api/radar/changes/${id}/confirm`, { method:'POST' }); }catch(e){ alert(e.error||'Error'); }
  renderSection();
}
async function dismissChange(id){
  try{ await api(`/api/radar/changes/${id}/dismiss`, { method:'POST' }); }catch(e){ alert(e.error||'Error'); }
  renderSection();
}
async function createOpportunityFromChange(id){
  const title = prompt('Título de la oportunidad (obligatorio):');
  if(!title || !title.trim()) return;
  const observation = prompt('Observación (opcional) — qué se propone evaluar:') || '';
  try{ await api(`/api/radar/changes/${id}/create-opportunity`, { method:'POST', body: JSON.stringify({ title, observation }) }); }
  catch(e){ alert(e.error||'Error'); }
  renderSection();
}

// ================= OPORTUNIDADES (§9/§13) =================
function renderOpportunitiesTable(list){
  if(!list.length) return '<div class="empty-hint">Sin oportunidades registradas todavía.</div>';
  return `
    <div class="table-wrap">
      <table class="min-w">
        <tr><th>Fecha</th><th>Título</th><th>Observación</th><th>Evidencia</th><th>Estado</th><th>Acciones</th></tr>
        ${list.map(o => `
          <tr>
            <td>${fmtDate(o.createdAt)}</td>
            <td class="strong">${escapeHtml(o.title)}</td>
            <td class="evidence">${escapeHtml(o.observation||'')}</td>
            <td class="evidence">${escapeHtml((o.evidence||'').slice(0,180))}</td>
            <td><span class="pill ${STATUS_CLASS[o.status]||'neutral'}">${o.status}</span></td>
            <td class="btn-row">
              ${o.status === 'pendiente' ? `
                <button class="ghost" onclick="confirmOpportunity('${o.id}')">Confirmar</button>
                <button class="ghost danger" onclick="dismissOpportunity('${o.id}')">Descartar</button>
              ` : ''}
            </td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
}
async function renderOpportunitiesSection(body){
  const opportunities = await api('/api/radar/opportunities');
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Oportunidades detectadas</h2>
      <p class="block-note">OBSERVACIÓN + EVIDENCIA — el radar nunca decide que hay que construir algo, solo lo deja planteado para revisión humana.</p>
      ${renderOpportunitiesTable(opportunities)}
    </section>
  `;
}
async function confirmOpportunity(id){
  try{ await api(`/api/radar/opportunities/${id}/confirm`, { method:'POST' }); }catch(e){ alert(e.error||'Error'); }
  renderSection();
}
async function dismissOpportunity(id){
  try{ await api(`/api/radar/opportunities/${id}/dismiss`, { method:'POST' }); }catch(e){ alert(e.error||'Error'); }
  renderSection();
}

// ================= PRECIOS (§11) =================
function renderPricesTable(list){
  if(!list.length) return '<div class="empty-hint">Sin precios detectados todavía.</div>';
  return `
    <div class="table-wrap">
      <table class="min-w">
        <tr><th>Fecha</th><th>Plan</th><th>Precio</th><th>Periodicidad</th></tr>
        ${list.map(p => `
          <tr>
            <td>${fmtDate(p.detectedAt)}</td>
            <td class="strong">${escapeHtml(p.plan||'—')}</td>
            <td>${escapeHtml(p.currency||'')} ${escapeHtml(p.price||'')}</td>
            <td>${escapeHtml(p.periodicity||'—')}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
}

// ================= MATRIZ COMPETITIVA (§8) =================
async function renderMatrixSection(body){
  const matrix = await api('/api/radar/matrix');
  body.innerHTML = `
    <section class="block">
      <h2 class="block-title">Matriz competitiva</h2>
      <p class="block-note">Diferencias objetivas, sin ranking ni "ganadores" — cada estado viene de evidencia pública verificable (o "no confirmada" si no hay evidencia).</p>
      <div class="table-wrap">
        <table class="min-w">
          <tr>
            <th>Función</th><th>Mediador</th>
            ${matrix.sources.map(s => `<th>${escapeHtml(s.name)}</th>`).join('')}
          </tr>
          ${matrix.rows.map(row => `
            <tr>
              <td class="strong">${escapeHtml(row.label)}</td>
              <td><span class="pill ${FEATURE_STATUS_CLASS[row.mediador]}">${FEATURE_STATUS_LABELS[row.mediador]}</span></td>
              ${row.competitors.map(c => `
                <td title="${escapeHtml(c.evidence||'')}"><span class="pill ${FEATURE_STATUS_CLASS[c.status]}">${FEATURE_STATUS_LABELS[c.status]}</span></td>
              `).join('')}
            </tr>
          `).join('')}
        </table>
      </div>
    </section>
  `;
}

// ================= FICHA DEL COMPETIDOR (§15) =================
function openCompetitor(id){ currentCompetitorId = id; renderSection(); }
async function renderCompetitorDetail(body, id){
  const data = await api(`/api/radar/competitors/${id}`);
  const s = data.source;
  body.innerHTML = `
    <span class="back-link" onclick="currentCompetitorId=null; renderSection();">← Volver</span>
    <div class="eyebrow">${CATEGORY_LABELS[s.category]||s.category}</div>
    <h1 style="font-family:var(--serif); font-size:22px; margin-bottom:4px;">${escapeHtml(s.name)}</h1>
    <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" style="color:var(--text-faint); font-size:12px;">${escapeHtml(s.url)}</a>
    <p class="block-note" style="margin-top:10px;">Última revisión: ${fmtDate(s.lastCheckedAt)} · Último cambio detectado: ${fmtDate(s.lastChangedAt)}</p>
    ${data.latestSnapshot ? `<p class="block-note">Título público más reciente: "${escapeHtml(data.latestSnapshot.title||'—')}"</p>` : ''}

    <section class="block">
      <h2 class="block-title">Funcionalidades detectadas</h2>
      <p class="block-note">Extractos cortos como evidencia — nunca se copia el contenido comercial completo (§15).</p>
      <div class="table-wrap">
        <table class="min-w">
          <tr><th>Función</th><th>Estado</th><th>Evidencia</th><th>Detectado</th></tr>
          ${data.features.map(f => `
            <tr>
              <td class="strong">${escapeHtml(f.feature)}</td>
              <td><span class="pill ${FEATURE_STATUS_CLASS[f.status]}">${FEATURE_STATUS_LABELS[f.status]}</span></td>
              <td class="evidence">${escapeHtml((f.evidence||'').slice(0,200))}</td>
              <td>${fmtDate(f.detectedAt)}</td>
            </tr>
          `).join('') || '<tr><td colspan="4" class="empty-hint">Sin funcionalidades detectadas todavía.</td></tr>'}
        </table>
      </div>
    </section>

    <section class="block">
      <h2 class="block-title">Precios históricos</h2>
      ${renderPricesTable(data.prices)}
    </section>

    <section class="block">
      <h2 class="block-title">Cambios históricos</h2>
      ${renderChangesTable(data.changes)}
    </section>

    <section class="block">
      <h2 class="block-title">Oportunidades relacionadas</h2>
      ${renderOpportunitiesTable(data.opportunities)}
    </section>
  `;
}
