# RH PLUS — quel hébergeur pour le logiciel SaaS ?

Ce document répond à une question simple : **où faire tourner le logiciel RH PLUS (celui du
`RH_PLUS_saas.zip`), et où ne pas essayer.**

---

> **Vous cherchez d'abord du gratuit ?** Voir **`docs/DEPLOIEMENT_GRATUIT.md`** : Oracle Cloud
> Always Free (gratuit sans expiration), votre ordinateur + Cloudflare Tunnel, et pourquoi les
> offres gratuites de Render et Koyeb ne conviennent pas à ce logiciel.

## 1. La règle qui décide tout

Le logiciel RH PLUS est un **serveur qui tourne en permanence**, avec :

| Besoin | Pourquoi | Conséquence sur le choix |
|---|---|---|
| un **serveur Node.js** qui reste allumé | sessions, envois de SMS, génération de PDF, tâches planifiées | pas de « fonction serverless » |
| un **disque persistant** | base SQLite (`rhplus.sqlite`), clé de chiffrement `master.key`, documents du coffre-fort, sauvegardes | l'hébergeur doit fournir un **volume** qui survit aux redémarrages |
| une **adresse unique** | cookies de session, portail salarié, webhooks de paiement | pas de mise à l'échelle « à la demande » qui change d'instance |

Donc : **hébergeurs statiques = non.** Et « statique » inclut Vercel, Netlify, GitHub Pages,
Cloudflare Pages.

---

## 2. Verdict par hébergeur

| Hébergeur | Nature | Logiciel SaaS RH PLUS | Démo statique | Remarque |
|---|---|---|---|---|
| **Vercel** | serverless / statique | **Non** | Oui | Vercel l'écrit lui-même : SQLite n'est pas utilisable, le disque des fonctions est **éphémère** ; chaque instance repart vierge. La base serait perdue à chaque requête |
| **Netlify** | statique | **Non** | Oui (glisser-déposer) | idem, aucun serveur Node persistant |
| **GitHub Pages / Cloudflare Pages** | statique | **Non** | Oui | idem |
| **Render** | conteneurs + disques | **Oui** | — | le plus direct : offre Starter ≈ 7 $/mois + disque persistant facturé au Go ; `render.yaml` fourni |
| **Railway** | conteneurs + volumes | **Oui** | — | ≈ 5 $/mois de forfait puis facturation à l'usage ; `Procfile` fourni |
| **Scalingo / Clever Cloud** | conteneurs (UE) | **Oui** | — | hébergeurs français, données en Europe, facturation au conteneur (tarifs à vérifier le jour J) |
| **Fly.io** | micro-VM + volumes | **Oui** | — | ≈ 3,5 $/mois pour ce logiciel (machine 512 Mo + volume 1 Go) ; **plus d'offre gratuite** pour les nouveaux comptes ; configuration fournie (`fly.toml`, `deploy/Dockerfile.fly`) et guide pas à pas : `docs/DEPLOIEMENT_FLY.md` |
| **VPS** (OVH, Hetzner, Contabo, hébergeur gabonais) | machine complète | **Oui** | Oui | le moins cher (≈ 4–7 $/mois pour 2 vCPU / 4 Go) et **le seul qui permette l'hébergement au Gabon** ; installation en une commande : `sudo bash deploy/installer-vps.sh` |
| **Oracle Cloud Always Free** | machine ARM + disque | **Oui** | Oui | **gratuit sans date d'expiration** (2 vCPU ARM, 12 Go de RAM, 200 Go de disque) : la meilleure option pour démarrer à coût nul |
| **Docker sur votre propre machine** | — | Oui (démonstration) | Oui | pratique pour montrer le logiciel à un client, pas pour un vrai service |

---

## 3. Pourquoi Vercel ne peut pas héberger ce logiciel

Ce n'est pas une opinion, c'est une contrainte de l'architecture « serverless » :

- **Pas de disque persistant.** Sur Vercel, le système de fichiers d'une fonction est recréé à
  chaque appel (seul `/tmp` est inscriptible, et il disparaît). Une base SQLite écrite pendant une
  requête est donc **perdue** à la fin de la requête. Vercel le documente explicitement : *« SQLite
  ne peut pas être utilisé avec Vercel »*.
- **Pas de processus qui reste allumé.** Les tâches planifiées du logiciel (sauvegarde quotidienne
  à 02:00, alertes de contrats à J-60/30/15) ne tournent pas.
