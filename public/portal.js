// public/portal.js — Bloque 7. Página separada, sin login, token en la URL.

const token = new URLSearchParams(location.search).get('token');

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('es-AR');
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

// Bloque 26 — mismo cálculo que public/mediador.js (ver el comentario ahí):
// en vivo, a partir de los hearings que ya trae este portal, nunca un
// endpoint nuevo. Lo que el portal ya puede ver en `data.hearings` es
// exactamente lo que puede ver acá — no se agrega ninguna decisión de
// acceso nueva.
function findActiveHearingForBanner(hearings){
  if(!hearings || !hearings.length) return null;
  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0,10);
  for(const h of hearings){
    if(h.date !== todayStr) continue;
    if(!h.meetingUrl) continue;
    if(h.modality !== 'virtual' && h.modality !== 'hibrida') continue;
    if(!h.startTime) continue;
    const startMs = new Date(`${h.date}T${h.startTime}`).getTime();
    if(isNaN(startMs)) continue;
    let durationMs = 60*60*1000;
    if(h.endTime){
      const endMs = new Date(`${h.date}T${h.endTime}`).getTime();
      if(!isNaN(endMs) && endMs > startMs) durationMs = endMs - startMs;
    }
    if(now >= startMs - 30*60*1000 && now <= startMs + durationMs) return h;
  }
  return null;
}
function renderHearingBanner(codeOrObject, hearings){
  const h = findActiveHearingForBanner(hearings);
  if(!h) return '';
  return `
    <div class="card" style="background:var(--calm-dim, var(--surface-2)); margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
      <div>Audiencia con <strong>${escapeHtml(codeOrObject)}</strong> — hoy a las ${escapeHtml(h.startTime)}</div>
      <a href="${escapeHtml(h.meetingUrl)}" target="_blank" class="primary" style="text-decoration:none; padding:8px 16px; flex-shrink:0;">Entrar a la audiencia</a>
    </div>
  `;
}

// Bloque 20 §13 — mismo helper que public/mediador.js, para no interrumpir
// con alert() los flujos normales del portal.
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

const CONFIRM_LABELS = { confirma:'Confirmaste', no_puede:'Avisaste que no podés', pide_cambio:'Pediste un cambio' };
const REQUEST_STATUS_LABELS = { pendiente:'Esperando respuesta del mediador/a', aceptada:'Aceptado — la audiencia se reprogramó', rechazada:'No se pudo hacer el cambio', resuelta:'Resuelto sin cambio' };
const MEDIATION_STATUS_LABELS = {
  borrador:'Recién iniciada', iniciada:'Iniciada', contactando_partes:'Contactando a las partes',
  notificaciones:'En notificaciones', audiencia_programada:'Audiencia programada', en_mediacion:'En mediación',
  acuerdo:'Con acuerdo', acuerdo_parcial:'Con acuerdo parcial', sin_acuerdo:'Sin acuerdo',
  incomparecencia:'Incomparecencia', cerrada:'Cerrada',
};
const COMMITMENT_STATUS_LABELS = { pendiente:'Pendiente', cumplido:'Cumplido', vencido:'Vencido', cancelado:'Cancelado' };

(async function boot(){
  const main = document.getElementById('main');
  if(!token){ main.innerHTML = `<p class="empty-hint" style="padding:20px;">Falta el enlace. Pedile a tu mediador/a que te reenvíe la invitación.</p>`; return; }
  await render();
})();

