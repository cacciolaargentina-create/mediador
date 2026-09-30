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
  // Art. 20, Ley 26.589: el plazo de la mediación es de hasta 60 días
  // hábiles judiciales, contados desde la última notificación fehaciente
  // al requerido (o al último de los requeridos, si hay más de uno).
  // Prorrogable por acuerdo de partes.
  mediationTermBusinessDays: 60,
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
