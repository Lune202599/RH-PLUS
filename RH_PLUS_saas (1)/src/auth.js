'use strict';
/* Authentification & autorisation :
   - inscription d'entreprise (crée l'entreprise + son premier administrateur) ;
   - connexion en deux étapes (mot de passe + code 2FA à 6 chiffres) ;
   - sessions signées (jeton HMAC, expiration), cookie HttpOnly ;
   - rôles : admin > rh > manager > employee (cloisonnement des accès) ;
   - limitation des tentatives de connexion. */
const { scoped, audit, nowISO } = require('./db');
const C = require('./crypto');
const M = require('./messaging');
const cfg = require('./config');

const ROLES = ['admin', 'rh', 'manager', 'employee'];
const ROLE_RANK = { employee: 1, manager: 2, rh: 3, admin: 4, platform_admin: 5 };
const COOKIE = 'rhp_sid';
/* platform_admin : compte de l'éditeur (RH PLUS). Il administre les entreprises
   clientes (création, suspension, validation des barèmes) sans accéder aux
   dossiers des salariés : les routes métier restent cloisonnées par entreprise. */

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const i = part.indexOf('=');
    if (i > -1) acc[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    return acc;
  }, {});
}

function setSessionCookie(res, token) {
  const maxAge = cfg.SESSION_TTL_HOURS * 3600;
  const secure = cfg.ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function rateLimited(db, email, ip) {
  const since = new Date(Date.now() - cfg.LOGIN_WINDOW_MINUTES * 60000).toISOString();
  const row = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE success = 0 AND at > ? AND (email = ? OR ip = ?)').get(since, email || '', ip || '');
  return row.n >= cfg.LOGIN_MAX_ATTEMPTS;
}

/* Politique de mot de passe : longueur, variété, mots de passe trop courants. */
const MOTS_DE_PASSE_FAIBLES = new Set(['motdepasse', 'password', '12345678', 'azerty123', 'rhplus2026', 'admin1234']);
function validiteMotDePasse(mdp) {
  const m = String(mdp || '');
  if (m.length < 10) return 'Le mot de passe doit contenir au moins 10 caractères.';
  const varietes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(m)).length;
  if (varietes < 3) return 'Le mot de passe doit mélanger minuscules, majuscules, chiffres et symboles (au moins trois catégories).';
  if (MOTS_DE_PASSE_FAIBLES.has(m.toLowerCase())) return 'Ce mot de passe est trop courant.';
  return null;
}