async function render(){
  const main = document.getElementById('main');
  let data;
  try{ data = await api(`/api/party-portal/${token}`); }
  catch(e){ main.innerHTML = `<p class="empty-hint" style="padding:20px;">${escapeHtml(e.error || 'No se pudo cargar tu mediación.')}</p>`; return; }

  main.innerHTML = `
    <div class="eyebrow">${escapeHtml(data.mediationCode)}</div>
    <h1>${escapeHtml(data.mediationObject)}</h1>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:18px;">Hola, ${escapeHtml(data.partyName || '')}.</p>

    <div class="card">
      <div class="eyebrow" style="margin-bottom:2px;">Estado</div>
      <div style="font-size:14px; font-weight:600; margin-bottom:12px;">${MEDIATION_STATUS_LABELS[data.mediationStatus] || data.mediationStatus}</div>
      <div class="eyebrow" style="margin-bottom:2px;">Pendiente</div>
      <div style="font-size:14px; font-weight:600; color:${data.pendiente ? 'var(--warn)' : 'var(--calm)'};">${data.pendiente ? escapeHtml(data.pendiente) : 'Nada pendiente de tu parte ahora mismo'}</div>
    </div>

    <div class="card">
      <h2>Audiencias</h2>
      ${data.hearings.length ? data.hearings.map(h => `
        <div class="item">
          <strong>${fmtDate(h.date)}${h.startTime ? ' ' + h.startTime : ''}</strong>
          ${h.location ? `<br><span style="color:var(--text-faint);">${escapeHtml(h.location)}</span>` : ''}
          ${h.meetingUrl ? `<br><a href="${escapeHtml(h.meetingUrl)}" style="color:var(--calm);" target="_blank">Link de la reunión</a>` : ''}
          <div style="margin-top:8px;">
            ${h.myResponse && h.myResponse !== 'pendiente'
              ? `<span class="pill calm">${CONFIRM_LABELS[h.myResponse] || h.myResponse}</span>`
              : `
                <button class="primary" onclick="confirmHearing('${h.id}','confirma')">Confirmo</button>
                <button class="ghost" onclick="confirmHearing('${h.id}','no_puede')">No puedo</button>
                <button class="ghost" onclick="togglePideCambioForm('${h.id}')">Pedir cambio</button>
              `}
          </div>
          <div id="pide-cambio-${h.id}" style="display:none; margin-top:10px; background:var(--surface-2); border-radius:8px; padding:12px;">
            <label>¿Por qué necesitás cambiar la audiencia? (opcional)</label>
            <textarea id="pc-reason-${h.id}" rows="2" placeholder="Ej: tengo un turno médico ese día"></textarea>
            <label>¿Qué día te vendría mejor? (opcional)</label>
            <input id="pc-day-${h.id}" placeholder="Ej: un jueves, después del 20">
            <label>¿Qué horario preferís? (opcional)</label>
            <input id="pc-time-${h.id}" placeholder="Ej: por la tarde">
            <label>¿Tenés una fecha exacta que te venga mejor? (opcional)</label>
            <input id="pc-date-${h.id}" type="date">
            <label>Algo más que quieras agregar (opcional)</label>
            <textarea id="pc-comment-${h.id}" rows="2"></textarea>
            <div style="display:flex; gap:6px; margin-top:4px;">
              <button class="primary" style="flex:1;" onclick="submitPideCambio('${h.id}')">Enviar pedido</button>
              <button class="ghost" onclick="togglePideCambioForm('${h.id}')">Cancelar</button>
            </div>
          </div>
          ${h.myRescheduleRequestStatus ? `<p class="empty-hint" style="margin-top:6px;">Tu pedido de cambio: ${REQUEST_STATUS_LABELS[h.myRescheduleRequestStatus] || h.myRescheduleRequestStatus}</p>` : ''}
        </div>
      `).join('') : `<p class="empty-hint">No hay audiencias agendadas por ahora.</p>`}
    </div>

    <div class="card">
      <h2>Tus compromisos</h2>
      ${data.commitments.length ? data.commitments.map(c => `
        <div class="item">
          ${escapeHtml(c.description)} ${c.dueDate ? `· vence ${fmtDate(c.dueDate)}` : ''}
          <br><span class="pill ${c.status === 'vencido' ? 'danger' : c.status === 'cumplido' ? 'calm' : 'warn'}">${COMMITMENT_STATUS_LABELS[c.status]}</span>
        </div>
      `).join('') : `<p class="empty-hint">No tenés compromisos cargados.</p>`}
    </div>

    <div class="card">
      <h2>Documentos</h2>
      ${data.documents.length ? data.documents.map(d => `
        <div class="item" style="display:flex; justify-content:space-between; align-items:center;">
          <div>${escapeHtml(d.originalFilename)}<br><span style="color:var(--text-faint);">${fmtFileSize(d.size)}</span></div>
          <a href="/api/party-portal/${token}/documents/${d.id}/download" class="ghost" style="text-decoration:none; padding:8px 14px; color:var(--text);">Descargar</a>
        </div>
      `).join('') : `<p class="empty-hint">No hay documentos todavía.</p>`}
      ${data.allowDocumentUpload ? `
        <div style="margin-top:10px;">
          <input id="doc-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx">
          <button class="primary" onclick="uploadDocument()" id="doc-upload-btn" style="margin-top:8px;">Subir documento</button>
        </div>
      ` : `<p class="empty-hint" style="margin-top:8px;">Tu mediador/a todavía no habilitó la carga de documentos para vos.</p>`}
    </div>

    ${renderHearingBanner(data.mediationCode, data.hearings)}

    <div class="card">
      <h2>Mensajes con tu mediador/a</h2>
      <div id="chat-box"></div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        <input id="chat-input" placeholder="Escribí un mensaje…" style="flex:1; margin:0;">
        <button class="primary" onclick="sendMessage()">Enviar</button>
      </div>
    </div>
  `;
  loadChat();
}

