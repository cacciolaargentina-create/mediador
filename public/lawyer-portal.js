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

const CONFIRM_LABELS = { confirma:'Confirmó', no_puede:'Avisó que no puede', pide_cambio:'Pidió un cambio' };
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
                <button class="ghost" onclick="confirmHearing('${mediationId}','${h.id}','pide_cambio')">Pedir cambio</button>
              `}
          </div>
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
      <h2>Comunicaciones</h2>
      <div id="messages-box"></div>
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
}

async function loadMessages(mediationId){
  const box = document.getElementById('messages-box');
  if(!box) return;
  let messages;
  try{ messages = await api(`/api/lawyer-portal/${token}/mediations/${mediationId}/messages`); }
  catch(e){ box.innerHTML = `<p class="empty-hint">No se pudieron cargar las comunicaciones.</p>`; return; }
  box.innerHTML = messages.length ? messages.map(m => `
    <div class="item" style="${m.fromParty ? 'text-align:right;' : ''}">
      <span style="background:${m.fromParty ? 'var(--calm-dim)' : 'var(--surface-2)'}; color:${m.fromParty ? 'var(--calm)' : 'var(--text)'}; padding:6px 10px; border-radius:8px; display:inline-block; font-size:12.5px;">${escapeHtml(m.text)}</span>
    </div>
  `).join('') : `<p class="empty-hint">No hay comunicaciones todavía.</p>`;
}

async function confirmHearing(mediationId, hearingId, response){
  const body = { response };
  if(response === 'pide_cambio'){
    body.reason = prompt('¿Por qué necesitás cambiar la audiencia? (opcional)') || null;
    const proposedDate = prompt('¿Tenés una fecha que le venga mejor a tu representado/a? (opcional, formato AAAA-MM-DD)');
    if(proposedDate) body.proposedDate = proposedDate;
  }
  try{
    await api(`/api/lawyer-portal/${token}/mediations/${mediationId}/hearings/${hearingId}/confirm`, { method:'POST', body: JSON.stringify(body) });
    renderDetail(mediationId);
  }catch(e){ alert(e.error || 'No se pudo registrar la respuesta.'); }
}

async function uploadDocument(mediationId){
  const file = document.getElementById('doc-file').files[0];
  if(!file){ alert('Elegí un archivo primero.'); return; }
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
    alert(e.error || 'No se pudo subir el archivo.');
    btn.disabled = false; btn.textContent = 'Subir documento';
  }
}
