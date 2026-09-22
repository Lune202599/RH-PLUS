# RH PLUS — déployer gratuitement (et jusqu'où c'est raisonnable)

Question posée : **où déployer d'abord, sans payer ?** Voici la réponse honnête, avec ce qui
fonctionne réellement pour ce logiciel et ce qui ne peut pas fonctionner.

Le logiciel RH PLUS a besoin de trois choses qu'un hébergement statique ne fournit pas : un serveur
Node qui tourne en permanence, un **disque persistant** (base SQLite, clé de chiffrement, coffre-fort,
sauvegardes) et une adresse fixe. Tout ce qui suit en découle.

---

## 1. La réponse courte

| Besoin | Solution gratuite | Durée |
|---|---|---|
| Montrer la **vitrine** (démo statique) | Netlify Drop, Vercel, Cloudflare Pages | gratuite, sans limite pratique |
| Faire tourner **le logiciel** avec des données réelles | **Oracle Cloud Always Free** (machine ARM + 200 Go de disque) | **gratuite sans date d'expiration** |
| Démarrer sans même une machine | **votre ordinateur + Cloudflare Tunnel** | gratuite (mais votre PC doit rester allumé) |
| Essayer vite, sans se soucier de la conservation des données | Render (offre gratuite), Koyeb | gratuite, avec des pièges décrits plus bas |

**Recommandation :** Oracle Cloud Always Free pour le logiciel, Netlify Drop pour la vitrine. Quand le
premier client paie, migrez sur un VPS à 4–7 $/mois hébergé au Gabon ou en Europe.

---

## 2. Oracle Cloud Always Free — l'option recommandée

C'est le seul hébergement **gratuit et sans limite de durée** qui convient à ce logiciel : une vraie
machine avec un vrai disque.

| Ressource | Allocation gratuite (2026) |
|---|---|
| Machine ARM (Ampere A1) | 2 vCPU + 12 Go de RAM cumulés *(réduit de 4/24 à 2/12 en 2026 ; les anciens comptes gardent 4/24)* |
| Disque bloc | **200 Go** — inchangé, largement suffisant (le logiciel en utilise < 1 Go) |
| Trafic sortant | 10 To/mois |
| Machines AMD micro | 2 × (1/8 vCPU, 1 Go) |
| Renouvellement | **aucun** : les ressources « Always Free » ne disparaissent pas |

Carte bancaire demandée à l'inscription (vérification d'identité), non débitée tant que vous restez
dans les quotas. Deux réserves honnêtes : les erreurs « out of capacity » sont fréquentes sur les
régions très demandées (essayez Marseille, Paris, Francfort ou Johannesburg, et réessayez), et
Oracle a réduit l'offre ARM en 2026 — le disque de 200 Go, lui, n'a pas bougé.

### Pas à pas

1. **Créer le compte** sur `oracle.com/cloud/free` (region : *France - Marseille* ou *South Africa -
   Johannesburg*, les plus proches du Gabon).
2. **Créer l'instance** : *Compute → Instances → Create instance*
   - Image : **Ubuntu 24.04** (canonical)
   - Shape : **VM.Standard.A1.Flex**, 1 à 2 OCPU, 6 à 12 Go de RAM
   - Ajoutez votre clé SSH publique (ou laissez Oracle en générer une et téléchargez-la)
   - Volume de démarrage : 50 Go suffisent
3. **Ouvrir les ports 80 et 443** : *Networking → Virtual Cloud Networks → votre VCN → Security
   Lists → Default Security List → Add Ingress Rules*
   - Source `0.0.0.0/0`, protocole TCP, ports de destination **80** puis **443**
4. **Se connecter** :
   ```bash
   ssh -i votre-cle.key ubuntu@<IP-publique>
   ```
5. **Installer RH PLUS** : copiez le projet sur la machine (Git, `scp`, ou le ZIP du SaaS),
   puis depuis le dossier contenant `package.json` :
   ```bash
   sudo bash deploy/installer-vps.sh --domaine=rhplus.duckdns.org --email=vous@rhplus.ga
   ```
   Le script installe Node.js, nginx, les dépendances, génère la clé de chiffrement, crée le
   service qui redémarre tout seul, et demande le certificat HTTPS.
   Pour un premier essai sans passerelle SMS : ajoutez `--essai`.
6. **Domaine gratuit** : créez un sous-domaine gratuit sur `duckdns.org`
   (ex. `rhplus.duckdns.org`), pointez-le vers l'IP publique, puis relancez le script avec
   `--domaine=` : il installe Let's Encrypt et redirige le HTTP vers HTTPS.
