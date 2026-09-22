'use strict';
/* API métier — toutes les routes sont cloisonnées par entreprise (req.tenant).
   Chaque écriture est journalisée dans le journal d'audit. */
const express = require('express');
const C = require('./crypto');
const CONFORMITE = require('./compliance');
const RATES = require('./rates');
const { audit, nowISO } = require('./db');
const payroll = require('./payroll');
const payments = require('./payments');
const { safeCompany, requireAuth, requireMinRole } = require('./auth');
const { payslipPdf, invoicePdf } = require('./payslip-pdf');

const PLANS = [
  { id: 'starter', name: 'Starter', price_cents: 1250000, max_emp: 15 },
  { id: 'pme', name: 'PME', price_cents: 3500000, max_emp: 50 },
  { id: 'entreprise', name: 'Entreprise', price_cents: 9000000, max_emp: 150 },
];
const SETUP_FEE_CENTS = 25000000;
const TVA = 0.18;
const RETENTION = CONFORMITE.RETENTION;

function actorOf(req) { return { user_id: req.user.id, actor: req.user.email, role: req.user.role, ip: req.ip }; }
function cents(v) { return Math.round(Number(v || 0) * 100); }
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (d) => Math.ceil((new Date(d) - new Date(today())) / 86400000);

function registerRoutes(app, db) {
  const company = (req) => db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.company_id);

  /* ================= Tableau de bord ================= */
  app.get('/api/dashboard', requireMinRole('manager'), (req, res) => {
    const t = req.tenant; const co = company(req);
    const employees = t.employees();
    const contracts = t.contracts();
    const payslips = t.payslips();
    const leaves = t.leaves('En attente');
    const invoices = t.invoices();
    const alerts = contracts
      .filter((c) => c.end_date)
      .map((c) => ({ contract: c, days: daysUntil(c.end_date) }))
      .filter((x) => x.days <= 60)
      .sort((a, b) => a.days - b.days)
      .map((x) => {
        const e = t.employee(x.contract.employee_id) || {};
        const level = x.days <= 15 ? 'critique' : x.days <= 30 ? 'eleve' : 'modere';
        return { employee: e.name, employee_id: e.id, type: x.contract.type, end_date: x.contract.end_date, days: x.days, level };
      });
    res.json({
      company: safeCompany(co),
      kpi: {
        effectif: employees.length,
        masse_salariale: employees.reduce((s, e) => s + e.salary_cents, 0) / 100,
        contrats_a_echeance_60j: alerts.length,
        conges_en_attente: leaves.length,
        bulletins_generes: payslips.length,
        factures_impayees: invoices.filter((i) => i.status !== 'Payée').length,
      },
      alerts,
      payroll: { validated: !!co.payroll_validated_by, validated_by: co.payroll_validated_by, validated_at: co.payroll_validated_at },
      compliance: { apdpvp_status: co.apdpvp_status, apdpvp_num: co.apdpvp_num, hosting: co.hosting },
      recent_audit: t.auditLog(8),
    });
  });

  /* ================= Espace salarié (portail) =================
     Un salarié ne voit que son propre dossier : profil, contrats, congés,
     bulletins, documents chiffrés, parcours et droits sur ses données. */
  const meEmployee = (req) => (req.user.employee_id ? req.tenant.employee(req.user.employee_id) : null);

  app.get('/api/me/overview', requireAuth, (req, res) => {
    const co = company(req);
    const e = meEmployee(req);
    if (!e) return res.json({ linked: false, company: safeCompany(co), reason: 'Aucun dossier salarié associé à ce compte.' });

    const contracts = req.tenant.contracts(e.id)
      .map((c) => Object.assign({}, c, { days_left: c.end_date ? daysUntil(c.end_date) : null }));
    const leaves = req.tenant.leaves().filter((l) => l.employee_id === e.id).sort((a, b) => (a.from_date < b.from_date ? 1 : -1));
    const payslips = req.tenant.payslips(e.id).map(summarizePayslip).sort((a, b) => (a.period < b.period ? 1 : -1));
    const documents = req.tenant.documents(e.id);

    // Solde indicatif calculé sur l'ANNÉE DE RÉFÉRENCE en cours (anniversaire d'entrée) :
    // 2,5 jours ouvrables par mois de présence, plafonné à 12 mois (30 jours).
    // Le décompte officiel reste celui du service RH, conforme à la convention applicable.
    const months = Math.max(0, Math.floor((Date.now() - new Date(e.hired).getTime()) / (30.44 * 86400000)));
    const anniversaire = (() => {
      const h = new Date(e.hired); const now = new Date();
      const d = new Date(now.getFullYear(), h.getMonth(), h.getDate());
      if (d > now) d.setFullYear(d.getFullYear() - 1);
      return d;
    })();
    const depuis = anniversaire.toISOString().slice(0, 10);
    const moisReference = Math.max(0, Math.min(12, Math.floor((Date.now() - anniversaire.getTime()) / (30.44 * 86400000))));
    const acquis = Math.round(moisReference * 2.5 * 10) / 10;
    const pris = leaves.filter((l) => l.status === 'Validée' && /annuel/i.test(l.type) && l.from_date >= depuis)
      .reduce((sum, l) => sum + l.days, 0);
    const enAttente = leaves.filter((l) => l.status === 'En attente').reduce((sum, l) => sum + l.days, 0);

    res.json({
      linked: true,
      company: safeCompany(co),
      employee: Object.assign(withMask(e), { cnss_no: C.decryptField(e.cnss_no_enc) }),
      seniority_months: months,
      contracts,
      leaves,
      payslips,
      documents,
      career: careerOf(req.tenant, e),
      alerts: contracts.filter((c) => c.days_left !== null && c.days_left <= 60)
        .map((c) => ({ type: c.type, end_date: c.end_date, days: c.days_left, level: c.days_left <= 15 ? 'critique' : c.days_left <= 30 ? 'eleve' : 'modere' })),
      leave_balance: {
        acquis_estime: acquis, pris, en_attente: enAttente,
        solde_estime: Math.round((acquis - pris - enAttente) * 10) / 10,
        periode_reference: depuis, mois_reference: moisReference,
      },
      payroll: { validated: !!co.payroll_validated_by, validated_by: co.payroll_validated_by || null },
    });
  });

  /* Droit d'accès en libre-service : le salarié exporte lui-même ses données (loi n°001/2011). */
  app.get('/api/me/export', requireAuth, (req, res) => {
    const e = meEmployee(req);
    if (!e) return res.status(404).json({ error: 'Aucun dossier salarié associé à ce compte.' });
    const data = {
      exporte_le: nowISO(),
      personne: {
        matricule: e.matricule, nom: e.name, poste: e.role, service: e.dept, contrat: e.contract,
        statut: e.status, date_entree: e.hired, email: e.email, telephone: e.phone,
        numero_cnss: C.decryptField(e.cnss_no_enc), canal_de_recrutement: e.origin,
      },
      entreprise: safeCompany(company(req)),
      contrats: req.tenant.contracts(e.id),
      conges: req.tenant.leaves().filter((l) => l.employee_id === e.id),
      bulletins: req.tenant.payslips(e.id).map((p) => Object.assign(summarizePayslip(p), { detail: JSON.parse(p.detail_json || 'null') })),
      documents: req.tenant.documents(e.id).map((d) => ({ nom: d.name, dossier: d.folder, taille: d.size, empreinte_sha256: d.sha256, depose_le: d.created_at })),
      parcours: careerOf(req.tenant, e),
      observations: 'Export remis au titre du droit d’accès (loi n°001/2011). Les pièces du coffre-fort ne sont pas incluses : elles restent téléchargeables une à une, chaque accès étant journalisé.',
    };
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Export des données personnelles', details: `${e.name} — droit d’accès exercé depuis le portail salarié` });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mes_donnees_${e.matricule}.json"`);
    res.send(JSON.stringify(data, null, 2));
  });

  /* ================= Employés ================= */
  app.get('/api/employees', requireAuth, (req, res) => {
    let rows = req.tenant.employees();
    if (req.user.role === 'employee') rows = rows.filter((e) => e.id === req.user.employee_id);
    res.json({ employees: rows.map((e) => withMask(e)) });
  });

  app.get('/api/employees/:id', requireAuth, (req, res) => {
    const e = req.tenant.employee(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Salarié introuvable dans cette entreprise.' });
    if (req.user.role === 'employee' && req.user.employee_id !== e.id) return res.status(403).json({ error: 'Accès limité à votre propre dossier.' });
    res.json({
      employee: Object.assign(withMask(e), { cnss_no: C.decryptField(e.cnss_no_enc) }),
      contracts: req.tenant.contracts(e.id),
      leaves: req.tenant.leaves().filter((l) => l.employee_id === e.id),
      documents: req.tenant.documents(e.id),
      payslips: req.tenant.payslips(e.id).map(summarizePayslip),
      career: careerOf(req.tenant, e),
    });
  });

  app.post('/api/employees', requireMinRole('rh'), (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Nom du salarié requis.' });
    const count = req.tenant.employees().length;
    const matricule = b.matricule || 'RHP-' + String(count + 1).padStart(4, '0');
    try {
      const info = db.prepare(`INSERT INTO employees (company_id, matricule, name, role, dept, contract, status, email, phone, hired, salary_cents, cnss_no_enc, origin, manager_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        req.user.company_id, matricule, b.name, b.role || null, b.dept || null, b.contract || 'CDI', b.status || 'Présent',
        b.email || null, b.phone || null, b.hired || today(), cents(b.salary), b.cnss_no ? C.encryptField(b.cnss_no) : null,
        b.origin || 'Non renseignée', b.manager_id || null, nowISO(),
      );
      const id = Number(info.lastInsertRowid);
      audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Création de salarié', details: `${b.name} (${matricule}) — origine : ${b.origin || 'non renseignée'}` });
      res.status(201).json({ id, matricule });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ce matricule existe déjà.' });
      throw e;
    }
  });

  app.patch('/api/employees/:id', requireMinRole('rh'), (req, res) => {
    const e = req.tenant.employee(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Salarié introuvable.' });
    const b = req.body || {};
    const fields = [];
    const params = [];
    ['name', 'role', 'dept', 'contract', 'status', 'email', 'phone', 'hired'].forEach((f) => {
      if (b[f] !== undefined) { fields.push(`${f} = ?`); params.push(b[f]); }
    });
    if (b.salary !== undefined) { fields.push('salary_cents = ?'); params.push(cents(b.salary)); }
    if (b.cnss_no !== undefined) { fields.push('cnss_no_enc = ?'); params.push(b.cnss_no ? C.encryptField(b.cnss_no) : null); }
    if (!fields.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    params.push(e.id, req.user.company_id);
    db.prepare(`UPDATE employees SET ${fields.join(', ')} WHERE id = ? AND company_id = ?`).run(...params);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Modification de salarié', details: `${e.name} — champs : ${Object.keys(b).join(', ')}` });
    res.json({ ok: true });
  });

  app.delete('/api/employees/:id', requireMinRole('admin'), (req, res) => {
    const e = req.tenant.employee(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Salarié introuvable.' });
    db.prepare('DELETE FROM employees WHERE id = ? AND company_id = ?').run(e.id, req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Suppression de salarié', details: e.name });
    res.json({ ok: true });
  });

  /* ================= Contrats ================= */
  app.get('/api/contracts', requireAuth, (req, res) => {
    let employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
    if (req.user.role === 'employee') employeeId = req.user.employee_id || -1;   // cloisonné à son dossier
    const list = req.tenant.contracts(employeeId).map((c) => Object.assign({}, c, { days_left: c.end_date ? daysUntil(c.end_date) : null }));
    res.json({ contracts: req.user.role === 'employee' ? list.filter((c) => c.employee_id === req.user.employee_id) : list });
  });

  app.post('/api/contracts', requireMinRole('rh'), (req, res) => {
    const b = req.body || {};
    const e = req.tenant.employee(Number(b.employee_id));
    if (!e) return res.status(404).json({ error: 'Salarié introuvable dans cette entreprise.' });
    const info = db.prepare('INSERT INTO contracts (company_id, employee_id, type, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.company_id, e.id, b.type || 'CDI', b.start_date || today(), b.end_date || null, b.status || 'En cours', nowISO());
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Création de contrat', details: `${e.name} — ${b.type || 'CDI'}${b.end_date ? ' jusqu\'au ' + b.end_date : ''}` });
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  /* ================= Comptes & accès =================
     Le service RH ouvre un accès nominatif aux salariés : chacun ne voit que
     son dossier (portail salarié). Les rôles déterminent le reste des droits. */
  const ROLES = ['admin', 'rh', 'manager', 'employee'];
  const publicAccount = (u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, employee_id: u.employee_id,
    twofa_enabled: !!u.twofa_enabled, last_login_at: u.last_login_at, created_at: u.created_at,
  });

  app.get('/api/users', requireMinRole('rh'), (req, res) => {
    const rows = db.prepare('SELECT * FROM users WHERE company_id = ? ORDER BY id').all(req.user.company_id);
    const employees = req.tenant.employees();
    res.json({
      users: rows.map((u) => Object.assign(publicAccount(u), {
        employee_name: u.employee_id ? (employees.find((e) => e.id === u.employee_id) || {}).name || null : null,
        matricule: u.employee_id ? (employees.find((e) => e.id === u.employee_id) || {}).matricule || null : null,
      })),
      roles: ROLES,
      sans_compte: employees.filter((e) => !rows.some((u) => u.employee_id === e.id)).map((e) => ({ id: e.id, name: e.name, matricule: e.matricule })),
    });
  });

  app.post('/api/users', requireMinRole('rh'), (req, res) => {
    const b = req.body || {};
    if (!b.email || !b.password) return res.status(400).json({ error: 'Email et mot de passe provisoire requis.' });
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    const email = String(b.email).toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Cet email est déjà utilisé.' });

    const role = ROLES.includes(b.role) ? b.role : 'employee';
    if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Seul un administrateur peut créer un administrateur.' });
    const employeeId = b.employee_id ? Number(b.employee_id) : null;
    if (employeeId && !req.tenant.employee(employeeId)) return res.status(404).json({ error: 'Salarié introuvable dans cette entreprise.' });
    if (role === 'employee' && !employeeId) return res.status(400).json({ error: 'Un compte salarié doit être rattaché à un dossier (portail salarié).' });
    if (employeeId && db.prepare('SELECT id FROM users WHERE company_id = ? AND employee_id = ?').get(req.user.company_id, employeeId)) {
      return res.status(409).json({ error: 'Ce salarié dispose déjà d’un accès.' });
    }

    const info = db.prepare(`INSERT INTO users (company_id, email, name, role, employee_id, password_hash, twofa_enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(req.user.company_id, email, b.name || 'Compte ' + role, role, employeeId, C.hashPassword(String(b.password)), nowISO());
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Création de compte', details: `${email} — rôle ${role}${employeeId ? ' (dossier ' + employeeId + ')' : ''}` });
    res.status(201).json({ id: Number(info.lastInsertRowid), email, role, employee_id: employeeId });
  });

  app.patch('/api/users/:id', requireMinRole('admin'), (req, res) => {
    const b = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(Number(req.params.id), req.user.company_id);
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    if (user.id === req.user.id && (b.role && b.role !== user.role)) return res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre rôle.' });
    if (b.role && !ROLES.includes(b.role)) return res.status(400).json({ error: 'Rôle inconnu.' });
    if (b.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, user.id);
    if (b.password) {
      if (String(b.password).length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(C.hashPassword(String(b.password)), user.id);
    }
    if (b.twofa_enabled !== undefined) db.prepare('UPDATE users SET twofa_enabled = ? WHERE id = ?').run(b.twofa_enabled ? 1 : 0, user.id);
    if (b.revoke_sessions) db.prepare('UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = ?').run(user.id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Modification de compte', details: `${user.email}${b.role ? ' — rôle ' + b.role : ''}${b.password ? ' — mot de passe réinitialisé' : ''}${b.revoke_sessions ? ' — sessions révoquées' : ''}` });
    res.json({ ok: true });
  });

  /* ================= Congés ================= */
  app.get('/api/leaves', requireAuth, (req, res) => {
    let list = req.query.status ? req.tenant.leaves(String(req.query.status)) : req.tenant.leaves();
    if (req.user.role === 'employee') list = list.filter((l) => l.employee_id === req.user.employee_id);
    res.json({ leaves: list });
  });

  app.post('/api/leaves', requireAuth, (req, res) => {
    const b = req.body || {};
    let employeeId = Number(b.employee_id);
    if (req.user.role === 'employee') {
      if (!req.user.employee_id) return res.status(403).json({ error: 'Aucun dossier salarié associé à votre compte.' });
      employeeId = req.user.employee_id;
    }
    const e = req.tenant.employee(employeeId);
    if (!e) return res.status(404).json({ error: 'Salarié introuvable.' });
    if (!b.from_date || !b.to_date) return res.status(400).json({ error: 'Dates de début et de fin requises.' });
    const days = Math.max(1, Math.ceil((new Date(b.to_date) - new Date(b.from_date)) / 86400000) + 1);
    const info = db.prepare('INSERT INTO leaves (company_id, employee_id, type, from_date, to_date, days, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.company_id, employeeId, b.type || 'Congé annuel', b.from_date, b.to_date, days, 'En attente', b.reason || null, nowISO());
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Demande de congé', details: `${e.name} — ${days} jour(s) du ${b.from_date} au ${b.to_date}` });
    res.status(201).json({ id: Number(info.lastInsertRowid), days });
  });

  app.post('/api/leaves/:id/decide', requireMinRole('manager'), (req, res) => {
    const l = req.tenant.leave(Number(req.params.id));
    if (!l) return res.status(404).json({ error: 'Demande introuvable.' });
    const approve = !!(req.body && req.body.approve);
    db.prepare('UPDATE leaves SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND company_id = ?')
      .run(approve ? 'Validée' : 'Refusée', req.user.id, nowISO(), l.id, req.user.company_id);
    const e = req.tenant.employee(l.employee_id) || {};
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: approve ? 'Validation de congé' : 'Refus de congé', details: `${e.name} — ${l.days} jour(s)` });
    res.json({ ok: true, status: approve ? 'Validée' : 'Refusée' });
  });

  /* ================= Paie ================= */
  app.get('/api/payroll/params', requireAuth, (req, res) => {
    const co = company(req);
    const p = payroll.paramsFor(co.country);
    res.json({ country: co.country, currency: p.currency, law: p.law, rates: p.rates, majors: p.overtime_majorations, certified: !!p.certified, warning: p.note, validated_by: co.payroll_validated_by, validated_at: co.payroll_validated_at });
  });

  app.get('/api/payslips', requireAuth, (req, res) => {
    const asked = req.user.role === 'employee' ? (req.user.employee_id || -1) : (req.query.employee_id ? Number(req.query.employee_id) : null);
    const list = req.tenant.payslips(asked).map(summarizePayslip)
      .filter((p) => req.user.role !== 'employee' || p.employee_id === req.user.employee_id);
    res.json({ payslips: list });
  });

  app.post('/api/payslips/generate', requireMinRole('rh'), (req, res) => {
    const b = req.body || {};
    const period = b.period || new Date().toISOString().slice(0, 7);
    const targets = b.employee_id ? [req.tenant.employee(Number(b.employee_id))] : req.tenant.employees();
    if (targets.some((t) => !t)) return res.status(404).json({ error: 'Salarié introuvable.' });
    const co = company(req);
    const created = [];
    const insert = db.prepare(`INSERT INTO payslips (company_id, employee_id, period, status, gross_cents, net_cents, detail_json, currency, rates_validated, generated_by, created_at)
      VALUES (?, ?, ?, 'brouillon', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, employee_id, period) DO UPDATE SET gross_cents = excluded.gross_cents, net_cents = excluded.net_cents, detail_json = excluded.detail_json, generated_by = excluded.generated_by, created_at = excluded.created_at`);
    const tx = db.transaction(() => {
      for (const e of targets) {
        const p = payroll.computePayslip({ salary: e.salary_cents / 100, country: co.country, overtime: Number(b.overtime || 0) });
        insert.run(req.user.company_id, e.id, period, p.detail.brut, p.totals.net_a_payer, JSON.stringify(p), p.currency, co.payroll_validated_by ? 1 : 0, req.user.id, nowISO());
        created.push({ employee_id: e.id, name: e.name, net: p.totals.net_a_payer });
      }
    });
    tx();
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Génération de bulletins', details: `${created.length} bulletin(s) — période ${period}${co.payroll_validated_by ? '' : ' (brouillon : barèmes non validés)'}` });
    res.status(201).json({ period, count: created.length, created, rates_validated: !!co.payroll_validated_by, warning: co.payroll_validated_by ? null : payroll.paramsFor(co.country).note });
  });

  app.get('/api/payslips/:id/pdf', requireAuth, (req, res) => {
    const row = req.tenant.payslip(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Bulletin introuvable.' });
    const e = req.tenant.employee(row.employee_id);
    if (req.user.role === 'employee' && req.user.employee_id !== e.id) return res.status(403).json({ error: 'Accès limité à vos propres bulletins.' });
    const co = company(req);
    const payslip = JSON.parse(row.detail_json);
    const pdf = payslipPdf({
      company: Object.assign({}, co, { cnss_no: co.cnss_no ? C.decryptField(co.cnss_no) : null }),
      employee: Object.assign({}, e, { cnss_no: e.cnss_no_enc ? C.decryptField(e.cnss_no_enc) : null }),
      period: row.period, payslip: Object.assign(payslip, { status: row.status }), generatedAt: row.created_at.slice(0, 10),
    });
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Téléchargement de bulletin PDF', details: `${e.name} — ${row.period}` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Bulletin_${e.name.replace(/\s+/g, '_')}_${row.period}.pdf"`);
    res.send(pdf);
  });

  app.post('/api/payslips/:id/emit', requireMinRole('admin'), (req, res) => {
    const row = req.tenant.payslip(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Bulletin introuvable.' });
    const co = company(req);
    const validation = RATES.validationPour(db, co);
    if (!validation.a_jour) return res.status(409).json(RATES.messageBlocage(co, validation));
    db.prepare('UPDATE payslips SET status = ?, rates_validated = 1 WHERE id = ? AND company_id = ?').run('emis', row.id, req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Émission de bulletin', details: `Bulletin n°${row.id} — ${row.period} — barème ${validation.version} (${validation.source || 'entreprise'})` });
    res.json({ ok: true, status: 'emis' });
  });

  /* ================= Documents (coffre-fort chiffré) ================= */
  app.get('/api/documents', requireAuth, (req, res) => {
    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
    if (req.user.role === 'employee' && req.user.employee_id !== employeeId) return res.status(403).json({ error: 'Accès limité à vos propres documents.' });
    res.json({ documents: req.tenant.documents(employeeId) });
  });

  app.post('/api/documents', requireMinRole('rh'), (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.content_base64) return res.status(400).json({ error: 'Nom et contenu du document requis.' });
    const buf = Buffer.from(b.content_base64, 'base64');
    if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Document trop volumineux (limite 8 Mo).' });
    const e = b.employee_id ? req.tenant.employee(Number(b.employee_id)) : null;
    if (b.employee_id && !e) return res.status(404).json({ error: 'Salarié introuvable.' });
    const enc = C.encryptBuffer(buf);
    const info = db.prepare(`INSERT INTO documents (company_id, employee_id, folder, name, mime, size, sha256, iv, tag, ciphertext, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.user.company_id, e ? e.id : null, b.folder || 'perso', b.name, b.mime || 'application/octet-stream',
      buf.length, C.sha256(buf), enc.iv, enc.tag, enc.ciphertext, req.user.id, nowISO(),
    );
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Archivage de document', details: `${b.name} — ${e ? e.name : 'entreprise'} (coffre chiffré, dossier ${b.folder || 'perso'})` });
    res.status(201).json({ id: Number(info.lastInsertRowid), sha256: C.sha256(buf), encrypted: 'AES-256-GCM' });
  });

  app.get('/api/documents/:id/download', requireAuth, (req, res) => {
    const row = req.tenant.documentRow(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Document introuvable.' });
    if (req.user.role === 'employee' && req.user.employee_id !== row.employee_id) return res.status(403).json({ error: 'Accès refusé.' });
    const buf = C.decryptBuffer(row);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Consultation de document', details: `${row.name} (empreinte ${String(row.sha256).slice(0, 12)}…)` });
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${row.name.replace(/"/g, '')}"`);
    res.send(buf);
  });

  app.delete('/api/documents/:id', requireMinRole('admin'), (req, res) => {
    const row = req.tenant.documentRow(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Document introuvable.' });
    db.prepare('DELETE FROM documents WHERE id = ? AND company_id = ?').run(row.id, req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Destruction de document', details: row.name });
    res.json({ ok: true });
  });

  /* ================= Abonnement & facturation ================= */
  app.get('/api/billing', requireMinRole('manager'), (req, res) => {
    const co = company(req);
    const invoices = req.tenant.invoices();
    res.json({
      plan: co.plan, plans: PLANS, setup_fee: SETUP_FEE_CENTS / 100, tva_rate: TVA,
      seats: req.tenant.employees().length, pay_method: co.pay_method,
      invoices, payments: req.tenant.payments(), providers: payments.availableProviders(),
    });
  });

  app.post('/api/billing/plan', requireMinRole('admin'), (req, res) => {
    const plan = PLANS.find((p) => p.id === (req.body || {}).plan);
    if (!plan) return res.status(400).json({ error: 'Plan inconnu.' });
    const seats = req.tenant.employees().length;
    if (seats > plan.max_emp) return res.status(409).json({ error: `Le plan ${plan.name} est limité à ${plan.max_emp} employés (${seats} actuellement).` });
    db.prepare('UPDATE companies SET plan = ? WHERE id = ?').run(plan.id, req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Changement de plan', details: `Nouveau plan : ${plan.name}` });
    res.json({ plan: plan.id, price: plan.price_cents / 100 });
  });

  app.post('/api/billing/pay-method', requireMinRole('admin'), (req, res) => {
    const method = String((req.body || {}).method || '');
    if (!method) return res.status(400).json({ error: 'Moyen de paiement requis.' });
    db.prepare('UPDATE companies SET pay_method = ? WHERE id = ?').run(method, req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Moyen de paiement', details: method });
    res.json({ pay_method: method });
  });

  app.post('/api/billing/invoices/generate', requireMinRole('admin'), (req, res) => {
    const co = company(req);
    const plan = PLANS.find((p) => p.id === co.plan) || PLANS[0];
    const seats = req.tenant.employees().length;
    const period = (req.body && req.body.period) || new Date().toISOString().slice(0, 7);
    // Abonnement forfaitaire mensuel selon l'offre ; les frais d'installation
    // (SETUP_FEE) ne s'ajoutent que sur demande explicite (première facture).
    if (seats > plan.max_emp) {
      return res.status(409).json({ error: `Effectif (${seats}) supérieur à la limite de l'offre ${plan.name} (${plan.max_emp} salariés) : changez d'offre avant de facturer.` });
    }
    const setup = (req.body && req.body.setup) ? SETUP_FEE_CENTS / 100 : 0;
    const amount_cents = Math.round(plan.price_cents + setup * 100);
    const tva_cents = Math.round(amount_cents * TVA);
    // Numérotation de facture tenue par RH PLUS (émetteur unique) : séquence
    // globale et continue, quel que soit le client. Le code client n'est là que
    // pour la lisibilité : FAC-<CLIENT>-<AAAAMM>-<NNN>
    const tenantCode = String(co.name || 'CLIENT')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')      // accents retirés (Étoile → Etoile)
      .replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ')[0]
      .toUpperCase().slice(0, 8) || 'CLIENT';
    const refBase = 'FAC-' + tenantCode + '-' + period.replace('-', '');
    let seq = Number(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n) + 1;
    let ref = refBase + '-' + String(seq).padStart(3, '0');
    while (db.prepare('SELECT 1 FROM invoices WHERE ref = ?').get(ref)) {
      seq += 1;
      ref = refBase + '-' + String(seq).padStart(3, '0');
    }
    const info = db.prepare('INSERT INTO invoices (company_id, ref, period, seats, amount_cents, tva_cents, status, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.company_id, ref, period, seats, amount_cents, tva_cents, 'À échoir', co.pay_method, nowISO());
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Émission de facture', details: `${ref} — offre ${plan.name}, ${seats} salarié(s), ${amount_cents / 100} ${co.currency} HT${setup ? ' (installation incluse)' : ''}` });
    res.status(201).json({ id: Number(info.lastInsertRowid), ref, plan: plan.name, seats, setup, amount: amount_cents / 100, tva: tva_cents / 100, total: (amount_cents + tva_cents) / 100 });
  });

  app.get('/api/billing/invoices/:id/pdf', requireAuth, (req, res) => {
    const inv = req.tenant.invoice(Number(req.params.id));
    if (!inv) return res.status(404).json({ error: 'Facture introuvable.' });
    const co = company(req);
    const pdf = invoicePdf({ company: Object.assign({}, co, { plan: (PLANS.find((p) => p.id === co.plan) || PLANS[0]).name }), invoice: inv, payments: req.tenant.payments().filter((p) => p.invoice_id === inv.id), generatedAt: new Date().toLocaleDateString('fr-FR') });
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Téléchargement de facture', details: inv.ref });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.ref}.pdf"`);
    res.send(pdf);
  });

  app.post('/api/billing/invoices/:id/pay', requireMinRole('admin'), (req, res, next) => {
    try {
      const inv = req.tenant.invoice(Number(req.params.id));
      if (!inv) return res.status(404).json({ error: 'Facture introuvable.' });
      const providerKey = (req.body && req.body.provider) || require('./config').PAYMENTS.default;
      const method = (req.body && req.body.method) || 'Airtel Money';
      const provider = payments.getProvider(providerKey);
      if (!provider.configured()) return res.status(503).json({ error: `Le fournisseur ${provider.label} n'est pas configuré sur ce serveur.` });
      const co = company(req);
      const initiation = provider.create({
        amount: (inv.amount_cents + inv.tva_cents) / 100, currency: co.currency, reference: inv.ref, method,
        customer: { name: co.name, phone: req.body.phone || null, email: req.user.email },
      });
      const info = db.prepare('INSERT INTO payments (company_id, invoice_id, provider, method, provider_ref, amount_cents, currency, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.user.company_id, inv.id, provider.key, method, initiation.provider_ref, inv.amount_cents + inv.tva_cents, co.currency, initiation.status, JSON.stringify(initiation), nowISO());
      audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Paiement initié', details: `${inv.ref} — ${provider.label} / ${method}` });
      if (initiation.auto_confirm) {
        const pid = Number(info.lastInsertRowid);
        db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?').run('confirmé', nowISO(), pid);
        db.prepare('UPDATE invoices SET status = ?, method = ?, paid_at = ? WHERE id = ?').run('Payée', method, nowISO(), inv.id);
        audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Paiement confirmé', details: `${inv.ref} — ${method} (fournisseur ${provider.key})` });
        return res.status(201).json({ payment_id: pid, status: 'confirmé', invoice_status: 'Payée', instructions: initiation.instructions });
      }
      res.status(201).json({ payment_id: Number(info.lastInsertRowid), status: initiation.status, checkout_url: initiation.checkout_url || null, instructions: initiation.instructions });
    } catch (e) { next(e); }
  });

  /* Webhook fournisseur (sans session : vérifié par signature) */
  app.post('/api/webhooks/payment/:provider', (req, res, next) => {
    try {
      const provider = payments.getProvider(req.params.provider);
      if (!provider.verifyWebhook(req)) return res.status(401).json({ error: 'Signature de webhook invalide.' });
      const body = req.body || {};
      const reference = body.reference || body.ref || (body.data && body.data.reference) || (body.invoice && body.invoice.ref);
      const status = String(body.status || (body.data && body.data.status) || 'confirmé');
      const inv = reference ? db.prepare('SELECT * FROM invoices WHERE ref = ?').get(reference) : null;
      if (inv) {
        const paid = /paid|success|confirm|succès/i.test(status);
        if (paid) db.prepare('UPDATE invoices SET status = ?, paid_at = ?, method = ? WHERE id = ?').run('Payée', nowISO(), provider.label, inv.id);
        db.prepare('UPDATE payments SET status = ?, updated_at = ?, payload_json = ? WHERE invoice_id = ? ORDER BY id DESC LIMIT 1').run(paid ? 'confirmé' : status, nowISO(), JSON.stringify(body), inv.id);
        db.prepare('INSERT INTO audit_log (company_id, user_id, actor, role, action, details, ip, at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
          .run(inv.company_id, provider.key + ' (webhook)', 'systeme', 'Webhook de paiement', `${inv.ref} — statut ${status}`, req.ip, nowISO());
      }
      res.json({ received: true, invoice: inv ? inv.ref : null });
    } catch (e) { next(e); }
  });

  /* ================= Conformité & données personnelles ================= */
  app.get('/api/compliance', requireMinRole('manager'), (req, res) => {
    const co = company(req);
    res.json({
      company: safeCompany(co),
      apdpvp: { num: co.apdpvp_num, date: co.apdpvp_date, status: co.apdpvp_status },
      hosting: co.hosting,
      registry: CONFORMITE.REGISTRE_TRAITEMENTS,
      cadre_legal: CONFORMITE.CADRE_LEGAL,
      mesures_securite: CONFORMITE.SECURITE,
      baremes: RATES.validationPour(db, co),
      retention: RETENTION,
      rights: ['Accès', 'Rectification', 'Effacement', 'Opposition', 'Portabilité'],
      security: {
        passwords: 'scrypt (sel aléatoire, 16384 itérations)',
        sessions: 'jetons signés HMAC-SHA256, expiration automatique, cookie HttpOnly SameSite=Strict',
        twofa: 'code à 6 chiffres, valable 10 minutes, stocké sous forme d\'empreinte',
        sensitive_fields: 'AES-256-GCM (numéros CNSS, documents du coffre)',
        audit: 'journal horodaté de toutes les actions sensibles',
        backups: 'sauvegardes quotidiennes chiffrées avec rétention 14 jours',
      },
    });
  });

  app.post('/api/compliance/apdpvp', requireMinRole('admin'), (req, res) => {
    const b = req.body || {};
    db.prepare('UPDATE companies SET apdpvp_num = ?, apdpvp_date = ?, apdpvp_status = ? WHERE id = ?')
      .run(b.num || null, b.date || today(), b.status || 'À jour', req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Déclaration APDPVP', details: `${b.num || 'sans référence'} — ${b.status || 'À jour'}` });
    res.json({ ok: true });
  });

  app.post('/api/compliance/payroll-validation', requireMinRole('admin'), (req, res) => {
    const b = req.body || {};
    const co = company(req);
    if (!b.expert_name) return res.status(400).json({ error: 'Nom du cabinet ou de l\'expert-comptable requis.' });
    const version = b.version || RATES.versionFor(co.country);
    const expire = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const info = db.prepare(`INSERT INTO rate_validations (country, version, cabinet, expert_name, order_ref, scope, validated_at, expires_at, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(country, version) DO UPDATE SET cabinet = excluded.cabinet, expert_name = excluded.expert_name,
        order_ref = excluded.order_ref, scope = excluded.scope, validated_at = excluded.validated_at,
        expires_at = excluded.expires_at, notes = excluded.notes, created_by = excluded.created_by`)
      .run(co.country, version, b.expert_name, b.expert_name, b.reference || null,
        b.scope || 'Taux de cotisations sociales, impôt sur le revenu, taxe de formation',
        nowISO(), expire, b.notes || null, req.user.email, nowISO());
    db.prepare('UPDATE companies SET payroll_validated_by = ?, payroll_validated_at = ?, rate_validation_id = ? WHERE id = ?')
      .run(String(b.expert_name) + (b.reference ? ' — réf. ' + b.reference : ''), nowISO(), Number(info.lastInsertRowid), req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Validation des barèmes de paie', details: `${b.expert_name} — barème ${version}, valable jusqu'au ${expire}${b.reference ? ' (réf. ' + b.reference + ')' : ''}` });
    res.json({ ok: true, validated_by: b.expert_name, validated_at: nowISO(), version, expires_at: expire });
  });

  /* Droit d'accès : export complet des données d'un salarié */
  app.get('/api/compliance/dsar/:employeeId', requireMinRole('rh'), (req, res) => {
    const e = req.tenant.employee(Number(req.params.employeeId));
    if (!e) return res.status(404).json({ error: 'Salarié introuvable.' });
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Droit d\'accès (export)', details: e.name });
    res.json({
      exported_at: nowISO(),
      employee: Object.assign(withMask(e), { cnss_no: C.decryptField(e.cnss_no_enc) }),
      contracts: req.tenant.contracts(e.id),
      leaves: req.tenant.leaves().filter((l) => l.employee_id === e.id),
      payslips: req.tenant.payslips(e.id).map(summarizePayslip),
      documents: req.tenant.documents(e.id),
      audit: db.prepare('SELECT action, details, at FROM audit_log WHERE company_id = ? AND details LIKE ? ORDER BY id DESC LIMIT 100').all(req.user.company_id, '%' + e.name + '%'),
    });
  });

  /* Droit à l'effacement : anonymisation (les pièces de paie obligatoires sont conservées) */
  app.post('/api/compliance/erase/:employeeId', requireMinRole('admin'), (req, res) => {
    const e = req.tenant.employee(Number(req.params.employeeId));
    if (!e) return res.status(404).json({ error: 'Salarié introuvable.' });
    const anon = 'Anonymisé #' + e.id;
    db.prepare(`UPDATE employees SET name = ?, email = NULL, phone = NULL, cnss_no_enc = NULL WHERE id = ? AND company_id = ?`).run(anon, e.id, req.user.company_id);
    db.prepare('DELETE FROM documents WHERE employee_id = ? AND company_id = ?').run(e.id, req.user.company_id);
    audit(db, { company_id: req.user.company_id, ...actorOf(req), action: 'Droit à l\'effacement', details: `${e.name} anonymisé — documents du coffre supprimés, bulletins conservés (obligation légale 50 ans)` });
    res.json({ ok: true, kept: 'Bulletins de paie et contrats (obligation légale de conservation)' });
  });

  /* ================= Journal d'audit ================= */
  app.get('/api/audit', requireMinRole('admin'), (req, res) => {
    res.json({ entries: req.tenant.auditLog(Math.min(Number(req.query.limit) || 200, 1000)) });
  });
}

/* ---------- Helpers ---------- */
function withMask(e) {
  if (!e) return null;
  const out = Object.assign({}, e);
  delete out.cnss_no_enc;
  out.cnss_no_mask = e.cnss_no_enc ? '•••••' + String(C.decryptField(e.cnss_no_enc) || '').slice(-3) : null;
  out.salary = e.salary_cents / 100;
  return out;
}
function summarizePayslip(p) {
  return { id: p.id, employee_id: p.employee_id, period: p.period, status: p.status, gross: p.gross_cents, net: p.net_cents, currency: p.currency, rates_validated: !!p.rates_validated, created_at: p.created_at };
}
function careerOf(t, e) {
  return {
    source: e.origin || 'Non renseignée',
    entry: { date: e.hired, role: e.role },
    steps: t.contracts(e.id).map((c) => ({ date: c.start_date, type: c.type, status: c.status })),
  };
}

module.exports = { registerRoutes, PLANS, SETUP_FEE_CENTS, TVA };
