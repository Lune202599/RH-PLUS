'use strict';
/* Application Express : en-têtes de sécurité, journaux, session, routes métier,
   fichiers statiques (console RH PLUS) et gestion d'erreurs. */
const path = require('path');
const express = require('express');
const cfg = require('./config');
const { openDatabase, audit } = require('./db');
const { registerAuthRoutes, authenticate } = require('./auth');
const { registerRoutes } = require('./routes');

function createApp(options = {}) {
  const db = options.db || openDatabase(options.dbPath || cfg.DB_PATH);
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // En-têtes de sécurité (aucune dépendance externe)
  /* Mise en cadre : interdite en production (l'interface ne doit pas être encapsulée
     dans un site tiers). En développement, on autorise l'encadrement par l'hôte
     d'aperçu, sinon la console ne s'affiche pas dans l'aperçu intégré. */
  const miseEnCadre = process.env.RHPLUS_FRAME_ANCESTORS || (cfg.ENV === 'production' ? "'none'" : '');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (cfg.ENV === 'production') res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
      + "script-src 'self' 'unsafe-inline'; connect-src 'self'"
      + (miseEnCadre ? '; frame-ancestors ' + miseEnCadre : ''));
    if (cfg.ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(authenticate(db));

  // Journal des requêtes sensibles (sans données personnelles)
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api/') && res.statusCode >= 400) {
        console.log(`[RH PLUS] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - t0} ms)`);
      }
    });
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'RH PLUS API', version: require('../package.json').version, env: cfg.ENV, at: new Date().toISOString() }));

  registerAuthRoutes(app, db);
  registerRoutes(app, db);
  require('./platform').registerPlatformRoutes(app, db);

  app.use(express.static(path.join(cfg.ROOT, 'public'), { extensions: ['html'] }));
  // Repli : API inconnue → 404 JSON ; sinon la console (application monopage)
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route inconnue.' });
    res.sendFile(path.join(cfg.ROOT, 'public', 'index.html'));
  });

  // Gestionnaire d'erreurs
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[RH PLUS] Erreur serveur :', err.message);
    if (req.user) {
      try { audit(db, { company_id: req.user.company_id, user_id: req.user.id, actor: req.user.email, role: req.user.role, action: 'Erreur applicative', details: `${req.method} ${req.path} — ${err.message}`, ip: req.ip }); } catch {}
    }
    res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur.' : err.message });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
