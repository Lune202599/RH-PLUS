'use strict';
/* Sauvegardes : copie à chaud de la base (VACUUM INTO), rotation des fichiers,
   planification quotidienne. Les sauvegardes sont stockées hors du dossier servi. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cfg = require('./config');
const { openDatabase } = require('./db');

function backupNow(db, label = 'auto') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(cfg.BACKUP_DIR, `rhplus-${stamp}-${label}.sqlite.gz`);
  const tmp = file.replace('.gz', '');
  db.prepare('VACUUM INTO ?').run(tmp);
  fs.writeFileSync(file, zlib.gzipSync(fs.readFileSync(tmp)));
  fs.unlinkSync(tmp);
  const size = fs.statSync(file).size;
  prune(cfg.BACKUP_KEEP);
  return { file, size };
}

function prune(keep) {
  const files = fs.readdirSync(cfg.BACKUP_DIR).filter((f) => f.endsWith('.sqlite.gz')).sort();
  while (files.length > keep) {
    const old = files.shift();
    fs.unlinkSync(path.join(cfg.BACKUP_DIR, old));
  }
}

function listBackups() {
  return fs.readdirSync(cfg.BACKUP_DIR).filter((f) => f.endsWith('.sqlite.gz')).sort().reverse()
    .map((f) => ({ file: f, size: fs.statSync(path.join(cfg.BACKUP_DIR, f)).size, at: f.slice(7, 26) }));
}

/** Lance une sauvegarde quotidienne (à 02:00) tant que le serveur tourne. */
function scheduleDailyBackup(db) {
  const run = () => {
    try {
      const r = backupNow(db, 'quotidien');
      console.log(`[RH PLUS] Sauvegarde créée : ${path.basename(r.file)} (${(r.size / 1024).toFixed(0)} Ko)`);
    } catch (e) {
      console.error('[RH PLUS] Échec de la sauvegarde :', e.message);
    }
  };
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const first = setTimeout(() => { run(); setInterval(run, 24 * 3600 * 1000); }, next - now);
  if (first.unref) first.unref();
  return next;
}

if (require.main === module) {
  const db = openDatabase();
  const r = backupNow(db, process.argv[2] || 'manuel');
  console.log('Sauvegarde :', r.file, (r.size / 1024).toFixed(0) + ' Ko');
  console.log('Sauvegardes disponibles :', listBackups().length);
}

module.exports = { backupNow, listBackups, scheduleDailyBackup, prune };