function registerAuthRoutes(app, db) {
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, company_id: u.company_id, twofa_enabled: !!u.twofa_enabled });

  /* ---------- Inscription d'une entreprise ---------- */
  app.post('/api/auth/register', (req, res) => {
    const { company, admin } = req.body || {};
    if (!company || !company.name) return res.status(400).json({ error: 'Nom de l\'entreprise requis.' });
    if (!admin || !admin.email || !admin.password) return res.status(400).json({ error: 'Email et mot de passe de l\'administrateur requis.' });
    if (String(admin.password).length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(String(admin.email).toLowerCase())) return res.status(409).json({ error: 'Cet email est déjà utilisé.' });

    const P = require('./payroll').paramsFor(company.country || 'Gabon');
    const id = C.randomId('co');
    const info = db.prepare(`INSERT INTO companies (id, name, country, currency, law, city, rccm, nif, cnss_no, rep, convention, plan, pay_method, hosting, apdpvp_status, created_at)
      VALUES (@id, @name, @country, @currency, @law, @city, @rccm, @nif, @cnss, @rep, @convention, 'starter', 'Virement bancaire', @hosting, 'Non déclaré', @created_at)`).run({
      id, name: company.name, country: company.country || 'Gabon', currency: P.currency, law: P.law,
      city: company.city || null, rccm: company.rccm || null, nif: company.nif || null,
      cnss: company.cnss_no ? C.encryptField(company.cnss_no) : null, rep: company.rep || null,
      convention: company.convention || null,
      hosting: company.hosting || 'Serveurs au Gabon (hébergement local)',
      created_at: nowISO(),
    });
    const u = db.prepare(`INSERT INTO users (company_id, email, name, role, password_hash, twofa_enabled, created_at)
      VALUES (?, ?, ?, 'admin', ?, 1, ?)`).run(id, String(admin.email).toLowerCase(), admin.name || 'Administrateur RH', C.hashPassword(admin.password), nowISO());
    audit(db, { company_id: id, user_id: Number(u.lastInsertRowid), actor: admin.email, role: 'admin', action: 'Création de l\'entreprise', details: company.name + ' — ' + (company.country || 'Gabon'), ip: req.ip });
    res.status(201).json({ company: { id, name: company.name, country: company.country || 'Gabon', currency: P.currency }, user: { id: Number(u.lastInsertRowid), email: String(admin.email).toLowerCase(), role: 'admin' } });
  });

  /* ---------- Connexion, étape 1 : mot de passe ---------- */
  app.post('/api/auth/login', async (req, res) => {
    const email = String((req.body || {}).email || '').toLowerCase();
    const password = String((req.body || {}).password || '');
    if (rateLimited(db, email, req.ip)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const okPass = user && C.verifyPassword(password, user.password_hash);
    db.prepare('INSERT INTO login_attempts (email, ip, success, at) VALUES (?, ?, ?, ?)').run(email, req.ip, okPass ? 1 : 0, nowISO());
    if (!okPass) {
      audit(db, { company_id: user ? user.company_id : null, actor: email, action: 'Échec de connexion', details: 'Mot de passe invalide', ip: req.ip });
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }
    const societe = db.prepare('SELECT * FROM companies WHERE id = ?').get(user.company_id);
    if (societe && societe.suspended) {
      audit(db, { company_id: user.company_id, user_id: user.id, actor: email, role: user.role, action: 'Connexion refusée', details: 'Entreprise suspendue', ip: req.ip });
      return res.status(403).json({ error: 'Accès suspendu. Contactez RH PLUS : facturation@rhplus.ga.' });
    }
    if (!user.twofa_enabled) {
      const token = C.signToken({ uid: user.id, cid: user.company_id, role: user.role });
      setSessionCookie(res, token);
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowISO(), user.id);
      audit(db, { company_id: user.company_id, user_id: user.id, actor: user.email, role: user.role, action: 'Connexion', details: '2FA désactivée', ip: req.ip });
      return res.json({ step: 'done', user: publicUser(user) });
    }
    // Étape 2 : envoi d'un code à 6 chiffres (SMS/email en production ; journalisé en démo)
    const code = C.randomCode(6);
    db.prepare('INSERT INTO login_challenges (user_id, code_hash, expires_at, used, created_at, ip) VALUES (?, ?, ?, 0, ?, ?)')
      .run(user.id, C.sha256(code), new Date(Date.now() + cfg.TWOFA_TTL_MINUTES * 60000).toISOString(), nowISO(), req.ip);
    const envoi = await M.envoyerCodeConnexion(db, { user, code, company: societe });
    audit(db, {
      company_id: user.company_id, actor: email, action: 'Code 2FA envoyé',
      details: 'Vérification en deux étapes — ' + envoi.canaux, ip: req.ip,
    });
    const payload = {
      step: '2fa', email,
      channel: user.phone ? 'SMS + email' : 'email',
      hint: envoi.reel
        ? 'Code envoyé sur le téléphone et/ou l’adresse email du titulaire.'
        : 'Aucun canal d’envoi configuré : le code est écrit dans le journal du serveur (mode démonstration).',
      delivery: envoi.canaux,
    };
    // Hors production, le code est renvoyé à l'écran pour la démonstration.
    // En production, il part uniquement par SMS/email et n'est jamais renvoyé.
    if (cfg.ENV !== 'production') payload.dev_code = code;
    res.json(payload);
  });

  /* ---------- Connexion, étape 2 : vérification du code ---------- */
  app.post('/api/auth/verify', (req, res) => {
    const { email, code } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!user) return res.status(401).json({ error: 'Identifiants invalides.' });
    const ch = db.prepare('SELECT * FROM login_challenges WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(user.id);
    if (!ch) return res.status(400).json({ error: 'Aucun code en attente. Recommencez la connexion.' });
    if (new Date(ch.expires_at) < new Date()) return res.status(400).json({ error: 'Code expiré.' });
    if (ch.code_hash !== C.sha256(String(code || ''))) {
      db.prepare('INSERT INTO login_attempts (email, ip, success, at) VALUES (?, ?, 0, ?)').run(user.email, req.ip, nowISO());
      return res.status(401).json({ error: 'Code incorrect.' });
    }
    db.prepare('UPDATE login_challenges SET used = 1 WHERE id = ?').run(ch.id);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowISO(), user.id);
    const token = C.signToken({ uid: user.id, cid: user.company_id, role: user.role, ver: user.token_version || 1 });
    setSessionCookie(res, token);
    audit(db, { company_id: user.company_id, user_id: user.id, actor: user.email, role: user.role, action: 'Connexion', details: '2FA validée', ip: req.ip });
    // Le jeton est aussi renvoyé au client : la console peut travailler sans cookie
    // (aperçu intégré, iframe, navigateur qui bloque les cookies tiers).
    res.json({ step: 'done', user: publicUser(user), token });
  });

  /* ---------- Changement de mot de passe (par le titulaire) ---------- */
  app.post('/api/auth/password', requireAuth, (req, res) => {
    const { current, password } = req.body || {};
    if (!C.verifyPassword(String(current || ''), req.user.password_hash)) {
      audit(db, { company_id: req.user.company_id, user_id: req.user.id, actor: req.user.email, role: req.user.role, action: 'Changement de mot de passe refusé', details: 'Mot de passe actuel incorrect', ip: req.ip });
      return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    }
    const erreur = validiteMotDePasse(password);
    if (erreur) return res.status(400).json({ error: erreur });
    db.prepare('UPDATE users SET password_hash = ?, token_version = COALESCE(token_version, 1) + 1 WHERE id = ?')
      .run(C.hashPassword(String(password)), req.user.id);
    audit(db, { company_id: req.user.company_id, user_id: req.user.id, actor: req.user.email, role: req.user.role, action: 'Changement de mot de passe', details: 'Sessions révoquées', ip: req.ip });
    clearSessionCookie(res);
    res.json({ ok: true, message: 'Mot de passe changé. Reconnectez-vous.' });
  });

  /* ---------- Mot de passe oublié : code envoyé par email ---------- */
  app.post('/api/auth/forgot', async (req, res) => {
    const email = String((req.body || {}).email || '').toLowerCase();
    if (rateLimited(db, email, req.ip)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Réponse identique que le compte existe ou non : on n'indique jamais si un email est connu.
    if (user) {
      const code = C.randomCode(6);
      db.prepare('INSERT INTO login_challenges (user_id, code_hash, expires_at, used, created_at, ip) VALUES (?, ?, ?, 0, ?, ?)')
        .run(user.id, C.sha256(code), new Date(Date.now() + 30 * 60000).toISOString(), nowISO(), req.ip);
      const mail = M.resetEmail(code, { name: user.name });
      await M.sendMail(db, { to: user.email, ...mail, company_id: user.company_id, purpose: 'réinitialisation de mot de passe' });
      audit(db, { company_id: user.company_id, user_id: user.id, actor: email, role: user.role, action: 'Demande de réinitialisation', details: 'Code envoyé par email', ip: req.ip });
    }
    res.json({ ok: true, message: 'Si ce compte existe, un code de réinitialisation vient d’être envoyé par email.' });
  });

  app.post('/api/auth/reset', (req, res) => {
    const { email, code, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    const erreurPwd = validiteMotDePasse(password);
    if (erreurPwd) return res.status(400).json({ error: erreurPwd });
    if (!user) return res.status(400).json({ error: 'Code invalide ou expiré.' });
    const ch = db.prepare('SELECT * FROM login_challenges WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(user.id);
    if (!ch || new Date(ch.expires_at) < new Date()) return res.status(400).json({ error: 'Code invalide ou expiré.' });
    if (ch.code_hash !== C.sha256(String(code || ''))) {
      db.prepare('INSERT INTO login_attempts (email, ip, success, at) VALUES (?, ?, 0, ?)').run(user.email, req.ip, nowISO());
      return res.status(401).json({ error: 'Code incorrect.' });
    }
    db.prepare('UPDATE login_challenges SET used = 1 WHERE id = ?').run(ch.id);
    db.prepare('UPDATE users SET password_hash = ?, token_version = COALESCE(token_version, 1) + 1 WHERE id = ?')
      .run(C.hashPassword(String(password)), user.id);
    audit(db, { company_id: user.company_id, user_id: user.id, actor: user.email, role: user.role, action: 'Mot de passe réinitialisé', details: 'Par code reçu par email', ip: req.ip });
    res.json({ ok: true, message: 'Mot de passe changé.' });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.user) {
      // révocation immédiate : tous les jetons émis pour cet utilisateur deviennent invalides
      db.prepare('UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = ?').run(req.user.id);
      audit(db, { company_id: req.user.company_id, user_id: req.user.id, actor: req.user.email, role: req.user.role, action: 'Déconnexion', details: 'Session révoquée', ip: req.ip });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié.' });
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.company_id);
    res.json({ user: publicUser(req.user), company: safeCompany(company) });
  });

  app.post('/api/auth/2fa', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié.' });
    const enabled = req.body && req.body.enabled ? 1 : 0;
    db.prepare('UPDATE users SET twofa_enabled = ? WHERE id = ?').run(enabled, req.user.id);
    audit(db, { company_id: req.user.company_id, user_id: req.user.id, actor: req.user.email, role: req.user.role, action: 'Paramètre 2FA', details: enabled ? 'Activée' : 'Désactivée', ip: req.ip });
    res.json({ twofa_enabled: !!enabled });
  });
}

