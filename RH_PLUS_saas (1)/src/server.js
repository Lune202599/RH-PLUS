'use strict';
const cfg = require('./config');
const { createApp } = require('./app');
const { scheduleDailyBackup, backupNow } = require('./backup');

const M = require('./messaging');

const app = createApp();
const db = app.locals.db;

/* En production, l'envoi réel est une condition de sécurité : sans lui, les
   utilisateurs ne peuvent pas recevoir leur code de connexion et le système
   retomberait sur un affichage du code à l'écran. On refuse donc de démarrer,
   sauf dérogation explicite (RHPLUS_ALLOW_CONSOLE_MESSAGING=1). */
const etatMessages = M.etat();
if (cfg.ENV === 'production' && !etatMessages.pret_pour_la_production
    && process.env.RHPLUS_ALLOW_CONSOLE_MESSAGING !== '1') {
  console.error('--------------------------------------------------------------');
  console.error(' ARRÊT : envoi des notifications non configuré en production.');
  console.error(`   Email : ${etatMessages.email.mode}${etatMessages.email.configured ? ' (configuré)' : ' (non configuré)'}`);
  console.error(`   SMS   : ${etatMessages.sms.mode}${etatMessages.sms.configured ? ' (configuré)' : ' (non configuré)'}`);
  console.error(' Renseignez RHPLUS_MAIL et RHPLUS_SMS dans .env (voir docs/NOTIFICATIONS.md).');
  console.error(' Dérogation temporaire : RHPLUS_ALLOW_CONSOLE_MESSAGING=1');
  console.error('--------------------------------------------------------------');
  process.exit(1);
}

const server = app.listen(cfg.PORT, '0.0.0.0', () => {
  console.log('--------------------------------------------------------------');
  console.log(' RH PLUS — API & console SIRH (logiciel réel)');
  console.log(` Environnement : ${cfg.ENV}`);
  console.log(` Adresse       : http://0.0.0.0:${cfg.PORT}`);
  console.log(` Base de données : ${cfg.DB_PATH}`);
  console.log('--------------------------------------------------------------');
  if (cfg.ENV !== 'production') {
    console.log(' Mode démonstration : le code 2FA est affiché dans cette console.');
  }
  console.log(` Notifications : email ${etatMessages.email.mode}${etatMessages.email.configured ? ' (prêt)' : ' (non configuré)'}`
    + ` · SMS ${etatMessages.sms.mode}${etatMessages.sms.configured ? ' (prêt)' : ' (non configuré)'}`);
  // Première sauvegarde au démarrage, puis tous les jours à 02:00
  try { const r = backupNow(db, 'demarrage'); console.log(' Sauvegarde de démarrage :', r.file.split('/').pop()); } catch (e) { console.error(' Sauvegarde impossible :', e.message); }
  scheduleDailyBackup(db);
});

function shutdown(signal) {
  console.log(`\n[RH PLUS] ${signal} reçu — arrêt propre, sauvegarde finale…`);
  try { backupNow(db, 'arret'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
