// scripts/generate-signing-keys.js
// Corré esto UNA sola vez: node scripts/generate-signing-keys.js
// Copiá lo que imprime a tu .env (SIGNING_PRIVATE_KEY, SIGNING_PUBLIC_KEY).
// Son del proyecto (no de un usuario) — se usan para firmar electrónicamente
// los informes certificados (ver signing.js).
//
// Importante: si en algún momento se regeneran, los informes certificados
// viejos dejan de poder verificarse con la clave pública nueva — guardalas
// bien y no las regeneres salvo que sea estrictamente necesario. Conviene
// además dejar constancia pública de la clave pública en algún lugar con
// fecha cierta (un commit de git, una publicación) — eso es lo que le da
// valor de "esta clave no se pudo haber creado después de tal fecha" a
// cualquier firma hecha con ella.

const crypto = require('crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).trim();

console.log('✅ Par de claves generado. Copiá esto a tu .env:\n');
console.log(`SIGNING_PRIVATE_KEY=${privatePem.replace(/\n/g, '\\n')}`);
console.log(`SIGNING_PUBLIC_KEY=${publicPem.replace(/\n/g, '\\n')}`);
console.log('\nSon del proyecto, no de un usuario — se generan una sola vez y quedan fijas.');
console.log('Guardá la clave pública también en algún lugar con fecha cierta (un commit, una publicación) — es lo que respalda que la clave existía antes de cualquier documento firmado con ella.');
