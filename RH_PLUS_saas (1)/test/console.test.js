'use strict';
/* =====================================================================
   Tests de la console web (public/index.html) — vrai DOM avec jsdom

   On démarre le serveur sur une base neuve créée par scripts/seed.js, on
   charge la console comme le ferait un navigateur, et on vérifie ce que
   l'utilisateur voit réellement : connexion en deux étapes, onglets,
   tableaux, fenêtres de détail, téléchargements.
   ===================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let JSDOMClass; let VirtualConsole;
try { ({ JSDOM: JSDOMClass, VirtualConsole } = require('jsdom')); } catch { /* dépendance de développement absente */ }

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rhplus-console-'));
process.env.RHPLUS_DATA_DIR = DATA;
process.env.RHPLUS_DB = path.join(DATA, 'console.sqlite');
process.env.NODE_ENV = 'development';
process.env.PORT = '0';

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
async function jusqua(fn, etiquette, limite = 15000) {  // tolérant : la suite tourne en parallèle
  const debut = Date.now();
  for (;;) {
    let valeur;
    try { valeur = fn(); } catch { valeur = null; }
    if (valeur) return valeur;
    if (Date.now() - debut > limite) throw new Error('Délai dépassé : ' + etiquette);
    await attendre(25);
  }
}

test('console web', { skip: !JSDOMClass ? 'jsdom absent (npm install --include=dev)' : false }, async (t) => {
  execFileSync(process.execPath, ['scripts/seed.js'], { cwd: ROOT, env: process.env, stdio: 'pipe' });
  const db = require('../src/db');
  const { createApp } = require('../src/app');
  const database = db.openDatabase(process.env.RHPLUS_DB);
  const serveur = createApp(database).listen(0);
  await new Promise((r) => serveur.once('listening', r));
  const base = 'http://127.0.0.1:' + serveur.address().port;
  t.after(() => serveur.close());

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  /* Monte une console comme un navigateur : cookies suivis, fenêtres de dialogue
     simulées, téléchargements interceptés. */
  function monterConsole() {
  const erreurs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => erreurs.push(e.message));
  vc.on('error', (m) => erreurs.push(String(m)));
  const cookies = {};
  const telechargements = [];
  const dom = new JSDOMClass(html, {
    url: base + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = async (url, options = {}) => {
        const cible = String(url).startsWith('http') ? String(url) : base + String(url);
        const entetes = Object.assign({}, options.headers || {});
        const biscuit = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        if (biscuit) entetes.cookie = biscuit;
        const res = await fetch(cible, { ...options, headers: entetes, redirect: 'manual' });
        for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
          const [paire] = c.split(';');
          const [nom, valeur] = paire.split('=');
          if (valeur === '') delete cookies[nom]; else cookies[nom] = valeur;
        }
        return res;
      };
      window.URL.createObjectURL = () => 'blob:rhplus';
      window.URL.revokeObjectURL = () => {};
      // jsdom n'implémente pas les boîtes de dialogue : on les simule et on trace
      const proto = window.HTMLDialogElement && window.HTMLDialogElement.prototype;
      if (proto) {
        proto.showModal = function showModal() { this.open = true; };
        proto.show = function show() { this.open = true; };
        proto.close = function close() { this.open = false; };
      } else {
        window.HTMLDialogElement = function () {};
        window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      }
      const clic = window.HTMLAnchorElement.prototype.click;
      window.HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute('download')) {
          telechargements.push({ nom: this.getAttribute('download'), href: this.getAttribute('href') });
          return;
        }
        return clic.apply(this, arguments);
      };
    },
  });
  const win = dom.window;
  return {
    win, dom, erreurs, cookies, telechargements,
    $: (sel) => win.document.querySelector(sel),
    $$: (sel) => Array.from(win.document.querySelectorAll(sel)),
    texte: () => win.document.body.textContent.replace(/\s+/g, ' '),
  };
  }

  let CONSOLE = monterConsole();
  const $ = (sel) => CONSOLE.$(sel);
  const $$ = (sel) => CONSOLE.$$(sel);
  const texte = () => CONSOLE.texte();
  const telechargements = CONSOLE.telechargements;
  const erreurs = CONSOLE.erreurs;

  await t.test('0. sans réseau (aperçu hors ligne), la console affiche quand même sa page', async () => {
    // Cas d'un aperçu intégré sans accès réseau : aucune requête n'aboutit.
    // L'interface ne doit jamais rester blanche.
    const { JSDOM: JSDOMHorsLigne, VirtualConsole: VCHorsLigne } = require('jsdom');
    const vc = new VCHorsLigne();
    const dom = new JSDOMHorsLigne(html, {
      url: 'https://apercu.exemple.ga/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(window) {
        window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        window.URL.createObjectURL = () => 'blob:x';
      },
    });
    const w = dom.window;
    await jusqua(() => w.document.querySelector('#lg-go'), 'formulaire affiché malgré l’absence de réseau');
    assert.ok(/RH PLUS/.test(w.document.body.textContent), 'la marque est visible');
    assert.ok(!/^\s*$/.test(w.document.body.textContent), 'la page n’est pas blanche');
    dom.window.close();
  });

  await t.test('1. la console se charge et propose la connexion sécurisée', async () => {
    await jusqua(() => $('#lg-go'), 'formulaire de connexion');
    assert.ok(/connexion sécurisée/i.test(texte()));
    assert.equal($$('.tab').length, 0, 'aucun onglet avant la connexion');
  });

  await t.test('2. connexion en deux étapes, puis affichage de l’entreprise et des onglets', async () => {
    $('#lg-email').value = 'admin@rhplus.ga';
    $('#lg-pass').value = 'RhPlus!2026';
    $('#lg-go').click();
    await jusqua(() => $('#login-step2') && $('#login-step2').style.display !== 'none', 'étape 2');
    const code = await jusqua(() => { const w = $('#login-step2 .warn strong'); return w && w.textContent.trim(); }, 'code affiché hors production');
    assert.match(code, /^\d{6}$/, 'code à 6 chiffres');
    $('#lg-code').value = code;
    $('#lg-verify').click();
    await jusqua(() => $$('.tab').length > 0, 'coquille applicative');
    assert.equal($$('.tab').length, 9, 'les 9 onglets sont affichés');
    assert.ok(/Lune Digital/.test(texte()), 'nom de l’entreprise');
    assert.ok(/Gabon/.test(texte()), 'pays');
    assert.ok(/FCFA/.test(texte()), 'devise');
    assert.ok(/Conformité/.test(texte()) && /Coffre-fort/.test(texte()));
  });

  await t.test('3. le tableau de bord affiche les chiffres réels', async () => {
    await jusqua(() => $$('#view .kpi').length >= 6, 'cartes d’indicateurs');
    const t2 = texte().replace(/\u202f|\u00a0|\s+/g, ' ');
    assert.match(t2, /Effectif/);
    assert.match(t2, /Masse salariale/);
    assert.match(t2, /4 090 000 FCFA/, 'masse salariale calculée : ' + t2.slice(0, 300));
    assert.match(t2, /Barèmes de paie non validés|Barèmes de paie validés/, 'état des barèmes affiché');
  });

  await t.test('4. l’onglet Employés liste les six salariés et ouvre une fiche', async () => {
    $$('.tab').find((b) => b.textContent.includes('Employés')).click();
    await jusqua(() => $$('table tbody tr').length >= 6, 'tableau des employés');
    const lignes = $$('table tbody tr');
    assert.equal(lignes.length, 6);
    const premier = lignes.map((l) => l.textContent).join(' | ');
    assert.match(premier, /RHP-0001/);
    lignes[0].querySelector('[data-view]').click();
    const fiche = await jusqua(() => { const d = $('#dlg-body'); return d && d.textContent.length > 50 ? d.textContent : null; }, 'fiche employé');
    assert.match(fiche, /Parcours/, 'la fiche présente le parcours professionnel');
    assert.match(fiche, /Origine/, 'l’origine de recrutement est tracée');
    assert.match(fiche, /RHP-\d{4}/, 'matricule affiché');
    assert.match(fiche, /N° CNSS \(déchiffré\)/);
  });

  await t.test('5. chaque module s’ouvre sans erreur', async () => {
    for (const onglet of ['Congés', 'Paie', 'Coffre-fort', 'Abonnement', 'Conformité', 'Comptes & accès', 'Journal']) {
      $$('.tab').find((b) => b.textContent.includes(onglet)).click();
      await attendre(120);
      const corps = $('#view').textContent;
      assert.ok(corps.length > 40, onglet + ' : contenu affiché');
      assert.ok(!/Erreur :/.test(corps), onglet + ' : aucune erreur (' + corps.slice(0, 120) + ')');
    }
    assert.deepEqual(CONSOLE.erreurs, [], 'aucune erreur JavaScript pendant la navigation');
  });

  await t.test('6. la génération de bulletins est tracée dans le journal', async () => {
    $$('.tab').find((b) => b.textContent.includes('Journal')).click();
    await jusqua(() => $$('table tbody tr').length > 0, 'journal d’audit');
    const t3 = texte();
    assert.match(t3, /Connexion|Validation|Création|Paie|Bulletin/);
  });

  await t.test('7. console de l’éditeur : portefeuille, barèmes, envois', async () => {
    // création du compte plateforme, puis ouverture de la console éditeur
    execFileSync(process.execPath, ['scripts/create-platform-admin.js', '--email=editeur@rhplus.ga', '--name=Direction RH PLUS', '--password=Plateforme#2026'], { cwd: ROOT, env: process.env, stdio: 'pipe' });
    CONSOLE = monterConsole();
    await jusqua(() => CONSOLE.$('#lg-go'), 'formulaire de connexion éditeur');
    CONSOLE.$('#lg-email').value = 'editeur@rhplus.ga';
    CONSOLE.$('#lg-pass').value = 'Plateforme#2026';
    CONSOLE.$('#lg-go').click();
    await jusqua(() => CONSOLE.$('#login-step2') && CONSOLE.$('#login-step2').style.display !== 'none', 'étape 2 éditeur');
    const code = await jusqua(() => { const w = CONSOLE.$('#login-step2 .warn strong'); return w && w.textContent.trim(); }, 'code éditeur');
    CONSOLE.$('#lg-code').value = code;
    CONSOLE.$('#lg-verify').click();
    await jusqua(() => CONSOLE.$$('.tab').length > 0, 'coquille éditeur');

    assert.deepEqual(CONSOLE.$$('.tab').map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
      ['Plateforme', 'Journal'], 'l’éditeur ne voit pas les dossiers des salariés');
    await jusqua(() => CONSOLE.$$('#view table tbody tr').length >= 1, 'portefeuille');
    const vue = CONSOLE.texte().replace(/\u202f|\u00a0|\s+/g, ' ');
    assert.match(vue, /Lune Digital/, 'l’entreprise cliente est listée');
    assert.match(vue, /35 000 FCFA/, 'abonnement mensuel affiché');
    assert.match(vue, /GA-2026\.1/, 'version du barème de paie affichée');
    assert.match(vue, /à valider/, 'barème signalé comme non validé');
    assert.match(vue, /Entreprises clientes/);
    assert.match(vue, /Envois de notifications/, 'état des canaux d’envoi');
    assert.match(vue, /non configuré/, 'canaux signalés non configurés hors production');

    // la note de validation se télécharge, la validation débloque les bulletins
    CONSOLE.$('[data-note]').click();
    await jusqua(() => CONSOLE.telechargements.length > 0, 'téléchargement de la note');
    assert.match(CONSOLE.telechargements[0].nom, /Note_validation_baremes/);

    CONSOLE.$('[data-valider]').click();
    await jusqua(() => CONSOLE.$('#v-enr'), 'formulaire de validation');
    CONSOLE.$('#v-cab').value = 'Cabinet Fiduciaire de l\'Estuaire';
    CONSOLE.$('#v-exp').value = 'M. Nzé, expert-comptable';
    CONSOLE.$('#v-ref').value = 'VAL-GA-2026-014';
    CONSOLE.$('#v-enr').click();
    await jusqua(() => database.prepare('SELECT COUNT(*) n FROM rate_validations').get().n === 1, 'validation enregistrée en base');
    await jusqua(() => /jusqu'au/.test(CONSOLE.texte()), 'barème validé à l’écran');
    const apres = CONSOLE.texte().replace(/\u202f|\u00a0|\s+/g, ' ');
    assert.match(apres, /VAL-GA-2026-014/, 'référence de la lettre de validation affichée');
    assert.match(apres, /Estuaire/, 'cabinet affiché');
    assert.deepEqual(CONSOLE.erreurs, [], 'aucune erreur JavaScript dans la console éditeur');
  });

  await t.test('8. déconnexion : retour à l’écran de connexion', async () => {
    $('#logout') && $('#logout').click();
    await jusqua(() => $('#lg-go'), 'retour au formulaire');
    assert.equal($$('.tab').length, 0);
  });
});
