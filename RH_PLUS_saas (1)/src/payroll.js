'use strict';
/* Moteur de paie — paramétrage par pays.
   IMPORTANT : les taux livrés ici sont des VALEURS PAR DÉFAUT NON CERTIFIÉES.
   Tant que le cabinet d'expertise-comptable n'a pas validé les barèmes
   (champs payroll_validated_by / payroll_validated_at de l'entreprise),
   les bulletins sont générés au statut « brouillon » et ne peuvent pas être
   verrouillés/émis. C'est la protection juridique prévue au cahier des charges. */

/* Libellés officiels des lignes de cotisation, utilisés par la note de validation
   remise au cabinet d'expertise-comptable et par les bulletins. */
const RATE_LABELS = {
  retraite_er: ['Retraite / pension — part employeur', 'Salaire brut'],
  retraite_ee: ['Retraite / pension — part salariale', 'Salaire brut'],
  sante_er: ['Assurance maladie — part employeur', 'Salaire brut'],
  sante_ee: ['Assurance maladie — part salariale', 'Salaire brut'],
  at_er: ['Accidents du travail — employeur', 'Salaire brut'],
  famille_er: ['Prestations familiales — employeur', 'Salaire brut'],
  formation_er: ['Taxe de formation professionnelle — employeur', 'Salaire brut'],
  irpp_ee: ['Impôt sur le revenu (retenue) — salarié', 'Salaire brut (barème simplifié)'],
  contribution_ee: ['Contribution nationale / redevance — salarié', 'Salaire brut'],
};

/* Version du barème : à incrémenter dès qu'un taux change. Une validation
   d'expert-comptable porte sur une version précise et devient caduque ensuite. */
const RATES_VERSIONS = {
  Gabon: 'GA-2026.1',
  'Sénégal': 'SN-2026.1',
  Cameroun: 'CM-2026.1',
  "Côte d'Ivoire": 'CI-2026.1',
  France: 'FR-2026.1',
  Maroc: 'MA-2026.1',
};

const COUNTRY_PARAMS = {
  Gabon: {
    currency: 'FCFA', law: 'Code du travail gabonais',
    rates: {
      retraite_er: 0.109, retraite_ee: 0.025,
      sante_er: 0.055, sante_ee: 0.015,
      at_er: 0.03, famille_er: 0.05, formation_er: 0.012,
      irpp_ee: 0.10, contribution_ee: 0.02,
    },
    overtime_majorations: { h1: 0.30, h2: 0.50, nuit: 0.20, ferie: 0.50 },
    note: 'Taux CNSS/CNAMGS/IRPP à valider par un expert-comptable avant émission.',
    certified: false,
  },
  'Sénégal': {
    currency: 'FCFA', law: 'Code du travail sénégalais',
    rates: {
      retraite_er: 0.084, retraite_ee: 0.056,
      sante_er: 0.05, sante_ee: 0.03,
      at_er: 0.03, famille_er: 0.07, formation_er: 0.01,
      irpp_ee: 0.12, contribution_ee: 0,
    },
    overtime_majorations: { h1: 0.15, h2: 0.40, nuit: 0.20, ferie: 0.60 },
    note: 'Barèmes IPRES/CSS/IR à valider par un expert-comptable.',
    certified: false,
  },
  Cameroun: {
    currency: 'FCFA', law: 'Code du travail camerounais',
    rates: {
      retraite_er: 0.042, retraite_ee: 0.042,
      sante_er: 0.015, sante_ee: 0.015,
      at_er: 0.025, famille_er: 0.07, formation_er: 0.015,
      irpp_ee: 0.11, contribution_ee: 0.01,
    },
    overtime_majorations: { h1: 0.20, h2: 0.30, nuit: 0.20, ferie: 0.40 },
    note: 'Barèmes CNPS/IRPP à valider par un expert-comptable.',
    certified: false,
  },
  "Côte d'Ivoire": {
    currency: 'FCFA', law: 'Code du travail ivoirien',
    rates: {
      retraite_er: 0.077, retraite_ee: 0.063,
      sante_er: 0.02, sante_ee: 0.02,
      at_er: 0.05, famille_er: 0.055, formation_er: 0.012,
      irpp_ee: 0.10, contribution_ee: 0.01,
    },
    overtime_majorations: { h1: 0.15, h2: 0.50, nuit: 0.20, ferie: 0.50 },
    note: 'Barèmes CNPS/ITS à valider par un expert-comptable.',
    certified: false,
  },
  France: {
    currency: 'EUR', law: 'Code du travail français',
    rates: {
      retraite_er: 0.0855, retraite_ee: 0.069,
      sante_er: 0.07, sante_ee: 0.008,
      at_er: 0.021, famille_er: 0.0345, formation_er: 0.01,
      irpp_ee: 0.12, contribution_ee: 0.01,
    },
    overtime_majorations: { h1: 0.25, h2: 0.50, nuit: 0.20, ferie: 1.00 },
    note: 'Taux de cotisations simplifiés — barème PAS à paramétrer avec un expert-comptable.',
    certified: false,
  },
  Maroc: {
    currency: 'MAD', law: 'Code du travail marocain',
    rates: {
      retraite_er: 0.0898, retraite_ee: 0.0448,
      sante_er: 0.0411, sante_ee: 0.0226,
      at_er: 0.0164, famille_er: 0.064, formation_er: 0.016,
      irpp_ee: 0.12, contribution_ee: 0,
    },
    overtime_majorations: { h1: 0.25, h2: 0.50, nuit: 0.25, ferie: 0.50 },
    note: 'Barèmes CNSS/AMO/IR à valider par un expert-comptable.',
    certified: false,
  },
};

