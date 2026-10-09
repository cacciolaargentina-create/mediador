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
// es "no uso ninguno, pongo el link yo".
// Bloque 71 — Zoom y Teams quedaron afuera de esta lista a pedido del
// usuario (Zoom: su cuenta está en plan Basic, sin el rol que habilita el
// scope de escritura; Teams: pide una licencia paga de Microsoft 365 que
// no tiene sentido comprar solo para esto). Los adapters y PROVIDERS de
// abajo siguen existiendo — isConfigured() sigue dando false sin
// credenciales, así que si algún día se resuelve alguno de los dos,
// alcanza con agregarlo de nuevo acá, sin tocar nada más.
function listSelectableProviders() {
  return [googleMeet];
}

module.exports = { getProvider, listSelectableProviders, PROVIDERS };
