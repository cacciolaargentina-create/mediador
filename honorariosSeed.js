// honorariosSeed.js
// Herramientas Legales — Calculadora de honorarios (Bloque 42). Compartido
// entre routes/admin-mediador.js (que siembra y permite cargar valores
// nuevos) y routes/mediations.js (que solo lee, para que cualquier
// mediador pueda usar la calculadora sin depender de que un admin haya
// entrado antes al panel). Un solo lugar con los datos — nunca duplicados
// entre los dos routers.
//
// Ningún valor monetario vive hardcodeado en el frontend: esto siembra la
// ESTRUCTURA de la norma (rara vez cambia) y el PRIMER valor conocido de
// la unidad; de ahí en más se actualiza agregando filas nuevas a
// honorariosUnitValues (ver POST /api/admin-mediador/honorarios/scales/:id/unit-values),
// nunca pisando las viejas ni tocando código. Todo dato salió de fuentes
// oficiales verificadas manualmente — ver fuente/urlFuente en cada fila.

const { nanoid } = require('nanoid');

const DEFAULT_HONORARIOS_SCALES = [
  {
    id: 'nacion-general',
    jurisdiccion: 'nacion',
    tipoMediacion: 'general',
    unidad: 'UHOM',
    norma: 'Decreto Nacional 1.467/2011 (Anexo I art. 28, Anexo III arts. 1-4) — reglamentario de la Ley 26.589. Aplica también a la mediación civil y comercial en CABA, cuya Justicia sigue siendo Justicia Nacional.',
    honorarioProvisionalUnidades: 2,
    tramos: [
      { item: 'A', label: 'Hasta 30 UHOM', montoHastaUnidades: 30, honorarioUnidades: 3 },
      { item: 'B', label: 'Más de 30 y hasta 60 UHOM', montoDesdeUnidades: 30, montoHastaUnidades: 60, honorarioUnidades: 6 },
      { item: 'C', label: 'Más de 60 y hasta 150 UHOM', montoDesdeUnidades: 60, montoHastaUnidades: 150, honorarioUnidades: 9 },
      { item: 'D', label: 'Más de 150 y hasta 300 UHOM', montoDesdeUnidades: 150, montoHastaUnidades: 300, honorarioUnidades: 12 },
      { item: 'E', label: 'Más de 300 y hasta 600 UHOM', montoDesdeUnidades: 300, montoHastaUnidades: 600, honorarioUnidades: 16 },
      { item: 'F', label: 'Más de 600 y hasta 1000 UHOM', montoDesdeUnidades: 600, montoHastaUnidades: 1000, honorarioUnidades: 20 },
      { item: 'G', label: 'Más de 1000 UHOM', montoDesdeUnidades: 1000, porcentaje: 2, topeUnidades: 120 },
      { item: 'H', label: 'Valor incierto o fuera del comercio, monto indeterminable', tipo: 'indeterminado', honorarioUnidades: 20 },
      { item: 'I', label: 'Cosas o cuestiones sin valor pecuniario', tipo: 'sin_valor_pecuniario', honorarioUnidades: 12 },
    ],
    adicionalPorAudiencia: { desdeAudiencia: 4, itemsMenor: ['A', 'B'], unidadesMenor: 0.5, unidadesMayor: 1 },
    fuente: 'Decreto Nacional 1.467/2011 (SAIJ/Boletín Oficial 28/09/2011), Anexo I art. 28 y Anexo III arts. 1-4',
    urlFuente: 'https://www.csjn.gov.ar/archivos/notificaciones/dec14672011.pdf',
  },
  {
    id: 'nacion-familiar',
    jurisdiccion: 'nacion',
    tipoMediacion: 'familiar',
    unidad: 'UHOM',
    norma: 'Decreto Nacional 1.467/2011 (Anexo III art. 3) — mediación familiar, art. 31 incisos b) y c) de la Ley 26.589 (cuidado personal, comunicación, plan de parentalidad).',
    honorarioProvisionalUnidades: 2,
    tramos: [
      { item: 'familiar', label: 'Cuidado personal, comunicación o plan de parentalidad (art. 31 incisos b y c, Ley 26.589)', honorarioUnidades: 9 },
    ],
    adicionalPorAudiencia: { desdeAudiencia: 2, unidadesMayor: 1, topeUnidades: 12 },
    fuente: 'Decreto Nacional 1.467/2011 (SAIJ/Boletín Oficial 28/09/2011), Anexo III art. 3',
    urlFuente: 'https://www.csjn.gov.ar/archivos/notificaciones/dec14672011.pdf',
  },
];

// Historial real de valores de la UHOM verificados (enero-mayo 2026) — se
// cargan los 5 juntos en el primer seed porque ya estaban públicos y
// verificables; de acá en más, cada mes se agrega con el endpoint de
// arriba, sin tocar código. mayo/2026 queda como el último verificado
// (fechaHasta null) — el calculador SIEMPRE muestra la fecha de
// verificación para que el mediador sepa si puede estar desactualizado.
const DEFAULT_HONORARIOS_UNIT_VALUES = [
  { valorPesos: 11290, fechaDesde: '2026-01-01', fechaHasta: '2026-01-31' },
  { valorPesos: 11540, fechaDesde: '2026-02-01', fechaHasta: '2026-02-28' },
  { valorPesos: 11770, fechaDesde: '2026-03-01', fechaHasta: '2026-03-31' },
  { valorPesos: 11970, fechaDesde: '2026-04-01', fechaHasta: '2026-04-30' },
  { valorPesos: 12150, fechaDesde: '2026-05-01', fechaHasta: null },
];
const HONORARIOS_UNIT_VALUES_SOURCE = {
  fuente: 'Unión de Mediadores Prejudiciales A.C. — tabla de honorarios de mediación prejudicial (reproduce el valor de la UHOM que publica periódicamente el Ministerio de Justicia y Derechos Humanos)',
  urlFuente: 'https://www.cpacf.org.ar/uploads/files/com/09032615_HONORARIOS%20MEDIACION%20PREJUDICIAL%20ENERO%20A%20MAYO%202026.pdf',
};

function ensureHonorariosSeeded(db) {
  let created = 0;
  for (const def of DEFAULT_HONORARIOS_SCALES) {
    if (!db.honorariosScales.some((s) => s.id === def.id)) {
      db.honorariosScales.push({ ...def, fechaVerificacion: Date.now(), createdAt: Date.now() });
      created++;
      for (const uv of DEFAULT_HONORARIOS_UNIT_VALUES) {
        db.honorariosUnitValues.push({
          id: nanoid(), scaleId: def.id, valorPesos: uv.valorPesos,
          fechaDesde: uv.fechaDesde, fechaHasta: uv.fechaHasta,
          fuente: HONORARIOS_UNIT_VALUES_SOURCE.fuente, urlFuente: HONORARIOS_UNIT_VALUES_SOURCE.urlFuente,
          fechaVerificacion: Date.now(), createdAt: Date.now(), createdBy: null,
        });
      }
    }
  }
  return created;
}

module.exports = { DEFAULT_HONORARIOS_SCALES, DEFAULT_HONORARIOS_UNIT_VALUES, HONORARIOS_UNIT_VALUES_SOURCE, ensureHonorariosSeeded };
