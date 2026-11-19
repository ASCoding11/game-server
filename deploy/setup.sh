#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04 server (Hetzner, DigitalOcean, Vultr...). Run it as root:
#
#   curl -fsSL https://raw.githubusercontent.com/ASCoding11/game-server/main/deploy/setup.sh | bash -s play.yourdomain.com
#
# It installs Node, PM2 and Caddy, starts the relay as a "relay" user, gets an HTTPS certificate for the domain,
# opens only the SSH and web ports, and prints a key for GitHub to deploy updates with.
set -euo pipefail
DOMAIN="${1:?Give the domain, for example: bash setup.sh play.yourdomain.com}"
REPO="${2:-https://github.com/ASCoding11/game-server.git}"

echo "== Updating the system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get upgrade -yq
apt-get install -yq curl git ufw caddy unattended-upgrades

echo "== Installing Node (LTS) and PM2"
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -yq nodejs
npm install -g pm2

echo "== Firewall: SSH and web only"
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

echo "== The relay, running as its own user"
id relay >/dev/null 2>&1 || useradd -m -s /bin/bash relay
sudo -u relay bash -c "
  set -e
  cd ~
  [ -d game-server ] || git clone '$REPO' game-server
  cd game-server
  [ -f .env ] || cp .env.example .env
  npm ci --omit=dev
  pm2 start ecosystem.config.cjs
  pm2 save
"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u relay --hp /home/relay >/dev/null
systemctl enable pm2-relay >/dev/null 2>&1 || true

echo "== HTTPS for $DOMAIN"
sed "s/play.example.com/$DOMAIN/" /home/relay/game-server/deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "== A key for GitHub to deploy with"
sudo -u relay bash -c '
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  [ -f ~/.ssh/deploy ] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/deploy -C github-deploy
  grep -q github-deploy ~/.ssh/authorized_keys 2>/dev/null || cat ~/.ssh/deploy.pub >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
'
IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
cat <<EOF

Done. Check it: https://$DOMAIN/health should say {"ok":true,...} once DNS has caught up.

To let GitHub update the server after each push, add these repository secrets
(github.com/ASCoding11/game-server -> Settings -> Secrets and variables -> Actions):
  DEPLOY_HOST  $IP
  DEPLOY_USER  relay
  DEPLOY_KEY   everything between the lines below
-----------------------------------------------------------------
$(cat /home/relay/.ssh/deploy)
-----------------------------------------------------------------
EOF
