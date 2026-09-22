'use strict';
/* =====================================================================
   Documents de la plateforme (éditeur RH PLUS)

   1. noteValidationPdf  : note de validation des barèmes de paie, à remettre
                           au cabinet d'expertise-comptable — c'est le
                           document qui débloque l'émission des bulletins.
   2. dossierApdpvpPdf   : dossier de déclaration de traitement à déposer
                           auprès de l'APDPVP (loi n°001/2011).
   ===================================================================== */
const { jsPDF } = require('jspdf');
const { docHeader, docFooter } = require('./payslip-pdf');
const { listeTaux, paramsFor, versionFor } = require('./payroll');
const CONFORMITE = require('./compliance');

const A4 = { unit: 'mm', format: 'a4' };
const L = 14;            // marge gauche
const W = 182;           // largeur utile

function titre(doc, texte, y) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(14, 92, 51);
  doc.text(texte, L, y);
  doc.setTextColor(20, 35, 26); doc.setFont('helvetica', 'normal'); doc.setFontSize(9.2);
  return y + 5.5;
}
function paragraphe(doc, texte, y, taille = 9.2) {
  doc.setFontSize(taille);
  const lignes = doc.splitTextToSize(texte, W);
  lignes.forEach((l) => { doc.text(l, L, y); y += taille * 0.52; });
  return y + 1.8;
}
function tableau(doc, y, entetes, lignes, largeurColonnes) {
  doc.autoTable({
    startY: y,
    head: [entetes],
    body: lignes,
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.6, textColor: [30, 45, 36] },
    headStyles: { fillColor: [23, 138, 76], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [246, 250, 247] },
    columnStyles: largeurColonnes || {},
    margin: { left: L, right: L },
  });
  return doc.lastAutoTable.finalY + 4;
}
function pied(doc, mention) {
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(130);
    doc.text(mention, L, 291);
    doc.text(`Page ${i}/${pages}`, 196, 291, { align: 'right' });
  }
}

