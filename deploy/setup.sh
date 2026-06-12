#!/usr/bin/env bash
# WC26 live model — one-shot server setup for a fresh Ubuntu 22.04/24.04 box
# (Lightsail, EC2, or any VPS). Installs Node, Caddy (HTTPS), oauth2-proxy
# (Google sign-in), and the app as systemd services.
#
# Usage (as root):
#   DOMAIN=wc26.example.com \
#   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
#   GOOGLE_CLIENT_SECRET=xxxx \
#   ALLOWED_EMAILS=you@gmail.com \
#   bash setup.sh
set -euo pipefail

: "${DOMAIN:?set DOMAIN, e.g. wc26.example.com}"
: "${GOOGLE_CLIENT_ID:?set GOOGLE_CLIENT_ID from Google Cloud Console}"
: "${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET}"
: "${ALLOWED_EMAILS:?set ALLOWED_EMAILS (comma-separated Google accounts)}"
REPO="${REPO:-https://github.com/jagatsastry/wc26-live-model}"
OAUTH2_PROXY_VERSION="${OAUTH2_PROXY_VERSION:-7.7.1}"

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq git curl debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi

if [ ! -x /usr/local/bin/oauth2-proxy ]; then
  echo "==> Installing oauth2-proxy v${OAUTH2_PROXY_VERSION}"
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "unsupported arch"; exit 1 ;;
  esac
  TARBALL="oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${ARCH}"
  curl -fsSL "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${OAUTH2_PROXY_VERSION}/${TARBALL}.tar.gz" | tar xz -C /tmp
  install -m 755 "/tmp/${TARBALL}/oauth2-proxy" /usr/local/bin/oauth2-proxy
fi

echo "==> App: clone + install"
id -u wc26 &>/dev/null || useradd -r -m -s /usr/sbin/nologin wc26
if [ ! -d /opt/wc26/.git ]; then
  git clone --depth 1 "$REPO" /opt/wc26
else
  git -C /opt/wc26 pull --ff-only
fi
cd /opt/wc26 && npm install --omit=dev --no-audit --no-fund
chown -R wc26:wc26 /opt/wc26

echo "==> Config files"
mkdir -p /etc/wc26 /etc/oauth2-proxy
COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')

cat > /etc/wc26/env <<EOF
HOST=127.0.0.1
PORT=3000
ALLOWED_EMAILS=${ALLOWED_EMAILS}
EOF

render() { # substitute {$VAR} placeholders in a template
  sed -e "s|{\$DOMAIN}|${DOMAIN}|g" \
      -e "s|{\$GOOGLE_CLIENT_ID}|${GOOGLE_CLIENT_ID}|g" \
      -e "s|{\$GOOGLE_CLIENT_SECRET}|${GOOGLE_CLIENT_SECRET}|g" \
      -e "s|{\$COOKIE_SECRET}|${COOKIE_SECRET}|g" "$1"
}
render /opt/wc26/deploy/oauth2-proxy.cfg.template > /etc/oauth2-proxy/config.cfg
echo "$ALLOWED_EMAILS" | tr ',' '\n' > /etc/oauth2-proxy/emails.txt
render /opt/wc26/deploy/Caddyfile.template > /etc/caddy/Caddyfile

id -u oauth2proxy &>/dev/null || useradd -r -s /usr/sbin/nologin oauth2proxy
chown -R oauth2proxy:oauth2proxy /etc/oauth2-proxy
chmod 600 /etc/oauth2-proxy/config.cfg

echo "==> Services"
cp /opt/wc26/deploy/wc26.service /opt/wc26/deploy/oauth2-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wc26 oauth2-proxy
systemctl reload caddy || systemctl restart caddy

echo
echo "Done. Checks:"
sleep 3
systemctl --no-pager -l status wc26 oauth2-proxy caddy | grep -E "●|Active:" || true
echo
echo "Visit: https://${DOMAIN}  (Google sign-in, allowed: ${ALLOWED_EMAILS})"
