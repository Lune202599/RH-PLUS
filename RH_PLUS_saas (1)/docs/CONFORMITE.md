# Conformité — loi n°001/2011 (Gabon) et protection des données

Ce document relie chaque obligation à sa mise en œuvre dans le logiciel.
Il sert de support à la déclaration auprès de l'APDPVP et aux questions des clients.

> **Référentiel unique : `src/compliance.js`.** Il alimente à la fois l'écran Conformité de la
> console, le dossier de déclaration APDPVP en PDF et les tableaux ci-dessous. Une correction à un
> seul endroit se propage partout : rien n'est recopié ailleurs.

## 1. Déclaration des traitements automatisés

La « gestion des paies » et la « gestion des ressources humaines » figurent parmi les
traitements à déclarer. Le récépissé est délivré **pour un an** et doit être renouvelé.

| Élément | Mise en œuvre |
|---|---|
| Récépissé, date, statut | table `companies` (`apdpvp_num`, `apdpvp_date`, `apdpvp_status`) |
| Suivi du renouvellement | module Conformité de la console (`À jour` / `À renouveler` / `Non déclaré`) |
| Journal des modifications | `audit_log`, action « Déclaration APDPVP » |

**À faire côté éditeur** : déposer la déclaration de Lune Digital (éditeur/sous-traitant)
**et** accompagner chaque client pour la sienne, en tant que responsable de traitement.

## 2. Registre des traitements

Sept traitements sont décrits dans l'application (finalité, base légale, données,
durée de conservation, destinataires) et exposés par `GET /api/compliance` :

gestion de la paie · gestion du personnel · recrutement · temps de travail ·
santé au travail · coffre-fort numérique · badges et accès.

## 3. Durées de conservation appliquées

| Catégorie | Durée | Source |
|---|---|---|
| Bulletins de paie et contrats | 50 ans | obligation légale |
| Candidatures | 2 ans | intérêt légitime / consentement |
| Médecine du travail | 5 ans | consentement + obligation légale |
| Journaux d'accès | 12 mois | sécurité / intérêt légitime |
| Pièces personnelles | durée du contrat | consentement |

## 4. Transferts hors du territoire (article 94)

L'application enregistre le lieu d'hébergement (`companies.hosting`) et refuse de
laisser croire à une conformité automatique : tant que l'hébergement n'est pas local
(Gabon) ou adossé à un cadre de transfert, le module Conformité l'indique explicitement.
Les copies de sauvegarde restent dans le dossier `data/backups/` du serveur d'exploitation.

## 5. Biométrie (article 54.5)

Le pointage biométrique nécessite une **autorisation** de la Commission. Le module
prévoit deux états : pointage classique (badge, application) ou biométrie
**uniquement après autorisation**, avec alternative sans biométrie toujours disponible.

## 6. Droits des personnes concernées

| Droit | Fonction |
|---|---|
| Accès | **en libre-service** depuis le portail salarié (`GET /api/me/export`) : le salarié télécharge lui-même ses données sans passer par le service RH. Côté employeur : `GET /api/compliance/dsar/:employeeId` (export JSON complet, journalisé) |
| Rectification | `PATCH /api/employees/:id` |
| Effacement | `POST /api/compliance/erase/:employeeId` — anonymisation, documents du coffre supprimés, **bulletins conservés** (obligation légale) |
| Opposition / portabilité | export JSON + désactivation du compte salarié |

Chaque exercice de ces droits est journalisé (action + acteur + horodatage), y compris lorsque le
salarié exporte lui-même ses données depuis son portail.

**Information des personnes** : le portail salarié comporte un écran « Mes droits » qui indique
l'identité du responsable du traitement, la finalité, le lieu d'hébergement, les durées de
conservation et l'autorité de contrôle (APDPVP) — l'information exigée avant tout traitement.
Les salariés n'accèdent qu'à leur propre dossier : l'écran précise aussi que toute consultation de
leurs pièces par un membre du service RH est tracée.

## 7. Sécurité (article 45 : loyauté, licéité, sécurité, confidentialité)

- Mots de passe : **scrypt**, sel aléatoire, 16 384 itérations, comparaison à temps constant.
- Sessions : jetons signés HMAC-SHA256, expiration 12 h, cookie `HttpOnly · SameSite=Strict`
  (`Secure` en production). La déconnexion **révoque immédiatement** tous les jetons de
  l'utilisateur (compteur de version en base), sur tous ses appareils.
