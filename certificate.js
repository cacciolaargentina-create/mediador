// certificate.js
// Genera el informe exportable en PDF con membrete, fecha y hash de
// integridad — pensado para que un mediador/a o estudio jurídico pueda
// llevar la conversación certificada a otro ámbito (juzgado, mediación
// presencial, etc.). No es una certificación notarial: es un registro
// digital fiel del canal, con un hash verificable del contenido en el
// momento de generación, dicho con esas palabras en el propio documento.

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

function fmt(ts) {
  return new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

// el informe deja constancia de que hubo un adjunto (nombre y tipo), pero
// no incrusta la imagen/PDF en sí — este documento es un registro de TEXTO
// de la conversación, no un contenedor de archivos.
function attachmentNote(m) {
  if (!m.attachment) return '';
  return ` [Adjunto: ${m.attachment.originalName || 'archivo'}]`;
}

// mismo contenido plano que el .txt existente — es la base sobre la que se
// calcula el hash de integridad, así el hash representa el contenido real
// del informe y no detalles de maquetado del PDF.
function buildPlainContent({ channel, messages, events, nameOf, rangeLabel }) {
  const lines = [];
  lines.push('INFORME — PUENTE DIGITAL');
  lines.push(`Código de canal: ${channel.code}`);
  lines.push(`Período: ${rangeLabel || 'historial completo'}`);
  lines.push('');
  lines.push('--- MENSAJES ---');
  messages.forEach((m) => {
    const who = m.senderId ? nameOf(m.senderId) : m.pattern ? 'ALERTA DE PATRON' : 'SISTEMA';
    lines.push(`[${fmt(m.createdAt)}] ${who}: ${m.text}${attachmentNote(m)}${m.flagged ? '  (marcado por IA)' : ''}`);
  });
  lines.push('');
  lines.push('--- CALENDARIO / ACUERDOS ---');
  events.forEach((e) => {
    lines.push(`${e.date} — ${e.detail} · pedido por ${nameOf(e.requestedBy)} · estado: ${e.status}`);
  });
  return lines.join('\n');
}

function integrityHash(plainContent) {
  return crypto.createHash('sha256').update(plainContent, 'utf-8').digest('hex');
}

// { channel, messages, events, nameOf, generatedBy: {name, role}, verifyUrl } -> Promise<Buffer>
// verifyUrl es opcional: si se pasa, se imprime un QR que lleva a una página
// pública (fuera de la app, sin login) que confirma que el documento salió
// de Puente Digital — pensado para cuando el PDF se lleva a un ámbito donde
// quien lo recibe no tiene cuenta ni contexto de la app.
async function buildCertifiedReport({ channel, messages, events, nameOf, generatedBy, verifyUrl, rangeLabel, signature, publicKeyFingerprint, legalCase }) {
  const plainContent = buildPlainContent({ channel, messages, events, nameOf, rangeLabel });
  const hash = integrityHash(plainContent);
  const now = new Date();

  const qrBuffer = verifyUrl
    ? await QRCode.toBuffer(verifyUrl, { type: 'png', width: 200, margin: 1, color: { dark: '#1a1a2e', light: '#ffffff' } })
    : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---- membrete ----
    // el QR va arriba, junto al membrete (no en el pie) — abajo del todo se
    // perdía entre el resto del texto del pie de página.
    const qrSize = 68;
    if (qrBuffer) {
      doc.image(qrBuffer, 545 - qrSize, 50, { width: qrSize, height: qrSize });
      doc.fontSize(6.5).fillColor('#777').font('Helvetica').text('Verificar autenticidad', 545 - qrSize - 8, 50 + qrSize + 2, { width: qrSize + 16, align: 'center' });
      // el .text() de arriba usa x,y absolutos (para caer justo debajo del
      // QR) y eso deja el cursor de pdfkit ahí — sin este reset, el resto
      // del membrete (título, subtítulo, etc., que sí fluyen con el cursor)
      // arrancaba desde esa posición y quedaba todo corrido a la derecha.
      doc.x = 50;
      doc.y = 50;
    }

    doc.fontSize(20).fillColor('#1a1a2e').font('Helvetica-Bold').text('PUENTE DIGITAL', { align: 'left' });
    doc.fontSize(11).fillColor('#555').font('Helvetica').text('Informe certificado de mediación digital', { align: 'left' });
    doc.moveDown(0.3);
    // el título+subtítulo son más bajos que el QR — si no se empuja el
    // cursor, la línea separadora de acá abajo pasaría por ARRIBA del QR
    // (dibujado antes) y quedaría como un tachado cruzándolo.
    if (qrBuffer) {
      const qrBottomY = 50 + qrSize + 16;
      if (doc.y < qrBottomY) doc.y = qrBottomY;
    }
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#1a1a2e').lineWidth(1.5).stroke();
    doc.moveDown(1);

    // ---- carátula (opcional — solo si se completó al exportar) ----
    // formato pensado para adjuntar directo a un escrito: juzgado,
    // expediente y carátula bien visibles arriba, antes que nada del
    // contenido del canal — es lo primero que alguien busca al mirar un
    // documento para saber a qué causa corresponde.
    if (legalCase) {
      doc.fontSize(9);
      // altura real de cada línea (heightOfString, no un número fijo a
      // ojo) — una carátula con varias partes puede envolver a 2-3 líneas
      // y un número fijo se hubiera quedado corto, cortando texto contra
      // el borde de la caja.
      const lineGap = 4;
      const fields = [
        legalCase.juzgado && { label: 'Juzgado: ', value: legalCase.juzgado },
        legalCase.expediente && { label: 'Expediente N°: ', value: legalCase.expediente },
        legalCase.caratula && { label: 'Carátula: ', value: legalCase.caratula },
      ].filter(Boolean);
      const lineHeights = fields.map((f) => doc.heightOfString(f.label + f.value, { width: 470 }));
      const boxHeight = lineHeights.reduce((sum, h) => sum + h + lineGap, 16);

      const boxTop = doc.y;
      doc.rect(50, boxTop, 495, boxHeight).fillColor('#f5f5f8').fill();
      doc.fillColor('#000');
      doc.y = boxTop + 8;
      fields.forEach((f) => {
        doc.x = 62;
        doc.font('Helvetica-Bold').text(f.label, { continued: true, width: 470 }).font('Helvetica').text(f.value, { width: 470 });
        doc.moveDown(0.15);
      });
      doc.x = 50;
      doc.y = boxTop + boxHeight;
      doc.moveDown(0.6);
    }

    doc.fontSize(10).fillColor('#000');
    doc.font('Helvetica-Bold').text('Código de canal: ', { continued: true }).font('Helvetica').text(channel.code);
    doc.font('Helvetica-Bold').text('Período: ', { continued: true }).font('Helvetica').text(rangeLabel || 'historial completo');
    doc.font('Helvetica-Bold').text('Generado: ', { continued: true }).font('Helvetica').text(now.toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' }));
    if (generatedBy) {
      doc.font('Helvetica-Bold').text('Generado por: ', { continued: true }).font('Helvetica').text(`${generatedBy.name}${generatedBy.role ? ' (' + generatedBy.role + ')' : ''}`);
    }
    doc.moveDown(1);

    // ---- firma electrónica (Ley 25.506 Art. 5 — no "firma digital") ----
    if (signature) {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1a1a2e').text('Firma electrónica');
      doc.font('Helvetica').fillColor('#555').fontSize(8).text(
        'Este documento está firmado electrónicamente con la clave privada de Puente Digital sobre el hash de integridad de abajo. No es firma digital en el sentido de la Ley 25.506 (sin certificador licenciado ni presunción legal automática), pero permite verificar de forma independiente que el documento salió de acá y no fue alterado.'
      );
      doc.moveDown(0.3);
      doc.font('Courier').fontSize(7).fillColor('#000').text(`Firma (base64): ${signature}`);
      if (publicKeyFingerprint) {
        doc.font('Courier').fontSize(7).text(`Clave pública (huella): ${publicKeyFingerprint}`);
      }
      doc.font('Helvetica').fontSize(8).fillColor('#555').text('Verificable en la página de verificación de este documento, con la firma y el hash de arriba.');
      doc.fillColor('#000');
      doc.moveDown(1);
    }

    // ---- mensajes ----
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1a2e').text('Mensajes');
    doc.moveDown(0.3);
    doc.fontSize(9.5).font('Helvetica').fillColor('#000');
    messages.forEach((m) => {
      const who = m.senderId ? nameOf(m.senderId) : m.pattern ? 'ALERTA DE PATRÓN' : 'SISTEMA';
      const tag = m.flagged ? '  [intervención de IA]' : '';
      doc.font('Helvetica-Bold').text(`[${fmt(m.createdAt)}] ${who}${tag}`, { continued: false });
      doc.font('Helvetica').text(m.text + attachmentNote(m));
      doc.moveDown(0.4);
    });

    doc.moveDown(0.5);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1a2e').text('Calendario y acuerdos');
    doc.moveDown(0.3);
    doc.fontSize(9.5).font('Helvetica').fillColor('#000');
    if (events.length === 0) {
      doc.text('Sin eventos registrados.');
    } else {
      events.forEach((e) => {
        doc.text(`${e.date} — ${e.detail} · pedido por ${nameOf(e.requestedBy)} · estado: ${e.status}`);
        doc.moveDown(0.2);
      });
    }

    // ---- pie legal + hash de integridad en cada página ----
    // antes era texto plano pegado al borde inferior, sin ninguna separación
    // del contenido — con una página corta quedaba mucho aire en blanco
    // arriba y el aviso legal se sentía como algo olvidado, no como parte
    // del diseño del documento. Ahora es un pie de página de verdad: línea
    // separadora, texto centrado en cursiva (registro legal, no cuerpo del
    // informe), y el hash en su propia línea monoespaciada abajo.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // el documento tiene margin:50 — todo el bloque del pie (línea +
      // aviso de 2 renglones + hash) tiene que terminar ANTES de esa
      // frontera. Si una parte cae dentro de la zona de margen, PDFKit
      // corta o pagina el texto en silencio, sin avisar del error.
      const bottom = doc.page.height - 95;
      doc.moveTo(50, bottom).lineTo(545, bottom).lineWidth(0.5).strokeColor('#ccc').stroke();
      doc.fontSize(7.5).fillColor('#777').font('Helvetica-Oblique');
      doc.text(
        'Documento generado automáticamente por Puente Digital a partir del registro digital del canal. ' +
        'No constituye una certificación notarial ni pericial, pero es un registro fiel del contenido del canal al momento de su generación.',
        50, bottom + 8, { width: 495, align: 'center' }
      );
      doc.fontSize(7).font('Courier').fillColor('#999')
        .text(`SHA-256: ${hash}`, 50, bottom + 34, { width: 495, align: 'center' });
      // foliado — solo tiene sentido para el formato de escrito judicial
      // (legalCase), donde la numeración de fojas es justamente lo que se
      // va a citar ("ver fs. 3"); en el informe normal sería ruido de más.
      if (legalCase) {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#555')
          .text(`Fs. ${i - range.start + 1}`, 495, bottom + 34, { width: 50, align: 'right' });
      }
    }

    doc.end();
  });
}

