// public/lawyer-portal.js — Portal de Abogados. Página separada, sin
// login, token en la URL. Mismo patrón que portal.js (Portal de Partes),
// pero con una lista de mediaciones primero, porque un abogado puede
// estar vinculado a más de una (ver el dedup por email en el backend).

const token = new URLSearchParams(location.search).get('token');

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('es-AR');
}
function fmtDateTime(ms){
  return new Date(ms).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function fmtFileSize(bytes){
  if(bytes < 1024) return bytes + ' B';
  if(bytes < 1024*1024) return (bytes/1024).toFixed(0) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
async function api(path, opts = {}){
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw data;
  return data;
}

// Bloque 20 §13 — mismo helper que public/mediador.js y public/portal.js.
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
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 3600);
}

const CONFIRM_LABELS = { confirma:'Confirmó', no_puede:'Avisó que no puede', pide_cambio:'Pidió un cambio' };
const REQUEST_STATUS_LABELS = { pendiente:'Esperando respuesta del mediador/a', aceptada:'Aceptado — se reprogramó', rechazada:'No se pudo hacer el cambio', resuelta:'Resuelto sin cambio' };
const COMMITMENT_STATUS_LABELS = { pendiente:'Pendiente', cumplido:'Cumplido', vencido:'Vencido', cancelado:'Cancelado' };
const MEDIATION_STATUS_LABELS = {
  borrador:'Recién iniciada', iniciada:'Iniciada', contactando_partes:'Contactando a las partes',
  notificaciones:'En notificaciones', audiencia_programada:'Audiencia programada', en_mediacion:'En mediación',
  acuerdo:'Con acuerdo', acuerdo_parcial:'Con acuerdo parcial', sin_acuerdo:'Sin acuerdo',
  incomparecencia:'Incomparecencia', cerrada:'Cerrada',
};
const EVENT_TYPE_LABELS = {
  MEDIATION_CREATED:'Mediación creada', MEDIATION_STATUS_CHANGED:'Cambio de estado', MEDIATION_CLOSED:'Mediación cerrada',
  PARTY_ADDED:'Parte agregada', LAWYER_ADDED:'Abogado agregado', LAWYER_INVITED:'Invitación al portal',
  HEARING_SCHEDULED:'Audiencia agendada',
  HEARING_CONFIRMATION_MISSING:'Confirmación pendiente', HEARING_REMINDER:'Recordatorio de audiencia',
  HEARING_RESCHEDULE_REQUESTED:'Pedido de cambio de audiencia', HEARING_RESCHEDULE_REJECTED:'Pedido de cambio rechazado', HEARING_RESCHEDULED:'Audiencia reprogramada',
  DOCUMENT_UPLOADED:'Documento subido', COMMITMENT_CREATED:'Compromiso creado',
  COMMITMENT_COMPLETED:'Compromiso cumplido', COMMITMENT_OVERDUE:'Compromiso vencido',
};

(async function boot(){
  const main = document.getElementById('main');
  if(!token){ main.innerHTML = `<p class="empty-hint" style="padding:20px;">Falta el enlace. Pedile al mediador/a que te reenvíe la invitación.</p>`; return; }
  await renderList();
})();

async function renderList(){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let data;
  try{ data = await api(`/api/lawyer-portal/${token}`); }
  catch(e){ main.innerHTML = `<p class="empty-hint" style="padding:20px;">${escapeHtml(e.error || 'No se pudo cargar tus mediaciones.')}</p>`; return; }

  main.innerHTML = `
    <h1>Mis mediaciones</h1>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:18px;">Hola, ${escapeHtml(data.lawyerName || '')}.</p>
    ${data.mediations.length ? data.mediations.map(m => `
      <div class="card clickable" onclick="renderDetail('${m.mediationId}')">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600; font-size:14px;">${escapeHtml(m.mediationObject)}</div>
            <div class="eyebrow">${escapeHtml(m.mediationCode)} · representás a ${escapeHtml(m.partyName)}</div>
          </div>
          <span class="pill calm">${MEDIATION_STATUS_LABELS[m.mediationStatus] || m.mediationStatus}</span>
        </div>
        <div style="margin-top:8px; font-size:12px; color:var(--text-dim);">
          ${m.nextHearingDate ? `Próxima audiencia: ${fmtDate(m.nextHearingDate)}` : 'Sin audiencia agendada'}
          ${m.pendingCommitmentsCount > 0 ? ` · <span style="color:var(--warn);">${m.pendingCommitmentsCount} compromiso(s) pendiente(s)</span>` : ''}
        </div>
      </div>
    `).join('') : `<p class="empty-hint">No estás vinculado a ninguna mediación todavía.</p>`}
  `;
}

