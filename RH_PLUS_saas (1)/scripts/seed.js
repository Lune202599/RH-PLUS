'use strict';
/* Données de démonstration : entreprise Lune Digital (Gabon) + équipe + contrats,
   congés, documents chiffrés, bulletins et facture. Usage : npm run seed */
const C = require('../src/crypto');
const { openDatabase, audit, nowISO } = require('../src/db');
const cfg = require('../src/config');
const { computePayslip } = require('../src/payroll');

const db = openDatabase();
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

db.prepare('DELETE FROM audit_log').run();
['payments', 'invoices', 'payslips', 'documents', 'leaves', 'contracts', 'login_challenges', 'login_attempts', 'messages', 'rate_validations'].forEach((t) => db.prepare(`DELETE FROM ${t}`).run());
db.prepare('DELETE FROM employees').run();
/* Les comptes de l'éditeur (plateforme) survivent à une remise à zéro de la démonstration :
   on ne veut pas perdre l'accès d'administration en rejouant le jeu de données. */
db.prepare("DELETE FROM users WHERE role <> 'platform_admin'").run();
db.prepare("DELETE FROM companies WHERE id NOT IN (SELECT company_id FROM users)").run();
try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch { /* aucune table AUTOINCREMENT */ }
if (db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'platform_admin'").get().n) {
  console.log('Comptes éditeur conservés :', db.prepare("SELECT email FROM users WHERE role = 'platform_admin'").all().map((u) => u.email).join(', '));
}

