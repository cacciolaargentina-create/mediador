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
async function buildCertifiedReport({ channel, messages, events, nameOf, generatedBy, verifyUrl, rangeLabel, signature, publicKeyFingerprint }) {
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
    }

    doc.end();
  });
}

module.exports = { buildCertifiedReport, integrityHash, buildPlainContent };
