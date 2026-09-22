# API RH PLUS — référence

Base : `https://app.rhplus.ga/api` — réponses JSON, `Content-Type: application/json`.
Toutes les données sont filtrées par l'entreprise du compte connecté (`company_id`) :
aucune requête ne peut atteindre les données d'un autre client.

## Authentification

Session par cookie `rhp_sid` (jeton HMAC-SHA256, 12 h, `HttpOnly`, `SameSite=Strict`).
`/auth/verify` renvoie **aussi le jeton** dans le corps de la réponse : le client peut alors
travailler avec l'en-tête `Authorization: Bearer <jeton>`, sans dépendre du cookie (utile
dans un aperçu intégré, une iframe, ou si le navigateur bloque les cookies tiers).
C'est ce que fait la console.

`POST /auth/logout` **révoque immédiatement** tous les jetons de l'utilisateur (compteur
`token_version` incrémenté en base) : le cookie comme le jeton deviennent inutilisables,
y compris les sessions ouvertes sur d'autres appareils.

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| POST | `/auth/register` | public | Créer une entreprise + compte administrateur (pays, devise, plan) |
| POST | `/auth/login` | public | Étape 1 : email + mot de passe → envoi d'un code 2FA |
| POST | `/auth/verify` | public | Étape 2 : code 2FA → ouverture de session |
| POST | `/auth/logout` | connecté | Fermer la session |
| GET | `/auth/me` | connecté | Profil, rôle, entreprise, plan, état 2FA |
| POST | `/auth/2fa` | connecté | Activer / désactiver la double authentification |
| POST | `/auth/password` | connecté | Changer son mot de passe (révoque toutes les sessions) |
| POST | `/auth/forgot` | public | Demander un code de réinitialisation |
| POST | `/auth/reset` | public | Réinitialiser avec le code reçu (usage unique, 30 min) |

Le code 2FA part **par email et par SMS** (si le compte a un mobile). La réponse de `/auth/login`
indique les canaux utilisés (`delivery`) et, hors production seulement, contient `dev_code`.
En production, le serveur refuse de démarrer si aucun canal d'envoi n'est configuré
(`RHPLUS_ALLOW_CONSOLE_MESSAGING=1` pour déroger). Voir `docs/NOTIFICATIONS.md`.

`/auth/forgot` répond la même chose que le compte existe ou non (pas d'énumération) ; le code
reçu est à usage unique et valable 30 minutes.

Erreurs : `401` non authentifié ou code expiré, `403` rôle insuffisant,
`429` trop de tentatives (8 essais / 15 min).

## Espace salarié (portail)

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| GET | `/me/overview` | connecté | Espace personnel : profil, contrats, congés, bulletins, documents, parcours, solde de congés estimé, alertes d'échéance |
| GET | `/me/export` | connecté | Droit d'accès en libre-service : export JSON complet de ses données (journalisé) |

`/me/overview` ne renvoie **que** les données du salarié connecté (`employees.id = users.employee_id`).
Si le compte n'est rattaché à aucun dossier, la réponse contient `linked: false`.

Le solde de congés est une **estimation indicative** : 2,5 jours ouvrables par mois de présence sur
l'année de référence en cours (anniversaire de la date d'entrée), plafonnée à 12 mois. Le décompte
officiel reste tenu par le service RH.

## Comptes & accès

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| GET | `/users` | rh | Comptes de l'entreprise + salariés sans accès + rôles disponibles |
| POST | `/users` | rh | Ouvrir un accès : `{email, name, role, employee_id, password}` — un compte `employee` doit viser un dossier, un seul accès par salarié |
| PATCH | `/users/:id` | admin | Changer le rôle, réinitialiser le mot de passe, activer/désactiver la 2FA, `revoke_sessions: true` pour fermer les sessions en cours |

Un administrateur ne peut pas modifier son propre rôle (garde-fou anti-verrouillage).

