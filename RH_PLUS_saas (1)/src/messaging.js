'use strict';
/* =====================================================================
   Envoi des messages — email et SMS

   Trois modes par canal :
     console  : écrit dans le journal du serveur (développement, aucun envoi)
     smtp     : envoi réel par serveur SMTP (nodemailer)
     http     : envoi par API HTTP (fournisseur email ou passerelle SMS)
     africastalking : passerelle SMS Africa's Talking (adaptateur dédié)

   Règle de sécurité : la table `messages` trace l'envoi (destinataire masqué,
   objet, statut, erreur) mais **ne contient jamais le code envoyé**.
   ===================================================================== */
const crypto = require('crypto');
const cfg = require('./config');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

/* ----------------------------- configuration ----------------------------- */
const conf = {
  mail: (process.env.RHPLUS_MAIL || 'console').toLowerCase(),
  smtp: {
    host: process.env.RHPLUS_SMTP_HOST || '',
    port: Number(process.env.RHPLUS_SMTP_PORT || 587),
    secure: String(process.env.RHPLUS_SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.RHPLUS_SMTP_USER || '',
    pass: process.env.RHPLUS_SMTP_PASS || '',
  },
  mailHttp: {
    url: process.env.RHPLUS_MAIL_HTTP_URL || '',
    method: (process.env.RHPLUS_MAIL_HTTP_METHOD || 'POST').toUpperCase(),
    key: process.env.RHPLUS_MAIL_HTTP_KEY || '',
    params: process.env.RHPLUS_MAIL_HTTP_PARAMS || '',
  },
  from: process.env.RHPLUS_MAIL_FROM || 'RH PLUS <notifications@rhplus.ga>',
  sms: {
    provider: (process.env.RHPLUS_SMS || 'console').toLowerCase(),
    url: process.env.RHPLUS_SMS_URL || '',
    method: (process.env.RHPLUS_SMS_METHOD || 'POST').toUpperCase(),
    key: process.env.RHPLUS_SMS_KEY || '',
    sender: process.env.RHPLUS_SMS_SENDER || 'RHPLUS',
    username: process.env.RHPLUS_SMS_USERNAME || '',
    params: process.env.RHPLUS_SMS_PARAMS || '',
  },
};

const masquer = (dest) => {
  const s = String(dest || '');
  if (s.includes('@')) {
    const [n, d] = s.split('@');
    return n.slice(0, 2) + '•'.repeat(Math.max(2, n.length - 2)) + '@' + d;
  }
  return s.length <= 4 ? '••••' : '••••' + s.slice(-3);
};

/* Remplace tout code à 4-8 chiffres par des points : garde la trace de l'envoi
   sans jamais conserver le secret dans le journal ou en base. */
const masquerCodes = (texte) => String(texte || '').replace(/\b\d{4,8}\b/g, '••••••');

function journaliser(db, entree) {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO messages (company_id, channel, recipient, purpose, status, provider, provider_ref, error, created_at)
      VALUES (@company_id, @channel, @recipient, @purpose, @status, @provider, @provider_ref, @error, @created_at)`)
      .run({
        company_id: entree.company_id || null,
        channel: entree.channel,
        recipient: masquer(entree.recipient),
        purpose: entree.purpose || null,
        status: entree.status,
        provider: entree.provider || null,
        provider_ref: entree.provider_ref || null,
        error: entree.error ? masquerCodes(String(entree.error)).slice(0, 300) : null,
        created_at: new Date().toISOString(),
      });
  } catch (err) { console.error('[RH PLUS] journal des messages indisponible :', err.message); }
}

/* ------------------------------- état --------------------------------- */
const mailConfigured = () => (conf.mail === 'smtp' && !!conf.smtp.host) || (conf.mail === 'http' && !!conf.mailHttp.url);
const smsConfigured = () => (conf.sms.provider === 'http' && !!conf.sms.url) || conf.sms.provider === 'africastalking';

function etat() {
  return {
    email: { mode: conf.mail, configured: mailConfigured(), expediteur: conf.from },
    sms: { mode: conf.sms.provider, configured: smsConfigured(), expediteur: conf.sms.sender },
    pret_pour_la_production: mailConfigured() && smsConfigured(),
    aide: 'Renseignez RHPLUS_MAIL=smtp + RHPLUS_SMTP_* et RHPLUS_SMS=http|africastalking + RHPLUS_SMS_* dans .env (voir docs/NOTIFICATIONS.md).',
  };
}

/* ------------------------------- email -------------------------------- */
let transportCache = null;
function transport() {
  if (!nodemailer) throw new Error('nodemailer absent : installez les dépendances (npm install).');
  if (conf.mail === 'smtp') {
    if (!conf.smtp.host) throw new Error('SMTP non configuré (RHPLUS_SMTP_HOST).');
    if (!transportCache) {
      transportCache = nodemailer.createTransport({
        host: conf.smtp.host,
        port: conf.smtp.port,
        secure: conf.smtp.secure,
        auth: conf.smtp.user ? { user: conf.smtp.user, pass: conf.smtp.pass } : undefined,
        // refus des envois vers un domaine non attendu (CVE récentes nodemailer)
        disableUrlAccess: true, disableFileAccess: true,
      });
    }
    return transportCache;
  }
  if (conf.mail === 'http') {
    return { sendMail: async (message) => envoyerHttpMail(message) };
  }
  return { sendMail: async (message) => ({ messageId: 'console:' + masquer(message.to) }) };
}

async function envoyerHttpMail(message) {
  const params = remplir(conf.mailHttp.params || '{"to":"{to}","subject":"{subject}","text":"{text}"}', {
    to: message.to, subject: message.subject, text: message.text || '', html: message.html || '', key: conf.mailHttp.key,
  });
  const url = remplir(conf.mailHttp.url, { to: message.to, subject: message.subject, key: conf.mailHttp.key });
  const init = { method: conf.mailHttp.method, headers: {} };
  if (conf.mailHttp.method === 'GET') {
    const q = new URLSearchParams(JSON.parse(params)).toString();
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + q);
    return { status: res.status };
  }
  const donnees = JSON.parse(params);
  init.headers['content-type'] = 'application/json';
  if (conf.mailHttp.key) init.headers.authorization = 'Bearer ' + conf.mailHttp.key;
  init.body = JSON.stringify(donnees);
  const res = await fetch(url, init);
  return { status: res.status, ref: res.headers.get('x-message-id') || null };
}

async function sendMail(db, { to, subject, text, html, company_id, purpose }) {
  if (!to) return { ok: false, error: 'destinataire manquant' };
  const payload = { from: conf.from, to, subject, text, html };
  try {
    if (conf.mail === 'console' || !mailConfigured()) {
      console.log(`[RH PLUS] EMAIL (non configuré — mode console) → ${masquer(to)} · ${subject}\n${masquerCodes(text).split('\n').map((l) => '    ' + l).join('\n')}`);
      journaliser(db, { company_id, channel: 'email', recipient: to, purpose, status: 'console', provider: 'console' });
      return { ok: true, mode: 'console', console: true };
    }
    const info = await transport().sendMail(payload);
    const ref = (info && (info.messageId || info.ref)) || null;
    journaliser(db, { company_id, channel: 'email', recipient: to, purpose, status: 'envoye', provider: conf.mail, provider_ref: ref });
    return { ok: true, mode: conf.mail, ref };
  } catch (err) {
    console.error('[RH PLUS] échec envoi email :', masquerCodes(err.message));
    journaliser(db, { company_id, channel: 'email', recipient: to, purpose, status: 'echec', provider: conf.mail, error: err.message });
    return { ok: false, error: err.message };
  }
}

/* -------------------------------- SMS --------------------------------- */
function remplir(modele, valeurs) {
  return String(modele || '').replace(/\{(\w+)\}/g, (m, cle) => (valeurs[cle] === undefined ? '' : String(valeurs[cle])));
}

async function sendSms(db, { to, text, company_id, purpose }) {
  if (!to) return { ok: false, error: 'numéro manquant' };
  try {
    if (!smsConfigured() || conf.sms.provider === 'console') {
      console.log(`[RH PLUS] SMS (non configuré — mode console) → ${masquer(to)} · ${masquerCodes(text)}`);
      journaliser(db, { company_id, channel: 'sms', recipient: to, purpose, status: 'console', provider: 'console' });
      return { ok: true, mode: 'console', console: true };
    }
    if (conf.sms.provider === 'africastalking') {
      const body = new URLSearchParams({
        username: conf.sms.username || conf.sms.key,
        to: String(to),
        message: String(text),
        from: conf.sms.sender,
      });
      const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: { apiKey: conf.sms.key, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
      const data = await res.json().catch(() => ({}));
      const ref = data && data.SMSData && data.SMSData.Recipients && data.SMSData.Recipients[0] && data.SMSData.Recipients[0].messageId;
      if (!res.ok) throw new Error('Africa\'s Talking : HTTP ' + res.status);
      journaliser(db, { company_id, channel: 'sms', recipient: to, purpose, status: 'envoye', provider: 'africastalking', provider_ref: ref || null });
      return { ok: true, mode: 'africastalking', ref: ref || null };
    }
    // passerelle HTTP générique (Airtel, Moov, agrégateur local) : modèle d'URL paramétrable
    const texte = String(text);
    const url = remplir(conf.sms.url, { to, text: encodeURIComponent(texte), sender: conf.sms.sender, key: conf.sms.key });
    const init = { method: conf.sms.method, headers: {} };
    if (conf.sms.method === 'POST') {
      const params = conf.sms.params
        ? JSON.parse(remplir(conf.sms.params, { to, text: texte, sender: conf.sms.sender, key: conf.sms.key }))
        : { to, message: texte, sender: conf.sms.sender, apiKey: conf.sms.key };
      init.headers['content-type'] = 'application/json';
      if (conf.sms.key) init.headers.authorization = 'Bearer ' + conf.sms.key;
      init.body = JSON.stringify(params);
    }
    const res = await fetch(url, init);
    const corps = await res.text().catch(() => '');
    if (!res.ok) throw new Error('passerelle SMS : HTTP ' + res.status + ' ' + masquerCodes(corps).slice(0, 120));
    journaliser(db, { company_id, channel: 'sms', recipient: to, purpose, status: 'envoye', provider: 'http', provider_ref: null });
    return { ok: true, mode: 'http' };
  } catch (err) {
    console.error('[RH PLUS] échec envoi SMS :', masquerCodes(err.message));
    journaliser(db, { company_id, channel: 'sms', recipient: to, purpose, status: 'echec', provider: conf.sms.provider, error: err.message });
    return { ok: false, error: err.message };
  }
}

/* ---------------------- modèles de messages --------------------------- */
const codeEmail = (code, { name = '', company = '', minutes = 10 } = {}) => ({
  subject: `RH PLUS — votre code de connexion : ${code}`,
  text: `Bonjour${name ? ' ' + name : ''},\n\n`
    + `Votre code de vérification RH PLUS est : ${code}\n`
    + `Il est valable ${minutes} minutes et ne fonctionne qu'une seule fois.\n\n`
    + `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : le code expirera de lui-même.\n\n`
    + `— RH PLUS${company ? ' · ' + company : ''}\n`,
});

