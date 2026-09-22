# RH PLUS — logiciel SIRH (SaaS multi-entreprises)

Application réelle, distincte de la maquette commerciale : **serveur, base de données,
comptes utilisateurs, cloisonnement par entreprise, chiffrement, journal d'audit et
sauvegardes**. C'est la base sur laquelle des clients peuvent être mis en production au
Gabon, puis dans les autres pays.

```
rhplus-saas/
├── src/
│   ├── server.js        point d'entrée (API + sauvegarde de démarrage + planification)
│   ├── app.js           application Express (en-têtes de sécurité, session, erreurs)
│   ├── config.js        configuration & variables d'environnement
│   ├── db.js            schéma SQLite + helpers cloisonnés par entreprise
│   ├── crypto.js        scrypt (mots de passe), HMAC (sessions), AES-256-GCM (données)
│   ├── auth.js          inscription entreprise, connexion 2FA (SMS/email), rôles, mots de passe
│   ├── messaging.js     envoi SMS & email réel, modèles de messages, journal des envois
│   ├── payroll.js       moteur de paie paramétrable par pays (barèmes versionnés)
│   ├── rates.js         validation des barèmes par pays et par version (12 mois)
│   ├── compliance.js    référentiel unique : registre des traitements, durées, cadre légal
│   ├── platform.js      espace éditeur : entreprises clientes, abonnements, conformité, barèmes
│   ├── payslip-pdf.js   bulletins et factures PDF générés côté serveur
│   ├── platform-pdf.js  note de validation des barèmes + dossier de déclaration APDPVP
│   ├── payments.js      adaptateurs Airtel/Moov Money : CinetPay, PayDunya, Flutterwave, bac à sable
│   ├── routes.js        API métier (employés, contrats, congés, paie, coffre, facturation, conformité)
│   └── backup.js        sauvegardes chiffrées + rotation
├── scripts/seed.js      données de démonstration (Lune Digital — 6 salariés)
├── scripts/create-platform-admin.js  création du compte éditeur (npm run platform:admin)
├── public/index.html    console RH PLUS (direction, RH, managers) + onglet Plateforme (éditeur)
├── public/portail.html  portail salarié (espace personnel de chaque salarié)
│   └── fonts/           Carlito auto-hébergée (Calibri-compatible, SIL OFL) — aucun CDN tiers
├── test/api.test.js     16 tests d'intégration (isolation, chiffrement, paie, paiements, rôles, facturation, comptes)
├── test/console.test.js 9 tests de la console (DOM réel + serveur réel) — dont l'espace plateforme
├── test/portail.test.js 14 tests du portail salarié (parcours, cloisonnement, droits)
├── test/messaging.test.js 12 tests des notifications (vrai serveur SMTP + vraie passerelle SMS localement)
├── test/harness.js      banc commun : serveur réel + DOM réel pour les tests d'interface
├── deploy/              Dockerfile + service systemd
├── docs/                CONFORMITE.md, DEPLOIEMENT.md, DEPLOIEMENT_FLY.md, DEPLOIEMENT_GRATUIT.md,
│                        HEBERGEMENT.md, API.md, NOTIFICATIONS.md, MISE_SUR_LE_MARCHE.md,
│                        FLY_PAS_A_PAS.html (guide illustré, à ouvrir dans un navigateur)
├── fly.toml             configuration Fly.io (volume persistant, HTTPS, machine unique)
├── deploy/Dockerfile.fly + deploy/fly-entrypoint.sh  image Fly.io (volume monté en root → application sans privilèges)
├── deploy/installer-vps.sh  installation en une commande sur Debian/Ubuntu (Node, nginx, systemd, HTTPS)
└── .dockerignore        empêche données, clés et .env d'entrer dans l'image
```

## Démarrage

```bash
npm install
npm run seed          # crée une entreprise de démonstration + 6 salariés
npm run platform:admin -- --email=vous@rhplus.ga --name="Votre nom"   # compte éditeur
npm start             # http://localhost:3000
```

Le **compte plateforme** (`platform_admin`) est celui de l'éditeur : il voit toutes les entreprises
clientes, leur usage, leur abonnement et leur conformité, il en crée de nouvelles, suspend un accès,
enregistre la validation des barèmes et suit les envois de notifications. **Il n'ouvre pas les
dossiers des salariés** : la console ne lui présente que l'onglet Plateforme.

**Comptes de démonstration** (mot de passe `RhPlus!2026`) :

