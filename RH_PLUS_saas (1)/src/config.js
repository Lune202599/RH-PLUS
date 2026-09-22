'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

/* Lecture du fichier .env s'il existe (aucune dépendance externe).
   Ainsi, TOUS les points d'entrée — le service, mais aussi les scripts en ligne
   de commande (seed, création du compte plateforme, sauvegarde) — travaillent
   sur la même base et la même configuration. Les variables déjà définies dans
   l'environnement gardent la priorité (pratique pour les tests). */
const ENV_FILE = process.env.RHPLUS_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const brute of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    if (!brute.trim() || brute.trim().startsWith('#')) continue;
    const m = brute.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let valeur = m[2].trim();
    if ((valeur.startsWith('"') && valeur.endsWith('"')) || (valeur.startsWith("'") && valeur.endsWith("'"))) {
      valeur = valeur.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = valeur;
  }
}

const DATA_DIR = process.env.RHPLUS_DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

module.exports = {
  ROOT,
  DATA_DIR,
  DB_PATH: process.env.RHPLUS_DB || path.join(DATA_DIR, 'rhplus.sqlite'),
  BACKUP_DIR: path.join(DATA_DIR, 'backups'),
  MASTER_KEY_FILE: process.env.RHPLUS_MASTER_KEY_FILE || path.join(DATA_DIR, 'master.key'),
  JWT_SECRET_FILE: path.join(DATA_DIR, 'session.key'),
  PORT: Number(process.env.PORT || 3000),
  ENV: process.env.NODE_ENV || 'development',
  SESSION_TTL_HOURS: Number(process.env.RHPLUS_SESSION_TTL_HOURS || 12),
  TWOFA_TTL_MINUTES: Number(process.env.RHPLUS_2FA_TTL_MINUTES || 10),
  BACKUP_KEEP: Number(process.env.RHPLUS_BACKUP_KEEP || 14),
  LOGIN_MAX_ATTEMPTS: 8,
  LOGIN_WINDOW_MINUTES: 15,
  // Fournisseurs de paiement (Afrique francophone). Le mode « sandbox » fonctionne sans clés.
  PAYMENTS: {
    default: process.env.RHPLUS_PAYMENT_PROVIDER || 'sandbox',
    cinetpay: { apikey: process.env.CINETPAY_APIKEY || '', site: process.env.CINETPAY_SITE_ID || '' },
    paydunya: { master: process.env.PAYDUNYA_MASTER_KEY || '', public: process.env.PAYDUNYA_PUBLIC_KEY || '', token: process.env.PAYDUNYA_TOKEN || '' },
    flutterwave: { secret: process.env.FLUTTERWAVE_SECRET_KEY || '', hash: process.env.FLUTTERWAVE_WEBHOOK_HASH || '' },
  },
};
