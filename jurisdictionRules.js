// jurisdictionRules.js
// Bloque 43 — reglas de plazo POR JURISDICCIÓN (spec §3/§4). Nunca
// hardcodeadas en legalDeadlines.js ni en ningún otro lugar: si una
// mediación no tiene jurisdicción cargada, o su jurisdicción no está acá,
// el motor de plazos la muestra como "no calculable" y nunca inventa un
// valor (mediations.jurisdiction, ver db.js).
//
// Estructura preparada para sumar provincias sin tocar la lógica central
// (legalDeadlines.js solo lee `getJurisdictionRules(code)` — agregar una
// jurisdicción nueva es sumar una entrada acá, nada más).

// NACION — Ley 26.589 de Mediación Prejudicial Obligatoria (ámbito
// nacional/CABA).
const NACION = {
  code: 'nacion',
  label: 'Nación (Ley 26.589)',
  // Art. 20, Ley 26.589: "El plazo para realizar la mediación será de
  // hasta sesenta (60) días CORRIDOS" — verificado contra el texto
  // actualizado de la ley (argentina.gob.ar/normativa/nacional/
  // ley-26589-166999/actualizacion). El artículo NO dice "hábiles": ese
  // error estaba en una versión anterior de este archivo (y, por separado,
  // en un borrador de contenido de marketing que se corrigió al revisarlo
  // contra la fuente — mismo error, dos lugares distintos). Contado desde
  // la última notificación fehaciente al requerido (o al último de los
  // requeridos, si hay más de uno). Prorrogable por acuerdo de partes.
  mediationTermCalendarDays: 60,
  // Art. 20 in fine: la audiencia debe notificarse con una anticipación no
  // menor a 3 días hábiles.
  hearingNoticeBusinessDays: 3,
  // Art. 22: el efecto suspensivo sobre la prescripción cesa (se reanuda
  // su curso) a los 20 días CORRIDOS desde que el acta de cierre queda a
  // disposición de las partes. A diferencia de las dos reglas anteriores,
  // el texto no dice "hábiles" acá — por eso se cuenta en días corridos.
  // PENDIENTE DE CONFIRMACIÓN (ver legalDeadlines.js:computeActaDisponibilidad):
  // se usa mediation.closedAt como fecha de "a disposición de las partes"
  // por ser el momento en que se genera el acta de cierre automática
  // (Bloque 34) — es la lectura más razonable con los datos que existen
  // hoy, pero no reemplaza una confirmación caso a caso si en la práctica
  // el acta se entrega en un momento posterior a closedAt.
  actaDisponibilidadCalendarDays: 20,
};

const JURISDICTIONS = { nacion: NACION };

function getJurisdictionRules(code) {
  if (!code) return null;
  return JURISDICTIONS[code] || null;
}

function listJurisdictions() {
  return Object.values(JURISDICTIONS).map((j) => ({ code: j.code, label: j.label }));
}

module.exports = { JURISDICTIONS, getJurisdictionRules, listJurisdictions };
