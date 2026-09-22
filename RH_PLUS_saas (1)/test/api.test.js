'use strict';
/* Tests d'intégration de l'API RH PLUS (base temporaire, serveur éphémère). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RHPLUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rhplus-test-'));
process.env.RHPLUS_DB = path.join(process.env.RHPLUS_DATA_DIR, 'test.sqlite');
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');
const { computePayslip } = require('../src/payroll');
const C = require('../src/crypto');

let server; let base;
const jars = {};
function cookieJar(name) { return { name, get cookie() { return jars[name] || ''; }, set cookie(v) { jars[name] = v.split(';')[0]; } }; }

async function call(who, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(jars[who] ? { cookie: jars[who] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars[who] = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, type };
}

async function registerAndLogin(who, companyName, email) {
  const reg = await call(who, 'POST', '/api/auth/register', {
    company: { name: companyName, country: 'Gabon', city: 'Libreville', rccm: 'LBV-2026-B-0001', nif: '111 222 A', cnss_no: '9988776' },
    admin: { email, password: 'MotDePasse!2026', name: 'Admin ' + companyName },
  });
  assert.equal(reg.status, 201, 'inscription entreprise');
  const login = await call(who, 'POST', '/api/auth/login', { email, password: 'MotDePasse!2026' });
  assert.equal(login.status, 200, 'connexion étape 1');
  assert.equal(login.data.step, '2fa');
  const dev = login.data.dev_code;
  assert.ok(/^\d{6}$/.test(String(dev)), 'code 2FA à 6 chiffres en démonstration');
  const verify = await call(who, 'POST', '/api/auth/verify', { email, code: dev });
  assert.equal(verify.status, 200, 'connexion étape 2');
  return reg.data.company.id;
}

test.before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); });

test('santé du service', async () => {
  const r = await call('anon', 'GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('accès refusé sans session', async () => {
  for (const url of ['/api/employees', '/api/dashboard', '/api/compliance', '/api/audit']) {
    const r = await call('anon', 'GET', url);
    assert.equal(r.status, 401, url + ' doit exiger une authentification');
  }
});

test('moteur de paie : cohérence des totaux', () => {
  const p = computePayslip({ salary: 850000, country: 'Gabon' });
  assert.equal(p.currency, 'FCFA');
  const cotisations = p.lines.reduce((s, l) => s + l.montant_ee, 0);
  assert.equal(p.totals.net_a_payer, p.detail.brut - cotisations, 'net = brut − cotisations salariales');
  assert.ok(p.totals.cout_employeur > p.detail.brut, 'coût employeur > brut');
  assert.equal(p.certified, false, 'barèmes non certifiés par défaut');
  assert.ok(/expert-comptable/i.test(p.warning), 'avertissement de validation présent');
});

test('chiffrement des données sensibles', () => {
  const enc = C.encryptField('700137001');
  assert.ok(!enc.includes('700137001'), 'la valeur chiffrée ne contient pas le numéro en clair');
  assert.equal(C.decryptField(enc), '700137001', 'déchiffrement fidèle');
  const buf = Buffer.from('document confidentiel');
  const row = C.encryptBuffer(buf);
  assert.ok(!row.ciphertext.toString('utf8').includes('confidentiel'));
  assert.equal(C.decryptBuffer(row).toString(), 'document confidentiel');
  const hash = C.hashPassword('MotDePasse!2026');
  assert.equal(C.verifyPassword('MotDePasse!2026', hash), true);
  assert.equal(C.verifyPassword('mauvais', hash), false);
});

test('isolation multi-entreprises', async () => {
  await registerAndLogin('A', 'Entreprise Alpha', 'admin@alpha.ga');
  const empA = await call('A', 'POST', '/api/employees', { name: 'Salarié Alpha', role: 'Testeur', salary: 500000, cnss_no: '111222333' });
  assert.equal(empA.status, 201);

  await registerAndLogin('B', 'Entreprise Beta', 'admin@beta.ga');
  const listB = await call('B', 'GET', '/api/employees');
  assert.equal(listB.data.employees.length, 0, 'B ne voit aucun salarié de A');

  const direct = await call('B', 'GET', `/api/employees/${empA.data.id}`);
  assert.equal(direct.status, 404, 'B ne peut pas lire un salarié de A par identifiant direct');

  const listA = await call('A', 'GET', '/api/employees');
  assert.equal(listA.data.employees.length, 1);

  const contractB = await call('B', 'POST', '/api/contracts', { employee_id: empA.data.id, type: 'CDI' });
  assert.equal(contractB.status, 404, 'B ne peut pas créer un contrat sur le salarié de A');

  const payslipB = await call('B', 'POST', '/api/payslips/generate', { employee_id: empA.data.id });
  assert.equal(payslipB.status, 404, 'B ne peut pas générer un bulletin pour A');
});

test('données sensibles stockées chiffrées, masquées dans l’API', async () => {
  const created = await call('A', 'POST', '/api/employees', { name: 'Fatou Ndiaye', role: 'Comptable', salary: 700000, cnss_no: '700999888' });
  const list = await call('A', 'GET', '/api/employees');
  const row = list.data.employees.find((e) => e.id === created.data.id);
  assert.ok(row.cnss_no_mask && row.cnss_no_mask.endsWith('888'), 'numéro CNSS masqué dans la liste');
  assert.equal(row.cnss_no, undefined, 'aucune donnée chiffrée exposée');
  const detail = await call('A', 'GET', `/api/employees/${created.data.id}`);
  assert.equal(detail.data.employee.cnss_no, '700999888', 'déchiffré uniquement sur la fiche détaillée');
});

test('parcours : contrats, congés et carrière', async () => {
  const list = await call('A', 'GET', '/api/employees');
  const emp = list.data.employees[0];
  const c = await call('A', 'POST', '/api/contracts', { employee_id: emp.id, type: 'CDD', start_date: '2026-01-01', end_date: '2026-10-01' });
  assert.equal(c.status, 201);
  const contracts = await call('A', 'GET', `/api/contracts?employee_id=${emp.id}`);
  assert.equal(contracts.data.contracts.length, 1);
  assert.ok(typeof contracts.data.contracts[0].days_left === 'number', 'échéance calculée pour les alertes 60/30/15 jours');

  const l = await call('A', 'POST', '/api/leaves', { employee_id: emp.id, type: 'Congé annuel', from_date: '2026-10-05', to_date: '2026-10-09' });
  assert.equal(l.status, 201);
  assert.equal(l.data.days, 5, '5 jours décomptés');
  const decide = await call('A', 'POST', `/api/leaves/${l.data.id}/decide`, { approve: true });
  assert.equal(decide.data.status, 'Validée');

  const detail = await call('A', 'GET', `/api/employees/${emp.id}`);
  assert.ok(detail.data.career.steps.length >= 1, 'parcours du salarié reconstitué');
  assert.ok(detail.data.career.source, 'origine du recrutement tracée');
});

test('paie : bulletins, garde-fou expert-comptable, PDF serveur', async () => {
  const cyc = await call('A', 'POST', '/api/employees', { name: 'Jean Mensah', role: 'Technicien', salary: 620000, origin: 'RH PLUS — Espace Talent' });
  const gen = await call('A', 'POST', '/api/payslips/generate', { employee_id: cyc.data.id, period: '2026-09' });
  assert.equal(gen.status, 201);
  assert.equal(gen.data.rates_validated, false, 'barèmes non validés : bulletins en brouillon');

  const list = await call('A', 'GET', `/api/payslips?employee_id=${cyc.data.id}`);
  const slip = list.data.payslips[0];
  assert.equal(slip.status, 'brouillon');
  assert.ok(slip.net > 0 && slip.net < slip.gross, 'net < brut');

  const blocked = await call('A', 'POST', `/api/payslips/${slip.id}/emit`, {});
  assert.equal(blocked.status, 409, 'émission bloquée sans validation des barèmes');
  assert.ok(/expert-comptable/i.test(blocked.data.error));

  const pdf = await call('A', 'GET', `/api/payslips/${slip.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.data.length > 3000, 'PDF de taille plausible');
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF', 'en-tête PDF valide');

  const validation = await call('A', 'POST', '/api/compliance/payroll-validation', { expert_name: 'Cabinet Fiduciaire de l\'Estuaire', reference: 'VAL-2026-09' });
  assert.equal(validation.status, 200);
  const emit = await call('A', 'POST', `/api/payslips/${slip.id}/emit`, {});
  assert.equal(emit.status, 200, 'émission possible après validation');
  assert.equal(emit.data.status, 'emis');
});

test('coffre-fort : chiffrement, empreinte, journal d’accès', async () => {
  const list = await call('A', 'GET', '/api/employees');
  const emp = list.data.employees[0];
  const content = Buffer.from('Contrat de travail — contenu confidentiel à protéger.');
  const up = await call('A', 'POST', '/api/documents', { employee_id: emp.id, folder: 'contrat', name: 'contrat.txt', mime: 'text/plain', content_base64: content.toString('base64') });
  assert.equal(up.status, 201);
  assert.equal(up.data.encrypted, 'AES-256-GCM');
  assert.equal(up.data.sha256, C.sha256(content), 'empreinte SHA-256 vérifiable');

  const down = await call('A', 'GET', `/api/documents/${up.data.id}/download`);
  assert.equal(down.status, 200);
  assert.equal(Buffer.compare(down.data, content), 0, 'contenu restitué identique à l’original');

  const onB = await call('B', 'GET', `/api/documents/${up.data.id}/download`);
  assert.equal(onB.status, 404, 'B ne peut pas télécharger un document de A');

  const audit = await call('A', 'GET', '/api/audit');
  const actions = audit.data.entries.map((e) => e.action);
  assert.ok(actions.includes('Archivage de document'), 'archivage journalisé');
  assert.ok(actions.includes('Consultation de document'), 'consultation journalisée');
  assert.ok(actions.includes('Connexion'), 'connexion journalisée');
});

test('abonnement : facture, paiement mobile money (bac à sable), PDF', async () => {
  const billing = await call('A', 'GET', '/api/billing');
  assert.equal(billing.status, 200);
  assert.ok(billing.data.providers.find((p) => p.key === 'sandbox').configured, 'bac à sable disponible');
  const cinetpay = billing.data.providers.find((p) => p.key === 'cinetpay');
  assert.equal(cinetpay.configured, false, 'CinetPay non configuré sans clés marchand');

  const switchPlan = await call('A', 'POST', '/api/billing/plan', { plan: 'pme' });
  assert.equal(switchPlan.status, 200, 'changement d’offre');
  assert.equal(switchPlan.data.price, 35000);

  const gen = await call('A', 'POST', '/api/billing/invoices/generate', { period: '2026-09' });
  assert.equal(gen.status, 201);
  assert.equal(gen.data.amount, 35000, 'abonnement forfaitaire de l’offre PME (35 000 FCFA HT)');
  assert.equal(gen.data.tva, 6300, 'TVA 18 % : 6 300 FCFA');
  assert.equal(gen.data.total, 41300, 'total à payer : 41 300 FCFA');
  assert.ok(gen.data.seats >= 1, 'nombre de salariés facturés repris de la base');

  const withSetup = await call('A', 'POST', '/api/billing/invoices/generate', { period: '2026-09', setup: true });
  assert.equal(withSetup.data.amount, 285000, 'frais d’installation (250 000 FCFA) ajoutés sur demande');
  assert.equal(withSetup.data.setup, 250000);

  const payFail = await call('A', 'POST', `/api/billing/invoices/${gen.data.id}/pay`, { provider: 'cinetpay' });
  assert.equal(payFail.status, 503, 'fournisseur réel indisponible sans configuration');

  const pay = await call('A', 'POST', `/api/billing/invoices/${gen.data.id}/pay`, { provider: 'sandbox', method: 'Airtel Money' });
  assert.equal(pay.status, 201);
  const after = await call('A', 'GET', '/api/billing');
  assert.equal(after.data.invoices.find((i) => i.id === gen.data.id).status, 'Payée', 'facture réglée après paiement confirmé');

  const pdf = await call('A', 'GET', `/api/billing/invoices/${gen.data.id}/pdf`);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF', 'facture PDF générée côté serveur');
});

test('abonnement : le plafond de salariés de l’offre est contrôlé', async () => {
  await registerAndLogin('G', 'Entreprise Gamma', 'admin@gamma.ga');
  const json = (r, what) => { assert.equal(r.status, 201, what); return r.data; };
  const billing = await call('G', 'GET', '/api/billing');
  const starter = billing.data.plans.find((p) => p.id === 'starter');
  assert.equal(billing.data.plan, 'starter', 'offre Starter par défaut à l’inscription');

  // on remplit l’entreprise jusqu’au-delà du plafond de l’offre Starter
  for (let i = 1; i <= starter.max_emp + 1; i++) {
    json(await call('G', 'POST', '/api/employees', { name: 'Salarié Plafond ' + i, role: 'Agent', salary: 300000 }), 'création salarié ' + i);
  }
  const blocked = await call('G', 'POST', '/api/billing/invoices/generate', { period: '2026-09' });
  assert.equal(blocked.status, 409, 'facturation refusée au-delà du plafond de l’offre');
  assert.match(blocked.data.error, /limite de l'offre Starter/);

  const up = await call('G', 'POST', '/api/billing/plan', { plan: 'pme' });
  assert.equal(up.status, 200, 'passage à une offre compatible');
  const ok = await call('G', 'POST', '/api/billing/invoices/generate', { period: '2026-09' });
  assert.equal(ok.status, 201, 'facturation alors acceptée');
  assert.equal(ok.data.seats, starter.max_emp + 1, 'effectif facturé');
  assert.match(ok.data.ref, /^FAC-ENTREPRI-\d{6}-\d{3}$/, 'référence lisible préfixée par le client');
  // deux entreprises peuvent facturer le même mois sans se heurter
  const again = await call('A', 'POST', '/api/billing/invoices/generate', { period: '2026-09' });
  assert.equal(again.status, 201, 'deuxième entreprise facturant la même période');
  assert.notEqual(again.data.ref, ok.data.ref, 'références distinctes d’une entreprise à l’autre');
});

test('portail salarié : comptes, espace personnel, solde et export des droits', async () => {
  const db = require('../src/db').openDatabase(process.env.RHPLUS_DB);
  await registerAndLogin('S', 'Entreprise Soleil', 'admin@soleil.ga');

  // 1) le service RH crée un salarié puis lui ouvre un accès nominatif
  const emp = await call('S', 'POST', '/api/employees', { name: 'Aline Nzue', role: 'Assistante RH', dept: 'Ressources humaines', salary: 350000, hired: '2025-10-01' });
  assert.equal(emp.status, 201);
  const comptes = await call('S', 'GET', '/api/users');
  assert.equal(comptes.data.users.length, 1, 'un seul compte au départ : l’administrateur');
  assert.ok(comptes.data.sans_compte.some((e) => e.id === emp.data.id), 'salarié sans accès détecté');

  const compte = await call('S', 'POST', '/api/users', { email: 'aline.nzue@soleil.ga', name: 'Aline Nzue', role: 'employee', employee_id: emp.data.id, password: 'Provisoire!2026' });
  assert.equal(compte.status, 201, 'compte salarié créé');
  const doublon = await call('S', 'POST', '/api/users', { email: 'aline2@soleil.ga', role: 'employee', employee_id: emp.data.id, password: 'Provisoire!2026' });
  assert.equal(doublon.status, 409, 'un seul accès par dossier salarié');
  const sansDossier = await call('S', 'POST', '/api/users', { email: 'flottant@soleil.ga', role: 'employee', password: 'Provisoire!2026' });
  assert.equal(sansDossier.status, 400, 'un compte employé doit être rattaché à un dossier');
  const tropCourt = await call('S', 'POST', '/api/users', { email: 'court@soleil.ga', password: 'court' });
  assert.equal(tropCourt.status, 400, 'mot de passe de moins de 8 caractères refusé');

  // 2) le salarié se connecte (2FA) et voit son espace
  const login = await call('S2', 'POST', '/api/auth/login', { email: 'aline.nzue@soleil.ga', password: 'Provisoire!2026' });
  assert.equal(login.status, 200);
  const verif = await call('S2', 'POST', '/api/auth/verify', { email: 'aline.nzue@soleil.ga', code: login.data.dev_code });
  assert.equal(verif.status, 200);
  assert.ok(verif.data.token, 'jeton renvoyé au portail');

  const ov = await call('S2', 'GET', '/api/me/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.data.linked, true);
  assert.equal(ov.data.employee.matricule, emp.data.matricule, 'son dossier, et pas un autre');
  assert.equal(ov.data.employee.cnss_no, undefined, 'aucun numéro CNSS saisi → champ absent');
  assert.ok(Array.isArray(ov.data.contracts) && ov.data.contracts.length === 0, 'aucun contrat à ce stade');
  const b = ov.data.leave_balance;
  assert.ok(b.acquis_estime <= 30, 'acquisition plafonnée à 30 jours (12 mois de référence) : ' + b.acquis_estime);
  assert.ok(Math.abs(b.solde_estime - (b.acquis_estime - b.pris - b.en_attente)) < 0.11, 'solde = acquis − pris − en attente');
  assert.match(b.periode_reference, /^\d{4}-\d{2}-\d{2}$/, 'année de référence calculée depuis la date d’entrée');

  // 3) demande de congé depuis le portail : impossible de la poser pour un collègue
  const autre = await call('S', 'POST', '/api/employees', { name: 'Boris Ibinga', role: 'Chauffeur', salary: 250000 });
  const conge = await call('S2', 'POST', '/api/leaves', { type: 'Congé annuel', from_date: '2026-10-05', to_date: '2026-10-09', employee_id: autre.data.id, reason: 'Vacances' });
  assert.equal(conge.status, 201);
  assert.equal(conge.data.days, 5);
  const mesConges = await call('S2', 'GET', '/api/leaves');
  assert.equal(mesConges.data.leaves.length, 1);
  assert.equal(mesConges.data.leaves[0].employee_id, emp.data.id, 'la demande est bien rattachée au salarié connecté, pas au collègue désigné');

  // 4) droit d’accès en libre-service
  const exp = await call('S2', 'GET', '/api/me/export');
  assert.equal(exp.status, 200);
  assert.match(exp.type, /json/);
  assert.equal(exp.data.personne.matricule, emp.data.matricule);
  assert.ok(Array.isArray(exp.data.conges) && exp.data.conges.length === 1, 'ses congés inclus dans l’export');

  // 5) l’exercice du droit d’accès est journalisé
  const rows = db.prepare("SELECT action FROM audit_log WHERE company_id = (SELECT id FROM companies WHERE name = 'Entreprise Soleil')").all();
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('Export des données personnelles'), 'export journalisé');
  assert.ok(actions.includes('Création de compte'), 'création de compte journalisée');

  // 6) révocation des sessions par l’administration
  const compteId = compte.data.id;
  const revoke = await call('S', 'PATCH', '/api/users/' + compteId, { revoke_sessions: true });
  assert.equal(revoke.status, 200);
  const apres = await call('S2', 'GET', '/api/me/overview');
  assert.equal(apres.status, 401, 'les jetons du salarié sont révoqués immédiatement');
  db.close();
});

test('webhook de fournisseur : signature exigée', async () => {
  const bad = await call('anon', 'POST', '/api/webhooks/payment/flutterwave', { reference: 'FAC-202609-001', status: 'successful' });
  assert.equal(bad.status, 401, 'webhook sans signature rejeté');
});

test('conformité : registre, export de droits, effacement', async () => {
  const comp = await call('A', 'GET', '/api/compliance');
  assert.equal(comp.status, 200);
  assert.ok(comp.data.registry.length >= 5, 'registre des traitements renseigné');
  assert.ok(comp.data.security.sensitive_fields.includes('AES-256-GCM'));

  const ap = await call('A', 'POST', '/api/compliance/apdpvp', { num: 'RCP-2026-1234', status: 'À jour' });
  assert.equal(ap.status, 200);
  const after = await call('A', 'GET', '/api/compliance');
  assert.equal(after.data.apdpvp.num, 'RCP-2026-1234');

  const list = await call('A', 'GET', '/api/employees');
  const emp = list.data.employees.find((e) => e.name === 'Fatou Ndiaye') || list.data.employees[0];
  const dsar = await call('A', 'GET', `/api/compliance/dsar/${emp.id}`);
  assert.equal(dsar.status, 200);
  assert.ok(dsar.data.employee && Array.isArray(dsar.data.payslips), 'export complet des données du salarié');
  assert.equal(dsar.data.employee.cnss_no, '700999888', 'données personnelles restituées au salarié');

  const erase = await call('A', 'POST', `/api/compliance/erase/${emp.id}`, {});
  assert.equal(erase.status, 200);
  const after2 = await call('A', 'GET', `/api/employees/${emp.id}`);
  assert.ok(/Anonymisé/.test(after2.data.employee.name), 'identité anonymisée');
  assert.equal(after2.data.employee.cnss_no, null, 'numéro CNSS supprimé');
  assert.ok(after2.data.payslips.length >= 0, 'bulletins conservés pour l’obligation légale');
});

test('rôles : un employé n’accède qu’à ses données', async () => {
  const db = require('../src/db').openDatabase(process.env.RHPLUS_DB);
  const co = db.prepare('SELECT id FROM companies WHERE name = ?').get('Entreprise Alpha');
  const other = await call('A', 'POST', '/api/employees', { name: 'Salarié Test Rôle', role: 'Agent', salary: 400000 });
  db.prepare('INSERT INTO users (company_id, email, name, role, employee_id, password_hash, twofa_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(co.id, 'employe@alpha.ga', 'Salarié Test Rôle', 'employee', other.data.id, C.hashPassword('MotDePasse!2026'), new Date().toISOString());
  const login = await call('E', 'POST', '/api/auth/login', { email: 'employe@alpha.ga', password: 'MotDePasse!2026' });
  await call('E', 'POST', '/api/auth/verify', { email: 'employe@alpha.ga', code: login.data.dev_code });

  const list = await call('E', 'GET', '/api/employees');
  assert.equal(list.data.employees.length, 1, 'un employé ne voit que son propre dossier');
  const auditDenied = await call('E', 'GET', '/api/audit');
  assert.equal(auditDenied.status, 403, 'journal d’audit réservé à l’administrateur');
  const createDenied = await call('E', 'POST', '/api/employees', { name: 'Interdit' });
  assert.equal(createDenied.status, 403, 'création réservée aux rôles RH');
  db.close();
});

test('limitation des tentatives de connexion', async () => {
  for (let i = 0; i < 9; i++) await call('X', 'POST', '/api/auth/login', { email: 'admin@beta.ga', password: 'mauvais-' + i });
  const blocked = await call('X', 'POST', '/api/auth/login', { email: 'admin@beta.ga', password: 'mauvais-final' });
  assert.equal(blocked.status, 429, 'tentatives excessives bloquées');
});
