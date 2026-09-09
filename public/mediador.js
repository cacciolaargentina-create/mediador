// public/mediador.js — página separada, sin tocar public/app.js (Bloque 3)

let me = null;
let currentMediationId = null;

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
const DESGLOSE_LABELS = {
  audienciasSinConfirmar: 'audiencias sin confirmar', documentosPendientesRevision: 'documento(s) pendiente(s) de revisión',
  compromisosVencidos: 'compromiso(s) vencido(s)', tareasVencidas: 'tarea(s) vencida(s)', sinProximaAccion: 'mediación(es) sin próxima acción',
};
const NEXT_ACTION_RESPONSIBLE_LABELS = { mediador: 'Mediador/a', party: 'Una parte', lawyer: 'Un abogado' };

(async function boot(){
  try{
    me = await api('/auth/me');
  }catch(e){
    document.getElementById('login-gate').style.display = 'flex';
    return;
  }
  document.getElementById('app').style.display = 'block';
  document.getElementById('user-name').textContent = me.name;
  goTo('dashboard');
})();

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

function goTo(screen, id){
  currentMediationId = id || null;
  if(screen === 'dashboard') renderDashboard();
  else if(screen === 'list') renderList();
  else if(screen === 'detail') renderDetail(id);
  else if(screen === 'new') renderNewForm();
  else if(screen === 'stats') renderStats();
}

