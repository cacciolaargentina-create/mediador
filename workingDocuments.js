// workingDocuments.js
// Bloque 22 (Parte 3) — documentos DE TRABAJO: borrador de acta de
// audiencia y carta de convocatoria. Deliberadamente separado de
// certificate.js — no comparten hash, firma, ni ningún dato de
// certified_exports. Un documento de acá NUNCA debe poder confundirse
// visualmente con el informe certificado: paleta ámbar/advertencia en
// vez del navy de certificate.js, y un banner de "BORRADOR" explícito
// en cada página.

const PDFDocument = require('pdfkit');

const STATUS_LABELS_ES = {
  programada: 'Programada', confirmada: 'Confirmada', realizada: 'Realizada',
  cancelada: 'Cancelada', no_realizada: 'No realizada', propuesta: 'Propuesta',
};
const CONFIRMATION_LABELS_ES = { confirma: 'Confirmó', no_puede: 'Avisó que no puede', pide_cambio: 'Pidió un cambio', pendiente: 'Pendiente' };
const MODALITY_LABELS_ES = { presencial: 'Presencial', virtual: 'Virtual', hibrida: 'Híbrida' };

function partyLabel(p) {
  return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Parte sin nombre';
}

// banner "BORRADOR" repetido en cada página — no es una marca de agua
// diagonal (más difícil de leer/imprimir bien en pdfkit sin líos de
// rotación), es una franja superior imposible de no ver.
function drawDraftBanner(doc) {
  const bandHeight = 22;
  doc.rect(0, 0, doc.page.width, bandHeight).fill('#FFF6DF');
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#8a5c14')
    .text('BORRADOR DE TRABAJO — NO ES UN DOCUMENTO CERTIFICADO', 0, 6, { width: doc.page.width, align: 'center' });
  doc.fillColor('#000');
}

function header(doc, title) {
  drawDraftBanner(doc);
  doc.y = 40;
  doc.fontSize(18).fillColor('#8a5c14').font('Helvetica-Bold').text('MEDIADOR', { align: 'left' });
  doc.fontSize(11).fillColor('#555').font('Helvetica').text(title, { align: 'left' });
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#D79B2B').lineWidth(1.2).stroke();
  doc.moveDown(1);
  doc.fillColor('#000');
}

function footer(doc) {
  // el documento tiene margin:50 (ver `new PDFDocument`) — si el pie cae
  // dentro de esa zona de margen, PDFKit lo pagina en silencio y aparece
  // una segunda página casi vacía. Mismo problema (y misma solución, con
  // el mismo comentario) que ya documentó certificate.js: el pie tiene
  // que terminar ANTES de doc.page.height - 50.
  const y = doc.page.height - 70;
  doc.fontSize(7.5).fillColor('#8A989A').font('Helvetica')
    .text('Generado por Mediador como documento de trabajo — no reemplaza la exportación certificada del expediente.', 50, y, { width: 495, align: 'center' });
}

// 3.1 — borrador de acta de audiencia. Fecha, partes, modalidad, y el
// estado de confirmación de cada una — a partir de datos ya cargados,
// nada de contenido generado.
async function buildDraftMinutesPDF({ mediation, hearing, parties, lawyers, confirmations }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    header(doc, 'Borrador de acta de audiencia');

    doc.fontSize(10).font('Helvetica-Bold').text('Mediación: ', { continued: true }).font('Helvetica').text(`${mediation.code} — ${mediation.object}`);
    doc.font('Helvetica-Bold').text('Fecha de audiencia: ', { continued: true }).font('Helvetica')
      .text(`${hearing.date}${hearing.startTime ? ' · ' + hearing.startTime : ''}`);
    doc.font('Helvetica-Bold').text('Modalidad: ', { continued: true }).font('Helvetica').text(MODALITY_LABELS_ES[hearing.modality] || hearing.modality);
    if (hearing.location) doc.font('Helvetica-Bold').text('Ubicación: ', { continued: true }).font('Helvetica').text(hearing.location);
    if (hearing.meetingUrl) doc.font('Helvetica-Bold').text('Link de reunión: ', { continued: true }).font('Helvetica').text(hearing.meetingUrl);
    doc.font('Helvetica-Bold').text('Estado de la audiencia: ', { continued: true }).font('Helvetica').text(STATUS_LABELS_ES[hearing.status] || hearing.status);
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica-Bold').fillColor('#8a5c14').text('Partes y confirmación');
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#222');
    if (parties.length === 0) doc.fillColor('#888').text('— sin partes cargadas —');
    parties.forEach((p) => {
      const confirmation = confirmations.find((c) => c.partyId === p.id);
      const lawyer = lawyers.find((l) => l.partyId === p.id);
      doc.font('Helvetica-Bold').fillColor('#222').text(`${partyLabel(p)} (${p.role || 'parte'})`, { continued: true })
        .font('Helvetica').fillColor('#555').text(`  —  ${CONFIRMATION_LABELS_ES[confirmation ? confirmation.response : 'pendiente']}`);
      if (lawyer) doc.fontSize(8).fillColor('#8A989A').text(`   Abogado/a: ${lawyer.name}`);
      doc.fontSize(9).fillColor('#222');
    });
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica-Bold').fillColor('#8a5c14').text('Desarrollo de la audiencia');
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#888')
      .text('(Espacio para completar manualmente — este borrador no incluye contenido generado sobre lo ocurrido en la audiencia.)');

    footer(doc);
    doc.end();
  });
}

// 3.2 — carta de convocatoria. Pensada para mandarse por fuera del
// sistema si hace falta (impresa, adjunta a un mail manual).
async function buildConvocationLetterPDF({ mediation, hearing, parties }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    header(doc, 'Carta de convocatoria a audiencia');

    doc.fontSize(10).font('Helvetica').text(`Por medio de la presente se convoca a las partes de la mediación ${mediation.code} (${mediation.object}) a la audiencia programada según el siguiente detalle:`);
    doc.moveDown(1);

    doc.fontSize(9).font('Helvetica-Bold').text('Fecha: ', { continued: true }).font('Helvetica').text(hearing.date);
    if (hearing.startTime) doc.font('Helvetica-Bold').text('Hora: ', { continued: true }).font('Helvetica').text(hearing.startTime);
    doc.font('Helvetica-Bold').text('Modalidad: ', { continued: true }).font('Helvetica').text(MODALITY_LABELS_ES[hearing.modality] || hearing.modality);
    if (hearing.location) doc.font('Helvetica-Bold').text('Lugar: ', { continued: true }).font('Helvetica').text(hearing.location);
    if (hearing.meetingUrl) doc.font('Helvetica-Bold').text('Link de acceso: ', { continued: true }).font('Helvetica').text(hearing.meetingUrl);
    doc.moveDown(1);

    doc.fontSize(9).font('Helvetica-Bold').text('Partes convocadas:');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9);
    if (parties.length === 0) doc.fillColor('#888').text('— sin partes cargadas —');
    parties.forEach((p) => doc.text(`• ${partyLabel(p)} (${p.role || 'parte'})`));

    footer(doc);
    doc.end();
  });
}

module.exports = { buildDraftMinutesPDF, buildConvocationLetterPDF };