- 2FA obligatoire par défaut pour tous les comptes.
- Données sensibles : **AES-256-GCM** — numéro CNSS/CNAMGS, documents du coffre-fort.
- Clé maître hors base de données (`data/master.key`, permissions 600).
- Cloisonnement : chaque requête est filtrée par `company_id` ; tests dédiés.
- Journalisation : toutes les actions sensibles, consultations de documents incluses.
- Limitation des tentatives de connexion, en-têtes de sécurité HTTP (CSP, nosniff,
  X-Frame-Options, HSTS en production).
- Sauvegardes quotidiennes compressées, rotation 14 jours, à froid hors du dossier public.

## 8. Paie : responsabilité et garde-fou

Le logiciel **calcule** mais ne certifie rien : les barèmes (CNSS, CNAMGS, IRPP, CFP…)
sont des paramètres par défaut non certifiés. Un bulletin ne peut être émis que si
l'éditeur ou l'entreprise a enregistré la validation de son expert-comptable
pour le **barème et la version du pays** (`rate_validations`, validité 12 mois) — sinon le bulletin
reste en brouillon et l'API répond 409, en indiquant la version manquante et la marche à suivre.
La note de validation est produite par le logiciel (§11).

## 9. À compléter avant la première vente

Le logiciel fournit la matière (dossier de déclaration, note de validation, suivi du récépissé et du
délégué) ; ce qui reste est administratif :

1. Déposer la déclaration APDPVP de l'éditeur **et** accompagner chaque client pour la sienne
   (le dossier PDF est généré par l'onglet Plateforme).
2. Faire signer le contrat de sous-traitance (article 40 et suivants) : finalités, sécurité, sort
   des données, durée.
3. Nommer un délégué à la protection des données et renseigner son contact dans le logiciel.
4. Retenir un hébergement conforme (local ou encadré), avec clause de transfert si hors Gabon.
5. Faire valider les barèmes de paie par un expert-comptable pour chaque pays ouvert (§11).
6. Écrire la procédure de notification des violations de données (72 h) et tenir un registre des
   incidents.

## 10. Le dossier de déclaration, généré par le logiciel

L'onglet **Plateforme → Détail → Dossier APDPVP (PDF)** produit, pour une entreprise donnée, la
pièce à déposer auprès de la Commission :

1. **Identification** — responsable de traitement (raison sociale, RCCM, NIF, ville, représentant
   légal), sous-traitant (RH PLUS : édition, hébergement, maintenance), délégué à la protection des
   données, lieu d'hébergement, récépissé précédent s'il existe.
2. **Finalités et traitements déclarés** — les 7 traitements du registre (paie, personnel,
   recrutement, temps de travail, santé au travail, coffre-fort, badges), chacun avec sa base
   légale, ses catégories de données, sa durée et ses destinataires.
3. **Durées de conservation**, catégorie par catégorie.
4. **Transferts hors du territoire national (article 94)** — hébergement réellement utilisé et, s'il
   est situé à l'étranger, encadrement du transfert (clauses contractuelles, niveau de protection
   suffisant, information des personnes, mention au dossier).
5. **Mesures de sécurité réellement mises en œuvre** — contrôle d'accès et rôles, authentification
   et 2FA, chiffrement AES-256-GCM, journalisation, cloisonnement par entreprise, sauvegardes hors
   site, disponibilité, sous-traitance.
6. **Droits des personnes** — accès (export en un clic), rectification, effacement, opposition, et
   journalisation de chaque exercice de droit.
7. **Engagements** — registre tenu à jour, déclaration des modifications, notification des
   violations, usage limité aux finalités déclarées, encadrement de la sous-traitance.
8. **Cadre de signature** — lieu, date, signature du responsable de traitement, emplacement du
   récépissé.

Le récépissé (numéro, date, statut) et le délégué à la protection des données se saisissent dans le
même écran : ils alimentent l'indicateur de conformité du portefeuille, qui signale d'un coup d'œil
les entreprises à régulariser.

## 11. Note de validation des barèmes de paie

Le même onglet produit la **note de validation** à remettre au cabinet d'expertise-comptable : taux
appliqués ligne par ligne, majorations d'heures supplémentaires, points à confirmer (barème de
l'impôt, exonérations, obligations déclaratives), version du barème et cadre de signature. Une fois
signée, la référence de la lettre est enregistrée dans le logiciel : la validation vaut 12 mois et
débloque l'émission des bulletins du pays concerné.