// ================= DASHBOARD =================
async function renderDashboard(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let d;
  try{ d = await api('/api/mediations/dashboard'); }
  catch(e){ main.innerHTML = `<p class="empty-hint">No se pudo cargar el dashboard.</p>`; return; }

  main.innerHTML = `
    <h1>¿Qué tengo que hacer hoy?</h1>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:18px;">Hola, ${escapeHtml(me.name)}.</p>

    <div class="card">
      <div class="stat-row">
        <div><div class="stat">${d.counts.activas}</div><div class="stat-label">activas</div></div>
        <div><div class="stat">${d.counts.cerradas}</div><div class="stat-label">cerradas</div></div>
        <div><div class="stat">${d.counts.total}</div><div class="stat-label">total</div></div>
      </div>
    </div>

    ${d.requierenAtencion.totalMediaciones > 0 ? `
    <div class="card" style="border-color:var(--warn-dim);">
      <h2 style="color:var(--warn);">${d.requierenAtencion.totalMediaciones} mediación${d.requierenAtencion.totalMediaciones===1?'':'es'} requiere${d.requierenAtencion.totalMediaciones===1?'':'n'} atención</h2>
      ${Object.entries(d.requierenAtencion.desglose).filter(([,n]) => n>0).map(([k,n]) => `
        <div style="font-size:12.5px; color:var(--text-dim); padding:3px 0;">- ${n} ${DESGLOSE_LABELS[k] || k}</div>
      `).join('')}
    </div>
    ` : ''}

    <div class="card">
      <h2>Necesitan atención</h2>
      ${[
        ...d.necesitanAtencion.accionesVencidas.map(m => ({ mediationId:m.id, mediationCode:m.code, label: m.object, badge: `<span class="pill danger">próxima acción vencida ${fmtDate(m.nextActionDueDate)}</span>` })),
        ...d.necesitanAtencion.sinProximaAccion.map(m => ({ mediationId:m.id, mediationCode:m.code, label: m.object, badge: `<span class="pill warn">sin próxima acción</span>` })),
        ...d.necesitanAtencion.tareasVencidas.map(t => ({ mediationId:t.mediationId, mediationCode:t.mediationCode, label: t.title, badge: `<span class="pill danger">tarea vencida</span>` })),
        ...d.necesitanAtencion.compromisosVencidos.map(c => ({ mediationId:c.mediationId, mediationCode:c.mediationCode, label: `${c.partyName}: ${c.description}`, badge: `<span class="pill danger">compromiso vencido</span>` })),
        ...d.necesitanAtencion.audienciasSinConfirmar.map(h => ({ mediationId:h.mediationId, mediationCode:h.mediationCode, label: `Audiencia ${fmtDate(h.date)}`, badge: `<span class="pill warn">confirmación pendiente</span>` })),
        ...d.necesitanAtencion.documentosPendientesRevision.map(doc => ({ mediationId:doc.mediationId, mediationCode:doc.mediationCode, label: doc.originalFilename, badge: `<span class="pill warn">documento sin revisar</span>` })),
      ].map(item => `
        <div class="alert-row" onclick="goTo('detail','${item.mediationId}')">
          <div>
            <div style="font-weight:600; font-size:13.5px;">${escapeHtml(item.label)}</div>
            <div class="code">${escapeHtml(item.mediationCode || '')}</div>
          </div>
          ${item.badge}
        </div>
      `).join('') || `<p class="empty-hint">Nada pendiente por ahora.</p>`}
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

let listFilters = { estado: '', responsable: '', responsableNombre: '', vencidas: '' };

async function renderList(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  const params = new URLSearchParams();
  if(listFilters.estado) params.set('estado', listFilters.estado);
  if(listFilters.responsable) params.set('responsable', listFilters.responsable);
  if(listFilters.responsableNombre) params.set('responsableNombre', listFilters.responsableNombre);
  if(listFilters.vencidas) params.set('vencidas', '1');
  let list;
  try{ list = await api('/api/mediations?' + params.toString()); }
  catch(e){ main.innerHTML = `<p class="empty-hint">No se pudo cargar la lista.</p>`; return; }

  main.innerHTML = `
    <h1>Mediaciones</h1>
    <button class="primary" style="width:100%; margin-bottom:16px;" onclick="goTo('new')">+ Nueva mediación</button>

    <div class="card">
      <label>Estado</label>
      <select id="filter-estado" onchange="applyListFilters()">
        <option value="">Todos</option>
        ${Object.keys(STATUS_LABELS).map(s => `<option value="${s}" ${listFilters.estado===s?'selected':''}>${STATUS_LABELS[s]}</option>`).join('')}
      </select>
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
  if(!object){ alert('Falta el objeto de la mediación.'); return; }
  try{
    const m = await api('/api/mediations', { method:'POST', body: JSON.stringify({
      object,
      type: document.getElementById('new-type').value.trim() || null,
      internalNumber: document.getElementById('new-internal').value.trim() || null,
      description: document.getElementById('new-description').value.trim() || null,
    })});
    goTo('detail', m.id);
  }catch(e){ alert(e.error || 'No se pudo crear la mediación.'); }
}

// ================= EXPEDIENTE (detalle) =================
let currentParties = []; // cache para no tener que resolver nombre de parte a mano en cada lugar que lo necesita (abogados, confirmaciones de audiencia)

