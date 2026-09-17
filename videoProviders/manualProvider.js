// videoProviders/manualProvider.js
// Bloque 28 §28 — "agregar enlace manualmente" sigue existiendo como
// primera clase, no como excepción al costado: es un VideoProvider más,
// que no llama a ninguna API externa. Así routes/mediations.js trata la
// creación/actualización/cancelación de la reunión con el MISMO código
// sin importar si hay un proveedor real detrás o no.

const { VideoProviderError, ERROR_CODES } = require('./base');

module.exports = {
  name: 'manual',
  label: 'Enlace manual',
  perMediatorAccount: false,

  async isConfigured() {
    return true;
  },

  async getStatus() {
    return { status: 'conectado', accountEmail: null, lastError: null };
  },

  async createMeeting(db, { meetingUrl }) {
    if (!meetingUrl) {
      throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'Falta el enlace de la reunión');
    }
    return { meetingId: null, joinUrl: meetingUrl, hostUrl: null, metadata: null, status: 'creada' };
  },

  async updateMeeting(db, { meetingUrl, hearing }) {
    const joinUrl = meetingUrl || hearing.meetingUrl;
    if (!joinUrl) {
      throw new VideoProviderError(ERROR_CODES.UPDATE_FAILED, 'Falta el enlace de la reunión');
    }
    return { joinUrl, hostUrl: null, metadata: null, status: 'actualizada' };
  },

  async cancelMeeting() {
    return { status: 'cancelada' };
  },
};
