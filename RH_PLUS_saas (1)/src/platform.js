'use strict';
/* =====================================================================
   Espace PLATEFORME — réservé à l'éditeur (RH PLUS)

   C'est le compte qui répond à la question « quelles entreprises sont dans
   mon logiciel ? ». Il permet de :
     - voir toutes les entreprises clientes et leur usage (effectif, comptes,
       activité, abonnement, état de conformité) ;
     - créer une entreprise cliente et son premier administrateur ;
     - suspendre / réactiver un accès, changer d'offre, suivre l'hébergement ;
     - enregistrer la validation des barèmes de paie par un cabinet ;
     - éditer la note de validation (à faire signer) et le dossier APDPVP ;
     - suivre les messages envoyés (SMS/email) et tester les canaux.

   Ce rôle NE donne PAS accès aux dossiers des salariés : les routes métier
   restent cloisonnées par entreprise. Il voit des chiffres, pas des personnes.
   ===================================================================== */
const C = require('./crypto');
const M = require('./messaging');
const RATES = require('./rates');
const CONFORMITE = require('./compliance');
const { audit, nowISO } = require('./db');
const { requireRole } = require('./auth');
const { noteValidationPdf, dossierApdpvpPdf } = require('./platform-pdf');

const PRIX_OFFRES = { starter: 12500, pme: 35000, entreprise: 90000 };   // FCFA HT / mois
const PLAFONDS = { starter: 15, pme: 50, entreprise: 150 };