| Email | Rôle | Accès |
|---|---|---|
| admin@rhplus.ga | admin | tout, y compris facturation, conformité et journal |
| paie@rhplus.ga | rh | employés, contrats, congés, paie, coffre-fort |
| manager@rhplus.ga | manager | validation des congés de son équipe |
| employe@rhplus.ga | employee | ses documents, ses bulletins, ses congés |

La connexion se fait en **deux étapes** : mot de passe puis code à 6 chiffres.
Hors production, le code est affiché dans la console du serveur et renvoyé à l'écran
(`dev_code`) pour faciliter la démonstration. **En production, il part par SMS/email et
n'est jamais renvoyé au navigateur.**

## Ce qui est réellement implémenté

**Multi-entreprises.** Chaque table métier porte `company_id` ; toutes les requêtes
passent par un « scope » (`scoped(db, companyId)`). Aucun accès croisé n'est possible :
les tests vérifient qu'une entreprise B ne peut ni lire, ni modifier, ni générer un
document pour un salarié de l'entreprise A (réponse 404/403).

**Authentification & rôles.** Mots de passe en **scrypt** (sel aléatoire, 16 384
itérations, comparaison à temps constant), sessions en **jeton HMAC-SHA256** avec
expiration (12 h par défaut) stocké dans un cookie `HttpOnly · SameSite=Strict`,
2FA par code à 6 chiffres valable 10 minutes et stocké uniquement sous forme d'empreinte,
**envoyé réellement par SMS et par email** (voir plus bas), politique de mot de passe
(10 caractères, 3 familles sur 4, mots de passe triviaux refusés), réinitialisation par code
à usage unique valable 30 minutes (réponse identique si le compte n'existe pas : pas
d'énumération de comptes), changement de mot de passe qui révoque toutes les sessions,
limitation des tentatives (8 essais / 15 minutes), hiérarchie
`platform_admin > admin > rh > manager > employee`.
Une entreprise suspendue (impayé, fin de contrat) ne peut plus se connecter : 403 explicite. La déconnexion révoque immédiatement les jetons de
l'utilisateur (tous appareils) ; la console peut travailler avec le jeton en mémoire quand
les cookies sont bloqués (aperçu intégré, iframe) — les deux cas sont couverts par les tests.

**Chiffrement des données sensibles.** Numéros CNSS/CNAMGS et documents du coffre-fort en
**AES-256-GCM** (chiffrement authentifié), clé maître de 32 octets stockée hors base
(`data/master.key`, permissions 600, ou `RHPLUS_MASTER_KEY`). L'API ne renvoie jamais la
valeur chiffrée : elle expose un masque (`•••••891`) et ne déchiffre que sur la fiche
détaillée, en journalisant l'accès.

**Journal d'audit.** Chaque action sensible est horodatée (création/modification/suppression
de salarié, archivage et consultation de document, génération et émission de bulletin,
validation des barèmes, déclaration APDPVP, paiements, connexions, erreurs applicatives).

**Sauvegardes.** Copie à chaud (`VACUUM INTO`) compressée au démarrage, à l'arrêt et tous
les jours à 02:00, avec rotation (14 fichiers par défaut) dans `data/backups/`.
Commande manuelle : `npm run backup`.

**Paie.** Moteur paramétrable par pays (Gabon, Sénégal, Cameroun, Côte d'Ivoire, France,
Maroc), bulletin PDF officiel généré **côté serveur**, historique par période.
Garde-fou juridique : chaque pays a un barème **versionné** (`GA-2026.1`), validé par un
expert-comptable pour 12 mois, par l'éditeur ou par l'entreprise. Sans validation en cours,
les bulletins restent en **brouillon** et l'émission est refusée (409, avec le motif et la
marche à suivre). La note de validation en PDF sort du logiciel pour être signée.

**Facturation et paiement.** Forfaits mensuels Starter 12 500 / PME 35 000 / Entreprise
90 000 FCFA HT (plafonds 15 / 50 / 150 salariés) + frais d'installation 250 000 FCFA sur
demande, TVA 18 %, PDF de facture, règlements enregistrés. Numérotation tenue par
l'éditeur : `FAC-<CLIENT>-<AAAAMM>-<NNN>` (séquence globale continue — deux clients
peuvent facturer la même période). Facturer au-delà du plafond de l'offre est refusé (409). Adaptateurs de paiement : **bac à sable**
(fonctionne sans compte marchand, pour la démonstration), **CinetPay**, **PayDunya**,
**Flutterwave** (activés par clés dans `.env`), avec vérification de signature des
webhooks — un webhook non signé est rejeté.

