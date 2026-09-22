'use strict';
/* =====================================================================
   Référentiel de conformité — source unique

   Ces données alimentent trois choses :
     1. l'écran Conformité de la console (loi n°001/2011) ;
     2. le dossier de déclaration APDPVP généré en PDF ;
     3. la documentation commerciale.
   Toute modification ici se propage partout : pas de doublon à maintenir.
   ===================================================================== */

/* Registre des traitements : [finalité, base légale, données, durée, destinataires] */
const REGISTRE_TRAITEMENTS = [
  ['Gestion de la paie', 'Obligation légale (Code du travail, fiscalité)',
    'Identité, salaire, cotisations, coordonnées bancaires', '50 ans', 'CNSS/CNAMGS, DGI'],
  ['Gestion du personnel', 'Contrat de travail',
    'Identité, contrat, absences, évaluations', 'Durée du contrat + 5 ans', 'Inspection du travail'],
  ['Recrutement', 'Intérêt légitime / consentement',
    'CV, coordonnées, candidatures, entretiens', '2 ans', '—'],
  ['Temps de travail', 'Obligation légale',
    'Pointage, horaires, heures supplémentaires', '5 ans', '—'],
  ['Santé au travail', 'Consentement + obligation légale',
    'Avis d’aptitude (sans détail médical)', '5 ans', 'Médecin du travail'],
  ['Coffre-fort numérique', 'Consentement',
    'Pièces personnelles et contrats numérisés', 'Durée du contrat', '—'],
  ['Badges et contrôle des accès', 'Intérêt légitime (sécurité des biens et des personnes)',
    'Identifiant du badge, horodatage des entrées', '12 mois', '—'],
];

/* Durées de conservation : [catégorie, durée, fondement] */
const RETENTION = [
  ['Bulletins de paie & contrats', '50 ans', 'Obligation légale'],
  ['Candidatures', '2 ans', 'Intérêt légitime / consentement'],
  ['Médecine du travail', '5 ans', 'Consentement + obligation légale'],
  ['Journaux d’accès (audit)', '12 mois', 'Sécurité / intérêt légitime'],
  ['Pièces personnelles', 'Durée du contrat', 'Consentement'],
];

/* Mesures de sécurité réellement mises en œuvre, décrites pour un dossier de déclaration. */
const SECURITE = [
  ['Contrôle d’accès', 'Comptes nominatifs, rôles séparés (direction, RH, manager, salarié), rattachement d’un salarié à son seul dossier, révocation immédiate des sessions à la déconnexion.'],
  ['Authentification', 'Mot de passe (scrypt, 16 384 itérations, comparaison à temps constant) et vérification en deux étapes par code à 6 chiffres valable 10 minutes, envoyé par SMS et email, conservé uniquement sous forme d’empreinte.'],
  ['Chiffrement', 'Numéros CNSS/CNAMGS et pièces du coffre-fort chiffrés en AES-256-GCM ; clé maître conservée hors base de données.'],
  ['Journalisation', 'Toutes les actions sensibles sont horodatées : connexions, consultations et téléchargements de pièces, création et modification de dossiers, génération et émission de bulletins, paiements, exercice des droits.'],
  ['Cloisonnement', 'Chaque entreprise cliente est isolée : toutes les requêtes sont filtrées par identifiant d’entreprise, vérifié par des tests automatisés.'],
  ['Sauvegardes', 'Copie quotidienne à chaud, compression, rétention 14 jours, recopie hors site vers un stockage chiffré, procédure de restauration documentée et testée.'],
  ['Disponibilité', 'Supervision du service (santé applicative), journal des erreurs, alertes de sauvegarde, procédure de reprise.'],
  ['Sous-traitance', 'Aucun envoi de données à un service tiers par défaut : polices et ressources servies par le serveur lui-même ; fournisseurs de paiement et passerelles SMS encadrés par contrat.'],
];

/* Autorité de contrôle et cadre légal (Gabon). */
const CADRE_LEGAL = {
  loi: 'Loi n°001/2011 du 25 janvier 2011 relative à la protection des données à caractère personnel',
  autorite: 'APDPVP — Commission nationale pour la protection des données à caractère personnel',
  obligations: [
    'Déclaration préalable des traitements auprès de l’APDPVP (les traitements de paie et de gestion des ressources humaines sont expressément visés).',
    'Autorisation préalable de la Commission pour tout usage de données biométriques (article 54.5).',
    'Encadrement des transferts de données hors du territoire national : niveau de protection suffisant (article 94).',
    'Contrat écrit entre le responsable de traitement (l’employeur) et le sous-traitant (RH PLUS) — article 40 et suivants.',
    'Information des personnes concernées et exercice effectif de leurs droits.',
    'Conservation limitée à la durée nécessaire aux finalités poursuivies.',
  ],
};

module.exports = { REGISTRE_TRAITEMENTS, RETENTION, SECURITE, CADRE_LEGAL };