function registerPlatformRoutes(app, db) {
  const requirePlatform = requireRole('platform_admin');

  /* --------------------------- indicateurs --------------------------- */
  function etatConformite(co) {
    const validation = RATES.validationPour(db, co);
    const apdpvpExpire = co.apdpvp_date
      ? new Date(new Date(co.apdpvp_date).setFullYear(new Date(co.apdpvp_date).getFullYear() + 1)).toISOString().slice(0, 10)
      : null;
    return {
      apdpvp: {
        num: co.apdpvp_num, date: co.apdpvp_date, status: co.apdpvp_status || 'Non déclaré',
        expire_le: apdpvpExpire,
        a_jour: !!co.apdpvp_num && (!apdpvpExpire || apdpvpExpire >= nowISO().slice(0, 10)),
      },
      baremes: validation,
      hosting: co.hosting,
      dpo: co.dpo_name ? { nom: co.dpo_name, email: co.dpo_email } : null,
    };
  }

  function indicateurs(co) {
    const employes = db.prepare('SELECT COUNT(*) n FROM employees WHERE company_id = ?').get(co.id).n;
    const comptes = db.prepare('SELECT COUNT(*) n FROM users WHERE company_id = ?').get(co.id).n;
    const bulletins = db.prepare('SELECT COUNT(*) n FROM payslips WHERE company_id = ?').get(co.id).n;
    const emis = db.prepare("SELECT COUNT(*) n FROM payslips WHERE company_id = ? AND status = 'emis'").get(co.id).n;
    const factures = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_cents), 0) total FROM invoices WHERE company_id = ?').get(co.id);
    const impayees = db.prepare("SELECT COUNT(*) n FROM invoices WHERE company_id = ? AND status <> 'Payée'").get(co.id).n;
    const derniere = db.prepare('SELECT at FROM audit_log WHERE company_id = ? ORDER BY id DESC LIMIT 1').get(co.id);
    const messages30 = db.prepare("SELECT COUNT(*) n FROM messages WHERE company_id = ? AND created_at >= ?")
      .get(co.id, new Date(Date.now() - 30 * 86400000).toISOString()).n;
    return {
      effectif: employes, comptes, bulletins, bulletins_emis: emis,
      factures: factures.n, facture_total: factures.total / 100, factures_impayees: impayees,
      mrr: co.suspended ? 0 : (PRIX_OFFRES[co.plan] || 0),
      plafond_offre: PLAFONDS[co.plan] || 0,
      depassement: employes > (PLAFONDS[co.plan] || 999),
      derniere_activite: derniere ? derniere.at : co.created_at,
      messages_30j: messages30,
    };
  }

  /* --------------------------- vue d'ensemble --------------------------- */
  app.get('/api/platform/overview', requirePlatform, (req, res) => {
    const entreprises = db.prepare('SELECT * FROM companies WHERE id <> ? ORDER BY created_at').all(req.user.company_id)
      .map((co) => Object.assign({
        id: co.id, name: co.name, country: co.country, currency: co.currency, city: co.city,
        plan: co.plan, suspended: !!co.suspended, created_at: co.created_at, pay_method: co.pay_method,
      }, { usage: indicateurs(co), conformite: etatConformite(co) }));

    const total = entreprises.reduce((acc, e) => {
      acc.mrr += e.suspended ? 0 : e.usage.mrr;
      acc.effectif += e.usage.effectif;
      acc.comptes += e.usage.comptes;
      acc.impayees += e.usage.factures_impayees;
      return acc;
    }, { mrr: 0, effectif: 0, comptes: 0, impayees: 0 });

    const aRenouveler = entreprises.filter((e) => !e.conformite.apdpvp.a_jour || !e.conformite.baremes.a_jour);
    res.json({
      editeur: { id: req.user.company_id, name: db.prepare('SELECT name FROM companies WHERE id = ?').get(req.user.company_id).name },
      entreprises,
      totaux: Object.assign(total, {
        entreprises: entreprises.length,
        actives: entreprises.filter((e) => !e.suspended).length,
        suspendues: entreprises.filter((e) => e.suspended).length,
        a_mettre_en_conformite: aRenouveler.length,
      }),
      offres: Object.keys(PRIX_OFFRES).map((id) => ({ id, prix: PRIX_OFFRES[id], plafond: PLAFONDS[id] })),
      messaging: M.etat(),
    });
  });

  app.get('/api/platform/companies/:id', requirePlatform, (req, res) => {
    const co = db.prepare('SELECT * FROM companies WHERE id = ?').get(String(req.params.id));
    if (!co) return res.status(404).json({ error: 'Entreprise introuvable.' });
    const comptes = db.prepare('SELECT id, email, name, role, last_login_at FROM users WHERE company_id = ? ORDER BY id').all(co.id);
    const depenses = db.prepare('SELECT ref, period, amount_cents, tva_cents, status, paid_at FROM invoices WHERE company_id = ? ORDER BY id DESC LIMIT 24').all(co.id);
    const paiments = db.prepare('SELECT provider, provider_ref, amount_cents, status, created_at FROM payments WHERE company_id = ? ORDER BY id DESC LIMIT 24').all(co.id);
    res.json({
      company: co, usage: indicateurs(co), conformite: etatConformite(co), comptes, factures: depenses, paiements: paiments,
      messages: db.prepare('SELECT channel, recipient, purpose, status, provider, created_at FROM messages WHERE company_id = ? ORDER BY id DESC LIMIT 30').all(co.id),
    });
  });

  /* --------------------------- création client --------------------------- */
  app.post('/api/platform/companies', requirePlatform, (req, res) => {
    const b = req.body || {};
    const societe = b.company || {};
    const admin = b.admin || {};
    if (!societe.name) return res.status(400).json({ error: 'Nom de l\'entreprise requis.' });
    if (!admin.email || !admin.password) return res.status(400).json({ error: 'Email et mot de passe de l\'administrateur requis.' });
    if (String(admin.password).length < 10) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 10 caractères.' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(String(admin.email).toLowerCase())) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }
    const P = require('./payroll').paramsFor(societe.country || 'Gabon');
    const id = C.randomId('co');
    db.prepare(`INSERT INTO companies (id, name, country, currency, law, city, rccm, nif, cnss_no, rep, convention, plan, pay_method, hosting, apdpvp_status, created_at)
      VALUES (@id, @name, @country, @currency, @law, @city, @rccm, @nif, @cnss, @rep, @convention, @plan, 'Airtel Money', @hosting, 'Non déclaré', @created_at)`).run({
      id,
      name: societe.name,
      country: societe.country || 'Gabon',
      currency: P.currency,
      law: P.law,
      city: societe.city || null,
      rccm: societe.rccm || null,
      nif: societe.nif || null,
      cnss: societe.cnss_no ? C.encryptField(societe.cnss_no) : null,
      rep: societe.rep || null,
      convention: societe.convention || null,
      plan: PRIX_OFFRES[societe.plan] ? societe.plan : 'starter',
      hosting: societe.hosting || 'Serveurs au Gabon (hébergement local)',
      created_at: nowISO(),
    });
    const u = db.prepare(`INSERT INTO users (company_id, email, name, role, phone, password_hash, twofa_enabled, created_at)
      VALUES (?, ?, ?, 'admin', ?, ?, 1, ?)`)
      .run(id, String(admin.email).toLowerCase(), admin.name || 'Administrateur', admin.phone || null, C.hashPassword(String(admin.password)), nowISO());
    audit(db, { company_id: id, user_id: Number(u.lastInsertRowid), actor: req.user.email, role: 'platform_admin', action: 'Création d\'une entreprise cliente', details: `${societe.name} — offre ${societe.plan || 'starter'}` });
    if (admin.email) {
      M.sendMail(db, {
        to: admin.email, company_id: id, purpose: 'bienvenue client',
        subject: 'RH PLUS — votre espace est ouvert',
        text: `Bonjour,\n\nL'espace RH PLUS de ${societe.name} est ouvert.\nAdresse : https://app.rhplus.ga\nIdentifiant : ${admin.email}\nVotre mot de passe vous a été communiqué séparément.\nLa connexion se fait en deux étapes (code envoyé par SMS et email).\n\n— RH PLUS`,
      }).catch(() => {});
    }
    res.status(201).json({ company: { id, name: societe.name }, user: { id: Number(u.lastInsertRowid), email: String(admin.email).toLowerCase() } });
  });

  /* --------------------------- administration --------------------------- */
  app.patch('/api/platform/companies/:id', requirePlatform, (req, res) => {
    const co = db.prepare('SELECT * FROM companies WHERE id = ?').get(String(req.params.id));
    if (!co) return res.status(404).json({ error: 'Entreprise introuvable.' });
    const b = req.body || {};
    const modifs = [];
    if (b.suspended !== undefined) { db.prepare('UPDATE companies SET suspended = ? WHERE id = ?').run(b.suspended ? 1 : 0, co.id); modifs.push(b.suspended ? 'accès suspendu' : 'accès rétabli'); }
    if (b.plan && PRIX_OFFRES[b.plan]) { db.prepare('UPDATE companies SET plan = ? WHERE id = ?').run(b.plan, co.id); modifs.push('offre ' + b.plan); }
    if (b.hosting) { db.prepare('UPDATE companies SET hosting = ? WHERE id = ?').run(String(b.hosting), co.id); modifs.push('hébergement : ' + b.hosting); }
    if (b.apdpvp_num !== undefined || b.apdpvp_date !== undefined || b.apdpvp_status !== undefined) {
      db.prepare('UPDATE companies SET apdpvp_num = COALESCE(?, apdpvp_num), apdpvp_date = COALESCE(?, apdpvp_date), apdpvp_status = COALESCE(?, apdpvp_status) WHERE id = ?')
        .run(b.apdpvp_num || null, b.apdpvp_date || null, b.apdpvp_status || null, co.id);
      modifs.push('déclaration APDPVP mise à jour');
    }
    if (b.dpo_name !== undefined || b.dpo_email !== undefined) {
      db.prepare('UPDATE companies SET dpo_name = ?, dpo_email = ? WHERE id = ?').run(b.dpo_name || null, b.dpo_email || null, co.id);
      modifs.push('délégué à la protection des données');
    }
    audit(db, { company_id: co.id, actor: req.user.email, role: 'platform_admin', action: 'Modification par la plateforme', details: `${co.name} — ${modifs.join(', ') || 'aucune modification'}` });
    const maj = db.prepare('SELECT * FROM companies WHERE id = ?').get(co.id);
    res.json({ ok: true, company: maj, usage: indicateurs(maj), conformite: etatConformite(maj), modifications: modifs });
  });

  /* --------------------- validation des barèmes --------------------- */
  app.get('/api/platform/validations', requirePlatform, (req, res) => {
    const lignes = db.prepare('SELECT * FROM rate_validations ORDER BY country, validated_at DESC').all();
    const aJour = new Date().toISOString().slice(0, 10);
    res.json({
      validations: lignes.map((v) => Object.assign({}, v, { active: v.expires_at >= aJour })),
      pays: Object.keys(require('./payroll').COUNTRY_PARAMS).map((pays) => ({
        country: pays, version: RATES.versionFor(pays),
        etat: RATES.validationPour(db, { country: pays, rate_validation_id: null, payroll_validated_by: null, payroll_validated_at: null }),
      })),
    });
  });

  app.post('/api/platform/validations', requirePlatform, (req, res) => {
    const b = req.body || {};
    if (!b.country || !b.cabinet) return res.status(400).json({ error: 'Pays et cabinet requis.' });
    const version = b.version || RATES.versionFor(b.country);
    const valide = b.validated_at || new Date().toISOString().slice(0, 10);
    const expire = b.expires_at || new Date(new Date(valide).getTime() + 365 * 86400000).toISOString().slice(0, 10);
    const info = db.prepare(`INSERT INTO rate_validations (country, version, cabinet, expert_name, order_ref, scope, validated_at, expires_at, document_name, notes, created_by, created_at)
      VALUES (@country, @version, @cabinet, @expert, @ref, @scope, @validated, @expires, @doc, @notes, @created_by, @created_at)
      ON CONFLICT(country, version) DO UPDATE SET cabinet = excluded.cabinet, expert_name = excluded.expert_name,
        order_ref = excluded.order_ref, scope = excluded.scope, validated_at = excluded.validated_at,
        expires_at = excluded.expires_at, document_name = excluded.document_name, notes = excluded.notes, created_by = excluded.created_by`)
      .run({
        country: b.country, version, cabinet: b.cabinet, expert: b.expert_name || null,
        ref: b.order_ref || null, scope: b.scope || 'Taux de cotisations sociales, impôt sur le revenu, taxe de formation',
        validated: valide, expires: expire, doc: b.document_name || null, notes: b.notes || null,
        created_by: req.user.email, created_at: nowISO(),
      });
    audit(db, { company_id: req.user.company_id, actor: req.user.email, role: 'platform_admin', action: 'Validation de barème (plateforme)', details: `${b.country} — ${version} par ${b.cabinet}, valable jusqu'au ${expire}` });
    res.status(201).json({ id: Number(info.lastInsertRowid), country: b.country, version, cabinet: b.cabinet, validated_at: valide, expires_at: expire });
  });

  app.delete('/api/platform/validations/:id', requirePlatform, (req, res) => {
    const v = db.prepare('SELECT * FROM rate_validations WHERE id = ?').get(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Validation introuvable.' });
    db.prepare('DELETE FROM rate_validations WHERE id = ?').run(v.id);
    db.prepare('UPDATE companies SET rate_validation_id = NULL WHERE rate_validation_id = ?').run(v.id);
    audit(db, { company_id: req.user.company_id, actor: req.user.email, role: 'platform_admin', action: 'Suppression de validation de barème', details: `${v.country} — ${v.version} (${v.cabinet})` });
    res.json({ ok: true });
  });

  /* Note de validation à faire signer par le cabinet */
  app.get('/api/platform/validations/note.pdf', requirePlatform, (req, res) => {
    const country = String(req.query.country || 'Gabon');
    const pdf = noteValidationPdf({ country, clientName: req.query.client || null });
    audit(db, { company_id: req.user.company_id, actor: req.user.email, role: 'platform_admin', action: 'Édition de la note de validation', details: `Pays : ${country} — barème ${RATES.versionFor(country)}` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Note_validation_baremes_${country}.pdf"`);
    res.send(pdf);
  });

  /* Dossier de déclaration APDPVP d'une entreprise (ou de l'éditeur) */
  app.get('/api/platform/companies/:id/dossier-apdpvp.pdf', requirePlatform, (req, res) => {
    const co = db.prepare('SELECT * FROM companies WHERE id = ?').get(String(req.params.id));
    if (!co) return res.status(404).json({ error: 'Entreprise introuvable.' });
    const pdf = dossierApdpvpPdf({
      company: co,
      hosting: co.hosting,
      dpo: co.dpo_name ? { name: co.dpo_name, email: co.dpo_email } : {},
      receipt: co.apdpvp_num ? { num: co.apdpvp_num, date: co.apdpvp_date } : null,
    });
    audit(db, { company_id: co.id, actor: req.user.email, role: 'platform_admin', action: 'Édition du dossier APDPVP', details: co.name });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Dossier_APDPVP_${String(co.name).replace(/\W+/g, '_')}.pdf"`);
    res.send(pdf);
  });

  /* --------------------------- messages --------------------------- */
  app.get('/api/platform/messages', requirePlatform, (req, res) => {
    const limite = Math.min(200, Number(req.query.limit || 60));
    const lignes = db.prepare(`SELECT m.*, c.name AS company_name FROM messages m
      LEFT JOIN companies c ON c.id = m.company_id ORDER BY m.id DESC LIMIT ?`).all(limite);
    const stats = db.prepare(`SELECT channel, status, COUNT(*) n FROM messages GROUP BY channel, status`).all();
    res.json({
      messages: lignes, statistiques: stats, etat: M.etat(),
      echecs_7j: db.prepare("SELECT COUNT(*) n FROM messages WHERE status = 'echec' AND created_at >= ?")
        .get(new Date(Date.now() - 7 * 86400000).toISOString()).n,
    });
  });

  app.post('/api/platform/messaging/test', requirePlatform, async (req, res) => {
    const b = req.body || {};
    const resultats = {};
    if (b.email) resultats.email = await M.sendMail(db, { to: b.email, company_id: req.user.company_id, purpose: 'test de configuration', subject: 'RH PLUS — test du canal email', text: 'Ceci est un message de test envoyé depuis l\'espace plateforme RH PLUS.' });
    if (b.phone) resultats.sms = await M.sendSms(db, { to: b.phone, company_id: req.user.company_id, purpose: 'test de configuration', text: 'RH PLUS : test de la passerelle SMS. Si vous recevez ce message, l\'envoi est configuré.' });
    if (!b.email && !b.phone) return res.status(400).json({ error: 'Indiquez une adresse email et/ou un numéro.' });
    audit(db, { company_id: req.user.company_id, actor: req.user.email, role: 'platform_admin', action: 'Test des canaux d\'envoi', details: Object.entries(resultats).map(([k, v]) => `${k} : ${v.mode || v.error}`).join(' · ') });
    res.json({ ok: true, resultats, etat: M.etat() });
  });
}

module.exports = { registerPlatformRoutes, PRIX_OFFRES, PLAFONDS };
