'use strict';
/* Accès à la base SQLite + helpers.
   Isolation multi-entreprises : toutes les tables métier portent company_id et
   toutes les requêtes passent par `scoped(db, companyId)`. */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'Gabon',
  currency TEXT NOT NULL DEFAULT 'FCFA',
  law TEXT NOT NULL DEFAULT 'Code du travail gabonais',
  city TEXT, rccm TEXT, nif TEXT,
  cnss_no TEXT, rep TEXT, convention TEXT,
  plan TEXT NOT NULL DEFAULT 'starter',
  pay_method TEXT NOT NULL DEFAULT 'Virement bancaire',
  hosting TEXT NOT NULL DEFAULT 'Serveurs au Gabon (hébergement local)',
  apdpvp_num TEXT, apdpvp_date TEXT, apdpvp_status TEXT DEFAULT 'Non déclaré',
  payroll_validated_by TEXT, payroll_validated_at TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,        -- 1 : compte client suspendu (impayé, fin de contrat)
  rate_validation_id INTEGER,                  -- validation des barèmes adoptée par l'entreprise
  dpo_name TEXT, dpo_email TEXT,               -- délégué à la protection des données (loi n°001/2011)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rh',            -- platform_admin | admin | rh | manager | employee
  phone TEXT,                                 -- destinataire du code 2FA par SMS
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  password_hash TEXT NOT NULL,
  twofa_enabled INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 1,   -- incrémenté à la déconnexion : révoque les jetons
  last_login_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  matricule TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT, dept TEXT,
  contract TEXT NOT NULL DEFAULT 'CDI',
  status TEXT NOT NULL DEFAULT 'Présent',
  email TEXT, phone TEXT, hired TEXT,
  salary_cents INTEGER NOT NULL DEFAULT 0,
  cnss_no_enc TEXT,                  -- numéro CNSS/CNAMGS chiffré (AES-256-GCM)
  origin TEXT, manager_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, matricule)
);
CREATE INDEX IF NOT EXISTS idx_emp_company ON employees(company_id);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
  status TEXT NOT NULL DEFAULT 'En cours',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_company ON contracts(company_id, employee_id);

CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, days INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'En attente', reason TEXT,
  decided_by INTEGER, decided_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leaves_company ON leaves(company_id, status);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  folder TEXT NOT NULL DEFAULT 'perso',
  name TEXT NOT NULL, mime TEXT, size INTEGER, sha256 TEXT,
  iv TEXT NOT NULL, tag TEXT NOT NULL, ciphertext BLOB NOT NULL,
  uploaded_by INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_company ON documents(company_id, employee_id);

CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'brouillon',
  gross_cents INTEGER NOT NULL, net_cents INTEGER NOT NULL,
  detail_json TEXT NOT NULL, currency TEXT NOT NULL,
  rates_validated INTEGER NOT NULL DEFAULT 0,
  generated_by INTEGER, created_at TEXT NOT NULL,
  UNIQUE (company_id, employee_id, period)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref TEXT NOT NULL UNIQUE, period TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL, tva_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'À échoir', method TEXT, paid_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  provider TEXT NOT NULL, method TEXT, provider_ref TEXT,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'FCFA',
  status TEXT NOT NULL DEFAULT 'en attente', payload_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT, user_id INTEGER, actor TEXT, role TEXT,
  action TEXT NOT NULL, details TEXT, ip TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id, at DESC);

CREATE TABLE IF NOT EXISTS login_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, ip TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, ip TEXT, success INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);

/* Journal des messages envoyés. Ne contient JAMAIS le code envoyé :
   seuls le destinataire masqué, l'objet, le statut et l'erreur sont conservés. */
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT, channel TEXT NOT NULL, recipient TEXT, purpose TEXT,
  status TEXT NOT NULL, provider TEXT, provider_ref TEXT, error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_company ON messages(company_id, created_at DESC);

/* Validation des barèmes de paie d'un pays par un cabinet d'expertise-comptable.
   Une validation porte sur une VERSION précise du barème : si les taux changent,
   la version change et la validation doit être renouvelée. */