7. **Créer votre compte administrateur** (l'écran de fin du script vous donne la commande exacte) :
   ```bash
   sudo -u rhplus HOME=/opt/rhplus-saas node /opt/rhplus-saas/scripts/create-platform-admin.js \
     --email=vous@rhplus.ga --name="Votre nom"
   ```
8. **Renseigner l'envoi réel des codes** dans `/opt/rhplus-saas/.env`
   (`RHPLUS_SMTP_*` et `RHPLUS_SMS_*`, voir `docs/NOTIFICATIONS.md`), puis
   `sudo systemctl restart rhplus`.

### Sauvegardes (gratuites aussi)

Le logiciel sauvegarde déjà chaque jour dans `/var/lib/rhplus/backups` (rotation 14 jours). Pour une
copie **hors de la machine**, Oracle offre 20 Go de stockage objet : installez `rclone`, configurez un
bucket, et ajoutez une ligne à la tâche quotidienne. C'est ce qui distingue une démonstration d'un
service exploitable.

---

## 3. Les autres options gratuites, et leurs pièges

| Option | Ce que ça donne | Le piège qui compte |
|---|---|---|
| **Votre ordinateur + Cloudflare Tunnel** (`cloudflare.com/products/tunnel`, gratuit) | le logiciel tourne chez vous, accessible par une adresse HTTPS publique | votre PC doit rester allumé et connecté ; aucune garantie de service — parfait pour une démonstration, pas pour un client |
| **Google Cloud e2-micro** (gratuit à vie) | 1 vCPU partagé, 1 Go de RAM, 30 Go de disque, régions **États-Unis uniquement** | 1 Go de RAM est juste mais suffisant ; surtout : données hors du Gabon → mention article 94 de la loi n°001/2011 |
| **Northflank** (offre Developer gratuite) | 2 services, volumes persistants selon l'offre, pas de mise en veille | vérifiez au moment de l'inscription que le **volume persistant** est bien inclus ; carte bancaire demandée |
| **Render (offre gratuite)** | service web 750 h/mois, HTTPS et domaine personnalisé | **pas de disque persistant sur l'offre gratuite**, mise en veille après 15 min, base PostgreSQL gratuite qui expire en 30 jours → la base du logiciel serait perdue. Utilisable pour tester l'**interface**, pas pour des données réelles |
| **Koyeb (offre gratuite)** | 1 service 512 Mo / 0,1 vCPU, 100 Go de trafic | très petit, et pas de volume persistant → même limite que Render |
| **Railway** | 5 $ de crédit d'essai | ce n'est pas une offre gratuite permanente : le crédit s'épuise |
| **Fly.io** | — | **plus d'offre gratuite** pour les nouveaux comptes |

### Ce qui ne peut pas héberger le logiciel, du tout

**Vercel, Netlify, Cloudflare Pages, GitHub Pages** : ce sont des hébergeurs de fichiers statiques.
Ils n'exécutent pas de serveur et n'ont pas de disque persistant (Vercel le documente : SQLite n'est
pas utilisable chez eux). Réservés à la **vitrine**.

---

## 4. Budget réel

| Phase | Coût | Où |
|---|---|---|
| Vitrine + démonstration client | **0 FCFA** | Netlify / Vercel |
| Pilote avec de vraies données, sans budget | **0 FCFA** | Oracle Cloud Always Free (ou votre PC + Cloudflare Tunnel) |
| Premier client payant (offre Starter 12 500 FCFA/mois) | ~4 000–4 500 FCFA/mois | VPS 2 vCPU / 4 Go au Gabon ou en Europe — ou rester sur Oracle si elle suffit |
| Passage à l'échelle (dizaines de clients) | ~8 000–15 000 FCFA/mois | VPS plus large, sauvegardes externalisées |

Autrement dit : **un seul client payant couvre l'hébergement de plusieurs clients**, et le palier
gratuit suffit pour les premiers pilotes. Le passage au payant doit se déclencher quand vous signez
un client avec des données de paie réelles — pour avoir un engagement de service, des sauvegardes
vérifiées et un support.

---

## 5. Ce qui a été vérifié, et non supposé

Le script `deploy/installer-vps.sh` a été exécuté pour de vrai sur une machine Debian vierge
(Node.js, systemd, nginx) : installation, service qui démarre au boot, nginx en frontal, connexion en
deux étapes, création du compte plateforme, génération de la note de validation en PDF — tout
fonctionne. Deux défauts ont été corrigés grâce à ce test :

1. la copie de l'application appartenait à `root` (le service tourne sans privilèges) ;
2. les scripts en ligne de commande ne lisaient pas le fichier `.env` et créaient donc une base
   **différente** de celle du service — corrigé dans `src/config.js` : désormais le service, le jeu
   de démonstration, la création de compte et la sauvegarde travaillent tous sur la même base.

---

## 6. À retenir

- **Vitrine : Netlify Drop ou Vercel, gratuit pour toujours.**
- **Logiciel : Oracle Cloud Always Free** (gratuit sans expiration) — installation en une commande :
  `sudo bash deploy/installer-vps.sh --domaine=… --email=…`.
- **Ne cherchez pas à faire tourner le logiciel sur Vercel ou Netlify** : ce sont des hébergeurs de
  fichiers, pas des serveurs ; la base serait perdue à chaque requête.
- **Le jour où un client paie**, basculez sur un VPS (4 000–4 500 FCFA/mois), idéalement hébergé au
  Gabon : cela ferme aussi la question du transfert de données hors du territoire (article 94).