function safeCompany(c) {
  if (!c) return null;
  return {
    id: c.id, name: c.name, country: c.country, currency: c.currency, law: c.law, city: c.city,
    rccm: c.rccm, nif: c.nif, rep: c.rep, convention: c.convention, plan: c.plan, pay_method: c.pay_method,
    hosting: c.hosting, apdpvp_num: c.apdpvp_num, apdpvp_date: c.apdpvp_date, apdpvp_status: c.apdpvp_status,
    cnss_no: c.cnss_no ? C.decryptField(c.cnss_no) : null,
    payroll_validated_by: c.payroll_validated_by, payroll_validated_at: c.payroll_validated_at,
  };
}

/* ---------- Middlewares ---------- */
function authenticate(db) {
  return (req, res, next) => {
    const token = parseCookies(req)[COOKIE] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = C.verifyToken(token);
    if (!payload) { req.user = null; return next(); }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user || user.company_id !== payload.cid) { req.user = null; return next(); }
    // jeton révoqué (déconnexion depuis n'importe quel appareil)
    if ((payload.ver || 1) !== (user.token_version || 1)) { req.user = null; return next(); }
    req.user = user;
    req.tenant = scoped(db, user.company_id);
    next();
  };
}

const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Authentification requise.' }));

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Action réservée aux rôles : ${roles.join(', ')}.` });
    }
    next();
  };
}

function requireMinRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    if ((ROLE_RANK[req.user.role] || 0) < (ROLE_RANK[role] || 99)) return res.status(403).json({ error: 'Droits insuffisants.' });
    next();
  };
}

module.exports = { registerAuthRoutes, authenticate, requireAuth, requireRole, requireMinRole, safeCompany, COOKIE };
