'use strict';
/* =====================================================================
   Tests du PORTAIL SALARIÉ (public/portail.html)

   Le salarié se connecte, fait le tour de ses 6 écrans, demande un congé,
   télécharge son bulletin et exerce son droit d'accès. On vérifie aussi le
   cloisonnement : aucune donnée d'un collègue, aucune donnée financière de
   l'entreprise ne doit être atteignable depuis ce compte.

   Lancer :  npm run test:portail
   ===================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM, preparerEnvironnement, demarrerServeur, ouvrirPage, waitFor } = require('./harness');

const SALARIE = 'employe@rhplus.ga';
preparerEnvironnement('portail');

test('portail salarié — parcours complet et cloisonnement', { skip: JSDOM ? false : 'jsdom non installé (npm install)' }, async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());
  const base = serveur.base;

  await t.test('1. le portail s’ouvre sur une connexion dédiée au salarié', async () => {
    const p = ouvrirPage(base, { fichier: 'portail.html' });
    await waitFor(() => p.$('#lg-email'), 'écran de connexion du portail');
    assert.match(p.doc.title, /Mon espace salarié/);
    assert.match(p.doc.body.textContent, /espace salarié/i);
    assert.match(p.doc.body.textContent, /Ouvrir la console RH PLUS/, 'lien vers la console RH');
    assert.ok(!p.doc.querySelector('header.top'), 'rien n’est affiché avant connexion');
  });

  const p = ouvrirPage(base, { fichier: 'portail.html' });
  await t.test('2. connexion par mot de passe puis code 2FA', async () => {
    const code = await p.connexion(SALARIE);
    assert.match(code, /^\d{6}$/);
    await waitFor(() => p.doc.querySelector('header.top'), 'coquille du portail');
    assert.match(p.doc.querySelector('header.top').textContent, /Lune Digital/);
    assert.ok(p.state.token, 'jeton de session reçu');
  });

  await t.test('3. les 6 écrans du salarié sont là', () => {
    assert.deepStrictEqual([...p.doc.querySelectorAll('.tab')].map((b) => b.dataset.tab),
      ['accueil', 'profil', 'bulletins', 'conges', 'documents', 'droits']);
  });

  await t.test('4. accueil : contrat, bulletin, congés, ancienneté', async () => {
    const txt = await waitFor(() => {
      const v = p.$('#view').textContent;
      return v.includes('Bonjour') && !v.includes('Chargement') ? v : null;
    }, 'accueil du salarié');
    assert.match(txt, /Bonjour Mariam/);
    assert.match(p.doc.querySelector('header.top').textContent, /RHP-0001/, 'matricule affiché en en-tête');
    assert.match(txt, /Mon contrat/);
    assert.match(txt, /Dernier bulletin/);
    assert.match(txt, /Congés à prendre/);
    assert.match(txt, /an\(s\)/, 'ancienneté calculée');
  });

  await t.test('5. mon profil : parcours, canal de recrutement et données déclarées', async () => {
    p.click(p.tab('profil'));
    const txt = await waitFor(() => {
      const v = p.$('#view').textContent;
      return v.includes('Mon profil') && !v.includes('Chargement') ? v : null;
    }, 'profil');
    assert.match(txt, /Parcours & carrière/);
    assert.match(txt, /RH PLUS — Espace Talent/, 'canal de recrutement');
    assert.match(txt, /RHP-0001/);
    assert.match(txt, /700137001/, 'numéro CNSS déchiffré pour son titulaire');
    assert.match(txt, /stocké chiffré/);
  });

  await t.test('6. mes bulletins : téléchargement PDF réel', async () => {
    p.click(p.tab('bulletins'));
    await waitFor(() => p.doc.querySelector('#view [data-pdf]'), 'liste des bulletins');
    assert.match(p.$('#view').textContent, /Net à payer/);
    p.click(p.doc.querySelector('#view [data-pdf]'));
    await waitFor(() => p.state.appels.some((c) => /\/api\/payslips\/\d+\/pdf/.test(c.url) && c.status === 200), 'appel du bulletin PDF');
    await waitFor(() => p.state.telechargements.some((n) => /^Bulletin_.*\.pdf$/.test(n)), 'fichier PDF proposé au téléchargement');
    assert.ok(!/(Erreur|refus)/.test(p.$('#toasts').textContent), 'téléchargement sans erreur');
  });

  await t.test('7. mes congés : demande envoyée au service RH', async () => {
    p.click(p.tab('conges'));
    await waitFor(() => p.$('#new-leave'), 'bouton de demande');
    assert.match(p.$('#view').textContent, /estimation indicative/);
    p.click(p.$('#new-leave'));
    const form = await waitFor(() => p.doc.querySelector('#f-leave'), 'formulaire de congé');
    assert.match(p.doc.querySelector('#dlg-body').textContent, /Type de congé/);
    const jours = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    form.querySelector('[name="from_date"]').value = jours(40);
    form.querySelector('[name="to_date"]').value = jours(44);
    form.querySelector('[name="reason"]').value = 'Congé posé depuis le portail';
    form.dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => /Demande envoyée/.test(p.$('#toasts').textContent), 'confirmation de la demande');
    const ligne = await waitFor(() => [...p.doc.querySelectorAll('#view tbody tr')].find((tr) => tr.textContent.includes('Congé posé depuis le portail')), 'demande visible dans la liste');
    assert.match(ligne.textContent, /En attente/);
    assert.match(ligne.textContent, /5/, '5 jours décomptés');
  });

  await t.test('8. mes documents : coffre-fort et journalisation', async () => {
    p.click(p.tab('documents'));
    const txt = await waitFor(() => {
      const v = p.$('#view').textContent;
      return v.includes('Mes documents') && !v.includes('Chargement') ? v : null;
    }, 'documents');
    assert.match(txt, /Contrat_CDI_Mariam_Ouedraogo\.pdf/, 'pièce déposée par les RH');
    assert.match(txt, /chiffré/i);
    p.click(p.doc.querySelector('#view [data-doc]'));
    await waitFor(() => p.state.appels.some((c) => /\/api\/documents\/\d+\/download/.test(c.url) && c.status === 200), 'téléchargement du document');
    await waitFor(() => p.state.telechargements.includes('Contrat_CDI_Mariam_Ouedraogo.pdf'), 'document remis au salarié');
  });

  await t.test('9. mes droits : export de ses données en un clic', async () => {
    p.click(p.tab('droits'));
    await waitFor(() => p.$('#export'), 'bouton d’export');
    assert.match(p.$('#view').textContent, /Loi n°001\/2011/);
    assert.match(p.$('#view').textContent, /APDPVP/);
    p.click(p.$('#export'));
    await waitFor(() => p.state.appels.some((c) => c.url === '/api/me/export' && c.status === 200), 'export des données');
    await waitFor(() => p.state.telechargements.includes('mes_donnees_RHP-0001.json'), 'fichier d’export remis');
    assert.match(p.$('#toasts').textContent, /Export de vos données téléchargé/);
  });

  await t.test('10. cloisonnement : rien de l’entreprise ni des collègues', async () => {
    const entetes = { authorization: 'Bearer ' + p.state.token };
    const interdit = ['/api/dashboard', '/api/billing', '/api/compliance', '/api/audit'];
    for (const url of interdit) {
      const r = await fetch(base + url, { headers: entetes });
      assert.strictEqual(r.status, 403, url + ' doit être interdit au salarié');
    }
    for (const [url, cle] of [['/api/contracts', 'contracts'], ['/api/leaves', 'leaves'], ['/api/payslips', 'payslips']]) {
      const r = await fetch(base + url, { headers: entetes });
      const d = await r.json();
      assert.strictEqual(r.status, 200, url);
      assert.ok(d[cle].length >= 1, url + ' : ses propres données restent accessibles');
      assert.ok(d[cle].every((x) => x.employee_id === 1), url + ' : uniquement ses lignes (aucun collègue)');
    }
    const autre = await fetch(base + '/api/payslips/2/pdf', { headers: entetes });
    assert.strictEqual(autre.status, 403, 'bulletin d’un collègue inaccessible');
    const autreDossier = await fetch(base + '/api/employees/2', { headers: entetes });
    assert.strictEqual(autreDossier.status, 403, 'dossier d’un collègue inaccessible');
  });

  await t.test('11. le journal d’audit trace les actions du salarié', async () => {
    // connexion RH côté serveur pour consulter le journal
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@rhplus.ga', password: 'RhPlus!2026' }) });
    const { dev_code } = await login.json();
    const verif = await fetch(base + '/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@rhplus.ga', code: dev_code }) });
    const { token } = await verif.json();
    const journal = await (await fetch(base + '/api/audit', { headers: { authorization: 'Bearer ' + token } })).json();
    const actions = journal.entries.map((e) => e.action);
    for (const attendu of ['Demande de congé', 'Export des données personnelles', 'Téléchargement de bulletin PDF', 'Consultation de document', 'Connexion']) {
      assert.ok(actions.includes(attendu), 'action journalisée : ' + attendu);
    }
  });

  await t.test('12. le portail fonctionne aussi sans cookie (jeton en mémoire)', async () => {
    const sans = ouvrirPage(base, { fichier: 'portail.html', cookies: false });
    await sans.connexion(SALARIE);
    await waitFor(() => sans.doc.querySelector('header.top'), 'portail connecté sans cookie');
    const txt = await waitFor(() => (sans.$('#view').textContent.includes('Bonjour') ? sans.$('#view').textContent : null), 'accueil sans cookie');
    assert.match(txt, /Bonjour Mariam/);
    assert.match(sans.doc.querySelector('header.top').textContent, /RHP-0001/);
    assert.strictEqual(sans.state.cookiesStored, 0, 'aucun cookie utilisé');
    assert.strictEqual(sans.state.errors.length, 0, 'aucune erreur JavaScript → ' + sans.state.errors.join(' | '));
  });

  await t.test('13. aucune erreur JavaScript pendant le parcours', () => {
    assert.deepStrictEqual(p.state.errors, []);
  });
});