- **Instances multiples.** Si le trafic augmente, Vercel lance plusieurs copies de la fonction ;
  chacune aurait sa propre base → deux clients verraient deux vérités différentes.
- **Conformité.** Les serveurs Vercel sont aux États-Unis et en Europe : les données de paie
  gabonaises seraient transférées hors du territoire, ce qui impose un encadrement au titre de
  l'article 94 de la loi n°001/2011 et une mention dans le dossier APDPVP.

**Ce que Vercel sait très bien faire :** la **démo statique** (`RH_PLUS_deploiement_netlify.zip`),
c'est-à-dire un site vitrine à montrer aux prospects. `npx vercel --prod` depuis le dossier, ou
import du dépôt Git : c'est un site de fichiers, aucun réglage nécessaire.

**Et si vous teniez absolument à Vercel ?** Il faudrait réécrire le stockage : remplacer SQLite par
une base distante (Vercel Postgres, Neon, Turso), déplacer le coffre-fort vers un stockage objet
(S3/R2), externaliser les sauvegardes et les tâches planifiées. Comptez **une à deux semaines** de
travail et une dépendance de plus, pour aucun gain de conformité. À faire seulement si un client
l'exige, et jamais avant d'avoir des clients.

---

## 4. Ce que je recommande, concrètement

| Situation | Choix |
|---|---|
| Montrer le logiciel à un client, cette semaine | **Render** (offre Starter + disque persistant) ou **Railway** : mise en ligne en une demi-journée avec `render.yaml` |
| Premier client payant | **VPS** chez un hébergeur au Gabon (données sur le territoire, aucune démarche article 94) ou en Europe avec clause de transfert ; sauvegardes recopiées hors site |
| Démonstration publique (vitrine) | **Netlify Drop** ou **Vercel**, avec la démo statique uniquement |

### Ordre de grandeur des coûts (à revérifier au moment de souscrire)

| Option | Coût mensuel indicatif | Remarque |
|---|---|---|
| Render Starter + disque 1 Go | ≈ 7 à 8 $ | HTTPS et déploiement automatique inclus |
| Railway Hobby | ≈ 5 $ + usage | facturation à l'usage, peut descendre très bas |
| Fly.io (1 machine + volume) | ≈ 4 à 12 $ | selon la taille de la machine |
| VPS 2 vCPU / 4 Go (Hetzner, OVH, Contabo) | ≈ 4 à 7 $ | le meilleur rapport prix/ressources, mais c'est vous l'administrateur |
| Vercel / Netlify (démo statique) | 0 $ | l'offre gratuite suffit largement pour une vitrine |

Pour référence : un même environnement « application + base » se facture couramment **14 à 50 $
par mois** chez les plateformes clés-en-main, alors qu'un VPS équivalent coûte **4 à 7 $** — la
différence, c'est le temps d'administration.

---

## 5. Points à vérifier avant de signer

1. **Disque persistant** : existe-t-il, à quel prix, et survit-il aux redéploiements ?
   (Sur Fly.io : `fly volumes create`. Chez Render : disque payant. Sur l'offre gratuite de Render et
   chez Koyeb : absent.)
2. **Emplacement des serveurs** : Gabon ? Afrique ? Europe ? (à reporter dans le dossier APDPVP).
3. **Sauvegardes** : inclues ou à faire vous-même ? Peut-on les copier hors site ?
4. **HTTPS et domaine** : certificat automatique ? Domaine personnalisé (`rhplus.ga`) ?
5. **Notification d'incident** : que se passe-t-il si le service tombe ? (le logiciel a une route
   `/api/health` pour la supervision)
6. **Résiliation et réversibilité** : comment récupérer les données si vous partez ? (une base
   SQLite et un dossier de sauvegardes : la réponse doit être « un simple téléchargement »)

---

## 6. En résumé

- **Vercel : excellent pour la vitrine, inutilisable pour le logiciel** (SQLite + disque persistant).
- **Render ou Railway** pour être en ligne rapidement, **VPS au Gabon** pour un premier client
  payant, **Netlify/Vercel** pour la démo publique.
- Quelle que soit la plateforme : **disque persistant** + **variables d'envoi SMS/email**
  (le serveur refuse de démarrer en production sans elles) + **sauvegardes recopiées hors site**.
