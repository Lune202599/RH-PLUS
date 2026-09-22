'use strict';
/* Visite guidée automatique de la démonstration RH PLUS.
   Ouvre un vrai navigateur (Chromium sans interface), se connecte comme un
   utilisateur, parcourt les écrans et enregistre une capture de chacun.
   Usage : node scripts/captures-demo.js [http://127.0.0.1:3000] */
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const SORTIE = process.argv[3] || '/home/user/demo-captures';
const NAVIGATEUR = process.env.RHPLUS_CHROMIUM || '/usr/bin/chromium';
const LARGEUR = 1440, HAUTEUR = 950;

fs.mkdirSync(SORTIE, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navigateur = await puppeteer.launch({
    executablePath: NAVIGATEUR,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--lang=fr-FR'],
    defaultViewport: { width: LARGEUR, height: HAUTEUR, deviceScaleFactor: 1 },
  });
  const page = await navigateur.newPage();
  const captures = [];
  const capturer = async (nom, legende) => {
    await pause(500);
    const fichier = path.join(SORTIE, `${nom}.jpg`);
    await page.screenshot({ path: fichier, type: 'jpeg', quality: 82, fullPage: false });
    captures.push({ nom, legende, fichier, taille: fs.statSync(fichier).size });
    console.log(`capture : ${nom.padEnd(28)} ${legende}`);
  };
  const attendre = async (selecteur, limite = 12000) => {
    await page.waitForSelector(selecteur, { timeout: limite });
  };
  const cliquer = async (texteOnglet) => {
    await page.evaluate((t) => {
      const b = Array.from(document.querySelectorAll('.tab')).find((x) => x.textContent.includes(t));
      if (!b) throw new Error('onglet introuvable : ' + t);
      b.click();
    }, texteOnglet);
    await pause(900);
  };
  const remplir = async (selecteur, texte) => {
    await page.$eval(selecteur, (el) => { el.value = ''; });
    await page.type(selecteur, texte, { delay: 8 });
  };
  const connexion = async (url, email, motdepasse) => {
    await page.goto(url, { waitUntil: 'networkidle2' });
    await attendre('#lg-go');
    await remplir('#lg-email', email);
    await remplir('#lg-pass', motdepasse);
    await page.click('#lg-go');
    await page.waitForFunction(() => {
      const e = document.querySelector('#login-step2');
      return e && e.style.display !== 'none';
    }, { timeout: 12000 });
    // hors production, le code est affiché à l'écran : on le lit comme le ferait l'utilisateur
    const code = await page.$eval('#login-step2 .warn strong', (e) => e.textContent.trim());
    await page.type('#lg-code', code, { delay: 8 });
    await page.click('#lg-verify');
    await page.waitForFunction(() => document.querySelectorAll('.tab').length > 0, { timeout: 12000 });
    await pause(900);
  };

  /* ---------- 1. Console, compte de direction ---------- */
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await attendre('#lg-go');
  await capturer('00-connexion', 'Écran de connexion de la console (accès direction, RH, managers)');
  await remplir('#lg-email', 'admin@rhplus.ga');
  await remplir('#lg-pass', 'RhPlus!2026');
  await page.click('#lg-go');
  await page.waitForFunction(() => {
    const e = document.querySelector('#login-step2');
    return e && e.style.display !== 'none';
  }, { timeout: 12000 });
  await capturer('01-connexion-code', 'Connexion en deux étapes : le code part par SMS et email (affiché à l’écran hors production)');
  const code = await page.$eval('#login-step2 .warn strong', (e) => e.textContent.trim());
  await page.type('#lg-code', code, { delay: 6 });
  await page.click('#lg-verify');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length > 0, { timeout: 12000 });
  await pause(1200);
  await capturer('02-tableau-de-bord', 'Tableau de bord : effectif, masse salariale, alertes de contrats, état des barèmes');

  await cliquer('Employés');
  await capturer('03-employes', 'Employés : les 6 salariés de l’entreprise de démonstration');
  await page.evaluate(() => document.querySelector('table tbody tr [data-view]').click());
  await pause(1200);
  await capturer('04-fiche-salarie', 'Fiche salarié : parcours et carrière, congés, bulletins, documents chiffrés, droits RGPD');
  await page.keyboard.press('Escape');
  await pause(400);

  await cliquer('Paie');
  await capturer('05-paie', 'Paie : bulletins de la période, émission verrouillée tant que le barème n’est pas validé');

  await cliquer('Coffre-fort');
  await capturer('06-coffre-fort', 'Coffre-fort : documents chiffrés en AES-256-GCM, empreintes SHA-256, accès journalisés');

  await cliquer('Conformité');
  await capturer('07-conformite', 'Conformité : registre des traitements, durées de conservation, loi n°001/2011 (APDPVP)');

  await cliquer('Abonnement');
  await capturer('08-abonnement', 'Abonnement : offres, factures, paiement mobile money (Airtel / Moov)');

  await cliquer('Journal');
  await capturer('09-journal', 'Journal d’audit : chaque action sensible est horodatée et attribuée');

  /* ---------- 2. Espace plateforme (l’éditeur : vous) ---------- */
  await page.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST' }); });
  await connexion(BASE, 'smz@rhplus.ga', 'Plateforme#2026');
  await capturer('10-plateforme-portefeuille', 'Espace plateforme : les entreprises clientes, leur effectif, leur abonnement, leur conformité');

  await page.evaluate(() => {
    const b = document.querySelector('[data-fiche]');
    if (b) b.click();
  });
  await pause(1200);
  await capturer('11-plateforme-fiche-client', 'Détail d’un client : comptes, facturation, récurrence, dossier APDPVP, délégué à la protection des données');
  await page.keyboard.press('Escape');
  await pause(400);

  await page.evaluate(() => {
    const b = document.querySelector('[data-valider]');
    if (b) b.click();
  });
  await pause(900);
  await capturer('12-plateforme-validation', 'Enregistrement de la validation du barème par le cabinet d’expertise-comptable (12 mois)');
  await page.keyboard.press('Escape');

  /* ---------- 3. Portail salarié ---------- */
  await page.goto(BASE + '/portail', { waitUntil: 'networkidle2' });
  await page.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST' }); });
  await connexion(BASE + '/portail', 'employe@rhplus.ga', 'RhPlus!2026');
  await capturer('13-portail-accueil', 'Portail salarié : espace personnel de la salariée (solde de congés, bulletins, documents)');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, .tab')).find((x) => /Bulletin|Paie/i.test(x.textContent));
    if (b) b.click();
  });
  await pause(1200);
  await capturer('14-portail-bulletins', 'Portail salarié : bulletins de paie téléchargeables en PDF, demande de congé, export des données');

  await navigateur.close();
  fs.writeFileSync(path.join(SORTIE, 'captures.json'), JSON.stringify(captures, null, 2));
  console.log(`\n${captures.length} captures enregistrées dans ${SORTIE}`);
  console.log('poids total :', Math.round(captures.reduce((a, c) => a + c.taille, 0) / 1024), 'Ko');
})().catch((e) => { console.error('Échec de la visite :', e.message); process.exit(1); });
