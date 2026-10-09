// scripts/cron-backup.js
// Bloque 57 — backup diario automático, corrido por cron en el VPS,
// INDEPENDIENTE de los backups manuales que se hacen a mano antes de cada
// deploy (ver runbook de deploy). Hasta ahora el único backup que existía
// era ese paso manual — si pasan varios días sin deployar nada, el backup
// más reciente podía tener semanas.
//
// Usa backupTo() de db.js (VACUUM INTO — ver ahí) en vez de copiar el
// .sqlite a mano: da un snapshot consistente de una sola vez, sin
// lidiar con el WAL/shm de un archivo que puede estar siendo escrito en
// paralelo por el proceso real de la app.
//
// Uso (crontab, corre como el mismo usuario que pm2):
//   0 6 * * * cd /var/www/mediador_digital/htdocs && node scripts/cron-backup.js >> ~/backups/cron-backup.log 2>&1

const fs = require('fs');
const path = require('path');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(require('os').homedir(), 'backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 60;
const ENV_PATH = path.join(__dirname, '..', '.env');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneOld(prefix) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(BACKUP_DIR, name);
    const st = fs.statSync(full);
    if (st.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      console.log(`Borrado backup viejo (> ${RETENTION_DAYS} días): ${name}`);
    }
  }
}

function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = stamp();

  const { backupTo } = require('../db');
  const dbDest = path.join(BACKUP_DIR, `cron-data.sqlite.${ts}.bak`);
  backupTo(dbDest);
  console.log(`OK — base de datos: ${dbDest}`);

  if (fs.existsSync(ENV_PATH)) {
    const envDest = path.join(BACKUP_DIR, `cron-env.${ts}.bak`);
    fs.copyFileSync(ENV_PATH, envDest);
    console.log(`OK — .env: ${envDest}`);
  } else {
    console.warn('.env no encontrado — se saltea ese backup (no es crítico, el .sqlite es lo que importa de verdad).');
  }

  pruneOld('cron-data.sqlite.');
  pruneOld('cron-env.');
  console.log(`Listo — ${new Date().toISOString()}`);
}

try {
  main();
} catch (e) {
  console.error('Error en el backup automático:', e);
  process.exit(1);
}
