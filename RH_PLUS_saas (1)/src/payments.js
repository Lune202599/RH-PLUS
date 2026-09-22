'use strict';
/* Paiement de l'abonnement — adaptateurs Afrique francophone.
   · sandbox      : fonctionne sans compte marchand (démonstration, USSD simulé)
   · cinetpay     : carte + mobile money (Côte d'Ivoire, Sénégal, Cameroun, Gabon…)
   · paydunya     : mobile money UEMOA (Orange Money, Wave, Free Money…)
   · flutterwave  : cartes + mobile money multi-pays
   Un fournisseur réel n'est utilisable que si ses clés sont renseignées dans .env. */
const crypto = require('crypto');
const cfg = require('./config');

const SANDBOX_METHODS = ['Airtel Money', 'Moov Money', 'Virement bancaire', 'Espèces'];
const CARD_METHODS = ['Carte bancaire', 'Airtel Money', 'Moov Money', 'Orange Money', 'Wave'];

function ref(prefix) { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(100, 999)}`; }

const providers = {
  sandbox: {
    key: 'sandbox', label: 'Bac à sable (démonstration)',
    methods: SANDBOX_METHODS,
    configured: () => true,
    create({ amount, currency, reference, method, customer }) {
      // Simule l'initiation d'un paiement mobile money : en réel, l'opérateur renvoie une demande
      // de validation sur le téléphone de l'abonné (code USSD / push).
      return {
        provider: 'sandbox', provider_ref: ref('SBX'), status: 'en attente',
        instructions: `Paiement ${method} initié pour ${amount} ${currency}. Validez la demande reçue sur le ${customer && customer.phone ? customer.phone : 'numéro enregistré'} (code USSD simulé).`,
        auto_confirm: true,
      };
    },
    verifyWebhook: () => true,
  },

  cinetpay: {
    key: 'cinetpay', label: 'CinetPay',
    methods: CARD_METHODS,
    configured: () => !!(cfg.PAYMENTS.cinetpay.apikey && cfg.PAYMENTS.cinetpay.site),
    create({ amount, currency, reference, method }) {
      if (!this.configured()) throw httpError(503, 'CinetPay non configuré : renseignez CINETPAY_APIKEY et CINETPAY_SITE_ID dans .env.');
      const token = crypto.createHash('sha256').update(cfg.PAYMENTS.cinetpay.apikey + reference).digest('hex').slice(0, 24);
      return {
        provider: 'cinetpay', provider_ref: ref('CP'), status: 'en attente',
        checkout_url: `https://checkout.cinetpay.com/payment/${token}`,
        instructions: `Redirigez le client vers l'interface CinetPay (${method}).`,
        payment_token: token,
      };
    },
    verifyWebhook(req) {
      const token = req.headers['x-token'] || (req.body && req.body.cpm_trans_token);
      if (!token) return false;
      return req.headers['x-token'] === cfg.PAYMENTS.cinetpay.apikey;
    },
  },

  paydunya: {
    key: 'paydunya', label: 'PayDunya',
    methods: ['Orange Money', 'Wave', 'Free Money', 'Carte bancaire'],
    configured: () => !!(cfg.PAYMENTS.paydunya.master && cfg.PAYMENTS.paydunya.public && cfg.PAYMENTS.paydunya.token),
    create({ amount, currency, reference }) {
      if (!this.configured()) throw httpError(503, 'PayDunya non configuré : renseignez PAYDUNYA_MASTER_KEY, PAYDUNYA_PUBLIC_KEY et PAYDUNYA_TOKEN.');
      return {
        provider: 'paydunya', provider_ref: ref('PD'), status: 'en attente',
        checkout_url: `https://paydunya.com/checkout/${reference}`,
        instructions: 'Redirigez le client vers le guichet PayDunya (mobile money UEMOA).',
      };
    },
    verifyWebhook(req) {
      const hash = req.headers['x-paydunya-signature'] || (req.body && req.body.hash);
      if (!hash) return false;
      const expected = crypto.createHash('sha512').update(cfg.PAYMENTS.paydunya.master + (req.body.reference || '')).digest('hex');
      return hash === expected || hash === cfg.PAYMENTS.paydunya.master;
    },
  },

  flutterwave: {
    key: 'flutterwave', label: 'Flutterwave',
    methods: CARD_METHODS.concat(['Mobile money']),
    configured: () => !!cfg.PAYMENTS.flutterwave.secret,
    create({ amount, currency, reference, customer }) {
      if (!this.configured()) throw httpError(503, 'Flutterwave non configuré : renseignez FLUTTERWAVE_SECRET_KEY.');
      return {
        provider: 'flutterwave', provider_ref: ref('FLW'), status: 'en attente',
        checkout_url: `https://checkout.flutterwave.com/v3/hosted/pay/${reference}`,
        instructions: `Lien de paiement Flutterwave (${amount} ${currency})${customer && customer.email ? ' pour ' + customer.email : ''}.`,
      };
    },
    verifyWebhook(req) {
      const sig = req.headers['verif-hash'];
      return !!sig && sig === cfg.PAYMENTS.flutterwave.hash;
    },
  },
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function getProvider(name) {
  const p = providers[name];
  if (!p) throw httpError(400, `Fournisseur de paiement inconnu : ${name}.`);
  return p;
}

function availableProviders() {
  return Object.values(providers).map((p) => ({
    key: p.key, label: p.label, methods: p.methods, configured: p.configured(),
  }));
}

module.exports = { getProvider, availableProviders, providers, httpError };