module.exports = { buildCertifiedReport, integrityHash, buildPlainContent, buildMediationPlainContent, buildMediationCertifiedPDF, buildMediationConstanciaPDF };

// ===== Bloque 8 de Mediador (B2B) — exportación certificada de una
// mediación completa. Reusa integrityHash/signHash/verificación pública
// tal cual (son genéricos) — lo que cambia es el CONTENIDO, porque una
// mediación no es un chat de dos personas, es datos generales + partes +
// abogados + audiencias + timeline + documentos + compromisos + resultado.

const STATUS_LABELS_ES = {
  borrador: 'Borrador', iniciada: 'Iniciada', contactando_partes: 'Contactando partes',
  notificaciones: 'Notificaciones', audiencia_programada: 'Audiencia programada',
  en_mediacion: 'En mediación', acuerdo: 'Acuerdo', acuerdo_parcial: 'Acuerdo parcial',
  sin_acuerdo: 'Sin acuerdo', incomparecencia: 'Incomparecencia', cerrada: 'Cerrada',
};

function partyLabel(p) {
  if (!p) return '—';
  return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || '—';
}

function buildMediationPlainContent({ mediation, parties, lawyers, hearings, documents, commitments, timeline }) {
  const lines = [];
  lines.push('INFORME DE MEDIACIÓN — MEDIADOR (Puente Digital)');
  lines.push(`Código: ${mediation.code}${mediation.internalNumber ? ' · N° interno: ' + mediation.internalNumber : ''}`);
  lines.push(`Objeto: ${mediation.object}`);
  lines.push(`Estado: ${STATUS_LABELS_ES[mediation.status] || mediation.status}`);
  if (mediation.closedAt) {
    lines.push(`Resultado de cierre: ${mediation.closedResult} — ${fmt(mediation.closedAt)}`);
  }
  lines.push('');
  lines.push('--- PARTES ---');
  parties.forEach((p) => {
    lines.push(`${partyLabel(p)} (${p.role})${p.documentNumber ? ' — ' + (p.documentType || 'Doc.') + ' ' + p.documentNumber : ''}`);
  });
  lines.push('');
  lines.push('--- ABOGADOS ---');
  lawyers.forEach((l) => {
    const party = parties.find((p) => p.id === l.partyId);
    lines.push(`${l.name}${l.enrollmentNumber ? ' — Mat. ' + l.enrollmentNumber : ''}${party ? ' (representa a ' + partyLabel(party) + ')' : ''}`);
  });
  lines.push('');
  lines.push('--- AUDIENCIAS ---');
  hearings.forEach((h) => {
    lines.push(`${h.date}${h.startTime ? ' ' + h.startTime : ''} — ${h.modality} — estado: ${h.status}`);
  });
  lines.push('');
  lines.push('--- DOCUMENTOS ---');
  documents.forEach((d) => {
    lines.push(`${d.originalFilename} (${d.type}) — ${fmt(d.createdAt)}`);
  });
  lines.push('');
  lines.push('--- COMPROMISOS ---');
  commitments.forEach((c) => {
    const party = parties.find((p) => p.id === c.partyId);
    lines.push(`${partyLabel(party)}: ${c.description}${c.dueDate ? ' — vence ' + c.dueDate : ''} — estado: ${c.status}`);
  });
  lines.push('');
  lines.push('--- TIMELINE ---');
  timeline.forEach((e) => {
    lines.push(`[${fmt(e.createdAt)}] ${e.type}${e.title ? ': ' + e.title : ''}`);
  });
  return lines.join('\n');
}

