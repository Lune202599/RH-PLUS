'use strict';
/* =====================================================================
   Création du compte PLATEFORME (éditeur RH PLUS)

   Ce compte est au-dessus des entreprises clientes : il les crée, les
   administre, suit les abonnements et la conformité. Il n'accède pas aux
   dossiers des salariés.

   Usage :
     npm run platform:admin -- --email=moi@rhplus.ga --name="Mon nom" \
        --company="RH PLUS" --password="UnMotDePasse#2026"

   Sans --password, un mot de passe robuste est généré et affiché une fois.
   ===================================================================== */
const crypto = require('crypto');
const { openDatabase, audit, nowISO } = require('../src/db');
const C = require('../src/crypto');

const arg = (nom, defaut = null) => {
  const prefixe = `--${nom}=`;
  const trouve = process.argv.slice(2).find((a) => a.startsWith(prefixe));
  return trouve ? trouve.slice(prefixe.length) : defaut;
};

function motDePasseRobuste() {
  return 'Rh' + crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) + '#' + (crypto.randomInt(10, 99));
}

const db = openDatabase();
const email = String(arg('email', 'direction@rhplus.ga')).toLowerCase();
const nom = arg('name', 'Direction RH PLUS');
const nomEditeur = arg('company', 'RH PLUS');
let motDePasse = arg('password');
const genere = !motDePasse;
if (genere) motDePasse = motDePasseRobuste();

if (motDePasse.length < 10) {
  console.error('Mot de passe trop court : 10 caractères minimum.');
  process.exit(1);
}
if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
  console.error(`Le compte ${email} existe déjà.`);
  process.exit(1);
}

/* L'éditeur est lui-même une entreprise : cela permet de rattacher les comptes
   plateforme à une entité légale (facturation, mentions, audit). */
let editeur = db.prepare('SELECT * FROM companies WHERE name = ?').get(nomEditeur);
if (!editeur) {
  const id = C.randomId('ed');
  db.prepare(`INSERT INTO companies (id, name, country, currency, law, city, plan, pay_method, hosting, apdpvp_status, created_at)
    VALUES (?, ?, 'Gabon', 'FCFA', 'Code du travail gabonais', 'Libreville', 'entreprise', 'Virement bancaire', 'Serveurs au Gabon (hébergement local)', 'Non déclaré', ?)`)
    .run(id, nomEditeur, nowISO());
  editeur = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  console.log(`Entité éditeur créée : ${nomEditeur} (${id})`);
}

const info = db.prepare(`INSERT INTO users (company_id, email, name, role, password_hash, twofa_enabled, created_at)
  VALUES (?, ?, ?, 'platform_admin', ?, 1, ?)`)
  .run(editeur.id, email, nom, C.hashPassword(motDePasse), nowISO());

db.prepare(`INSERT INTO audit_log (company_id, user_id, actor, role, action, details, at)
  VALUES (?, ?, ?, 'platform_admin', ?, ?, ?)`)
  .run(editeur.id, Number(info.lastInsertRowid), email, 'Création du compte plateforme',
    `Compte éditeur pour ${nom}`, nowISO());

console.log('--------------------------------------------------------------');
console.log(' Compte plateforme RH PLUS créé');
console.log(`   Email        : ${email}`);
console.log(`   Mot de passe : ${motDePasse}${genere ? '   (généré — notez-le, il ne sera plus affiché)' : ''}`);
console.log(`   Rôle         : platform_admin (toutes les entreprises clientes)`);
console.log('   Connexion    : http://localhost:3000 → code de vérification par SMS/email');
console.log('--------------------------------------------------------------');
