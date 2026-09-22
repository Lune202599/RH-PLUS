# RH PLUS — déployer sur Fly.io

Guide pas à pas pour mettre le logiciel en ligne sur Fly.io. Tout ce qui est nécessaire est déjà
dans le ZIP : `fly.toml`, `deploy/Dockerfile.fly`, `deploy/fly-entrypoint.sh`, `.dockerignore`.

> **Version illustrée, à ouvrir dans un navigateur : `docs/FLY_PAS_A_PAS.html`.** Elle déroule les
> 14 étapes avec la commande à copier, ce que vous devez voir apparaître, le piège à éviter, la
> checklist de mise en service et un tableau de dépannage. Utile à garder ouvert pendant
> l'installation ou à transmettre à la personne qui déploie.

---

## 0. À savoir avant de commencer

| Point | Réalité |
|---|---|
| **Coût** | Fly.io **n'a plus d'offre gratuite** pour les nouveaux comptes. Comptez **≈ 3,5 $ à 4 $/mois** (≈ 2 000–2 500 FCFA) : machine `shared-cpu-1x` 512 Mo + volume 1 Go. Carte bancaire demandée |
| **Une seule machine** | La base SQLite vit sur un **volume unique** : ne jamais passer à plusieurs machines (`fly scale count 2` corromprait les données). Pour monter en charge, il faudra d'abord migrer vers PostgreSQL |
| **Volume obligatoire** | Sans volume, la base, la clé de chiffrement et le coffre-fort disparaissent à chaque déploiement |
| **Régions** | `cdg` (Paris) ou `jnb` (Johannesburg, plus proche du Gabon). Les deux sont **hors du Gabon** : à mentionner dans le dossier APDPVP au titre de l'article 94 (transfert encadré) |
| **Envoi des codes** | En production, le serveur **refuse de démarrer** sans passerelle SMS/email. Pour un premier essai, `RHPLUS_ALLOW_CONSOLE_MESSAGING=1` fait démarrer quand même (les codes s'écrivent alors dans les journaux) |

---

## 1. Installer l'outil `flyctl`

```bash
# Linux / macOS
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

Puis :

```bash
fly auth signup      # création de compte (ou « fly auth login » si vous en avez un)
fly version
```

---

## 2. Créer l'application

Depuis le dossier **décompressé du ZIP** (celui qui contient `package.json` et `fly.toml`) :

```bash
fly launch --no-deploy --copy-config
```

- Fly détecte `fly.toml` et **conserve votre configuration** (répondez « Yes » à la question sur le
  fichier existant).
- Il vous proposera un **nom unique** (le nom `rhplus-saas` est déjà pris sur Fly :
  acceptez par exemple `rhplus-saas-votre-nom`).
- Choisissez la région : **Paris (cdg)** ou **Johannesburg (jnb)**.
- **Refusez** la proposition de base PostgreSQL, Redis ou Upstash : le logiciel utilise SQLite sur
  le volume.

---

## 3. Créer le volume de données

Le volume doit être **dans la même région** que l'application :

```bash
fly volumes create rhplus_data --size 1 --region cdg --yes
```

(1 Go suffit très largement : base + clé + documents + sauvegardes locales ≈ quelques dizaines de Mo
pour des milliers de bulletins.)

---

## 4. Renseigner les secrets

```bash
# clé de chiffrement (numéros CNSS, documents du coffre) — à générer une seule fois
fly secrets set RHPLUS_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# --- premier essai sans passerelle SMS/email : le serveur démarre quand même ---
fly secrets set RHPLUS_ALLOW_CONSOLE_MESSAGING=1

# --- envoi réel (à mettre en place dès que possible) ---
fly secrets set \
  RHPLUS_MAIL=smtp \
  RHPLUS_MAIL_FROM="RH PLUS <notifications@rhplus.ga>" \
  RHPLUS_SMTP_HOST=smtp.votre-fournisseur.ga \
  RHPLUS_SMTP_PORT=587 \
  RHPLUS_SMTP_SECURE=false \
  RHPLUS_SMTP_USER=notifications@rhplus.ga \
  RHPLUS_SMTP_PASS="votre-mot-de-passe-smtp" \
  RHPLUS_SMS=http \
  RHPLUS_SMS_SENDER=RHPLUS \
  RHPLUS_SMS_URL='https://passerelle.exemple.ga/send?to={to}&text={text}&sender={sender}&key={key}' \
  RHPLUS_SMS_KEY="votre-cle-sms"

# une fois l'envoi réel vérifié (test depuis l'onglet Plateforme) :
fly secrets unset RHPLUS_ALLOW_CONSOLE_MESSAGING
```

⚠️ Conservez `RHPLUS_MASTER_KEY` en lieu sûr (gestionnaire de mots de passe) : **sans elle, les
numéros CNSS et les documents du coffre-fort sont définitivement illisibles.**

---

## 5. Déployer

```bash
fly deploy
```

Ce qui se passe : construction de l'image (`deploy/Dockerfile.fly`), création du volume monté sur
`/data`, démarrage de la machine, vérification de santé sur `/api/health`, puis adresse publique
`https://<votre-app>.fly.dev` (HTTPS forcé par `force_https = true`).

Le point d'entrée `deploy/fly-entrypoint.sh` s'occupe d'un détail qui fait échouer la plupart des
déploiements de ce type : Fly monte le volume en **root**, alors que l'application tourne sous un
compte sans privilèges. Le script s'approprie le volume, puis abandonne immédiatement ses
privilèges (`gosu`).

---

## 6. Vérifier

```bash
fly status                       # la machine doit être « started » (1 machine, pas 2)
fly logs                         # doit afficher l'entreprise, la devise et l'état des notifications
curl https://<votre-app>.fly.dev/api/health
# → {"ok":true,"service":"RH PLUS API",...}
```

Puis ouvrez `https://<votre-app>.fly.dev` : la console s'affiche, `/portail` pour l'espace salarié.

---

## 7. Créer votre compte administrateur plateforme

```bash
fly ssh console -C "gosu node node scripts/create-platform-admin.js --email=vous@rhplus.ga --name=Votre nom --password=UnMotDePasse#2026"
```

> `gosu node` est important : sans lui, le fichier de base créé appartiendrait à `root` et
> l'application (qui tourne sans privilèges) ne pourrait plus y écrire.

Pour montrer le logiciel avec des données de démonstration :

```bash
fly ssh console -C "gosu node npm run seed"     # 6 salariés fictifs, entreprise « Lune Digital »
```

---

## 8. Exploitation courante

| Besoin | Commande |
|---|---|
| Voir les journaux en direct | `fly logs` |
| Redémarrer | `fly apps restart <app>` |
| Mettre à jour le logiciel | modifier le code, puis `fly deploy` (les données du volume sont conservées) |
| Ouvrir un shell dans le conteneur | `fly ssh console` |
| Vérifier le volume | `fly volumes list` |
| Sauvegarde à la demande | `fly ssh console -C "gosu node node src/backup.js"` |
| Récupérer une sauvegarde | `fly ssh sftp get /data/backups/<fichier>.sqlite.gz` |
| Nom de domaine | `fly certs add rhplus.ga` puis créer les enregistrements DNS indiqués par Fly |

**Sauvegardes** : le logiciel en fait une automatiquement chaque jour à 02:00 dans
`/data/backups` (rotation 14 fichiers), et Fly prend en plus des **instantanés de volume**
quotidiens (rétention courte, prolongeable). Pour un service commercial, récupérez une copie hors
site une fois par semaine (`fly ssh sftp get`) ou installez `rclone` vers un stockage objet.

---

## 9. Ce qui ne doit jamais être fait

1. **`fly scale count 2`** : deux machines écriraient dans deux bases différentes.
2. **Supprimer le volume** `rhplus_data` : toutes les données clients disparaissent.
3. **Laisser `RHPLUS_ALLOW_CONSOLE_MESSAGING=1`** en exploitation réelle : les codes de connexion
   seraient écrits dans les journaux. C'est un mode d'essai.
4. **Déployer sans `RHPLUS_MASTER_KEY`** : chaque redéploiement générerait une nouvelle clé et les
   données chiffrées deviendraient illisibles.

---

## 10. Dépannage

| Symptôme | Cause | Solution |
|---|---|---|
| La machine redémarre en boucle, journal : « ARRÊT : envoi des notifications non configuré » | aucun canal SMS/email | renseigner `RHPLUS_SMTP_*` / `RHPLUS_SMS_*`, ou `RHPLUS_ALLOW_CONSOLE_MESSAGING=1` pour un essai |
| `EACCES` sur `/data` | volume non accessible au compte d'exécution | c'est géré par `fly-entrypoint.sh` ; vérifiez que vous déployez bien `deploy/Dockerfile.fly` |
| La base semble vide après un déploiement | pas de volume monté | `fly volumes list` puis vérifier la section `[[mounts]]` de `fly.toml` |
| Connexion impossible à la console créée | compte créé dans la base locale (sur votre poste) et non sur la machine | recréez-le avec `fly ssh console -C "gosu node node scripts/create-platform-admin.js …"` |
| Page blanche dans un aperçu intégré | mise en cadre refusée (protection normale en production) | ouvrez directement l'adresse `https://<app>.fly.dev` dans un navigateur |

---

## 11. Coût et suite

| Poste | Coût mensuel indicatif |
|---|---|
| Machine `shared-cpu-1x` 512 Mo, allumée en permanence | ≈ 3,3 $ |
| Volume 1 Go | ≈ 0,15 $ |
| Trafic sortant | inclus dans les premiers gigaoctets, puis facturé au Go |
| **Total** | **≈ 3,5 $ ≈ 2 000 FCFA/mois** |

Votre offre **Starter (12 500 FCFA/mois)** couvre donc l'hébergement de plusieurs clients. Le jour
où vous signez un client gabonais important, comparez avec un **VPS au Gabon** (~4 000–4 500
FCFA/mois) : c'est le seul moyen de supprimer la question du transfert de données hors du
territoire (article 94) et d'annoncer « données hébergées au Gabon » dans vos propositions.