**Conformité (loi n°001/2011 — APDPVP).** Registre des traitements, durée de conservation
par catégorie, suivi de la déclaration et de son renouvellement annuel, hébergement et
transferts hors Gabon (art. 94), droits des personnes : **export complet des données d'un
salarié** (JSON) et **droit à l'effacement** (anonymisation, bulletins conservés comme la
loi l'impose), **dossier de déclaration APDPVP généré en PDF** par entreprise (identification du
responsable de traitement et du sous-traitant, finalités, durées, transferts art. 94, mesures de
sécurité, engagements), suivi du récépissé et du délégué à la protection des données. Un référentiel
unique (`src/compliance.js`) alimente l'écran, le dossier PDF et cette documentation.
Voir `docs/CONFORMITE.md`.

**Espace éditeur (plateforme).** Un rôle `platform_admin` au-dessus des entreprises clientes :
portefeuille (effectif, comptes, bulletins, facturation, revenu récurrent), création d'une
entreprise cliente et de son administrateur, suspension/réactivation d'un accès, changement
d'offre, hébergement, récépissé APDPVP et délégué à la protection des données, validations de
barèmes par pays, journal des envois de notifications. Le compte s'ouvre par
`npm run platform:admin` et **ne donne accès à aucun dossier de salarié**.

## Envoi réel des notifications (SMS + email)

Les codes de connexion (2FA) et de réinitialisation partent par **email** (SMTP ou API HTTP) et par
**SMS** (passerelle HTTP, Africa's Talking). Sans configuration, la plateforme fonctionne en mode
console : les messages sont journalisés et le code s'affiche à l'écran **hors production**.
En production, le serveur **refuse de démarrer** si aucun canal réel n'est configuré
(`RHPLUS_ALLOW_CONSOLE_MESSAGING=1` pour déroger explicitement).

```env
RHPLUS_MAIL=smtp
RHPLUS_SMTP_HOST=smtp.votre-hebergeur.ga ; RHPLUS_SMTP_USER=... ; RHPLUS_SMTP_PASS=...
RHPLUS_SMS=http
RHPLUS_SMS_URL=https://passerelle.ga/send?to={to}&text={text}&sender={sender}&key={key}
```

Détail des canaux, tests et bonnes pratiques : **`docs/NOTIFICATIONS.md`**. Le journal des envois
(canal, destinataire masqué, objet, statut) est consultable dans l'onglet **Plateforme**. Le code
n'est **jamais** écrit en base.

## Barèmes de paie validés par un expert-comptable

Chaque pays a un barème **versionné** (`GA-2026.1` pour le Gabon). Une validation porte sur une
version et vaut 12 mois :

1. l'éditeur génère la **note de validation** en PDF (taux appliqués, majorations, points à
   confirmer, cadre de signature) — onglet Plateforme ;
2. le cabinet d'expertise-comptable la signe ;
3. l'éditeur enregistre la référence de la lettre : les bulletins de ce pays deviennent émisables.

Tant qu'aucune validation en cours n'existe, l'émission d'un bulletin répond **409** avec le motif
et la marche à suivre. Le garde-fou est volontaire : on n'émet pas un document officiel sur des
taux non vérifiés.

## Déclaration APDPVP (données personnelles, Gabon)

L'onglet Plateforme génère, pour chaque entreprise, le **dossier de déclaration** à déposer auprès
de l'APDPVP : identification du responsable de traitement et du sous-traitant, finalités et bases
légales, durées de conservation, transferts hors du territoire (article 94), mesures de sécurité
réellement mises en œuvre, droits des personnes, engagements, cadre de signature. Le récépissé et
le délégué à la protection des données se renseignent dans le même écran puisqu'ils conditionnent
la conformité de l'entreprise cliente.

## Portail salarié

Chaque salarié dispose d'un **accès nominatif** à `https://app.rhplus.ga/portail` (en local :
`http://localhost:3000/portail`). Le service RH l'ouvre depuis l'écran **Comptes & accès** de la
console : le compte est rattaché à un dossier salarié, et à un seul.

| Écran | Contenu |
|---|---|
| Accueil | contrat en cours, dernier bulletin, solde de congés, ancienneté, alerte d'échéance de contrat |
| Mon profil | identité, poste, coordonnées, numéro CNSS (son propre numéro), parcours et canal de recrutement |
| Mes bulletins | historique par période, net à payer, statut (brouillon / émis), **bulletin PDF** |
| Mes congés | solde estimé sur l'année de référence en cours, demandes et statuts, **demande de congé** en ligne |
| Mes documents | pièces déposées au coffre-fort chiffré, téléchargement (chaque accès est journalisé) |
| Mes droits | droit d'accès **en libre-service** (export JSON immédiat), rectification, effacement, opposition, contact du responsable de traitement et hébergement |