const PARTY_ROLE_LABELS = { requirente: 'Requirente', requerido: 'Requerido', otro: 'Otro' };
const HEARING_MODALITY_LABELS = { presencial: 'Presencial', virtual: 'Virtual', hibrida: 'Híbrida' };
const HEARING_STATUS_LABELS = { programada: 'Programada', confirmada: 'Confirmada', realizada: 'Realizada', cancelada: 'Cancelada', no_realizada: 'No realizada' };
const CONFIRMATION_LABELS = { pendiente: 'Pendiente', confirma: 'Confirma', no_puede: 'No puede', pide_cambio: 'Pide cambio' };
const DOCUMENT_TYPE_LABELS = { dni:'DNI', poder:'Poder', notificacion:'Notificación', presupuesto:'Presupuesto', contrato:'Contrato', acta:'Acta', acuerdo:'Acuerdo', constancia:'Constancia', otro:'Otro' };
const DOCUMENT_STATUS_LABELS = { pendiente_escaneo:'Pendiente de escaneo', recibido:'Recibido — sin revisar', pendiente_revision:'Pendiente de revisión', revisado:'Revisado', observado:'Observado', final:'Final' };
const TASK_PRIORITY_LABELS = { baja:'Baja', media:'Media', alta:'Alta', urgente:'Urgente' };
const TASK_STATUS_LABELS = { pendiente:'Pendiente', en_proceso:'En proceso', completada:'Completada', cancelada:'Cancelada' };
const COMMITMENT_STATUS_LABELS = { pendiente:'Pendiente', cumplido:'Cumplido', vencido:'Vencido', cancelado:'Cancelado' };
const EVENT_TYPE_LABELS = {
  MEDIATION_CREATED:'Mediación creada', MEDIATION_STATUS_CHANGED:'Cambio de estado', MEDIATION_CLOSED:'Mediación cerrada',
  PARTY_ADDED:'Parte agregada', PARTY_INVITED:'Invitación al portal', LAWYER_ADDED:'Abogado agregado', LAWYER_INVITED:'Invitación al portal (abogado)',
  HEARING_SCHEDULED:'Audiencia agendada', HEARING_CONFIRMED:'Audiencia confirmada',
  HEARING_HELD:'Audiencia realizada', HEARING_CANCELLED:'Audiencia cancelada',
  HEARING_NOT_HELD:'Audiencia no realizada', HEARING_CONFIRMATION_MISSING:'Confirmación pendiente',
  HEARING_RESCHEDULE_REQUESTED:'Pedido de cambio de audiencia', HEARING_RESCHEDULE_REJECTED:'Pedido de cambio rechazado', HEARING_RESCHEDULED:'Audiencia reprogramada',
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

function partyName(partyId){
  const p = currentParties.find(x => x.id === partyId);
  if(!p) return '—';
  return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || '—';
}

async function renderDetail(id){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let m, history, parties, lawyers, hearings, documents, timeline, tasks, commitments;
  try{
    [m, history, parties, lawyers, hearings, documents, timeline, tasks, commitments] = await Promise.all([
      api(`/api/mediations/${id}`),
      api(`/api/mediations/${id}/status-history`),
      api(`/api/mediations/${id}/parties`),
      api(`/api/mediations/${id}/lawyers`),
      api(`/api/mediations/${id}/hearings`),
      api(`/api/mediations/${id}/documents`),
      api(`/api/mediations/${id}/timeline`),
      api(`/api/mediations/${id}/tasks`),
      api(`/api/mediations/${id}/commitments`),
    ]);
  }catch(e){ main.innerHTML = `<p class="empty-hint">${escapeHtml(e.error || 'No se pudo cargar la mediación.')}</p>`; return; }
  currentParties = parties;

  const statusOptions = Object.keys(STATUS_LABELS).map(s =>
    `<option value="${s}" ${s === m.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`
  ).join('');

  main.innerHTML = `
    <span class="back-link" onclick="goTo('list')">← Volver a mediaciones</span>
    <div class="eyebrow">${escapeHtml(m.code)}${m.internalNumber ? ' · ' + escapeHtml(m.internalNumber) : ''}</div>
    <h1>${escapeHtml(m.object)}</h1>

    <div class="card" style="border-color:${m.nextActionDueDate && new Date(m.nextActionDueDate).getTime()<Date.now() ? 'var(--danger-dim)' : 'var(--line)'};">
      <div style="display:flex; flex-wrap:wrap; gap:14px;">
        <div><div class="eyebrow" style="margin-bottom:2px;">Estado</div><div style="font-size:13px; font-weight:600;">${STATUS_LABELS[m.status] || m.status}</div></div>
        <div><div class="eyebrow" style="margin-bottom:2px;">Próxima acción</div><div style="font-size:13px; font-weight:600;">${m.nextActionText ? escapeHtml(m.nextActionText) : '<span style="color:var(--warn);">Sin cargar</span>'}</div></div>
        <div><div class="eyebrow" style="margin-bottom:2px;">Responsable</div><div style="font-size:13px; font-weight:600;">${NEXT_ACTION_RESPONSIBLE_LABELS[m.nextActionResponsibleType] || '—'}</div></div>
        <div><div class="eyebrow" style="margin-bottom:2px;">Vencimiento</div><div style="font-size:13px; font-weight:600; color:${m.nextActionDueDate && new Date(m.nextActionDueDate).getTime()<Date.now() ? 'var(--danger)' : 'var(--text)'};">${m.nextActionDueDate ? fmtDate(m.nextActionDueDate) : '—'}</div></div>
      </div>
    </div>

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
      `).join('') : `<p class="empty-hint">Todavía no hay partes cargadas.</p>`}
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

    <div class="card">
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

    <div class="card">
      <h2>Audiencias</h2>
      ${hearings.length ? hearings.map(h => `
        <div class="status-history-item">
          <strong>${fmtDate(h.date)}${h.startTime ? ' ' + h.startTime : ''}</strong> —
          ${HEARING_MODALITY_LABELS[h.modality] || h.modality} · <span class="pill calm">${HEARING_STATUS_LABELS[h.status] || h.status}</span>
          <div style="margin-top:4px;">
            ${h.confirmations.map(c => `
              <span class="pill ${c.response === 'confirma' ? 'calm' : c.response === 'no_puede' ? 'danger' : 'warn'}" style="margin-right:4px;">
                ${escapeHtml(partyName(c.partyId))}: ${CONFIRMATION_LABELS[c.response] || c.response}
              </span>
            `).join('')}
          </div>
          <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
            <select onchange="changeHearingStatus('${m.id}','${h.id}',this.value)" style="width:auto; margin:0;">
              ${Object.keys(HEARING_STATUS_LABELS).map(s => `<option value="${s}" ${s===h.status?'selected':''}>${HEARING_STATUS_LABELS[s]}</option>`).join('')}
            </select>
            ${h.confirmations.map(c => `
              <select onchange="recordConfirmation('${m.id}','${h.id}','${c.partyId}',this.value)" style="width:auto; margin:0;">
                <option value="">${escapeHtml(partyName(c.partyId))} responde…</option>
                ${Object.keys(CONFIRMATION_LABELS).map(r => `<option value="${r}">${CONFIRMATION_LABELS[r]}</option>`).join('')}
              </select>
            `).join('')}
            <button class="ghost" style="padding:4px 10px; font-size:11px;" onclick="toggleRescheduleRequests('${m.id}','${h.id}')">Solicitudes de cambio</button>
          </div>
          <div id="reschedule-${h.id}" style="display:none; margin-top:8px;"></div>
        </div>
      `).join('') : `<p class="empty-hint">Todavía no hay audiencias agendadas.</p>`}
      <button class="ghost" style="width:100%; margin-top:8px;" onclick="toggleForm('hearing-form')">+ Agendar audiencia</button>
      <div id="hearing-form" style="display:none; margin-top:10px;">
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
        <button class="primary" style="width:100%;" onclick="addHearing('${m.id}')">Guardar audiencia</button>
      </div>
    </div>

    <div class="card">
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

    <div class="card">
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

    <div class="card">
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

    <div class="card">
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
  }catch(e){ alert(e.error || 'No se pudo guardar la configuración.'); }
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
    alert(lines.join('\n'));
  }catch(e){ alert(e.error || 'No se pudo cargar el checklist.'); }
}

