// signing.js
// Firma electrónica de los informes certificados (Ley 25.506 de Argentina,
// Art. 5) — OJO: esto NO es "firma digital" en el sentido fuerte del Art. 2
// de esa misma ley, que exige un certificado emitido por un certificador
// licenciado ante ONTI y trae presunción legal automática de validez. Acá
// es una firma criptográfica propia del proyecto: prueba que el documento
// salió de la clave privada de Puente Digital (no de un hash que cualquiera
// pudo calcular), verificable con la clave pública de acá abajo — pero si
// alguien la cuestiona, la carga de probar su validez es de quien la
// invoca, no tiene la presunción automática que sí tiene la firma digital.
// El PDF y la página de verificación la rotulan siempre como "firma
// electrónica", nunca como "firma digital", para no prometer algo que no es.
//
// Ed25519: firmas cortas (64 bytes), rápido, sin las trampas de padding
// que tiene RSA para este uso — es el estándar moderno para este tipo de
// firma de documentos.

const crypto = require('crypto');

// en .env las claves van con los saltos de línea escapados como \n (mismo
// truco que usan Firebase/otros SDKs para meter un PEM multilínea en una
// sola variable de entorno) — acá se deshace eso antes de usarlas.
function loadKey(envVar) {
  const raw = process.env[envVar];
  if (!raw) return null;
  return raw.replace(/\\n/g, '\n');
}

const privateKeyPem = loadKey('SIGNING_PRIVATE_KEY');
const publicKeyPem = loadKey('SIGNING_PUBLIC_KEY');
const configured = !!(privateKeyPem && publicKeyPem);

let privateKey = null;
let publicKey = null;
if (configured) {
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch (err) {
    console.error('SIGNING_PRIVATE_KEY / SIGNING_PUBLIC_KEY inválidos:', err.message);
  }
} else {
  console.warn('⚠ SIGNING_PRIVATE_KEY / SIGNING_PUBLIC_KEY no configurados — los informes certificados van a salir sin firma electrónica hasta que corras scripts/generate-signing-keys.js.');
}

// firma el hash de integridad (no el documento entero — "hash-then-sign",
// el patrón estándar) y devuelve la firma en base64. null si no hay claves
// configuradas — el PDF se sigue generando igual, solo sin este agregado.
function signHash(hashHex) {
  if (!privateKey) return null;
  const signature = crypto.sign(null, Buffer.from(hashHex, 'utf-8'), privateKey);
  return signature.toString('base64');
}

function verifySignature(hashHex, signatureBase64) {
  if (!publicKey || !signatureBase64) return false;
  try {
    return crypto.verify(null, Buffer.from(hashHex, 'utf-8'), publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch (e) {
    return false;
  }
}

function getPublicKeyPem() {
  return publicKeyPem;
}

// huella corta para imprimir sin ocupar tanto lugar — mismo criterio que un
// fingerprint de clave SSH/TLS: es un hash DE LA CLAVE, no del documento.
// Sirve para que alguien pueda confirmar a simple vista "esta es la misma
// clave pública que Puente Digital publicó" sin tener que comparar el PEM
// entero carácter por carácter.
function publicKeyFingerprint() {
  if (!publicKey) return null;
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const hex = crypto.createHash('sha256').update(der).digest('hex');
  return hex.slice(0, 32).match(/.{1,4}/g).join(':');
}

module.exports = {
  signHash,
  verifySignature,
  getPublicKeyPem,
  publicKeyFingerprint,
  signingConfigured: () => configured,
};
