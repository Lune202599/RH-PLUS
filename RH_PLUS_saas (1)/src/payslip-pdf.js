'use strict';
/* Génération serveur du bulletin de paie en PDF (jsPDF + autoTable).
   Le PDF est produit côté serveur : l'entreprise n'a besoin que d'un navigateur
   pour le télécharger, et il peut être archivé automatiquement au coffre-fort. */
globalThis.window = globalThis.window || globalThis;
const { jsPDF } = require('jspdf');
globalThis.window.jspdf = globalThis.window.jspdf || { jsPDF };
require('jspdf-autotable');

const F = (n) => Math.round(n).toLocaleString('fr-FR');

function docHeader(doc, doctitle, refLines) {
  doc.setFillColor(14, 92, 51); doc.rect(0, 0, 210, 24, 'F');
  doc.setFillColor(23, 138, 76); doc.rect(0, 24, 210, 1.8, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('RH PLUS', 14, 10);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
  doc.text('Recrutement & Accompagnement', 14, 14.5);
  doc.text('Plateforme SIRH — document généré par le serveur RH PLUS', 14, 18.5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
  doc.text(doctitle, 196, 10, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
  (refLines || []).forEach((l, i) => doc.text(l, 196, 14.5 + i * 4, { align: 'right' }));
  doc.setTextColor(20, 35, 26);
  return 32;
}

function docFooter(doc, company, currency) {
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(6.8); doc.setTextColor(130);
    doc.text(`${company.name} — ${company.city || ''} · ${company.legal_ref || ''} · devise : ${currency}`, 14, 291);
    doc.text(`Page ${i}/${pages}`, 196, 291, { align: 'right' });
  }
}

/** Bulletin officiel. employee & company viennent de la base ; payslip du moteur de paie. */
function payslipPdf({ company, employee, period, payslip, generatedAt }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const currency = payslip.currency;
  let y = docHeader(doc, 'BULLETIN DE PAIE', [`Référence BP-${String(employee.id).padStart(4, '0')}/${period.replace(/\D/g, '').slice(-4)}`, `Période : ${period}`]);

  doc.setFontSize(8.4);
  doc.setFont('helvetica', 'bold'); doc.text('EMPLOYEUR', 14, y); doc.text('SALARIÉ', 108, y);
  doc.setFont('helvetica', 'normal');
  const L = [
    company.name,
    company.city || '',
    `RCCM : ${company.rccm || '—'} · NIF : ${company.nif || '—'}`,
    `N° employeur : ${company.cnss_no || '—'}`,
  ];
  const R = [
    employee.name,
    `${employee.role || ''} — ${employee.dept || ''}`,
    `Matricule : ${employee.matricule} · N° CNSS : ${employee.cnss_no || '—'}`,
    `Entrée : ${employee.hired || '—'} · Contrat : ${employee.contract || '—'}`,
  ];
  L.forEach((t, i) => doc.text(String(t).slice(0, 62), 14, y + 4.6 + i * 4));
  R.forEach((t, i) => doc.text(String(t).slice(0, 62), 108, y + 4.6 + i * 4));
  y += 24;

  doc.autoTable({
    startY: y,
    head: [['Rémunération', `Base (${currency})`, 'Montant']],
    body: [
      ['Salaire de base', F(payslip.detail.base), F(payslip.detail.base)],
      ['Primes et indemnités', F(payslip.detail.base), F(payslip.detail.primes)],
      ['Heures supplémentaires', F(payslip.detail.base), F(payslip.detail.heures_sup)],
      ['SALAIRE BRUT', '', F(payslip.detail.brut)],
    ],
    styles: { fontSize: 8, cellPadding: 1.8 },
    headStyles: { fillColor: [23, 138, 76], fontSize: 8 },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    didParseCell: (d) => { if (d.section === 'body' && d.row.index === 3) d.cell.styles.fontStyle = 'bold'; },
  });
  y = doc.lastAutoTable.finalY + 4;

  doc.autoTable({
    startY: y,
    head: [['Cotisations et retenues', 'Base', { content: 'Part employeur', colSpan: 2 }, { content: 'Part salarié', colSpan: 2 }], ['', '', 'Taux', 'Montant', 'Taux', 'Retenue']],
    body: payslip.lines.map((l) => [l.label, F(l.base), (l.rate_er * 100).toFixed(2) + ' %', l.montant_er ? F(l.montant_er) : '—', l.rate_ee ? (l.rate_ee * 100).toFixed(2) + ' %' : '—', l.montant_ee ? F(l.montant_ee) : '—'])
      .concat([['TOTAL COTISATIONS', '', '', F(payslip.totals.cotisations_employeur), '', F(payslip.totals.cotisations_salarie)]]),
    styles: { fontSize: 7.4, cellPadding: 1.6 },
    headStyles: { fillColor: [23, 138, 76], fontSize: 7.4 },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    didParseCell: (d) => { if (d.section === 'body' && d.row.index === payslip.lines.length) d.cell.styles.fontStyle = 'bold'; },
  });
  y = doc.lastAutoTable.finalY + 4;

  doc.autoTable({
    startY: y,
    body: [
      ['SALAIRE NET À PAYER', F(payslip.totals.net_a_payer) + ' ' + currency],
      ['Coût total employeur', F(payslip.totals.cout_employeur) + ' ' + currency],
    ],
    styles: { fontSize: 8.6, cellPadding: 2 },
    columnStyles: { 1: { halign: 'right' } },
    didParseCell: (d) => {
      if (d.row.index === 0) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [221, 239, 228]; d.cell.styles.fontSize = 9.6; }
    },
  });
  y = doc.lastAutoTable.finalY + 6;

  doc.setFontSize(7); doc.setTextColor(110);
  doc.text(`Cadre juridique : ${payslip.law}. Document non contractuel tant que les barèmes n'ont pas été validés par un expert-comptable.`, 14, y);
  doc.text('À conserver sans limitation de durée — ce bulletin fait foi pour vos droits à la retraite.', 14, y + 3.6);
  doc.text(`Statut : ${payslip.status === 'emis' ? 'ÉMIS' : 'BROUILLON (en attente de validation des barèmes)'} · Généré le ${generatedAt}`, 14, y + 7.2);
  doc.setTextColor(20, 35, 26);

  docFooter(doc, { name: company.name, city: company.city, legal_ref: company.law }, currency);
  return Buffer.from(doc.output('arraybuffer'));
}

/** Reçu d'abonnement / facture RH PLUS (côté éditeur). */
function invoicePdf({ company, invoice, payments, generatedAt }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  let y = docHeader(doc, 'FACTURE', [invoice.ref, `Émise le : ${generatedAt}`]);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold'); doc.text('CLIENT', 14, y);
  doc.setFont('helvetica', 'normal');
  [
    company.name, company.city || '', `RCCM : ${company.rccm || '—'} · NIF : ${company.nif || '—'}`,
    `Période facturée : ${invoice.period} · ${invoice.seats} siège(s)`,
  ].forEach((t, i) => doc.text(String(t).slice(0, 90), 14, y + 5 + i * 4.4));
  y += 30;

  const ht = invoice.amount_cents / 100;
  const tva = invoice.tva_cents / 100;
  doc.autoTable({
    startY: y,
    head: [['Désignation', 'Montant HT']],
    body: [
      [`Abonnement RH PLUS — plan ${company.plan} — ${invoice.seats} siège(s)`, F(ht) + ' ' + company.currency],
      ['Total HT', F(ht) + ' ' + company.currency],
      ['TVA 18 %', F(tva) + ' ' + company.currency],
      ['TOTAL TTC', F(ht + tva) + ' ' + company.currency],
    ],
    styles: { fontSize: 8.4, cellPadding: 2 },
    headStyles: { fillColor: [23, 138, 76] },
    columnStyles: { 1: { halign: 'right' } },
    didParseCell: (d) => { if (d.section === 'body' && d.row.index === 3) d.cell.styles.fontStyle = 'bold'; },
  });
  y = doc.lastAutoTable.finalY + 6;

  doc.setFontSize(7.5); doc.setTextColor(90);
  doc.text(`Statut : ${invoice.status}${invoice.paid_at ? ' le ' + new Date(invoice.paid_at).toLocaleDateString('fr-FR') : ''} · Moyen de paiement : ${invoice.method || '—'}`, 14, y);
  if (payments && payments.length) {
    y += 5;
    doc.text('Règlements enregistrés : ' + payments.map((p) => `${p.provider} ${p.method || ''} ${p.status} (${p.provider_ref || '—'})`).join(' · ').slice(0, 180), 14, y);
  }
  doc.text('Lune Digital — éditeur de RH PLUS · Recrutement & Accompagnement', 14, y + 5);
  doc.setTextColor(20, 35, 26);
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { payslipPdf, invoicePdf, docHeader, docFooter };
