#!/usr/bin/env bash
# =============================================================================
#  RH PLUS — installation complète sur un serveur Debian/Ubuntu
#  (fonctionne aussi bien sur une machine ARM gratuite Oracle Cloud que sur un VPS)
#
#  Utilisation, depuis le dossier du projet (celui qui contient package.json) :
#      sudo bash deploy/installer-vps.sh --domaine=rhplus.duckdns.org --email=moi@rhplus.ga
#
#  Options :
#      --domaine=mon.domaine.org   nom de domaine déjà pointé vers ce serveur
#      --email=moi@rhplus.ga       email pour le certificat HTTPS (Let's Encrypt)
#      --essai                     démarre sans configuration SMS/email (mode démonstration)
#      --port=3000                 port interne (nginx s'occupe du public)
#
#  Le script est rejouable : relancer ne casse rien, il met à jour.
# =============================================================================
set -euo pipefail

APP_USER="rhplus"
APP_DIR="/opt/rhplus-saas"
DATA_DIR="/var/lib/rhplus"
SERVICE="rhplus"
PORT="3000"
DOMAINE=""
EMAIL=""
ESSAI="0"
NODE_MAJOR="22"

for arg in "$@"; do
  case "$arg" in
    --domaine=*) DOMAINE="${arg#*=}" ;;
    --email=*)   EMAIL="${arg#*=}" ;;
    --port=*)    PORT="${arg#*=}" ;;
    --essai)     ESSAI="1" ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg"; exit 1 ;;
  esac
done

etape() { printf '\n\033[1;32m▶ %s\033[0m\n' "$1"; }
info()  { printf '   %s\n' "$1"; }
alerte(){ printf '\033[1;33m   ⚠ %s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then echo "À lancer avec sudo (ou en root)."; exit 1; fi
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
  echo "Lancez ce script depuis le dossier du projet RH PLUS (celui qui contient package.json)."
  exit 1
fi
SOURCE_DIR="$(pwd)"

etape "1/8 · Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx rsync build-essential python3 >/dev/null
info "nginx, curl, outillage de compilation : installés"

etape "2/8 · Node.js ${NODE_MAJOR}"
BESOIN_NODE=1
if command -v node >/dev/null 2>&1; then
  ACTUEL="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$ACTUEL" -ge 20 ]; then BESOIN_NODE=0; info "Node.js $(node -v) déjà présent"; fi