// PDF más simple que el del chat (sin carátula judicial ni foliado — eso
// es específico del uso en un escrito, acá no aplica todavía) pero con el
// mismo tratamiento de membrete + QR + firma electrónica, para que la
// identidad visual sea consistente entre los dos productos.
async function buildMediationCertifiedPDF({ mediation, parties, lawyers, hearings, documents, commitments, timeline, hash, signature, verifyUrl, generatedBy }) {
  const now = new Date();
  const qrBuffer = verifyUrl
    ? await QRCode.toBuffer(verifyUrl, { type: 'png', width: 200, margin: 1, color: { dark: '#1a1a2e', light: '#ffffff' } })
    : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const qrSize = 68;
    if (qrBuffer) {
      doc.image(qrBuffer, 545 - qrSize, 50, { width: qrSize, height: qrSize });
      doc.fontSize(6.5).fillColor('#777').font('Helvetica').text('Verificar autenticidad', 545 - qrSize - 8, 50 + qrSize + 2, { width: qrSize + 16, align: 'center' });
      doc.x = 50; doc.y = 50;
    }
    doc.fontSize(20).fillColor('#1a1a2e').font('Helvetica-Bold').text('MEDIADOR', { align: 'left' });
    doc.fontSize(11).fillColor('#555').font('Helvetica').text('Informe certificado de mediación', { align: 'left' });
    doc.moveDown(0.3);
    if (qrBuffer) { const qrBottomY = 50 + qrSize + 16; if (doc.y < qrBottomY) doc.y = qrBottomY; }
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#1a1a2e').lineWidth(1.5).stroke();
    doc.moveDown(1);

    doc.fontSize(10).fillColor('#000');
    doc.font('Helvetica-Bold').text('Mediación: ', { continued: true }).font('Helvetica').text(`${mediation.code} — ${mediation.object}`);
    doc.font('Helvetica-Bold').text('Estado: ', { continued: true }).font('Helvetica').text(STATUS_LABELS_ES[mediation.status] || mediation.status);
    doc.font('Helvetica-Bold').text('Generado: ', { continued: true }).font('Helvetica').text(now.toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' }));
    if (generatedBy) doc.font('Helvetica-Bold').text('Generado por: ', { continued: true }).font('Helvetica').text(generatedBy.name);
    doc.moveDown(1);

    function section(title, rows) {
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a2e').text(title);
      doc.moveDown(0.2);
      doc.fontSize(9).font('Helvetica').fillColor('#222');
      if (!rows.length) { doc.fillColor('#888').text('— sin datos —'); }
      rows.forEach((r) => doc.text(r));
      doc.moveDown(0.8);
    }

    section('Partes', parties.map((p) => `${partyLabel(p)} (${p.role})${p.documentNumber ? ' — ' + (p.documentType || 'Doc.') + ' ' + p.documentNumber : ''}`));
    section('Abogados', lawyers.map((l) => {
      const party = parties.find((p) => p.id === l.partyId);
      return `${l.name}${l.enrollmentNumber ? ' — Mat. ' + l.enrollmentNumber : ''}${party ? ' (representa a ' + partyLabel(party) + ')' : ''}`;
    }));
    section('Audiencias', hearings.map((h) => `${h.date}${h.startTime ? ' ' + h.startTime : ''} — ${h.modality} — ${h.status}`));
    section('Documentos', documents.map((d) => `${d.originalFilename} (${d.type}) — ${fmt(d.createdAt)}`));
    section('Compromisos', commitments.map((c) => {
      const party = parties.find((p) => p.id === c.partyId);
      return `${partyLabel(party)}: ${c.description}${c.dueDate ? ' — vence ' + c.dueDate : ''} — ${c.status}`;
    }));
    section('Timeline', timeline.map((e) => `[${fmt(e.createdAt)}] ${e.title || e.type}`));

    if (mediation.closedAt) {
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a2e').text('Cierre');
      doc.fontSize(9).font('Helvetica').fillColor('#222').text(`Resultado: ${mediation.closedResult} — ${fmt(mediation.closedAt)}`);
      if (mediation.closedNotes) doc.text(mediation.closedNotes);
      doc.moveDown(0.8);
    }

    // ---- firma electrónica — mismo texto/criterio que el informe de chat ----
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1a1a2e').text('Firma electrónica');
    doc.font('Helvetica').fillColor('#555').fontSize(8).text(
      signature
        ? 'Este documento está firmado electrónicamente con la clave privada de Puente Digital sobre el hash de integridad de abajo. No es firma digital en el sentido de la Ley 25.506 (sin certificador licenciado ni presunción legal automática), pero permite verificar de forma independiente que el documento salió de acá y no fue alterado.'
        : 'Este documento no incluye firma electrónica (clave de firma no configurada en el servidor) — el hash de integridad de abajo sigue siendo válido para detectar alteraciones.'
    );
    doc.moveDown(0.3);
    doc.fontSize(7.5).font('Courier').fillColor('#333').text(`SHA-256: ${hash}`);
    if (signature) doc.fontSize(7).font('Courier').fillColor('#555').text(`Firma: ${signature.slice(0, 60)}…`);

    doc.end();
  });
}

