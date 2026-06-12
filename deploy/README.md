# Deploying to AWS (Lightsail) with Google sign-in

Architecture: `Internet → Caddy (HTTPS) → oauth2-proxy (Google sign-in) → Node app (127.0.0.1:3000)`.
The app itself is never exposed; oauth2-proxy only forwards requests from allowlisted Google accounts, and the app double-checks the `X-Forwarded-Email` header (`ALLOWED_EMAILS` env).

## 1. Google OAuth client (~5 min, free)

1. https://console.cloud.google.com/ → create/select a project.
2. **APIs & Services → OAuth consent screen**: External, fill in app name + your email, add yourself as a test user (test mode is fine for personal use).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**
   - Authorized redirect URI: `https://YOUR_DOMAIN/oauth2/callback`
4. Note the **Client ID** and **Client secret**.

## 2. Instance + DNS

1. Lightsail → Create instance → Ubuntu 24.04, smallest plan ($5/mo, 512MB is enough; $10/1GB if you want headroom).
2. Attach a **static IP**.
3. Networking tab: open ports **80** and **443** (close anything else except SSH).
4. Point a DNS A record at the static IP (a subdomain on any domain you own, or a free https://www.duckdns.org subdomain).

## 3. Run setup

SSH in, then:

```bash
sudo -i
git clone https://github.com/jagatsastry/wc26-live-model /tmp/wc26 && cd /tmp/wc26/deploy
DOMAIN=wc26.yourdomain.com \
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=xxxx \
ALLOWED_EMAILS=jagatsastry@gmail.com \
bash setup.sh
```

Visit `https://wc26.yourdomain.com` — you'll get the Google sign-in, then the live dashboard.

## Operating it

```bash
journalctl -u wc26 -f              # app logs (refresh ticks, market lines)
systemctl restart wc26             # restart app
cd /opt/wc26 && sudo -u wc26 git pull && systemctl restart wc26   # deploy updates
```

Notes:
- Prediction history (`tools/data/predlog.json`, `results.json`) lives on the instance disk and survives restarts/deploys (`git pull` won't clobber files with local changes committed... if `git pull` conflicts on data files, `git stash` them first or add them to `.gitignore` on the box).
- To add viewers: add their email to `/etc/oauth2-proxy/emails.txt` and `ALLOWED_EMAILS` in `/etc/wc26/env`, then `systemctl restart oauth2-proxy wc26`.
- Cost: ~$5/mo Lightsail + $0 for Caddy/oauth2-proxy/Let's Encrypt/Google OAuth.