/* ------------------------------------------------------------------ */
/* 1. Note de validation des barèmes                                   */
/* ------------------------------------------------------------------ */
function noteValidationPdf({ country = 'Gabon', clientName, preparedAt = new Date().toLocaleDateString('fr-FR') } = {}) {
  const p = paramsFor(country);
  const version = versionFor(country);
  const doc = new jsPDF(Object.assign({ compress: true }, A4));
  let y = docHeader(doc, 'Note de validation des barèmes', [
    `Pays : ${country}`, `Version du barème : ${version}`, `Établie le : ${preparedAt}`,
  ]);

  y = paragraphe(doc, `Objet : validation, par un expert-comptable, des taux et règles de calcul `
    + `appliqués par RH PLUS pour la paie du ${country}. Cette validation conditionne l'émission des bulletins `
    + `de paie sur la plateforme : sans elle, les bulletins restent au statut « brouillon » et ne peuvent pas être remis aux salariés.`, y);

  y = titre(doc, '1. Taux appliqués', y);
  y = tableau(doc, y,
    ['Ligne de cotisation', 'Taux appliqué', 'Assiette'],
    listeTaux(country).map((t) => [t.libelle, t.pourcentage, t.assiette]),
    { 0: { cellWidth: 90 }, 1: { cellWidth: 28, halign: 'right' }, 2: { cellWidth: 64 } });

  y = titre(doc, '2. Majorations des heures supplémentaires', y);
  const maj = p.overtime_majorations || {};
  y = tableau(doc, y,
    ['Type d’heure', 'Majoration appliquée'],
    [['Premières heures supplémentaires', `${((maj.h1 || 0) * 100).toFixed(0)} %`],
     ['Heures suivantes', `${((maj.h2 || 0) * 100).toFixed(0)} %`],
     ['Heures de nuit', `${((maj.nuit || 0) * 100).toFixed(0)} %`],
     ['Jours fériés', `${((maj.ferie || 0) * 100).toFixed(0)} %`]],
    { 0: { cellWidth: 110 }, 1: { cellWidth: 72, halign: 'right' } });

  y = titre(doc, '3. Points à confirmer par l’expert-comptable', y);
  y = paragraphe(doc, 'Les taux ci-dessus sont ceux effectivement utilisés par le moteur de calcul. '
    + 'Merci de confirmer ou corriger, pour le pays concerné :', y);
  [
    'l’exactitude des taux de cotisations (parts patronale et salariale) et des plafonds d’assiette ;',
    'l’application de l’impôt sur le revenu : taux proportionnel simplifié ou barème progressif par tranches ;',
    'les exonérations et réductions éventuelles (jeunes, zones franches, conventions collectives) ;',
    'les règles de congés payés, d’ancienneté et de prime de transport retenues pour le pays ;',
    'les obligations déclaratives périodiques (CNSS/CNAMGS, impôts) et leur calendrier.',
  ].forEach((point) => { y = paragraphe(doc, '• ' + point, y) ; });

  y = paragraphe(doc, `Version validée : ${version}. Toute modification d'un taux entraîne un changement de version `
    + `et rend caduque la présente validation, qui devra être renouvelée.`, y);

  y += 3;
  doc.setDrawColor(23, 138, 76); doc.setLineWidth(0.3);
  doc.roundedRect(L, y, W, 44, 2, 2, 'S');
  y += 7;
  y = paragraphe(doc, 'Validation de l’expert-comptable' + (clientName ? ` — dossier ${clientName}` : ''), y, 10);
  y += 2;
  const lignesSignature = [
    ['Cabinet / expert-comptable', ''],
    ['Numéro d’inscription à l’ordre', ''],
    ['Référence de la lettre ou du rapport', ''],
    ['Date et lieu de signature', ''],
    ['Validité (12 mois recommandés)', ''],
  ];
  doc.setFontSize(8.6);
  lignesSignature.forEach(([label]) => {
    doc.text(label + ' :', L + 4, y);
    doc.setDrawColor(200); doc.line(L + 74, y + 1, L + 174, y + 1);
    y += 6.6;
  });

  pied(doc, `RH PLUS — note de validation des barèmes ${version} · ${country} · document à retourner signé`);
  return Buffer.from(doc.output('arraybuffer'));
}