async function closeMediation(id){
  const result = document.getElementById('close-result').value;
  const notes = document.getElementById('close-notes').value.trim() || undefined;
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
        }catch(e2){ alert(e2.error || 'No se pudo cerrar la mediación.'); }
      }
    } else {
      alert(e.error || 'No se pudo cerrar la mediación.');
    }
  }
}
async function changeStatus(id){
  const status = document.getElementById('status-select').value;
  const note = document.getElementById('status-note').value.trim() || undefined;
  try{
    await api(`/api/mediations/${id}/status`, { method:'POST', body: JSON.stringify({ status, note }) });
    renderDetail(id);
  }catch(e){ alert(e.error || 'No se pudo cambiar el estado.'); }
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
  }catch(e){ alert(e.error || 'No se pudo guardar.'); }
}
async function saveGeneralData(id){
  try{
    await api(`/api/mediations/${id}`, { method:'PATCH', body: JSON.stringify({
      type: document.getElementById('edit-type').value.trim(),
      description: document.getElementById('edit-description').value.trim(),
    })});
    renderDetail(id);
  }catch(e){ alert(e.error || 'No se pudo guardar.'); }
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
  }catch(e){ alert(e.error || 'No se pudo enviar el mensaje.'); }
}

async function toggleAllowUpload(mediationId, partyId, allow){
  try{
    await api(`/api/mediations/${mediationId}/parties/${partyId}`, { method:'PATCH', body: JSON.stringify({ allowDocumentUpload: allow }) });
  }catch(e){ alert(e.error || 'No se pudo actualizar el permiso.'); renderDetail(mediationId); }
}

