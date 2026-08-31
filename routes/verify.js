// routes/verify.js
// Página pública (sin login) a la que apunta el QR impreso en cada informe
// certificado — pensada para quien RECIBE el PDF fuera de la app (un
// juzgado, la otra parte, un mediador presencial) y quiere confirmar que
// realmente salió de Puente Digital, sin tener que crear una cuenta.
// No expone contenido de mensajes: solo confirma la existencia del export
// (código de canal, quién lo generó y cuándo) tal como ya figura impreso en
// el propio PDF.

const express = require('express');
const { getDB } = require('../db');

const router = express.Router();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmt(ts) {
  return new Date(ts).toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' });
}

function page({ title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root{ --bg:#0E1A19; --surface:#152625; --surface-2:#1C332F; --text:#EAF3F1; --text-dim:#9FB8B3;
         --calm:#5FA8A0; --calm-dim:#3E6E69; --warn:#D98C4A; --warn-dim:#5A4327; --danger:#C4614A; --danger-dim:#4A2C23;
         --mono:'Courier New', monospace; --sans:-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .card{ max-width:480px; width:100%; background:var(--surface); border:1px solid var(--calm-dim); border-radius:14px; padding:28px 26px; }
  .brand{ font-size:14px; font-weight:700; letter-spacing:0.02em; color:var(--text); margin-bottom:2px; }
  .brand em{ font-style:italic; color:var(--calm); font-weight:500; }
  .icon{ font-size:36px; margin-bottom:6px; }
  h1{ font-size:19px; margin:0 0 10px; }
  p{ font-size:13.5px; color:var(--text-dim); line-height:1.5; margin:0 0 10px; }
  .details{ background:var(--surface-2); border:1px solid var(--calm-dim); border-radius:9px; padding:12px 14px; margin:16px 0; font-size:12.5px; }
  .details div{ margin-bottom:5px; }
  .details b{ color:var(--text); }
  .hash{ font-family:var(--mono); font-size:10.5px; word-break:break-all; color:var(--text-dim); background:var(--surface-2); border-radius:6px; padding:8px 10px; margin-top:10px; }
  .ok{ color:var(--calm); }
  .warn{ color:var(--warn); }
  .disclaimer{ font-size:11px; color:var(--text-dim); border-top:1px solid var(--calm-dim); padding-top:12px; margin-top:16px; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">Puente <em>Digital</em></div>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

router.get('/:hash', (req, res) => {
  const db = getDB();
  const hash = req.params.hash.trim();
  const record = db.certifiedExports.find((e) => e.hash === hash);

  if (!record) {
    return res.status(404).send(page({
      title: 'No se pudo verificar — Puente Digital',
      bodyHtml: `
        <div class="icon">⚠️</div>
        <h1 class="warn">No pudimos verificar este documento</h1>
        <p>Este código no corresponde a ningún informe certificado generado por Puente Digital. Puede que el enlace esté mal escrito o que el documento no haya sido generado por esta plataforma.</p>
        <div class="hash">${escapeHtml(hash)}</div>
      `,
    }));
  }

  res.send(page({
    title: 'Documento auténtico — Puente Digital',
    bodyHtml: `
      <div class="icon">✅</div>
      <h1 class="ok">Documento auténtico</h1>
      <p>Este informe fue generado y certificado por Puente Digital.</p>
      <div class="details">
        <div><b>Caso:</b> ${escapeHtml(record.channelCode)}</div>
        <div><b>Generado el:</b> ${escapeHtml(fmt(record.createdAt))}</div>
        ${record.generatedByName ? `<div><b>Generado por:</b> ${escapeHtml(record.generatedByName)}${record.generatedByRole ? ' (' + escapeHtml(record.generatedByRole) + ')' : ''}</div>` : ''}
      </div>
      <div class="hash">Hash de integridad (SHA-256):<br>${escapeHtml(record.hash)}</div>
      <p class="disclaimer">Esta página solo confirma que el hash de integridad fue emitido por Puente Digital para el caso indicado. No es una certificación notarial ni pericial, y no muestra el contenido de la conversación.</p>
    `,
  }));
});

module.exports = router;
