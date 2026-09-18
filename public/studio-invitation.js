const token = new URLSearchParams(location.search).get('token');

async function api(path, opts = {}){
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials:'same-origin', ...opts });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw data;
  return data;
}

(async function boot(){
  const main = document.getElementById('main');
  if(!token){ main.innerHTML = `<h1>Enlace inválido</h1><p>Falta el token de invitación.</p>`; return; }

  let invitation;
  try{ invitation = await api(`/api/studios/invitations/${token}`); }
  catch(e){ main.innerHTML = `<h1>Enlace inválido</h1><p>${e.error || 'Esta invitación no existe o ya venció.'}</p>`; return; }

  if(invitation.status !== 'pendiente'){
    main.innerHTML = `<h1>Invitación ya resuelta</h1><p>Esta invitación ya fue ${invitation.status}.</p>`;
    return;
  }

  let me;
  try{ me = await api('/auth/me'); }catch(e){ me = null; }

  if(!me){
    main.innerHTML = `
      <h1>Te invitaron a ${escapeHtml(invitation.studioName || 'un estudio')}</h1>
      <p>Como ${escapeHtml(invitation.role)}. Iniciá sesión con <strong>${escapeHtml(invitation.email)}</strong> para aceptar.</p>
      <button class="primary" onclick="location.href='/auth/google?next=/studio-invitation.html?token=${token}'">Continuar con Google</button>
    `;
    return;
  }

  if((me.email || '').toLowerCase() !== invitation.email){
    main.innerHTML = `
      <h1>Cuenta incorrecta</h1>
      <p>Esta invitación es para <strong>${escapeHtml(invitation.email)}</strong>, pero iniciaste sesión como ${escapeHtml(me.email)}.</p>
    `;
    return;
  }

  main.innerHTML = `
    <h1>Te invitaron a ${escapeHtml(invitation.studioName || 'un estudio')}</h1>
    <p>Como ${escapeHtml(invitation.role)}.</p>
    <button class="primary" onclick="acceptInvitation()">Aceptar</button>
    <button class="ghost" onclick="rejectInvitation()">Rechazar</button>
  `;
})();

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function acceptInvitation(){
  try{
    await api(`/api/studios/invitations/${token}/accept`, { method:'POST' });
    document.getElementById('main').innerHTML = `<h1>¡Listo!</h1><p>Ya sos parte del estudio.</p><button class="primary" onclick="location.href='/'">Ir a Mediador</button>`;
  }catch(e){ alert(e.error || 'No se pudo aceptar la invitación.'); }
}

async function rejectInvitation(){
  try{
    await api(`/api/studios/invitations/${token}/reject`, { method:'POST' });
    document.getElementById('main').innerHTML = `<h1>Invitación rechazada</h1>`;
  }catch(e){ alert(e.error || 'No se pudo rechazar la invitación.'); }
}