async function inviteParty(mediationId, partyId){
  try{
    const result = await api(`/api/mediations/${mediationId}/parties/${partyId}/invite`, { method:'POST' });
    const fullUrl = location.origin + result.portalUrl;
    prompt('Copiá este link y compartíselo a la parte (WhatsApp, mail, lo que uses):', fullUrl);
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo generar la invitación.'); }
}

async function addParty(mediationId){
  const firstName = document.getElementById('party-first-name').value.trim();
  const lastName = document.getElementById('party-last-name').value.trim();
  if(!firstName){ alert('Falta el nombre de la parte.'); return; }
  try{
    await api(`/api/mediations/${mediationId}/parties`, { method:'POST', body: JSON.stringify({
      role: document.getElementById('party-role').value,
      firstName, lastName,
      documentNumber: document.getElementById('party-document').value.trim() || null,
      email: document.getElementById('party-email').value.trim() || null,
      phone: document.getElementById('party-phone').value.trim() || null,
    })});
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo guardar la parte.'); }
}

async function inviteLawyer(mediationId, lawyerId){
  try{
    const result = await api(`/api/mediations/${mediationId}/lawyers/${lawyerId}/invite`, { method:'POST' });
    const fullUrl = location.origin + result.portalUrl;
    prompt('Copiá este link y compartíselo al abogado (WhatsApp, mail, lo que uses):', fullUrl);
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo generar la invitación.'); }
}

async function addLawyer(mediationId){
  const name = document.getElementById('lawyer-name').value.trim();
  if(!name){ alert('Falta el nombre del abogado.'); return; }
  try{
    await api(`/api/mediations/${mediationId}/lawyers`, { method:'POST', body: JSON.stringify({
      name,
      enrollmentNumber: document.getElementById('lawyer-enrollment').value.trim() || null,
      partyId: document.getElementById('lawyer-party').value || null,
      email: document.getElementById('lawyer-email').value.trim() || null,
    })});
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo guardar el abogado.'); }
}

async function addHearing(mediationId){
  const date = document.getElementById('hearing-date').value;
  if(!date){ alert('Falta la fecha de la audiencia.'); return; }
  try{
    await api(`/api/mediations/${mediationId}/hearings`, { method:'POST', body: JSON.stringify({
      date,
      startTime: document.getElementById('hearing-time').value || null,
      modality: document.getElementById('hearing-modality').value,
      location: document.getElementById('hearing-location').value.trim() || null,
    })});
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo agendar la audiencia.'); }
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
    if(!body.newDate){ alert('Falta la fecha para proponer.'); return; }
  }
  try{
    await api(`/api/mediations/${mediationId}/hearings/${hearingId}/reschedule-requests/${requestId}/resolve`, { method:'POST', body: JSON.stringify(body) });
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo resolver la solicitud.'); }
}

async function changeHearingStatus(mediationId, hearingId, status){
  try{
    const result = await api(`/api/mediations/${mediationId}/hearings/${hearingId}/status`, { method:'POST', body: JSON.stringify({ status }) });
    renderDetail(mediationId);
    // el backend solo SUGIERE, nunca crea el compromiso solo (ver
    // IMPLEMENTATION_PLAN.md §3.11) — acá simplemente mostramos el aviso
    // y abrimos el formulario de compromisos si el mediador quiere cargarlo.
    if(result.suggestion?.type === 'CREATE_COMMITMENTS'){
      setTimeout(() => {
        if(confirm(result.suggestion.message)) toggleForm('commitment-form');
      }, 300);
    }
  }catch(e){ alert(e.error || 'No se pudo actualizar el estado de la audiencia.'); }
}

async function recordConfirmation(mediationId, hearingId, partyId, response){
  if(!response) return; // el select tiene una opción vacía de placeholder, no hacer nada si la elige de nuevo
  try{
    await api(`/api/mediations/${mediationId}/hearings/${hearingId}/confirmations/${partyId}`, { method:'POST', body: JSON.stringify({ response }) });
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo registrar la respuesta.'); }
}

function toggleVersionUpload(docId){
  const box = document.getElementById(`version-upload-${docId}`);
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
}

async function uploadNewVersion(mediationId, docId){
  const file = document.getElementById(`version-file-${docId}`).files[0];
  if(!file){ alert('Elegí un archivo primero.'); return; }
  const formData = new FormData();
  formData.append('file', file);
  try{
    const res = await fetch(`/api/mediations/${mediationId}/documents/${docId}/versions`, { method:'POST', credentials:'same-origin', body: formData });
    const data = await res.json();
    if(!res.ok) throw data;
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo subir la nueva versión.'); }
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
  }catch(e){ alert(e.error || 'No se pudo actualizar el documento.'); }
}

async function uploadDocument(mediationId){
  const fileInput = document.getElementById('document-file');
  const file = fileInput.files[0];
  if(!file){ alert('Elegí un archivo primero.'); return; }

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
    renderDetail(mediationId);
  }catch(e){
    alert(e.error || 'No se pudo subir el archivo.');
    btn.disabled = false;
    btn.textContent = 'Subir';
  }
}

async function addTask(mediationId){
  const title = document.getElementById('task-title').value.trim();
  if(!title){ alert('Falta el título de la tarea.'); return; }
  try{
    await api(`/api/mediations/${mediationId}/tasks`, { method:'POST', body: JSON.stringify({
      title,
      dueDate: document.getElementById('task-due').value || null,
      priority: document.getElementById('task-priority').value,
    })});
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo guardar la tarea.'); }
}

async function changeTaskStatus(mediationId, taskId, status){
  try{
    await api(`/api/mediations/${mediationId}/tasks/${taskId}`, { method:'PATCH', body: JSON.stringify({ status }) });
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo actualizar la tarea.'); }
}

async function addCommitment(mediationId){
  const description = document.getElementById('commitment-description').value.trim();
  if(!description){ alert('Falta la descripción del compromiso.'); return; }
  const partySelect = document.getElementById('commitment-party');
  if(!partySelect.value){ alert('Cargá al menos una parte antes de crear un compromiso.'); return; }
  try{
    await api(`/api/mediations/${mediationId}/commitments`, { method:'POST', body: JSON.stringify({
      partyId: partySelect.value, description,
      dueDate: document.getElementById('commitment-due').value || null,
    })});
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo guardar el compromiso.'); }
}

async function changeCommitmentStatus(mediationId, commitmentId, status){
  try{
    await api(`/api/mediations/${mediationId}/commitments/${commitmentId}`, { method:'PATCH', body: JSON.stringify({ status }) });
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo actualizar el compromiso.'); }
}