const codeSms = (code, { minutes = 10 } = {}) => ({
  text: `RH PLUS : votre code de connexion est ${code}. Valable ${minutes} min. Ne le partagez avec personne.`,
});

const resetEmail = (code, { name = '', minutes = 30 } = {}) => ({
  subject: 'RH PLUS — réinitialisation de votre mot de passe',
  text: `Bonjour${name ? ' ' + name : ''},\n\n`
    + `Vous avez demandé à changer votre mot de passe. Code de vérification : ${code}\n`
    + `Valable ${minutes} minutes. Si vous n'avez rien demandé, ignorez ce message : votre mot de passe reste inchangé.\n\n— RH PLUS\n`,
});

const alerteContratEmail = ({ name, type, end_date, jours, company = '' } = {}) => ({
  subject: `RH PLUS — contrat de ${name} à échéance dans ${jours} jour(s)`,
  text: `Le contrat ${type} de ${name} arrive à échéance le ${end_date} (soit dans ${jours} jour(s)).\n\n`
    + `Pensez à préparer le renouvellement, l'avenant ou le solde de tout compte.\n\n— RH PLUS${company ? ' · ' + company : ''}\n`,
});

const factureEmail = ({ ref, montant, devise = 'FCFA', echeance = '' } = {}) => ({
  subject: `RH PLUS — facture ${ref}`,
  text: `Votre facture ${ref} d'un montant de ${montant} ${devise} est disponible dans votre espace (Abonnement).\n`
    + (echeance ? `Échéance : ${echeance}.\n` : '')
    + `\nPaiement par Airtel Money, Moov Money ou virement.\n\n— RH PLUS\n`,
});