**Cloisonnement vérifié par les tests** : un salarié ne peut atteindre ni le dossier d'un collègue, ni
son bulletin, ni la masse salariale, ni la facturation, ni le registre de conformité, ni le journal
d'audit (réponses 403). Les demandes de congé sont rattachées d'office à son propre dossier, même si
le client tente de désigner quelqu'un d'autre.

## API (extrait)

| Méthode | Route | Rôle requis |
|---|---|---|
| POST | `/api/auth/register` | — (crée l'entreprise + son admin) |
| POST | `/api/auth/login` / `/api/auth/verify` | — |
| GET | `/api/auth/me`, `/api/dashboard` | connecté |
| GET/POST/PATCH/DELETE | `/api/employees` | rh (suppression : admin) |
| GET/POST | `/api/contracts` | connecté / rh |
| GET/POST | `/api/leaves` · POST `/api/leaves/:id/decide` | connecté / manager |
| GET | `/api/payroll/params` · `/api/payslips` | connecté |
| POST | `/api/payslips/generate` · `/api/payslips/:id/emit` | rh · admin |
| GET | `/api/payslips/:id/pdf` | connecté (ses bulletins) |
| GET/POST/DELETE | `/api/documents` (+ `/download`) | rh (suppression : admin) |
| GET | `/api/billing` · POST `/api/billing/plan`, `/invoices/generate`, `/invoices/:id/pay` | admin (paiement) |
| POST | `/api/webhooks/payment/:provider` | signature vérifiée |
| GET | `/api/me/overview` · `/api/me/export` | connecté — espace et droits du salarié |
| GET/POST | `/api/users` · PATCH `/api/users/:id` | rh (création) · admin (modification) |
| GET/POST | `/api/compliance`, `/apdpvp`, `/payroll-validation`, `/dsar/:id`, `/erase/:id` | admin/rh |
| GET | `/api/audit` | admin |

## Espace plateforme (extrait)

| Méthode | Route | Rôle | Objet |
|---|---|---|---|
| GET | `/api/platform/overview` | platform_admin | toutes les entreprises : usage, abonnement, conformité, totaux |
| GET | `/api/platform/companies/:id` | platform_admin | détail : comptes, factures, paiements, messages |
| POST | `/api/platform/companies` | platform_admin | création d'une entreprise cliente + son administrateur |
| PATCH | `/api/platform/companies/:id` | platform_admin | suspension, offre, hébergement, récépissé APDPVP, délégué |
| GET/POST | `/api/platform/validations` | platform_admin | validations de barèmes par pays et par version |
| GET | `/api/platform/validations/note.pdf` | platform_admin | note de validation à faire signer |
| GET | `/api/platform/companies/:id/dossier-apdpvp.pdf` | platform_admin | dossier de déclaration APDPVP |
| GET | `/api/platform/messages` | platform_admin | journal des envois + état des canaux |
| POST | `/api/platform/messaging/test` | platform_admin | test réel email / SMS |

## Tests

```bash
npm test                      # tout, d'un coup (51 tests)
npm run test:console          # la console RH (nécessite jsdom)
npm run test:portail          # le portail salarié
npm run test:notifications    # les envois SMS/email (vrai SMTP + vraie passerelle)
```

**Tests de la console** : `test/console.test.js` télécharge la vraie console dans un DOM (jsdom),
la connecte au vrai serveur sur une base temporaire et déroule le parcours réel — ouverture de
l'écran de connexion, mot de passe, code 2FA, les 9 modules, ouverture d'une fiche salarié (numéro
CNSS déchiffré, parcours, droits), déconnexion. Un scénario distinct se connecte avec le **compte
plateforme**, vérifie que l'éditeur ne voit que son portefeuille (pas les dossiers des salariés),
génère la note de validation, l'enregistre et contrôle que le barème passe à « validé » en base —
le tout sans aucune erreur JavaScript.

16 tests d'intégration : isolation entre deux entreprises, absence d'accès sans session,
cohérence du moteur de paie, chiffrement/déchiffrement, stockage chiffré et masquage,
parcours (contrats, congés, carrière), garde-fou expert-comptable, PDF serveur,
coffre-fort + journal, paiement mobile money et rejet des webhooks non signés, conformité
(registre, export, effacement), cloisonnement par rôle, anti-force brute, plafond de
l'offre et numérotation des factures, ouverture d'un accès salarié et révocation immédiate.

**Tests des notifications** : `test/messaging.test.js` démarre un **vrai serveur SMTP** et une
**vraie passerelle HTTP** sur des ports locaux, puis vérifie que le code de connexion part bien par
les deux canaux, qu'il n'est jamais écrit en base, que la réinitialisation de mot de passe
fonctionne de bout en bout depuis l'email reçu, que les sessions sont révoquées après un changement
de mot de passe, qu'un administrateur client n'atteint pas l'espace plateforme, que la validation
d'un barème débloque l'émission d'un bulletin, et que le dossier APDPVP se génère.

**Tests du portail salarié** : `test/portail.test.js` déroule le parcours complet dans un DOM réel
(connexion, 2FA, les 6 écrans, demande de congé, téléchargement du bulletin PDF et d'un document du
coffre, export des droits) puis attaque l'API avec le jeton du salarié pour vérifier qu'aucune donnée
d'un collègue ni de l'entreprise n'est accessible — et que toutes ces actions sont journalisées.

## Confort d'exploitation

- **Polices** : Calibri quand elle est présente (Windows/Office), sinon **Carlito**
  auto-hébergée (`public/fonts/`, 40 Ko par graisse, SIL OFL 1.1) — aucune requête vers un
  CDN tiers, ce qui évite tout transfert de données à un sous-traitant et respecte la CSP.
- **En-têtes de sécurité** appliqués à toutes les réponses (`default-src 'self'`,
  `nosniff`, `X-Frame-Options`, HSTS en production).
- **Sauvegarde avant mise à jour** : `npm run backup` puis redémarrage du service.

## Est-ce exploitable et commercialisable ?

`docs/MISE_SUR_LE_MARCHE.md` répond point par point, preuves à l'appui : ce qui est prêt
(multi-entreprises, chiffrement, audit, sauvegardes, portail salarié, facturation), les **5 blocages
à lever avant une vente** (envoi réel des SMS/email, validation des barèmes de paie par un
expert-comptable, déclaration APDPVP, choix de l'hébergement, comptes marchands de paiement), les
décisions qui vous appartiennent, et un plan de mise sur le marché en 5 semaines.

## Mise en production

**En une commande sur Debian/Ubuntu (y compris la machine ARM gratuite d'Oracle Cloud)** :

```bash
sudo bash deploy/installer-vps.sh --domaine=rhplus.duckdns.org --email=vous@rhplus.ga
```

Le script installe Node.js et nginx, copie l'application, installe les dépendances, génère la clé de
chiffrement, crée le service qui redémarre automatiquement et demande le certificat HTTPS. Détail des
options : `--essai` (démarrer sans passerelle SMS/email), `--port=`. Il est rejouable sans risque.

**Sur Fly.io** (serveur managé, ≈ 3,5 $/mois) : la configuration est fournie.

```bash
fly launch --no-deploy --copy-config
fly volumes create rhplus_data --size 1 --region cdg --yes
fly secrets set RHPLUS_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly deploy
fly ssh console -C "gosu node node scripts/create-platform-admin.js --email=vous@rhplus.ga --password=…"
```

Guide complet (secrets, domaine, sauvegardes, dépannage, coûts) : **`docs/DEPLOIEMENT_FLY.md`**.
Règle à retenir : **une seule machine** — la base SQLite vit sur un volume unique.

Sinon, voir `docs/DEPLOIEMENT.md` (Docker/systemd, HTTPS, sauvegardes, supervision),
`docs/HEBERGEMENT.md` (choix de l'hébergeur), `docs/DEPLOIEMENT_GRATUIT.md` (Oracle Cloud
Always Free) et `docs/CONFORMITE.md`. Points à traiter avant de vendre : hébergement et déclaration
APDPVP, validation des barèmes de paie par un expert-comptable, comptes marchands
CinetPay/PayDunya/Flutterwave, envoi réel des codes 2FA par SMS, domaine et certificat.

## Ce que ce logiciel n'est pas (encore)

- Pas de facturation électronique certifiée DGI, ni de télédéclaration CNSS/CNAMGS.
- Pas d'application mobile native (le portail est utilisable depuis un téléphone, en web).
- Le changement de mot de passe est disponible par l'API (`POST /api/auth/password`) et depuis la
  console ; l'écran dédié dans le portail salarié reste à ajouter (le service RH réinitialise en
  attendant, écran Comptes & accès).
- Pas de gestion de paie certifiée : **le moteur calcule, l'expert-comptable valide**.
- Pas de haute disponibilité : SQLite convient jusqu'à quelques milliers de salariés ;
  au-delà, passer à PostgreSQL (les requêtes sont déjà paramétrées et isolées par `company_id`).
