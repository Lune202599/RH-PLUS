# Déploiement de RH PLUS (SaaS)

> **Installation automatique :** `sudo bash deploy/installer-vps.sh --domaine=… --email=…`
> (Node.js, nginx, service systemd, HTTPS, clé de chiffrement générée — testé de bout en bout).
> **Gratuit ?** voir `docs/DEPLOIEMENT_GRATUIT.md`.

> **Quel hébergeur choisir ? Voir `docs/HEBERGEMENT.md`** (comparatif Vercel, Netlify, Render,
> Railway, Fly.io, VPS, avec les coûts et l'impact sur la déclaration APDPVP).

> **Netlify n'héberge pas ce logiciel.** Netlify sert des fichiers statiques (HTML, CSS,
> JavaScript) : il ne peut pas exécuter un serveur Node, ni faire tourner une base de données, ni
> garder des données entre deux visites. Un dépôt de la version SaaS sur Netlify affiche donc
> « Page introuvable ». C'est attendu, ce n'est pas un défaut du ZIP. Les hébergements adaptés sont
> décrits ci-dessous (§1) et dans §4bis.

## 1. Prérequis

- Node.js 20+, 512 Mo de RAM minimum (base SQLite incluse)
- Un nom de domaine et un certificat TLS (Let's Encrypt)
- Un hébergement : **au Gabon** de préférence (article 94 de la loi n°001/2011),
  sinon chez un hébergeur européen avec clauses de transfert et déclaration APDPVP

## 2. Installation (serveur classique)

```bash
sudo adduser --system --group rhplus
sudo mkdir -p /opt/rhplus-saas /var/lib/rhplus
sudo chown -R rhplus:rhplus /opt/rhplus-saas /var/lib/rhplus
# copier le projet dans /opt/rhplus-saas, puis :
cd /opt/rhplus-saas
npm ci --omit=dev
cp .env.example .env && nano .env          # clé maître, domaine, clés de paiement
npm run seed                                # facultatif : données de démonstration
sudo cp deploy/rhplus.service /etc/systemd/system/
sudo systemctl enable --now rhplus
```

## 3. Reverse proxy HTTPS (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name app.rhplus.ga;
  ssl_certificate     /etc/letsencrypt/live/app.rhplus.ga/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.rhplus.ga/privkey.pem;
  client_max_body_size 12M;                  # documents du coffre-fort
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 4. Docker

```bash
docker build -f deploy/Dockerfile -t rhplus .
docker run -d --name rhplus -p 3000:3000 \
  -v /srv/rhplus-data:/data \
  -e RHPLUS_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e NODE_ENV=production rhplus
```

## 4bis. Hébergeurs d'applications (sans gérer de serveur)

Trois familles d'hébergement, de la plus simple à la plus maîtrisée :

| Option | Pour qui | Points d'attention |
|---|---|---|
| **Render / Railway / Scalingo** (PaaS) | mise en ligne rapide, sans administrer de machine | il faut **un disque persistant** pour la base (offre payante) ; `render.yaml` et `Procfile` sont fournis à la racine du projet |
| **Vercel · Netlify · Cloudflare Pages** | **non : plateformes statiques** | elles ne font pas tourner de serveur et n'ont pas de disque : la base serait recréée à chaque requête. Réservées à la vitrine (`RH_PLUS_deploiement_netlify.zip`) |
| **VPS** (OVH, Contabo, hébergeur gabonais…) | maîtrise complète, données hébergées au Gabon | prévoir la sauvegarde, le HTTPS et les mises à jour système (§2, §3, §5) |
| **Docker** | tout environnement disposant de Docker | `deploy/Dockerfile` + volume `-v /var/lib/rhplus:/data` (§4) |

### Render (le plus direct)

1. Poussez le projet dans un dépôt Git (GitHub, GitLab…).
2. Sur Render : **New → Blueprint**, sélectionnez le dépôt. Le fichier `render.yaml` fourni décrit
   le service, le disque persistant (`/data`, 1 Go) et les variables d'environnement.
3. Renseignez les valeurs secrètes demandées : SMTP (`RHPLUS_SMTP_*`) et passerelle SMS
   (`RHPLUS_SMS_URL`, `RHPLUS_SMS_KEY`). `RHPLUS_MASTER_KEY` est générée automatiquement —
   **conservez-la** : sans elle, les numéros CNSS et les documents du coffre sont illisibles.
4. Après le déploiement, créez vos comptes :

```bash
# depuis l'interface Shell du service (ou en local sur la base copiée)
node scripts/create-platform-admin.js --email=vous@rhplus.ga --name="Votre nom"
```

5. Vérifiez : `https://<votre-service>.onrender.com/api/health` doit répondre `{"ok":true}`,
   puis connectez-vous sur `/` (console) et `/portail` (salariés).

### Ce qui ne doit pas être oublié

- **Disque persistant obligatoire** : sans lui, la base est recréée à chaque redéploiement et les
  données clients disparaissent.
- **Variables d'envoi SMS/email** : le serveur refuse de démarrer en production sans canal réel
  (dérogation temporaire : `RHPLUS_ALLOW_CONSOLE_MESSAGING=1`).
- **Sauvegardes** : recopiez régulièrement le disque ou lancez `npm run backup` (rotation 14 jours)
  et gardez une copie hors site (§5).
- **Nom de domaine** : ajoutez votre domaine dans la console de l'hébergeur, puis mettez à jour
  `RHPLUS_MAIL_FROM` et les liens que vous envoyez aux clients.

## 5. Sauvegardes

- Automatiques : au démarrage, à l'arrêt et **tous les jours à 02:00** (`data/backups/`, 14 fichiers conservés).
- Manuelles : `npm run backup` (ou `node src/backup.js avant-mise-a-jour`).
- **Recopie hors site obligatoire** : `rsync`/`rclone` quotidien vers un stockage chiffré.
- Test de restauration : décompresser `rhplus-….sqlite.gz` et démarrer avec `RHPLUS_DB=…`.

## 6. Supervision

Deux interfaces à connaître : la **console RH** sur `/` (direction, RH, managers) et le **portail
salarié** sur `/portail`. Toutes deux sont servies par le même serveur : un sous-domaine dédié
n'est pas nécessaire.

- `GET /api/health` : à surveiller toutes les minutes (status 200 attendu).
- Journaux : `journalctl -u rhplus -f` (connexions refusées, webhooks rejetés, erreurs 5xx).
- Métriques utiles : taille de `data/rhplus.sqlite`, nombre de sauvegardes, dernière
  sauvegarde réussie, espace disque, latence du PDF.

## 7. Montée en charge

SQLite tient confortablement quelques milliers de salariés (lecture/écriture locale,
mode WAL). Au-delà : PostgreSQL — remplacer `src/db.js` (le reste du code n'utilise que
des requêtes paramétrées filtrées par `company_id`), puis ajouter :
files d'attente pour les PDF, mise en cache des tableaux de bord, réplication de lecture.

## 8. Mise à jour

```bash
npm run backup            # sauvegarde manuelle avant toute mise à jour
git pull && npm ci --omit=dev
sudo systemctl restart rhplus
curl -s https://app.rhplus.ga/api/health
```

## 9. Checklist avant première mise en production client

- [ ] `NODE_ENV=production` (le code 2FA ne revient plus au navigateur)
- [ ] `RHPLUS_MASTER_KEY` définie et sauvegardée **hors du serveur** (sinon les données chiffrées sont perdues)
- [ ] HTTPS actif, redirection 80 → 443
- [ ] Envoi réel des codes 2FA par SMS/email (brancher le fournisseur d'envoi)
- [ ] Déclaration APDPVP déposée, DPO désigné, page de confidentialité publiée
- [ ] Barèmes de paie validés par un expert-comptable pour chaque pays ouvert
- [ ] Comptes marchands de paiement créés et webhooks configurés
- [ ] Procédure de restauration testée et documentée
- [ ] Contrat de sous-traitance et CGU signés avec le client