// Bloque 10 — constancia corta: una sola página, solo lo mínimo para
// PROBAR que la mediación se cerró y con qué resultado, no el expediente
// completo (eso sigue siendo buildMediationCertifiedPDF, sin tocar). Mismo
// hash+firma+QR — la única diferencia real es cuánto contenido entra.
async function buildMediationConstanciaPDF({ mediation, hash, signature, verifyUrl }) {
  const qrBuffer = verifyUrl
    ? await QRCode.toBuffer(verifyUrl, { type: 'png', width: 160, margin: 1, color: { dark: '#1a1a2e', light: '#ffffff' } })
    : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).fillColor('#1a1a2e').font('Helvetica-Bold').text('CONSTANCIA DE MEDIACIÓN', { align: 'center' });
    doc.moveDown(2);

    if (qrBuffer) {
      doc.image(qrBuffer, doc.page.width / 2 - 80, doc.y, { width: 160, height: 160 });
      doc.y += 170;
    }

    doc.fontSize(11).fillColor('#000').font('Helvetica');
    doc.text(' ', { align: 'center' });
    doc.font('Helvetica-Bold').fontSize(13).text(mediation.code, { align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(10).font('Helvetica').fillColor('#333').text(mediation.object, { align: 'center' });
    doc.moveDown(1);
    if (mediation.closedAt) {
      doc.font('Helvetica-Bold').text(`Resultado: ${mediation.closedResult}`, { align: 'center' });
      doc.font('Helvetica').text(`Cerrada el ${fmt(mediation.closedAt)}`, { align: 'center' });
    } else {
      doc.font('Helvetica').fillColor('#888').text('Mediación en curso — no cerrada', { align: 'center' });
    }
    doc.moveDown(2);

    doc.fontSize(7.5).font('Courier').fillColor('#555').text(`SHA-256: ${hash}`, { align: 'center' });
    if (signature) doc.fontSize(7).text(`Firma electrónica: ${signature.slice(0, 40)}…`, { align: 'center' });

    doc.end();
  });
}