async function renderDetail(mediationId){
  const main = document.getElementById('main');
  main.innerHTML = `<p class="empty-hint">Cargando…</p>`;
  let data;
  try{ data = await api(`/api/lawyer-portal/${token}/mediations/${mediationId}`); }
  catch(e){ main.innerHTML = `<p class="empty-hint" style="padding:20px;">${escapeHtml(e.error || 'No se pudo cargar la mediación.')}</p>`; return; }

  main.innerHTML = `
    <span class="back-link" onclick="renderList()">← Mis mediaciones</span>
    <div class="eyebrow">${escapeHtml(data.mediationCode)}</div>
    <h1>${escapeHtml(data.mediationObject)}</h1>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:18px;">Representás a ${escapeHtml(data.partyName || '')}.</p>

    <div class="card">
      <h2>Resumen</h2>
      <div class="eyebrow" style="margin-bottom:2px;">Estado</div>
      <div style="font-size:14px; font-weight:600;">${MEDIATION_STATUS_LABELS[data.mediationStatus] || data.mediationStatus}</div>
    </div>

    <div class="card">
      <h2>Audiencias</h2>
      ${data.hearings.length ? data.hearings.map(h => `
        <div class="item">
          <strong>${fmtDate(h.date)}${h.startTime ? ' ' + h.startTime : ''}</strong> — ${h.modality}
          ${h.location ? `<br><span style="color:var(--text-faint);">${escapeHtml(h.location)}</span>` : ''}
          ${h.meetingUrl ? `<br><a href="${escapeHtml(h.meetingUrl)}" style="color:var(--calm);" target="_blank">Link de la reunión</a>` : ''}
          <div style="margin-top:8px;">
            ${h.myResponse && h.myResponse !== 'pendiente'
              ? `<span class="pill calm">${CONFIRM_LABELS[h.myResponse] || h.myResponse}</span>`
              : `
                <button class="primary" onclick="confirmHearing('${mediationId}','${h.id}','confirma')">Confirmo</button>
                <button class="ghost" onclick="confirmHearing('${mediationId}','${h.id}','no_puede')">No puede</button>
                <button class="ghost" onclick="togglePideCambioForm('${h.id}')">Pedir cambio</button>
              `}
          </div>
          <div id="pide-cambio-${h.id}" style="display:none; margin-top:10px; background:var(--surface-2); border-radius:8px; padding:12px;">
            <label>¿Por qué necesitan cambiar la audiencia? (opcional)</label>
            <textarea id="pc-reason-${h.id}" rows="2"></textarea>
            <label>¿Qué día le vendría mejor a tu representado/a? (opcional)</label>
            <input id="pc-day-${h.id}" placeholder="Ej: un jueves">
            <label>¿Qué horario prefieren? (opcional)</label>
            <input id="pc-time-${h.id}" placeholder="Ej: por la tarde">
            <label>¿Tenés una fecha exacta que le venga mejor? (opcional)</label>
            <input id="pc-date-${h.id}" type="date">
            <label>Algo más que quieras agregar (opcional)</label>
            <textarea id="pc-comment-${h.id}" rows="2"></textarea>
            <div style="display:flex; gap:6px; margin-top:4px;">
              <button class="primary" style="flex:1;" onclick="submitPideCambio('${mediationId}','${h.id}')">Enviar pedido</button>
              <button class="ghost" onclick="togglePideCambioForm('${h.id}')">Cancelar</button>
            </div>
          </div>
          ${h.myRescheduleRequestStatus ? `<p class="empty-hint" style="margin-top:6px;">Estado de tu pedido de cambio: ${REQUEST_STATUS_LABELS[h.myRescheduleRequestStatus] || h.myRescheduleRequestStatus}</p>` : ''}
        </div>
      `).join('') : `<p class="empty-hint">No hay audiencias agendadas por ahora.</p>`}
    </div>

    <div class="card">
      <h2>Compromisos de tu representado/a</h2>
      ${data.commitments.length ? data.commitments.map(c => `
        <div class="item">
          ${escapeHtml(c.description)} ${c.dueDate ? `· vence ${fmtDate(c.dueDate)}` : ''}
          <br><span class="pill ${c.status === 'vencido' ? 'danger' : c.status === 'cumplido' ? 'calm' : 'warn'}">${COMMITMENT_STATUS_LABELS[c.status]}</span>
        </div>
      `).join('') : `<p class="empty-hint">No hay compromisos cargados.</p>`}
    </div>

    <div class="card">
      <h2>Documentos</h2>
      ${data.documents.length ? data.documents.map(d => `
        <div class="item" style="display:flex; justify-content:space-between; align-items:center;">
          <div>${escapeHtml(d.originalFilename)}<br><span style="color:var(--text-faint);">${fmtFileSize(d.size)}</span></div>
          <a href="/api/lawyer-portal/${token}/mediations/${mediationId}/documents/${d.id}/download" class="ghost" style="text-decoration:none; padding:8px 14px; color:var(--text);">Descargar</a>
        </div>
      `).join('') : `<p class="empty-hint">No hay documentos todavía.</p>`}
      ${data.allowDocumentUpload ? `
        <div style="margin-top:10px;">
          <input id="doc-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx">
          <button class="primary" onclick="uploadDocument('${mediationId}')" id="doc-upload-btn" style="margin-top:8px;">Subir documento</button>
        </div>
      ` : `<p class="empty-hint" style="margin-top:8px;">El mediador/a todavía no habilitó la carga de documentos para esta parte.</p>`}
    </div>

    <div class="card">
      <h2>Conversación de tu representado/a</h2>
      <p class="empty-hint" style="margin-top:-4px; margin-bottom:8px;">Lo que tu representado/a habló con el mediador/a — de solo lectura.</p>
      <div id="messages-box"></div>
    </div>

    <div class="card">
      <h2>Tu conversación con el mediador/a</h2>
      <p class="empty-hint" style="margin-top:-4px; margin-bottom:8px;">Esta es tuya, en tu propio nombre — el mediador/a te responde acá, no a través de tu representado/a.</p>
      <div id="lawyer-messages-box"></div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        <input id="lawyer-chat-input" placeholder="Escribí un mensaje…" style="flex:1; margin:0;" onkeyup="if(event.key==='Enter') sendLawyerMessage('${mediationId}')">
        <button class="primary" onclick="sendLawyerMessage('${mediationId}')">Enviar</button>
      </div>
    </div>

    <div class="card">
      <h2>Eventos visibles</h2>
      ${data.timeline.length ? data.timeline.map(e => `
        <div class="item">
          <strong>${EVENT_TYPE_LABELS[e.type] || e.type}</strong>${e.title ? ': ' + escapeHtml(e.title) : ''}
          <br><span style="color:var(--text-faint); font-size:11px;">${fmtDateTime(e.createdAt)}</span>
        </div>
      `).join('') : `<p class="empty-hint">Sin actividad todavía.</p>`}
    </div>
  `;
  loadMessages(mediationId);
  loadLawyerMessages(mediationId);
}

