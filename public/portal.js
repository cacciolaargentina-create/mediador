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

const CONFIRM_LABELS = { confirma:'Confirmaste', no_puede:'Avisaste que no podés', pide_cambio:'Pediste un cambio' };
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
                <button class="ghost" onclick="confirmHearing('${h.id}','pide_cambio')">Pedir cambio</button>
              `}
          </div>
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
      <span style="background:${m.mine ? 'var(--calm-dim)' : 'var(--surface-2)'}; color:${m.mine ? 'var(--calm)' : 'var(--text)'}; padding:6px 10px; border-radius:8px; display:inline-block; font-size:12.5px;">${escapeHtml(m.text)}</span>
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
  }catch(e){ alert(e.error || 'No se pudo enviar el mensaje.'); }
}

async function confirmHearing(hearingId, response){
  const body = { response };
  if(response === 'pide_cambio'){
    body.reason = prompt('¿Por qué necesitás cambiar la audiencia? (opcional)') || null;
    const proposedDate = prompt('¿Tenés una fecha que te venga mejor? (opcional, formato AAAA-MM-DD)');
    if(proposedDate) body.proposedDate = proposedDate;
  }
  try{
    await api(`/api/party-portal/${token}/hearings/${hearingId}/confirm`, { method:'POST', body: JSON.stringify(body) });
    render();
  }catch(e){ alert(e.error || 'No se pudo registrar tu respuesta.'); }
}

async function uploadDocument(){
  const file = document.getElementById('doc-file').files[0];
  if(!file){ alert('Elegí un archivo primero.'); return; }
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
    alert(e.error || 'No se pudo subir el archivo.');
    btn.disabled = false; btn.textContent = 'Subir documento';
  }
}
