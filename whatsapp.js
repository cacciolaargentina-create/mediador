// whatsapp.js
// Cliente mínimo de la API de WhatsApp Cloud (Meta Graph API). Sin
// dependencias del resto de la app — solo manda/verifica, no sabe nada de
// canales ni mensajes (eso vive en messaging.js y routes/whatsapp.js).

const crypto = require('crypto');

const GRAPH_VERSION = 'v20.0';

function configured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function callGraphAPI(payload) {
  if (!configured()) {
    console.warn('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID no configurados — se omite el envío por WhatsApp.', payload);
    return null;
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`WhatsApp Graph API error ${resp.status}: ${errText}`);
  }
  return resp.json();
}

async function sendText(to, body) {
  return callGraphAPI({ to, type: 'text', text: { body } });
}

// buttons: [{ id, title }] — máximo 3, límite de la API de Meta.
async function sendButtons(to, bodyText, buttons) {
  return callGraphAPI({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  });
}

// HMAC-SHA256 del body crudo contra WHATSAPP_APP_SECRET, formato Meta:
// header "X-Hub-Signature-256: sha256=<hex>". Sin secret configurado no hay
// forma segura de confiar en el webhook — se acepta solo fuera de
// producción (para poder probar en local sin credenciales reales) y se
// rechaza siempre en producción.
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') return false;
    console.warn('WHATSAPP_APP_SECRET no configurado — se omite la verificación de firma (solo válido fuera de producción).');
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = { configured, sendText, sendButtons, verifySignature };