CREATE TABLE IF NOT EXISTS rate_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,
  version TEXT NOT NULL,                       -- version du barème validé (ex. GA-2026.1)
  cabinet TEXT NOT NULL,                       -- cabinet d'expertise-comptable
  expert_name TEXT,                            -- expert-comptable signataire
  order_ref TEXT,                              -- référence de la lettre / du rapport
  scope TEXT,                                  -- périmètre validé (cotisations, IRPP, etc.)
  validated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                    -- 12 mois par défaut
  document_name TEXT,                          -- lettre signée archivée au coffre-fort
  notes TEXT,
  created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE(country, version)
);
`;

/* Ajoute une colonne manquante sur une base déjà installée (mise à jour en place,
   sans perte de données ni réinstallation). */
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function openDatabase(dbPath = cfg.DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // migrations en place (bases créées par une version antérieure)
  ensureColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'users', 'phone', 'TEXT');
  ensureColumn(db, 'companies', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'companies', 'rate_validation_id', 'INTEGER');
  ensureColumn(db, 'companies', 'dpo_name', 'TEXT');
  ensureColumn(db, 'companies', 'dpo_email', 'TEXT');
  return db;
}

const nowISO = () => new Date().toISOString();

function audit(db, entry) {
  db.prepare(`INSERT INTO audit_log (company_id, user_id, actor, role, action, details, ip, at)
    VALUES (@company_id, @user_id, @actor, @role, @action, @details, @ip, @at)`).run({
    company_id: entry.company_id || null, user_id: entry.user_id || null, actor: entry.actor || null,
    role: entry.role || null, action: entry.action, details: entry.details || null,
    ip: entry.ip || null, at: nowISO(),
  });
}

/* Toutes les lectures métier, filtrées par entreprise. */
function scoped(db, companyId) {
  if (!companyId) throw new Error('company_id manquant : accès refusé');
  return {
    companyId,
    employees: () => db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY name').all(companyId),
    employee: (id) => db.prepare('SELECT * FROM employees WHERE id = ? AND company_id = ?').get(id, companyId),
    contracts: (employeeId) => employeeId
      ? db.prepare('SELECT * FROM contracts WHERE company_id = ? AND employee_id = ? ORDER BY start_date DESC').all(companyId, employeeId)
      : db.prepare('SELECT * FROM contracts WHERE company_id = ? ORDER BY start_date DESC').all(companyId),
    leaves: (status) => status
      ? db.prepare('SELECT * FROM leaves WHERE company_id = ? AND status = ? ORDER BY created_at DESC').all(companyId, status)
      : db.prepare('SELECT * FROM leaves WHERE company_id = ? ORDER BY created_at DESC').all(companyId),
    leave: (id) => db.prepare('SELECT * FROM leaves WHERE id = ? AND company_id = ?').get(id, companyId),
    documents: (employeeId) => employeeId
      ? db.prepare('SELECT id, company_id, employee_id, folder, name, mime, size, sha256, created_at FROM documents WHERE company_id = ? AND employee_id = ? ORDER BY created_at DESC').all(companyId, employeeId)
      : db.prepare('SELECT id, company_id, employee_id, folder, name, mime, size, sha256, created_at FROM documents WHERE company_id = ? ORDER BY created_at DESC').all(companyId),
    documentRow: (id) => db.prepare('SELECT * FROM documents WHERE id = ? AND company_id = ?').get(id, companyId),
    payslips: (employeeId) => employeeId
      ? db.prepare('SELECT * FROM payslips WHERE company_id = ? AND employee_id = ? ORDER BY period DESC').all(companyId, employeeId)
      : db.prepare('SELECT * FROM payslips WHERE company_id = ? ORDER BY period DESC').all(companyId),
    payslip: (id) => db.prepare('SELECT * FROM payslips WHERE id = ? AND company_id = ?').get(id, companyId),
    invoices: () => db.prepare('SELECT * FROM invoices WHERE company_id = ? ORDER BY created_at DESC').all(companyId),
    invoice: (id) => db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').get(id, companyId),
    payments: () => db.prepare('SELECT * FROM payments WHERE company_id = ? ORDER BY created_at DESC').all(companyId),
    auditLog: (limit = 200) => db.prepare('SELECT * FROM audit_log WHERE company_id = ? ORDER BY id DESC LIMIT ?').all(companyId, limit),
  };
}

module.exports = { openDatabase, scoped, audit, nowISO, SCHEMA, ensureColumn };