const coId = 'lune';
db.prepare(`INSERT INTO companies (id, name, country, currency, law, city, rccm, nif, cnss_no, rep, convention, plan, pay_method, hosting, apdpvp_num, apdpvp_date, apdpvp_status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  coId, 'Lune Digital', 'Gabon', 'FCFA', 'Code du travail gabonais', 'Libreville · Gabon',
  'LBV-2015-B-1234', '745 120 K', C.encryptField('1234567'), 'M. Paul Onangué, Directeur Général',
  'Convention collective nationale du travail (Gabon)', 'pme', 'Airtel Money',
  'Serveurs au Gabon (hébergement local)', 'RCP-2025-0456', '2025-06-15', 'À jour', nowISO(),
);

const employees = [
  ['RHP-0001', 'Mariam Ouédraogo', "Chargée d'affaires", 'Commercial', 'CDI', 'Présent', 'mariam.ouedraogo@lunedigital.ga', '+241 06 12 34 56', '2021-03-15', 850000, '700137001', 'RH PLUS — Espace Talent'],
  ['RHP-0002', 'Sylvie Mabiala', 'Cheffe des ventes', 'Commercial', 'CDI', 'Présent', 'sylvie.mabiala@lunedigital.ga', '+241 06 56 78 90', '2018-01-22', 1350000, '700274002', 'LinkedIn'],
  ['RHP-0003', 'Ibrahim Touré', 'Développeur full-stack', 'Informatique', 'CDI', 'Présent', 'ibrahim.toure@lunedigital.ga', '+241 07 78 90 12', '2022-11-14', 980000, '700411003', 'RH PLUS — Espace Talent'],
  ['RHP-0004', 'Clarisse Ondo', 'Assistante commerciale', 'Commercial', 'CDD', 'Présent', 'clarisse.ondo@lunedigital.ga', '+241 07 33 44 55', addDays(-107), 480000, '700548004', 'Candidature physique (dépôt de dossier)'],
  ['RHP-0005', 'Awa Cissé', 'Stagiaire RH', 'Ressources humaines', 'Stage', 'Présent', 'awa.cisse@lunedigital.ga', '+241 06 66 77 88', addDays(-165), 180000, '700685005', 'RH PLUS — Espace Talent'],
  ['RHP-0006', 'Kofi Danso', 'Business developer', 'Commercial', 'Alternance', 'Présent', 'kofi.danso@lunedigital.ga', '+241 07 45 67 89', '2025-10-06', 250000, '700822006', 'Forum écoles / alternance'],
];
const insEmp = db.prepare(`INSERT INTO employees (company_id, matricule, name, role, dept, contract, status, email, phone, hired, salary_cents, cnss_no_enc, origin, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
employees.forEach((e) => insEmp.run(coId, e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9] * 100, C.encryptField(e[10]), e[11], nowISO()));
/* Identifiants réels des salariés (jamais supposés) — utilisés par les contrats,
   congés, documents, bulletins et comptes ci-dessous. */
const E = employees.map((e) => Number(db.prepare('SELECT id FROM employees WHERE matricule = ?').get(e[0]).id));

const users = [
  ['admin@rhplus.ga', 'Aïcha Koné', 'admin', 'Directrice RH', null],
  ['paie@rhplus.ga', 'Grace Okafor', 'rh', 'Gestionnaire de paie', null],
  ['manager@rhplus.ga', 'Sylvie Mabiala', 'manager', 'Cheffe des ventes', E[1]],
  ['employe@rhplus.ga', 'Mariam Ouédraogo', 'employee', 'Chargée d\'affaires', E[0]],
];
const insUser = db.prepare('INSERT INTO users (company_id, email, name, role, employee_id, password_hash, twofa_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const PWD = process.env.SEED_PASSWORD || 'RhPlus!2026';
users.forEach(([email, name, role, , empId]) => insUser.run(coId, email, name, role, empId, C.hashPassword(PWD), 1, nowISO()));

const insContract = db.prepare('INSERT INTO contracts (company_id, employee_id, type, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
insContract.run(coId, E[0], 'CDI', '2021-03-15', null, 'En cours', nowISO());
insContract.run(coId, E[3], 'CDD', addDays(-107), addDays(15), 'En cours', nowISO());
insContract.run(coId, E[4], 'Stage', addDays(-165), addDays(30), 'En cours', nowISO());
insContract.run(coId, E[5], 'Alternance', '2025-10-06', addDays(60), 'En cours', nowISO());

const insLeave = db.prepare('INSERT INTO leaves (company_id, employee_id, type, from_date, to_date, days, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
insLeave.run(coId, E[0], 'Congé annuel', addDays(10), addDays(14), 5, 'En attente', 'Congé familial', nowISO());
insLeave.run(coId, E[2], 'Congé maladie', addDays(-6), addDays(-4), 3, 'Validée', 'Certificat médical déposé', nowISO());
insLeave.run(coId, E[4], 'Congé annuel', addDays(20), addDays(24), 5, 'En attente', 'Fin de stage', nowISO());

const photo = Buffer.from('Contrat de travail numérisé — Lune Digital (exemple de document chiffré au coffre-fort).', 'utf8');
const enc = C.encryptBuffer(photo);
db.prepare(`INSERT INTO documents (company_id, employee_id, folder, name, mime, size, sha256, iv, tag, ciphertext, uploaded_by, created_at)
  VALUES (?, ?, 'contrat', 'Contrat_CDI_Mariam_Ouedraogo.pdf', 'application/pdf', ?, ?, ?, ?, ?, 1, ?)`)
  .run(coId, E[0], photo.length, C.sha256(photo), enc.iv, enc.tag, enc.ciphertext, nowISO());

const period = new Date().toISOString().slice(0, 7);
const insPayslip = db.prepare(`INSERT INTO payslips (company_id, employee_id, period, status, gross_cents, net_cents, detail_json, currency, rates_validated, generated_by, created_at)
  VALUES (?, ?, ?, 'brouillon', ?, ?, ?, ?, 0, ?, ?)`);
const adminId = Number(db.prepare("SELECT id FROM users WHERE role = 'admin'").get().id);
for (const id of [E[0], E[1], E[2]]) {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  const p = computePayslip({ salary: emp.salary_cents / 100, country: 'Gabon' });
  insPayslip.run(coId, id, period, p.detail.brut, p.totals.net_a_payer, JSON.stringify(p), p.currency, adminId, nowISO());
}

db.prepare('INSERT INTO invoices (company_id, ref, period, seats, amount_cents, tva_cents, status, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(coId, 'FAC-202609-001', period, 6, 3500000, 630000, 'À échoir', 'Airtel Money', nowISO());
db.prepare('INSERT INTO invoices (company_id, ref, period, seats, amount_cents, tva_cents, status, method, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(coId, 'FAC-202608-001', '2026-08', 6, 3500000, 630000, 'Payée', 'Airtel Money', nowISO(), nowISO());

audit(db, { company_id: coId, actor: 'systeme', role: 'admin', action: 'Initialisation des données de démonstration', details: `Lune Digital — ${employees.length} salariés, base : ${cfg.DB_PATH}` });

console.log('Données de démonstration créées.');
console.log('Comptes (mot de passe : ' + PWD + ') :');
users.forEach(([email, , role]) => console.log(`  ${role.padEnd(8)} ${email}`));
console.log('Le code 2FA est affiché dans la console du serveur à la connexion.');