function versionFor(country) {
  return RATES_VERSIONS[country] || String(country || 'XX').slice(0, 2).toUpperCase() + '-2026.1';
}

/* Liste lisible des taux d'un pays : sert à la note de validation et à l'écran Paie. */
function listeTaux(country) {
  const p = paramsFor(country);
  return Object.entries(p.rates).map(([cle, taux]) => {
    const [libelle, assiette] = RATE_LABELS[cle] || [cle, 'Salaire brut'];
    return { cle, libelle, assiette, taux, pourcentage: (taux * 100).toFixed(2) + ' %' };
  });
}

function paramsFor(country) {
  return COUNTRY_PARAMS[country] || COUNTRY_PARAMS.Gabon;
}

/** Calcule un bulletin. salary et toutes les valeurs monétaires sont en unités entières. */
function computePayslip({ salary, allowances = 0, country = 'Gabon', months = 1, overtime = 0 }) {
  const p = paramsFor(country);
  const r = p.rates;
  const base = Math.round(salary * months);
  const primes = Math.round(allowances);
  const heuresSup = Math.round(overtime);
  const brut = base + primes + heuresSup;

  const line = (code, label, amountBase, erRate, eeRate) => ({
    code, label, base: amountBase,
    rate_er: erRate, rate_ee: eeRate,
    montant_er: Math.round(amountBase * erRate),
    montant_ee: Math.round(amountBase * eeRate),
  });

  const lines = [
    line('retraite', 'CNSS / retraite', brut, r.retraite_er, r.retraite_ee),
    line('sante', 'Santé / assurance maladie', brut, r.sante_er, r.sante_ee),
    line('at', 'Accidents du travail', brut, r.at_er, 0),
    line('famille', 'Prestations familiales', brut, r.famille_er, 0),
    line('formation', 'Formation professionnelle', brut, r.formation_er, 0),
    line('irpp', 'Impôt sur le revenu (IRPP / PAS)', brut, 0, r.irpp_ee),
  ];
  if (r.contribution_ee) lines.push(line('contribution', 'Contribution sociale', brut, 0, r.contribution_ee));

  const cot_er = lines.reduce((s, l) => s + l.montant_er, 0);
  const cot_ee = lines.reduce((s, l) => s + l.montant_ee, 0);
  const net = brut - cot_ee;

  return {
    country, currency: p.currency, law: p.law,
    certified: !!p.certified, warning: p.note,
    detail: { base, primes, heures_sup: heuresSup, brut },
    lines,
    totals: { cotisations_employeur: cot_er, cotisations_salarie: cot_ee, net_a_payer: net, cout_employeur: brut + cot_er },
  };
}

module.exports = {
  RATE_LABELS, RATES_VERSIONS, versionFor, listeTaux, COUNTRY_PARAMS, paramsFor, computePayslip };
