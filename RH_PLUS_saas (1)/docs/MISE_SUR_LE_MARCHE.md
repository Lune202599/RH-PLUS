# RH PLUS — état de préparation à l'exploitation et à la vente

Audit réalisé le 18 septembre 2026 sur le code livré (`RH_PLUS_saas.zip`, 44 fichiers, **59 points
d'API**, **51 tests**). Depuis cet audit, le volet logiciel des blocages 1 à 3 a été construit : envoi
réel des codes, validation des barèmes par version, dossier APDPVP généré (§2).

## Verdict en deux lignes

**Exploitable : oui.** Ce n'est plus une maquette : base de données, comptes, cloisonnement,
chiffrement, journal d'audit, sauvegardes, tests (51) et procédure de déploiement existent et
fonctionnent.

**Commercialisable : dès que trois démarches extérieures sont faites** — ouvrir les comptes d'envoi
SMS/email, faire signer la note de validation des barèmes par un expert-comptable, déposer la
déclaration APDPVP. Le logiciel est prêt pour ces trois-là (il produit les documents et bloque ce
qui ne doit pas être émis sans elles) : comptez **2 à 3 semaines**, essentiellement des délais
administratifs.

---

## 1. Ce qui est réellement prêt

| Domaine | État | Preuve |
|---|---|---|
| Multi-entreprises | Cloisonnement strict, `company_id` sur chaque table | Tests « isolation » : entreprise B → 404 sur les données de A |
| Authentification | scrypt (16 384 itérations), jeton HMAC 12 h, cookie HttpOnly, 2FA obligatoire | Tests rôles + anti-force brute (8 essais / 15 min) |
| Chiffrement | AES-256-GCM sur les numéros CNSS et les pièces du coffre-fort, clé hors base | Test chiffrement/déchiffrement + masquage API |
| Journal d'audit | Toute action sensible horodatée (acteur, rôle, IP) | Test conformité : 6 actions vérifiées |
| Sauvegardes | Au démarrage, à l'arrêt, tous les jours 02:00, rotation 14 fichiers | `npm run backup` → 7 Ko compressé |
| Paie | Moteur 6 pays (GA, SN, CM, CI, FR, MA), bulletins PDF côté serveur, garde-fou expert-comptable | Émission refusée 409 tant que les barèmes ne sont pas validés |
| Portail salarié | 6 écrans, bulletin PDF, demande de congé, export des droits | 14 tests, dont cloisonnement et 2 scénarios de navigateur |
| Comptes & accès | Création nominative, réinitialisation, révocation immédiate des sessions | Test API + vérification en direct |
| Facturation | Forfaits 12 500 / 35 000 / 90 000 FCFA, TVA 18 %, numérotation par client, PDF | 3 tests (montants, plafond d'offre, références) |
| Paiements | Adaptateur CinetPay / PayDunya / Flutterwave + bac à sable, webhooks signés | Paiement bac à sable de bout en bout ; webhook non signé → 401 |
| Déploiement | Dockerfile, service systemd durci, guide nginx/HTS, checklist | `docs/DEPLOIEMENT.md` |
| Documentation | README, API, conformité, déploiement | à jour à la date de l'audit |

## 2. Ce qui bloque une vente (les 5 points durs)

*Mis à jour le 18 septembre 2026 : le volet logiciel des blocages 1 à 3 est désormais construit.
Ce qui reste à faire est administratif ou commercial, plus du développement.*

| # | Blocage | Côté logiciel | Ce qu'il reste à faire | Qui |
|---|---|---|---|---|
| 1 | **Envoi réel des codes** | **Construit.** Email (SMTP ou API HTTP) + SMS (passerelle HTTP ou Africa's Talking), journal des envois, test depuis l'onglet Plateforme, et le serveur **refuse de démarrer en production** sans canal configuré | Ouvrir un compte SMTP et une passerelle SMS, renseigner `.env` | Vous |
| 2 | **Barèmes validés par un expert-comptable** | **Construit.** Validation par pays **et par version** (`GA-2026.1`), validité 12 mois, note de validation en PDF à faire signer, référence de la lettre enregistrée, garde-fou à l'émission (réponse 409 motivée) | Faire signer la note (le document sort du logiciel) | Expert-comptable gabonais |
| 3 | **Déclaration APDPVP** | **Construit.** Dossier de déclaration complet en PDF depuis la plateforme (identification, finalités, durées, transferts article 94, mesures de sécurité, droits, engagements) + suivi du récépissé et du délégué à la protection des données | Déposer le dossier à l'APDPVP, signer le contrat de sous-traitance (article 40) avec chaque client | Vous |
| 4 | **Hébergement** | Prêt : `deploy/installer-vps.sh` (VPS, testé de bout en bout), **`fly.toml` + `deploy/Dockerfile.fly` (Fly.io, testé)**, `Dockerfile`, `rhplus.service`, `render.yaml`, `Procfile`, et les guides `DEPLOIEMENT.md`, `DEPLOIEMENT_FLY.md`, `HEBERGEMENT.md`, `DEPLOIEMENT_GRATUIT.md` (gratuit sans expiration : Oracle Cloud Always Free ; Vercel/Netlify inutilisables) | Choisir l'emplacement (serveurs au Gabon de préférence, sinon UE avec mention article 94) | Vous |
| 5 | **Comptes marchands de paiement** | Prêt : CinetPay, PayDunya, Flutterwave, mode bac à sable | Ouvrir les comptes, brancher les clés | Vous |

Trois précisions honnêtes :

- **Le point 1 reste le vrai verrou**, mais il n'est plus technique : le logiciel sait envoyer, il
  attend des identifiants. Tant que ce n'est pas fait, la plateforme reste en mode console — et en
  production elle **ne démarre pas** (garde-fou volontaire).
- **Le point 2 n'est pas un défaut du logiciel, c'est une protection.** Le garde-fou empêche
  d'émettre un bulletin sur des taux non vérifiés : le logiciel produit la note, l'expert-comptable
  la signe, la plateforme l'enregistre et les bulletins se débloquent. En l'état, vous vendez un
  **calculateur de paie** ; après signature, une **paie validée**.
- **Le point 3 vous engage en tant que responsable de traitement** pour vos propres traitements
  (paie de vos clients, GRH) et vous rend aussi sous-traitant de vos clients : le dossier est prêt à
  déposer, il faut le récépissé **et** un contrat de sous-traitance (article 40 et suivants de la
  loi n°001/2011).

## 3. Attendu par les clients, mais non bloquant

- Changement de mot de passe et « mot de passe oublié » en libre-service (aujourd'hui : réinitialisation par le service RH) — **1 jour**.
- Emails transactionnels : invitation d'un salarié, alerte contrat 60/30/15 jours, facture — **1 jour**.
- Sauvegarde hors site automatique (`rclone`/`rsync` vers stockage chiffré) — **½ journée**.
- Supervision : alerte si `/api/health` ne répond plus, si la dernière sauvegarde a échoué — **½ journée**.
- Page web publique : tarifs, mentions légales, politique de confidentialité, formulaire de contact — **1 jour** (la landing de la maquette sert de base).
- Procédure d'incident (notification des violations sous 72 h) écrite et testée — **½ journée**.

## 4. Décisions à prendre par vous (pas par le logiciel)

1. **Où héberger ?** Serveur au Gabon (idéal au sens de la loi, article 94) ou en Europe avec
   clauses de transfert et déclaration. Un VPS suffit au démarrage : de l'ordre de
   15 000 à 40 000 FCFA par mois (estimation).
2. **Qui valide les barèmes de paie ?** Un cabinet gabonais, avec une référence écrite. Budget
   indicatif à négocier : 300 000 à 800 000 FCFA selon le périmètre (estimation).
3. **Qui exploite et qui supporte ?** Un service vendu à des entreprises qui paient des salariés
   suppose un engagement de disponibilité et un interlocuteur joignable le jour de la paie.
4. **Quelle entité vend ?** Facturation, TVA, statut de l'éditeur : à cadrer avec votre comptable.

## 5. Plan de mise sur le marché proposé (5 semaines)

| Semaine | Objectif | Livrable |
|---|---|---|
| 1 | Fermer le verrou technique : envoi SMS + email, mot de passe oublié, emails transactionnels | Un vrai client peut se connecter seul |
| 2 | Faire valider les barèmes par un cabinet (Gabon d'abord) et renseigner la référence | Émission de bulletins débloquée |
| 3 | Déposer la déclaration APDPVP, rédiger CGU + contrat de sous-traitance, désigner un DPO | Dossier juridique complet |
| 4 | Héberger, HTTPS, supervision, sauvegarde hors site, procédure d'incident | Service en ligne supervisé |
| 5 | Ouvrir les comptes marchands et tester un paiement réel, puis **pilote payant** | Premier client payant |

## 6. Ce que je recommande de vendre — et de ne pas vendre

**À vendre maintenant** (avec les 5 blocages fermés) : un **pilote payant encadré** à 2 ou 3
entreprises de Libreville — mise en service accompagnée, saisie des dossiers, formation, paie du
mois prise en charge avec l'expert-comptable du client, engagement de disponibilité limité et écrit.

**À ne pas vendre aujourd'hui** : un abonnement en libre-service sans accompagnement, une paie
présentée comme « certifiée », ou une promesse de conformité APDPVP avant récépissé. Ces trois
choses peuvent coûter plus cher en réputation qu'elles ne rapportent.

## 7. Ce qui reste au-delà (après les premiers clients)

- Migration PostgreSQL si l'on dépasse quelques milliers de salariés (les requêtes sont déjà
  paramétrées et cloisonnées par `company_id` : le remplacement est localisé dans `src/db.js`).
- Télédéclaration CNSS/CNAMGS et facturation électronique DGI, si les administrations ouvrent des
  interfaces : c'est le principal argument d'un SIRH intégré face à un tableur.
- Application mobile salarié (le portail web suffit aux premiers clients).
- Audit de sécurité externe et test d'intrusion avant de dépasser quelques dizaines de clients.
