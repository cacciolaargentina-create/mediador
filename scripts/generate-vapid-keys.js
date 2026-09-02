// scripts/generate-vapid-keys.js
// Corré esto UNA sola vez: node scripts/generate-vapid-keys.js
// Copiá lo que imprime a tu .env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY).
// La pública además tiene que estar disponible para el frontend — se sirve
// sola desde GET /api/push/vapid-public-key, no hace falta pegarla a mano
// en ningún archivo del cliente.

const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();
console.log('✅ Claves VAPID generadas. Copiá esto a tu .env:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:tu-email-de-contacto@dominio.com`);
console.log('\nSon del proyecto, no de un usuario — se generan una sola vez y quedan fijas.');
