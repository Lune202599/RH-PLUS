'use strict';
/* =====================================================================
   Validation des barèmes de paie

   Une validation est valable pour UN PAYS et UNE VERSION de barème, pendant
   12 mois. Elle peut être :
     - « plateforme » : validée par le cabinet pour l'éditeur RH PLUS (tous
       les clients du pays en bénéficient) ;
     - « entreprise »  : validée par le cabinet du client pour son compte.

   L'émission d'un bulletin exige une validation en cours. C'est la protection
   juridique : on n'émet pas un document officiel sur des taux non vérifiés.
   ===================================================================== */
const { versionFor } = require('./payroll');

const aujourdHui = () => new Date().toISOString().slice(0, 10);

/** Validation en cours pour le pays de l'entreprise (plateforme ou entreprise). */
function validationPour(db, company) {
  const version = versionFor(company.country);
  const entreprise = company.rate_validation_id
    ? db.prepare('SELECT * FROM rate_validations WHERE id = ?').get(company.rate_validation_id) : null;
  const plateforme = db.prepare(`SELECT * FROM rate_validations WHERE country = ? AND version = ?
    ORDER BY validated_at DESC LIMIT 1`).get(company.country, version);
  const reference = entreprise || plateforme || null;
  const expiration = reference && reference.expires_at ? reference.expires_at : null;
  const aJour = !!reference && (!expiration || expiration >= aujourdHui());

  return {
    version,
    a_jour: aJour,
    source: entreprise ? 'entreprise' : (plateforme ? 'plateforme' : null),
    cabinet: reference ? reference.cabinet : (company.payroll_validated_by || null),
    expert: reference ? reference.expert_name : null,
    reference: reference ? reference.order_ref : null,
    valide_le: reference ? reference.validated_at : company.payroll_validated_at || null,
    expire_le: expiration,
    motif: aJour ? null
      : (reference ? `La validation du barème ${reference.version} a expiré le ${expiration}.`
        : `Aucune validation du barème ${version} enregistrée pour ${company.country}.`),
  };
}

/** Message d'erreur destiné à l'utilisateur quand l'émission est bloquée. */
function messageBlocage(company, validation) {
  return {
    error: `Bulletin verrouillé : les barèmes de paie ${validation.version} (${company.country}) `
      + `n'ont pas été validés par un expert-comptable.`,
    detail: validation.motif,
    hint: 'Faites signer la note de validation des barèmes, puis enregistrez la référence '
      + '(écran Barèmes & validations, ou POST /api/compliance/payroll-validation), et réessayez.',
  };
}

module.exports = { validationPour, messageBlocage, versionFor };
