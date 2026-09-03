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
    lines.push(`[${fmt(m.createdAt)}] ${who}: ${m.text}${m.flagged ? '  (marcado por IA)' : ''}`);
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
async function buildCertifiedReport({ channel, messages, events, nameOf, generatedBy, verifyUrl, rangeLabel }) {
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

    doc.fontSize(10).fillColor('#000');
    doc.font('Helvetica-Bold').text('Código de canal: ', { continued: true }).font('Helvetica').text(channel.code);
    doc.font('Helvetica-Bold').text('Período: ', { continued: true }).font('Helvetica').text(rangeLabel || 'historial completo');
    doc.font('Helvetica-Bold').text('Generado: ', { continued: true }).font('Helvetica').text(now.toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' }));
    if (generatedBy) {
      doc.font('Helvetica-Bold').text('Generado por: ', { continued: true }).font('Helvetica').text(`${generatedBy.name}${generatedBy.role ? ' (' + generatedBy.role + ')' : ''}`);
    }
    doc.moveDown(1);

    // ---- mensajes ----
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1a2e').text('Mensajes');
    doc.moveDown(0.3);
    doc.fontSize(9.5).font('Helvetica').fillColor('#000');
    messages.forEach((m) => {
      const who = m.senderId ? nameOf(m.senderId) : m.pattern ? 'ALERTA DE PATRÓN' : 'SISTEMA';
      const tag = m.flagged ? '  [intervención de IA]' : '';
      doc.font('Helvetica-Bold').text(`[${fmt(m.createdAt)}] ${who}${tag}`, { continued: false });
      doc.font('Helvetica').text(m.text);
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
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 60;
      doc.fontSize(7.5).fillColor('#777').font('Helvetica');
      doc.text(
        'Documento generado automáticamente por Puente Digital a partir del registro digital del canal. ' +
        'No constituye una certificación notarial ni pericial, pero es un registro fiel del contenido del canal al momento de su generación.',
        50, bottom, { width: 495, align: 'left' }
      );
      doc.text(`Hash de integridad (SHA-256): ${hash}`, 50, bottom + 20, { width: 495, align: 'left' });
    }

    doc.end();
  });
}

module.exports = { buildCertifiedReport, integrityHash, buildPlainContent };
