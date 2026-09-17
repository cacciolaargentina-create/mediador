// videoProviders/index.js
// Bloque 28 — registro central de proveedores. Agregar un proveedor
// nuevo el día de mañana es sumar un módulo acá, nunca tocar
// videoConferencing.js ni routes/mediations.js.

const { VideoProviderError, ERROR_CODES } = require('./base');
const manual = require('./manualProvider');
const googleMeet = require('./googleMeetProvider');
const zoom = require('./zoomProvider');
const teams = require('./teamsProvider');

const PROVIDERS = {
  manual,
  google_meet: googleMeet,
  zoom,
  teams,
};

function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new VideoProviderError(ERROR_CODES.NOT_CONFIGURED, `Proveedor de videoconferencia desconocido: ${name}`);
  return provider;
}

// proveedores "reales" que se muestran para elegir al crear una audiencia
// virtual — manual queda aparte porque no es una elección de proveedor,
// es "no uso ninguno, pongo el link yo" (spec §3: la lista que ve el
// mediador es Google Meet/Zoom/Microsoft Teams).
function listSelectableProviders() {
  return [googleMeet, zoom, teams];
}

module.exports = { getProvider, listSelectableProviders, PROVIDERS };