async function loadMessages(mediationId){
  const box = document.getElementById('messages-box');
  if(!box) return;
  let messages;
  try{ messages = await api(`/api/lawyer-portal/${token}/mediations/${mediationId}/messages`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudieron cargar las comunicaciones.</p>`; return; }
  box.innerHTML = messages.length ? messages.map(m => `
    <div class="item" style="${m.fromParty ? 'text-align:right;' : ''}">
      <span style="background:${m.fromParty ? 'var(--calm-dim)' : 'var(--surface-2)'}; color:${m.fromParty ? 'var(--calm)' : 'var(--text)'}; padding:6px 10px; border-radius:8px; display:inline-block; font-size:12.5px;">
        ${escapeHtml(m.text)}
        ${m.document ? `<br><a href="/api/lawyer-portal/${token}/mediations/${mediationId}/documents/${m.document.id}/download" style="color:inherit; text-decoration:underline; font-size:11.5px;">📎 ${escapeHtml(m.document.originalFilename)}</a>` : ''}
      </span>
    </div>
  `).join('') : `<p class="empty-hint">No hay comunicaciones todavía.</p>`;
}

// Bloque 19 — hilo propio del abogado, distinto del de arriba (esa es
// la conversación de SU representado/a, de solo lectura; esta es la
// suya, de ida y vuelta).
async function loadLawyerMessages(mediationId){
  const box = document.getElementById('lawyer-messages-box');
  if(!box) return;
  let messages;
  try{ messages = await api(`/api/lawyer-portal/${token}/mediations/${mediationId}/lawyer-messages`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudo cargar la conversación.</p>`; return; }
  box.innerHTML = messages.length ? messages.map(m => `
    <div class="item" style="${m.mine ? 'text-align:right;' : ''}">
      <span style="background:${m.mine ? 'var(--calm-dim)' : 'var(--surface-2)'}; color:${m.mine ? 'var(--calm)' : 'var(--text)'}; padding:6px 10px; border-radius:8px; display:inline-block; font-size:12.5px;">
        ${escapeHtml(m.text)}
        ${m.document ? `<br><a href="/api/lawyer-portal/${token}/mediations/${mediationId}/documents/${m.document.id}/download" style="color:inherit; text-decoration:underline; font-size:11.5px;">📎 ${escapeHtml(m.document.originalFilename)}</a>` : ''}
      </span>
    </div>
  `).join('') : `<p class="empty-hint">Todavía no hay mensajes.</p>`;
  box.scrollTop = box.scrollHeight;
}

async function sendLawyerMessage(mediationId){
  const input = document.getElementById('lawyer-chat-input');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  try{
    await api(`/api/lawyer-portal/${token}/mediations/${mediationId}/lawyer-messages`, { method:'POST', body: JSON.stringify({ text }) });
    await loadLawyerMessages(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo enviar el mensaje.', 'danger'); }
}

async function confirmHearing(mediationId, hearingId, response){
  try{
    await api(`/api/lawyer-portal/${token}/mediations/${mediationId}/hearings/${hearingId}/confirm`, { method:'POST', body: JSON.stringify({ response }) });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo registrar la respuesta.', 'danger'); }
}

function togglePideCambioForm(hearingId){
  const box = document.getElementById(`pide-cambio-${hearingId}`);
  if(!box) return;
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
}

async function submitPideCambio(mediationId, hearingId){
  const body = {
    response: 'pide_cambio',
    reason: document.getElementById(`pc-reason-${hearingId}`).value.trim() || null,
    preferredDayText: document.getElementById(`pc-day-${hearingId}`).value.trim() || null,
    preferredTimeText: document.getElementById(`pc-time-${hearingId}`).value.trim() || null,
    comment: document.getElementById(`pc-comment-${hearingId}`).value.trim() || null,
  };
  const proposedDate = document.getElementById(`pc-date-${hearingId}`).value;
  if(proposedDate) body.proposedDate = proposedDate;
  try{
    await api(`/api/lawyer-portal/${token}/mediations/${mediationId}/hearings/${hearingId}/confirm`, { method:'POST', body: JSON.stringify(body) });
    renderDetail(mediationId);
  }catch(e){ showToast(e.error || 'No se pudo registrar el pedido.', 'danger'); }
}

async function uploadDocument(mediationId){
  const file = document.getElementById('doc-file').files[0];
  if(!file){ showToast('Elegí un archivo primero.', 'danger'); return; }
  const btn = document.getElementById('doc-upload-btn');
  btn.disabled = true; btn.textContent = 'Subiendo…';
  const formData = new FormData();
  formData.append('file', file);
  try{
    const res = await fetch(`/api/lawyer-portal/${token}/mediations/${mediationId}/documents`, { method:'POST', body: formData });
    const data = await res.json();
    if(!res.ok) throw data;
    renderDetail(mediationId);
  }catch(e){
    showToast(e.error || 'No se pudo subir el archivo.', 'danger');
    btn.disabled = false; btn.textContent = 'Subir documento';
  }
}