/* ------------------------------------------------------------------ */
/* 2. Dossier de déclaration APDPVP                                    */
/* ------------------------------------------------------------------ */
function dossierApdpvpPdf({
  company, editor = {}, dpo = {}, hosting, preparedAt = new Date().toLocaleDateString('fr-FR'), receipt = null,
} = {}) {
  const doc = new jsPDF(Object.assign({ compress: true }, A4));
  const pays = company.country || 'Gabon';
  let y = docHeader(doc, 'Dossier de déclaration de traitement', [
    CONFORMITE.CADRE_LEGAL.autorite, `Établi le : ${preparedAt}`,
  ]);

  y = paragraphe(doc, `Objet : déclaration des traitements de données à caractère personnel mis en œuvre dans le cadre `
    + `de la gestion du personnel et de la paie, conformément à la ${CONFORMITE.CADRE_LEGAL.loi}.`, y);

  y = titre(doc, '1. Identification', y);
  y = tableau(doc, y, ['Qualité', 'Identification'], [
    ['Responsable de traitement', `${company.name || '—'}${company.city ? ' — ' + company.city : ''}`],
    ['Immatriculations', `RCCM : ${company.rccm || '—'} · NIF : ${company.nif || '—'}`],
    ['Représentant légal', company.rep || '—'],
    ['Sous-traitant (éditeur du logiciel)', `${editor.name || 'RH PLUS'} — fourniture de la solution SIRH, hébergement et maintenance`],
    ['Délégué à la protection des données', dpo.name ? `${dpo.name}${dpo.email ? ' — ' + dpo.email : ''}` : 'à désigner'],
    ['Lieu d’hébergement des données', hosting || company.hosting || '—'],
    ['Récépissé de déclaration', receipt ? `${receipt.num || '—'}${receipt.date ? ' du ' + receipt.date : ''}` : 'première déclaration'],
  ], { 0: { cellWidth: 62 }, 1: { cellWidth: 120 } });

  y = titre(doc, '2. Finalités et traitements déclarés', y);
  y = tableau(doc, y, ['Traitement', 'Base légale', 'Catégories de données', 'Durée', 'Destinataires'],
    CONFORMITE.REGISTRE_TRAITEMENTS.map((r) => [r[0], r[1], r[2], r[3], r[4]]),
    { 0: { cellWidth: 30 }, 1: { cellWidth: 38 }, 2: { cellWidth: 48 }, 3: { cellWidth: 28 }, 4: { cellWidth: 38 } });

  y = titre(doc, '3. Durées de conservation', y);
  y = tableau(doc, y, ['Catégorie', 'Durée', 'Fondement'],
    CONFORMITE.RETENTION.map((r) => [r[0], r[1], r[2]]),
    { 0: { cellWidth: 70 }, 1: { cellWidth: 40 }, 2: { cellWidth: 72 } });

  y = titre(doc, '4. Transferts hors du territoire national (article 94)', y);
  y = paragraphe(doc, `Les données sont hébergées dans l’emplacement suivant : ${hosting || company.hosting || 'à préciser'}. `
    + `Lorsque cet hébergement est situé hors du ${pays}, le transfert est encadré : clauses contractuelles avec le prestataire, `
    + `engagement de niveau de protection suffisant, information des personnes concernées et mention au présent dossier. `
    + `Les copies de sauvegarde suivent le même régime que les données d’origine.`, y);

  y = titre(doc, '5. Mesures de sécurité mises en œuvre', y);
  y = tableau(doc, y, ['Domaine', 'Mesure'], CONFORMITE.SECURITE.map((r) => [r[0], r[1]]),
    { 0: { cellWidth: 34 }, 1: { cellWidth: 148 } });

  y = titre(doc, '6. Droits des personnes concernées', y);
  y = paragraphe(doc, 'Chaque salarié dispose d’un espace personnel lui permettant d’accéder à ses données (export complet en un clic), '
    + 'de demander leur rectification, de s’opposer à un traitement non obligatoire et, à la fin du contrat, d’en demander l’effacement — '
    + 'les bulletins de paie étant conservés conformément à la loi. L’employeur répond aux demandes d’accès depuis l’écran Conformité. '
    + 'Chaque consultation de pièce et chaque exercice de droit est journalisé.', y);

  y = titre(doc, '7. Engagements', y);
  [
    'tenir à jour le registre des traitements et déclarer toute modification substantielle ;',
    'renouveler la déclaration à l’échéance du récépissé ;',
    'notifier à la Commission toute violation de données dans les meilleurs délais ;',
    'n’utiliser les données que pour les finalités déclarées ;',
    'encadrer la sous-traitance par un contrat écrit (article 40 et suivants) et n’y recourir que dans les limites déclarées.',
  ].forEach((e) => { y = paragraphe(doc, '• ' + e, y); });

  y += 4;
  doc.setDrawColor(23, 138, 76);
  doc.roundedRect(L, y, W, 30, 2, 2, 'S');
  y += 8;
  doc.setFontSize(9);
  doc.text('Fait à ' + (company.city || '________') + ', le ____ / ____ / ________', L + 4, y);
  y += 8;
  doc.text('Le responsable de traitement (nom, qualité et signature)', L + 4, y);
  y += 10;
  doc.text('Récépissé n° : ______________________     Date de délivrance : ___ / ___ / _______', L + 4, y);

  pied(doc, 'RH PLUS — dossier de déclaration « gestion de la paie et du personnel » établi pour l’APDPVP (loi n°001/2011)');
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { noteValidationPdf, dossierApdpvpPdf };
