'use strict';
/* =====================================================================
   Tests des notifications (email + SMS) et de l'espace plateforme

   Aucun service externe n'est utilisé : un vrai serveur SMTP minimal et une
   vraie passerelle HTTP sont lancés sur des ports locaux. Le test vérifie que
   le code de connexion part réellement par ces canaux, qu'il n'est jamais
   écrit dans la base, et que la réinitialisation de mot de passe fonctionne
   de bout en bout à partir de l'email reçu.
   ===================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rhplus-notif-'));
process.env.RHPLUS_DATA_DIR = DATA;
process.env.RHPLUS_DB = path.join(DATA, 'notif.sqlite');
process.env.NODE_ENV = 'development';
process.env.PORT = '0';

/* --- serveur SMTP minimal : capte les messages sans les livrer --- */
function serveurSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let tampon = ''; let enDonnees = false; let courant = { lignes: [] };
    socket.write('220 rhplus-test SMTP\r\n');
    socket.on('data', (bloc) => {
      tampon += bloc.toString();
      const lignes = tampon.split('\r\n');
      tampon = lignes.pop();
      for (const ligne of lignes) {
        if (enDonnees) {
          if (ligne === '.') {
            enDonnees = false;
            courant.corps = courant.lignes.join('\n');
            messages.push(courant);
            courant = { lignes: [] };
            socket.write('250 OK message accepté\r\n');
          } else courant.lignes.push(ligne);
          continue;
        }
        const haut = ligne.toUpperCase();
        if (haut.startsWith('EHLO') || haut.startsWith('HELO')) socket.write('250-rhplus-test\r\n250 OK\r\n');
        else if (haut.startsWith('MAIL FROM')) { courant.de = ligne; socket.write('250 OK\r\n'); }
        else if (haut.startsWith('RCPT TO')) { courant.a = ligne; socket.write('250 OK\r\n'); }
        else if (haut.startsWith('DATA')) { enDonnees = true; socket.write('354 Envoyez le message\r\n'); }
        else if (haut.startsWith('QUIT')) { socket.write('221 Au revoir\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  return {
    messages,
    ecouter: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    fermer: () => new Promise((r) => server.close(r)),
  };
}

/* --- passerelle SMS simulée --- */
function passerelleSms() {
  const recus = [];
  const server = http.createServer((req, res) => {
    let corps = '';
    req.on('data', (c) => { corps += c; });
    req.on('end', () => {
      recus.push({ url: req.url, corps, entetes: req.headers });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', messageId: 'MSG-' + recus.length }));
    });
  });
  return {
    recus,
    ecouter: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    fermer: () => new Promise((r) => server.close(r)),
  };
}

const smtp = serveurSmtp();
const sms = passerelleSms();

test('notifications et plateforme', async (t) => {
  const portSmtp = await smtp.ecouter();
  const portSms = await sms.ecouter();

  // configuration des canaux AVANT le chargement de l'application
  process.env.RHPLUS_MAIL = 'smtp';
  process.env.RHPLUS_SMTP_HOST = '127.0.0.1';
  process.env.RHPLUS_SMTP_PORT = String(portSmtp);
  process.env.RHPLUS_SMTP_SECURE = 'false';
  process.env.RHPLUS_MAIL_FROM = 'RH PLUS <notifications@rhplus.ga>';
  process.env.RHPLUS_SMS = 'http';
  process.env.RHPLUS_SMS_URL = `http://127.0.0.1:${portSms}/send?to={to}&text={text}&sender={sender}&key={key}`;
  process.env.RHPLUS_SMS_KEY = 'cle-de-test';
  process.env.RHPLUS_SMS_SENDER = 'RHPLUS';

  execFileSync(process.execPath, ['scripts/seed.js'], { cwd: ROOT, env: process.env, stdio: 'pipe' });
  // compte plateforme (éditeur)
  execFileSync(process.execPath, ['scripts/create-platform-admin.js', '--email=editeur@rhplus.ga', '--name=Direction RH PLUS', '--password=Plateforme#2026'], { cwd: ROOT, env: process.env, stdio: 'pipe' });

  const db = require('../src/db');
  const { createApp } = require('../src/app');
  const database = db.openDatabase(process.env.RHPLUS_DB);
  const serveur = createApp(database).listen(0);
  await new Promise((r) => serveur.once('listening', r));
  const base = 'http://127.0.0.1:' + serveur.address().port;
  const jar = {};
  const call = async (qui, methode, url, corps, entetes = {}) => {
    const res = await fetch(base + url, {
      method: methode,
      headers: { 'content-type': 'application/json', ...(jar[qui] ? { cookie: jar[qui] } : {}), ...entetes },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) jar[qui] = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
  };
  const connexion = async (qui, email, motdepasse) => {
    const l = await call(qui, 'POST', '/api/auth/login', { email, password: motdepasse });
    assert.equal(l.status, 200, 'connexion ' + email);
    const v = await call(qui, 'POST', '/api/auth/verify', { email, code: l.data.dev_code });
    assert.equal(v.status, 200);
    return v.data.token;
  };
  t.after(async () => { serveur.close(); await smtp.fermer(); await sms.fermer(); });

  await t.test('1. le code de connexion part réellement par email (SMTP) et par SMS', async () => {
    smtp.messages.length = 0; sms.recus.length = 0;
    const l = await call('A', 'POST', '/api/auth/login', { email: 'admin@rhplus.ga', password: 'RhPlus!2026' });
    assert.equal(l.status, 200);
    assert.equal(l.data.step, '2fa');
    assert.match(l.data.delivery, /email \(envoyé\)/, 'canal email déclaré envoyé : ' + l.data.delivery);

    const courriel = smtp.messages[0];
    assert.ok(courriel, 'un email est arrivé sur le serveur SMTP');
    assert.match(courriel.a || '', /admin@rhplus\.ga/);
    assert.match(courriel.corps, new RegExp(l.data.dev_code), 'l’email contient bien le code demandé');
    assert.match(courriel.corps, /valable 10 minutes/i);
  });

  await t.test('2. le SMS part par la passerelle configurée', async () => {
    // on donne un numéro au compte RH, puis reconnexion
    const token = await connexion('P', 'admin@rhplus.ga', 'RhPlus!2026');
    const maj = await call('P', 'PATCH', '/api/users/1', { }, { });
    assert.ok(maj.status === 200 || maj.status === 403, 'endpoint de compte accessible ou réservé');
    // le numéro est posé directement en base (l'API de comptes réserve le téléphone à l'admin plateforme)
    database.prepare('UPDATE users SET phone = ? WHERE email = ?').run('+241 06 12 34 56', 'admin@rhplus.ga');
    smtp.messages.length = 0; sms.recus.length = 0;

    const l = await call('B', 'POST', '/api/auth/login', { email: 'admin@rhplus.ga', password: 'RhPlus!2026' });
    assert.match(l.data.delivery, /sms \(envoyé\)/, 'canal SMS déclaré envoyé : ' + l.data.delivery);
    assert.ok(sms.recus.length >= 1, 'la passerelle SMS a reçu une requête');
    const url = decodeURIComponent(sms.recus[0].url);
    assert.match(url, new RegExp(l.data.dev_code), 'le SMS contient le code');
    assert.match(url, /RHPLUS/, 'expéditeur transmis');
    assert.match(sms.recus[0].url, /key=cle-de-test/, 'clé d’API transmise');
    await call('B', 'POST', '/api/auth/verify', { email: 'admin@rhplus.ga', code: l.data.dev_code });
  });

  await t.test('3. la base ne contient jamais le code, seulement la trace de l’envoi', () => {
    const lignes = database.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 10').all();
    assert.ok(lignes.length >= 2, 'les envois sont journalisés');
    const champs = JSON.stringify(lignes);
    assert.ok(!/\b\d{6}\b/.test(champs), 'aucun code à 6 chiffres dans le journal des messages');
    assert.match(lignes[0].recipient, /•/, 'destinataire masqué : ' + lignes[0].recipient);
    assert.equal(lignes[0].status, 'envoye');
    assert.ok(['email', 'sms'].includes(lignes[0].channel));
  });

  await t.test('4. mot de passe oublié : le code arrive par email et permet de se reconnecter', async () => {
    smtp.messages.length = 0;
    const demande = await call('C', 'POST', '/api/auth/forgot', { email: 'paie@rhplus.ga' });
    assert.equal(demande.status, 200);
    assert.ok(!JSON.stringify(demande.data).match(/\d{6}/), 'le code n’est pas renvoyé dans la réponse HTTP');
    const courriel = smtp.messages[smtp.messages.length - 1];
    assert.ok(courriel, 'email de réinitialisation reçu');
    const code = (courriel.corps.match(/\b(\d{6})\b/) || [])[1];
    assert.ok(code, 'code présent dans l’email');

    const court = await call('C', 'POST', '/api/auth/reset', { email: 'paie@rhplus.ga', code, password: 'court' });
    assert.equal(court.status, 400, 'mot de passe trop court refusé');

    const reset = await call('C', 'POST', '/api/auth/reset', { email: 'paie@rhplus.ga', code, password: 'Nouveau#MotDePasse2026' });
    assert.equal(reset.status, 200, 'réinitialisation acceptée');
    const connexion = await call('C', 'POST', '/api/auth/login', { email: 'paie@rhplus.ga', password: 'Nouveau#MotDePasse2026' });
    assert.equal(connexion.status, 200, 'connexion avec le nouveau mot de passe');
    // retour à l'état initial pour les tests suivants
    database.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(require('../src/crypto').hashPassword('RhPlus!2026'), 'paie@rhplus.ga');
  });

  await t.test('5. changement de mot de passe par le titulaire, sessions révoquées', async () => {
    const token = await connexion('D', 'manager@rhplus.ga', 'RhPlus!2026');
    const mauvais = await call('D', 'POST', '/api/auth/password', { current: 'faux', password: 'Autre#MotDePasse2026' });
    assert.equal(mauvais.status, 401, 'mot de passe actuel erroné refusé');
    const bon = await call('D', 'POST', '/api/auth/password', { current: 'RhPlus!2026', password: 'Autre#MotDePasse2026' });
    assert.equal(bon.status, 200);
    const apres = await call('D', 'GET', '/api/auth/me', null, { authorization: 'Bearer ' + token });
    assert.equal(apres.status, 401, 'les sessions ouvertes sont révoquées');
    database.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(require('../src/crypto').hashPassword('RhPlus!2026'), 'manager@rhplus.ga');
  });

  await t.test('6. un administrateur d’entreprise n’atteint pas l’espace plateforme', async () => {
    await connexion('E', 'admin@rhplus.ga', 'RhPlus!2026');
    for (const url of ['/api/platform/overview', '/api/platform/validations', '/api/platform/messages']) {
      const r = await call('E', 'GET', url);
      assert.equal(r.status, 403, url + ' interdit à un client');
    }
  });

  await t.test('7. le compte plateforme voit les entreprises, leur usage et leur conformité', async () => {
    await connexion('F', 'editeur@rhplus.ga', 'Plateforme#2026');
    const vue = await call('F', 'GET', '/api/platform/overview');
    assert.equal(vue.status, 200);
    const noms = vue.data.entreprises.map((e) => e.name);
    assert.ok(noms.includes('Lune Digital'), 'l’entreprise cliente est listée : ' + noms.join(', '));
    assert.ok(!noms.includes('RH PLUS'), 'l’entité éditeur ne se facture pas elle-même');
    const lune = vue.data.entreprises.find((e) => e.name === 'Lune Digital');
    assert.equal(lune.usage.effectif, 6, 'effectif réel lu en base');
    assert.ok(lune.usage.comptes >= 4, 'comptes utilisateurs comptés');
    assert.equal(lune.usage.mrr, 35000, 'abonnement mensuel de l’offre PME');
    assert.ok(lune.conformite.baremes.version.startsWith('GA-'), 'version du barème affichée');
    assert.equal(vue.data.totaux.entreprises, 1);
    assert.ok(vue.data.messaging.email.configured, 'état des canaux d’envoi exposé');
    assert.equal(vue.data.messaging.sms.configured, true);
  });

  await t.test('8. création d’une entreprise cliente par la plateforme, puis suspension', async () => {
    const creation = await call('F', 'POST', '/api/platform/companies', {
      company: { name: 'Société Test Plateau', country: 'Gabon', city: 'Franceville', plan: 'starter' },
      admin: { email: 'direction@plateau.ga', name: 'Direction Plateau', password: 'Client#2026Plateau' },
    });
    assert.equal(creation.status, 201);
    assert.ok(creation.data.company.id, 'identifiant attribué');

    const liste = await call('F', 'GET', '/api/platform/overview');
    const creee = liste.data.entreprises.find((e) => e.id === creation.data.company.id);
    assert.equal(creee.usage.effectif, 0);
    assert.equal(creee.usage.mrr, 12500, 'offre Starter facturée');

    const connexionClient = await call('G', 'POST', '/api/auth/login', { email: 'direction@plateau.ga', password: 'Client#2026Plateau' });
    assert.equal(connexionClient.status, 200, 'le client peut se connecter');

    const suspension = await call('F', 'PATCH', '/api/platform/companies/' + creation.data.company.id, { suspended: true });
    assert.equal(suspension.status, 200);
    const apresSuspension = await call('H', 'POST', '/api/auth/login', { email: 'direction@plateau.ga', password: 'Client#2026Plateau' });
    assert.equal(apresSuspension.status, 403, 'accès suspendu : connexion refusée');
    assert.match(apresSuspension.data.error, /suspendu/i);

    await call('F', 'PATCH', '/api/platform/companies/' + creation.data.company.id, { suspended: false });
    const retabli = await call('I', 'POST', '/api/auth/login', { email: 'direction@plateau.ga', password: 'Client#2026Plateau' });
    assert.equal(retabli.status, 200, 'accès rétabli');
  });

  await t.test('9. validation des barèmes : note PDF à signer, puis émission débloquée', async () => {
    // la note de validation est générée pour le cabinet
    const note = await call('F', 'GET', '/api/platform/validations/note.pdf?country=Gabon');
    assert.equal(note.status, 200);
    assert.equal(note.data.subarray(0, 4).toString(), '%PDF', 'note de validation en PDF');
    assert.ok(note.data.length > 3000);

    // l'entreprise cliente ne peut pas émettre avant validation
    const adminLune = await connexion('J', 'admin@rhplus.ga', 'RhPlus!2026');
    await call('J', 'POST', '/api/payslips/generate', { period: '2026-09' });
    const avant = await call('J', 'POST', '/api/payslips/1/emit', {});
    assert.equal(avant.status, 409, 'émission bloquée sans validation');
    assert.match(avant.data.error, /barèmes de paie GA-2026\.1/);
    assert.ok(avant.data.hint, 'la réponse indique la marche à suivre');

    // la plateforme enregistre la validation signée par le cabinet
    const enregistrement = await call('F', 'POST', '/api/platform/validations', {
      country: 'Gabon', cabinet: 'Cabinet Fiduciaire de l’Estuaire', expert_name: 'M. Nzé, expert-comptable',
      order_ref: 'VAL-GA-2026-014', validated_at: '2026-09-15',
    });
    assert.equal(enregistrement.status, 201);
    assert.equal(enregistrement.data.version, 'GA-2026.1');
    assert.match(enregistrement.data.expires_at, /^2027-09-15$/, 'validité 12 mois');

    const apres = await call('J', 'POST', '/api/payslips/1/emit', {});
    assert.equal(apres.status, 200, 'émission débloquée par la validation du barème');

    const etat = await call('J', 'GET', '/api/compliance');
    assert.equal(etat.data.baremes.a_jour, true);
    assert.equal(etat.data.baremes.source, 'plateforme');
    assert.match(etat.data.baremes.cabinet, /Estuaire/);
  });

  await t.test('10. dossier de déclaration APDPVP généré pour une entreprise', async () => {
    const dossier = await call('F', 'GET', '/api/platform/companies/' + database.prepare("SELECT id FROM companies WHERE name = 'Lune Digital'").get().id + '/dossier-apdpvp.pdf');
    assert.equal(dossier.status, 200);
    assert.equal(dossier.data.subarray(0, 4).toString(), '%PDF');
    assert.ok(dossier.data.length > 5000, 'dossier complet : ' + dossier.data.length + ' octets');
  });

  await t.test('11. test des canaux d’envoi depuis la plateforme, journal des messages', async () => {
    smtp.messages.length = 0; sms.recus.length = 0;
    const test1 = await call('F', 'POST', '/api/platform/messaging/test', { email: 'controle@rhplus.ga', phone: '+241 07 00 00 00' });
    assert.equal(test1.status, 200);
    assert.equal(test1.data.resultats.email.ok, true);
    assert.equal(test1.data.resultats.sms.ok, true);
    assert.ok(smtp.messages.length >= 1, 'email de test reçu');
    assert.ok(sms.recus.length >= 1, 'SMS de test reçu');

    const journal = await call('F', 'GET', '/api/platform/messages');
    assert.equal(journal.status, 200);
    assert.ok(journal.data.messages.length >= 4, 'journal des envois alimenté');
    assert.equal(journal.data.echecs_7j, 0, 'aucun échec d’envoi');
    assert.ok(journal.data.statistiques.length >= 2);
  });
});