fi
if [ "$BESOIN_NODE" -eq 1 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  info "Node.js $(node -v) installé"
fi

etape "3/8 · Compte système et dossiers"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR/backups"
chown -R "$APP_USER":"$APP_USER" "$DATA_DIR"
info "utilisateur : $APP_USER · données : $DATA_DIR"

etape "4/8 · Copie de l'application"
rsync -a --delete \
  --exclude 'node_modules' --exclude 'data' --exclude '.git' --exclude '.env' \
  "$SOURCE_DIR"/ "$APP_DIR"/
# la copie appartient à root : le service tourne sous un compte sans privilèges
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
info "application copiée dans $APP_DIR (propriétaire : $APP_USER)"

etape "5/8 · Dépendances"
cd "$APP_DIR"
sudo -u "$APP_USER" HOME="$APP_DIR" npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
  || sudo -u "$APP_USER" HOME="$APP_DIR" npm install --omit=dev --no-audit --no-fund >/dev/null
info "dépendances installées (better-sqlite3 compilé si nécessaire)"

etape "6/8 · Configuration (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  CLE="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat > "$APP_DIR/.env" <<EOF
# ---------------------------------------------------------------------------
# RH PLUS — configuration de production  (généré le $(date -u +%Y-%m-%dT%H:%MZ))
# ---------------------------------------------------------------------------
NODE_ENV=production
PORT=$PORT
RHPLUS_DATA_DIR=$DATA_DIR
RHPLUS_MASTER_KEY=$CLE
RHPLUS_SESSION_TTL_HOURS=12
RHPLUS_BACKUP_KEEP=14

# --- Envoi des codes de connexion (OBLIGATOIRE en production) ---
# Email par SMTP :
RHPLUS_MAIL=smtp
RHPLUS_MAIL_FROM=RH PLUS <notifications@$([ -n "$DOMAINE" ] && echo "$DOMAINE" || echo rhplus.ga)>
RHPLUS_SMTP_HOST=
RHPLUS_SMTP_PORT=587
RHPLUS_SMTP_SECURE=false
RHPLUS_SMTP_USER=
RHPLUS_SMTP_PASS=
# SMS : passerelle HTTP ({to} {text} {sender} {key}) ou africastalking
RHPLUS_SMS=http
RHPLUS_SMS_URL=
RHPLUS_SMS_KEY=
RHPLUS_SMS_SENDER=RHPLUS

# Paiement mobile money : sandbox | cinetpay | paydunya | flutterwave
RHPLUS_PAYMENT_PROVIDER=sandbox
EOF
  if [ "$ESSAI" -eq 1 ]; then
    echo "RHPLUS_ALLOW_CONSOLE_MESSAGING=1" >> "$APP_DIR/.env"
    alerte "mode --essai : le serveur démarre sans passerelle SMS/email (codes affichés dans le journal)."
    alerte "À retirer avant tout usage avec de vraies données clients."
  fi
  chmod 600 "$APP_DIR/.env"
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  info "fichier .env créé (clé de chiffrement générée)"
else
  info ".env déjà présent : conservé tel quel"
fi

etape "7/8 · Service (démarrage automatique) et nginx"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=RH PLUS — API et console SIRH
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR $APP_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable "$SERVICE" >/dev/null 2>&1 || true

NOM_SERVEUR="${DOMAINE:-_}"
cat > "/etc/nginx/sites-available/$SERVICE" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $NOM_SERVEUR;
  client_max_body_size 25m;
  gzip on;
  gzip_types text/plain text/css application/json application/javascript image/svg+xml;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
  location /api/health { proxy_pass http://127.0.0.1:$PORT; access_log off; }
}
EOF
ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
rm -f /etc/nginx/sites-enabled/default
if nginx -t >/dev/null 2>&1; then
  systemctl is-active --quiet nginx || systemctl start nginx 2>/dev/null || true
  systemctl reload nginx 2>/dev/null || true
  info "nginx : configuration active"
else
  alerte "nginx : configuration refusée (voir : nginx -t)"
fi
systemctl restart "$SERVICE" 2>/dev/null || true
sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  info "service $SERVICE : démarré"
else
  alerte "le service ne démarre pas — dernières lignes du journal :"
  journalctl -u "$SERVICE" -n 12 --no-pager 2>/dev/null || true
  alerte "cause la plus fréquente : RHPLUS_SMTP_* / RHPLUS_SMS_* non renseignés (le serveur refuse de démarrer en production sans envoi réel). Dans ce cas : systemctl restart $SERVICE une fois les réglages faits."
fi

etape "8/8 · HTTPS (Let's Encrypt)"
if [ -n "$DOMAINE" ] && [ -n "$EMAIL" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DOMAINE" --non-interactive --agree-tos -m "$EMAIL" --redirect >/dev/null 2>&1; then
    info "certificat HTTPS installé et renouvellement automatique activé"
  else
    alerte "certbot a échoué : le domaine pointe-t-il bien vers ce serveur ? Réessayez avec :"
    alerte "  certbot --nginx -d $DOMAINE -m $EMAIL --agree-tos"
  fi
else
  info "pas de domaine fourni : le site répond en HTTP sur l'adresse IP du serveur"
  info "pour un domaine gratuit : https://www.duckdns.org (puis relancer avec --domaine=)"
fi

IP_PUBLIQUE="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<EOF

=============================================================================
 RH PLUS est installé.
=============================================================================
 Adresse            : http://${DOMAINE:-$IP_PUBLIQUE}
 Données            : $DATA_DIR   (base, clé de chiffrement, sauvegardes)
 Configuration      : $APP_DIR/.env
 Service            : systemctl status $SERVICE   ·   journalctl -u $SERVICE -f
 Sauvegarde à la demande : sudo -u $APP_USER HOME=$APP_DIR node $APP_DIR/src/backup.js

 IL RESTE DEUX ÉTAPES :

 1) Créer votre compte administrateur plateforme :
      sudo -u $APP_USER HOME=$APP_DIR node $APP_DIR/scripts/create-platform-admin.js \\
        --email=vous@rhplus.ga --name="Votre nom"

 2) Renseigner l'envoi réel des codes dans $APP_DIR/.env
    (RHPLUS_SMTP_* et RHPLUS_SMS_*), puis :
      sudo systemctl restart $SERVICE
$([ "$ESSAI" -eq 1 ] && echo "    (mode essai actif : sans ces réglages, les codes s'affichent dans journalctl -u $SERVICE)")
=============================================================================
EOF
