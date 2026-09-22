'use strict';
/* =====================================================================
   Banc de test commun aux interfaces web (console RH et portail salarié).

   Chaque test démarre un vrai serveur sur une base temporaire, y injecte les
   données de démonstration, puis ouvre la page réelle dans un DOM (jsdom) relié
   à ce serveur. Les pages ne sont pas simulées : c'est le code de production
   qui s'exécute, avec ses vrais appels HTTP.
   ===================================================================== */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let JSDOM; let VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const MOT_DE_PASSE = 'RhPlus!2026';

/* À appeler AVANT de charger src/* : isole les données dans un dossier temporaire. */
function preparerEnvironnement(nom) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rhplus-' + nom + '-'));
  process.env.RHPLUS_DATA_DIR = DATA;
  process.env.RHPLUS_DB = path.join(DATA, 'test.sqlite');
  process.env.NODE_ENV = 'development';
  process.env.PORT = '0';
  return DATA;
}

/* Insère les données de démonstration puis démarre l'application sur un port libre. */
async function demarrerServeur() {
  execFileSync(process.execPath, ['scripts/seed.js'], { cwd: ROOT, env: process.env, stdio: 'pipe' });
  const db = require('../src/db');
  const { createApp } = require('../src/app');
  const app = createApp(db.openDatabase(process.env.RHPLUS_DB));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    fermer: () => server.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error('Délai dépassé : ' + label);
    await sleep(60);
  }
}

/* jsdom n'implémente pas showModal()/close() de <dialog> : on les fournit. */
function patchDialogs(w) {
  const D = w.HTMLDialogElement || (w.HTMLDialogElement = w.HTMLElement);
  D.prototype.showModal = function () { this.setAttribute('open', ''); };
  D.prototype.close = function () { this.removeAttribute('open'); };
  return w;
}

/* Ouvre une page réelle du logiciel dans un DOM relié au serveur.
   `cookies: false` simule un navigateur qui refuse le cookie de session. */
function ouvrirPage(base, { fichier = 'index.html', cookies = true } = {}) {
  const jar = new Map();
  const state = { token: null, errors: [], cookiesStored: 0, appels: [], telechargements: [] };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => state.errors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (m) => state.errors.push('error: ' + String(m)));

  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public', fichier), 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: base + '/',
    virtualConsole,
    beforeParse(window) {
      window.fetch = async (url, opts = {}) => {
        const target = String(url).startsWith('http') ? String(url) : base + String(url);
        const headers = { ...(opts.headers || {}) };
        if (cookies && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const res = await fetch(target, { ...opts, headers, redirect: 'manual' });
        state.appels.push({ method: opts.method || 'GET', url: String(url), status: res.status });
        if (cookies) {
          for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
            const [pair] = c.split(';');
            const i = pair.indexOf('=');
            jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
            state.cookiesStored += 1;
          }
        }
        if (target.includes('/api/auth/verify')) {
          res.clone().json().then((d) => { if (d && d.token) state.token = d.token; }).catch(() => {});
        }
        return res;
      };
      window.URL.createObjectURL = () => 'blob:local';
      window.URL.revokeObjectURL = () => {};
      // jsdom ne sait pas naviguer vers un fichier : on intercepte les liens de
      // téléchargement pour les recenser au lieu de déclencher une navigation.
      const proto = window.HTMLAnchorElement.prototype;
      const clickNative = proto.click;
      proto.click = function () {
        if (this.hasAttribute('download')) { state.telechargements.push(this.getAttribute('download')); return; }
        return clickNative.call(this);
      };
      patchDialogs(window);
    },
  });
  patchDialogs(dom.window);

  const doc = dom.window.document;
  return {
    dom,
    doc,
    state,
    jar,
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    $: (s) => doc.querySelector(s),
    click: (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
    tab: (name) => [...doc.querySelectorAll('.tab')].find((b) => b.dataset.tab === name),
    /* Parcours de connexion commun aux deux interfaces. */
    async connexion(email) {
      await waitFor(() => this.$('#lg-email'), 'écran de connexion');
      this.$('#lg-email').value = email;
      this.$('#lg-pass').value = MOT_DE_PASSE;
      this.click(this.$('#lg-go'));
      const dev = await waitFor(() => {
        const step2 = this.$('#login-step2');
        const shown = step2 && step2.style.display !== 'none';
        const code = doc.querySelector('.warn strong');
        return shown && code ? code : null;
      }, 'écran de code 2FA');
      const code = dev.textContent.trim();
      this.$('#lg-code').value = code;
      this.click(this.$('#lg-verify'));
      return code;
    },
  };
}

module.exports = { JSDOM, ROOT, MOT_DE_PASSE, preparerEnvironnement, demarrerServeur, ouvrirPage, waitFor, sleep, patchDialogs };