async function loadChat(){
  const box = document.getElementById('chat-box');
  if(!box) return;
  let messages;
  try{ messages = await api(`/api/party-portal/${token}/messages`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudo cargar el chat.</p>`; return; }
  box.innerHTML = messages.length ? messages.map(m => `
    <div class="item" style="${m.mine ? 'text-align:right;' : ''}">
      <span style="background:${m.mine ? 'var(--calm-dim)' : 'var(--surface-2)'}; color:${m.mine ? 'var(--calm)' : 'var(--text)'}; padding:6px 10px; border-radius:8px; display:inline-block; font-size:12.5px;">
        ${escapeHtml(m.text)}
        ${m.document ? `<br><a href="/api/party-portal/${token}/documents/${m.document.id}/download" style="color:inherit; text-decoration:underline; font-size:11.5px;">📎 ${escapeHtml(m.document.originalFilename)}</a>` : ''}
      </span>
    </div>
  `).join('') : `<p class="empty-hint">Todavía no hay mensajes.</p>`;
  box.scrollTop = box.scrollHeight;
}

async function sendMessage(){
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  try{
    await api(`/api/party-portal/${token}/messages`, { method:'POST', body: JSON.stringify({ text }) });
    await loadChat();
  }catch(e){ showToast(e.error || 'No se pudo enviar el mensaje.', 'danger'); }
}

async function confirmHearing(hearingId, response){
  try{
    await api(`/api/party-portal/${token}/hearings/${hearingId}/confirm`, { method:'POST', body: JSON.stringify({ response }) });
    render();
  }catch(e){ showToast(e.error || 'No se pudo registrar tu respuesta.', 'danger'); }
}

function togglePideCambioForm(hearingId){
  const box = document.getElementById(`pide-cambio-${hearingId}`);
  if(!box) return;
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
}

async function submitPideCambio(hearingId){
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
    await api(`/api/party-portal/${token}/hearings/${hearingId}/confirm`, { method:'POST', body: JSON.stringify(body) });
    render();
  }catch(e){ showToast(e.error || 'No se pudo registrar tu pedido.', 'danger'); }
}

async function uploadDocument(){
  const file = document.getElementById('doc-file').files[0];
  if(!file){ showToast('Elegí un archivo primero.', 'danger'); return; }
  const btn = document.getElementById('doc-upload-btn');
  btn.disabled = true; btn.textContent = 'Subiendo…';
  const formData = new FormData();
  formData.append('file', file);
  try{
    const res = await fetch(`/api/party-portal/${token}/documents`, { method:'POST', body: formData });
    const data = await res.json();
    if(!res.ok) throw data;
    render();
  }catch(e){
    showToast(e.error || 'No se pudo subir el archivo.', 'danger');
    btn.disabled = false; btn.textContent = 'Subir documento';
  }
}