/* Envoi du code de connexion : email systématique, SMS si le salarié a un numéro. */
async function envoyerCodeConnexion(db, { user, code, company }) {
  const ttl = cfg.TWOFA_TTL_MINUTES;
  const envois = [];
  if (user.email) {
    const mail = codeEmail(code, { name: user.name, company: company && company.name, minutes: ttl });
    envois.push({ canal: 'email', ...(await sendMail(db, { to: user.email, ...mail, company_id: user.company_id, purpose: 'code 2FA' })) });
  }
  if (user.phone) {
    const sms = codeSms(code, { minutes: ttl });
    envois.push({ canal: 'sms', ...(await sendSms(db, { to: user.phone, text: sms.text, company_id: user.company_id, purpose: 'code 2FA' })) });
  }
  const reel = envois.some((e) => e.ok && e.mode !== 'console');
  return { envois, reel, canaux: envois.map((e) => e.canal + (e.ok ? (e.mode === 'console' ? ' (console)' : ' (envoyé)') : ' (échec)')).join(', ') };
}

module.exports = {
  etat, sendMail, sendSms, envoyerCodeConnexion, masquer, masquerCodes,
  mailConfigured, smsConfigured, codeEmail, codeSms, resetEmail, alerteContratEmail, factureEmail,
  config: conf,
};