## Tableau de bord et personnel

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| GET | `/dashboard` | manager+ | Effectif, masse salariale, contrats à échéance, congés, indices |
| GET | `/employees` | connecté | Liste (un salarié ne voit que sa fiche) |
| GET | `/employees/:id` | connecté | Fiche, parcours, contrats, congés, bulletins |
| POST | `/employees` | rh | Créer un salarié (matricule, poste, contrat, salaire, origine) |
| PATCH | `/employees/:id` | rh | Modifier (rectification des données) |
| DELETE | `/employees/:id` | admin | Archiver (jamais de suppression physique des pièces comptables) |
| GET | `/contracts` | connecté | Contrats et alertes d'échéance (15 / 30 / 60 jours) — un salarié ne voit que le sien |
| POST | `/contracts` | rh | Créer un contrat |
| GET | `/leaves` | connecté | Congés — un salarié ne voit que les siens |
| POST | `/leaves` | connecté | Demander un congé |
| POST | `/leaves/:id/decide` | manager | Valider ou refuser |

## Paie

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| GET | `/payroll/params` | connecté | Barèmes pays (CNSS, CNAMGS, IRPP, CFP) + état de certification |
| GET | `/payslips` | connecté | Bulletins — un salarié ne voit que les siens (filtrage appliqué côté serveur) |
| POST | `/payslips/generate` | rh | Générer les bulletins d'une période (brouillon) |
| POST | `/payslips/:id/emit` | admin | Émettre — **409** si le barème du pays n'est pas validé (version + motif renvoyés) |
| GET | `/payslips/:id/pdf` | connecté | Bulletin PDF officiel |

## Coffre-fort numérique

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| GET | `/documents` | connecté | Documents (nom, dossier, taille, empreinte SHA-256) |
| POST | `/documents` | rh | Déposer (stocké chiffré en AES-256-GCM) |
| GET | `/documents/:id/download` | connecté | Télécharger — accès journalisé |
| DELETE | `/documents/:id` | admin | Supprimer définitivement |

## Abonnement et facturation

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| GET | `/billing` | manager+ | Plan, sièges, montants, factures, moyen de paiement |
| POST | `/billing/plan` | admin | Changer de plan (starter 12 500 · pme 35 000 · entreprise 90 000 FCFA HT/mois) |
| POST | `/billing/pay-method` | admin | Airtel Money, Moov Money, virement, espèces |
| POST | `/billing/invoices/generate` | admin | Générer la facture du mois (forfait de l'offre + TVA 18 %, `setup: true` ajoute les frais d'installation) |
| GET | `/billing/invoices/:id/pdf` | connecté | Facture PDF |
| POST | `/billing/invoices/:id/pay` | admin | Initier un paiement (mobile money / agrégateur) |
| POST | `/webhooks/payment/:provider` | fournisseur | Notification de paiement **signée** (401 sinon) |

Fournisseurs : `sandbox` (démonstration, confirmation immédiate), `cinetpay`,
`paydunya`, `flutterwave` (clés en variables d'environnement).

### Règles de facturation

- Chaque offre est un **forfait mensuel** avec plafond de salariés :
  Starter 12 500 FCFA HT (15 salariés) · PME 35 000 FCFA HT (50) · Entreprise 90 000 FCFA HT (150).
- Frais d'installation : **250 000 FCFA**, facturés seulement si `setup: true` est demandé.
- TVA **18 %** (Gabon) calculée sur le montant HT.
- **Numérotation tenue par l'éditeur** (RH PLUS est l'émetteur) : séquence globale et
  continue, préfixée par un code client pour la lisibilité —
  `FAC-<CLIENT>-<AAAAMM>-<NNN>`, par exemple `FAC-LUNE-202609-001`. Deux clients
  peuvent donc facturer la même période sans collision.
- Générer une facture dont l'effectif dépasse le plafond de l'offre renvoie **409**
  (« changez d'offre avant de facturer »).

## Conformité (loi n°001/2011)

| Méthode | Chemin | Rôles | Description |
|---|---|---|---|
| GET | `/compliance` | manager+ | Registre des 7 traitements, cadre légal, mesures de sécurité, hébergement, durées, état du barème |
| POST | `/compliance/apdpvp` | admin | Enregistrer le récépissé (numéro, date, statut) |
| POST | `/compliance/payroll-validation` | admin | Validation du barème par l'expert-comptable de l'entreprise (cabinet, expert, référence ; validité 12 mois) |
| GET | `/compliance/dsar/:employeeId` | rh | Droit d'accès : export JSON complet |
| POST | `/compliance/erase/:employeeId` | admin | Droit à l'effacement : anonymisation, bulletins conservés |
| GET | `/audit` | admin | Journal d'audit (acteur, action, horodatage) — paginé |

## Exemple

```bash
# 1) connexion
curl -s -c c.txt -X POST https://app.rhplus.ga/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@rhplus.ga","password":"………"}'
# → {"ok":true,"challenge":true}

# 2) vérification du code reçu
curl -s -b c.txt -c c.txt -X POST https://app.rhplus.ga/api/auth/verify \
  -H 'Content-Type: application/json' -d '{"code":"123456"}'

# 3) facture du mois (avec frais d'installation sur demande)
curl -s -b c.txt -X POST https://app.rhplus.ga/api/billing/invoices/generate \
  -H 'Content-Type: application/json' -d '{"period":"2026-09","setup":true}'

# 4) bulletin PDF de la période
curl -s -b c.txt -X POST https://app.rhplus.ga/api/payslips/generate \
  -H 'Content-Type: application/json' -d '{"period":"2026-09"}'
curl -s -b c.txt -o bulletin.pdf https://app.rhplus.ga/api/payslips/1/pdf
```

## Espace plateforme (éditeur)

Réservé au rôle `platform_admin`. Ces routes portent sur les entreprises clientes, jamais sur
les personnes : elles renvoient des compteurs et des états, pas des dossiers de salariés.

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/platform/overview` | portefeuille : usage et conformité de chaque entreprise, totaux (effectif, revenu récurrent, impayés) |
| GET | `/platform/companies/:id` | détail : comptes, factures, paiements, messages |
| POST | `/platform/companies` | créer une entreprise cliente + son administrateur |
| PATCH | `/platform/companies/:id` | suspension, offre, hébergement, récépissé APDPVP, délégué à la protection des données |
| GET | `/platform/validations` | validations de barèmes par pays et par version |
| POST | `/platform/validations` | enregistrer la validation d'un cabinet (12 mois) |
| DELETE | `/platform/validations/:id` | retirer une validation erronée |
| GET | `/platform/validations/note.pdf?country=Gabon` | note de validation à faire signer |
| GET | `/platform/companies/:id/dossier-apdpvp.pdf` | dossier de déclaration APDPVP |
| GET | `/platform/messages` | journal des envois + état des canaux |
| POST | `/platform/messaging/test` | envoyer un email et/ou un SMS de test |

## Périmètre par rôle (récapitulatif)

| Rôle | Console RH PLUS | Portail salarié | Interdits |
|---|---|---|---|
| `platform_admin` | portefeuille des entreprises clientes, barèmes, envois | ✗ | dossiers des salariés (non exposés à ce rôle) |
| `admin` | tout | s'il est aussi salarié | — |
| `rh` | personnel, paie, coffre, conformité, comptes | s'il est aussi salarié | facturation (lecture autorisée depuis la console), journal d'audit |
| `manager` | tableau de bord, congés à valider, lecture du personnel | s'il est aussi salarié | paie, coffre, comptes, journal |
| `employee` | ✗ (403) | son dossier uniquement | tout le reste : 403 |

## Codes de statut

| Code | Signification |
|---|---|
| 200 / 201 | succès |
| 400 | donnée manquante ou invalide |
| 401 | authentification requise, code 2FA invalide, webhook non signé |
| 403 | rôle insuffisant ou fiche d'un autre salarié |
| 404 | ressource inexistante (ou appartenant à une autre entreprise) |
| 409 | conflit de règle métier (barème de paie non validé, plafond d'offre atteint, état incompatible) |
| 429 | trop de tentatives de connexion |
| 500 | erreur interne (journalisée, sans donnée personnelle) |
