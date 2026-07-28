#!/usr/bin/env bash
#
# BullBots Design Lab — one-shot provisioning for an Alibaba Cloud ECS
# instance running Ubuntu 22.04/24.04.
#
# Alternative to the Function Compute path (deploy/s.yaml). Installs Node 20,
# fetches the repo, builds nothing on the frontend side (that ships to OSS),
# runs the Fastify API under systemd, and fronts it with nginx on :80.
#
# Usage (as root or with sudo, on the ECS box):
#   curl -fsSL https://raw.githubusercontent.com/suspect-47/bullbots-design-lab/main/deploy/ecs-setup.sh -o ecs-setup.sh
#   sudo DASHSCOPE_API_KEY=sk-xxxx bash ecs-setup.sh
#
# Environment (all optional except DASHSCOPE_API_KEY):
#   DASHSCOPE_API_KEY   Alibaba Cloud Model Studio key (required for live Qwen)
#   DASHSCOPE_BASE_URL  defaults to the international endpoint
#   QWEN_MODEL          defaults to qwen-plus
#   DATABASE_URL        ApsaraDB RDS for PostgreSQL DSN (optional)
#   REPO_URL / BRANCH / APP_DIR / APP_PORT
#
# The script is idempotent: re-running it updates the checkout, re-installs
# dependencies, rewrites the unit + nginx config, and restarts the service.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/suspect-47/bullbots-design-lab.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/bullbots}"
APP_USER="${APP_USER:-bullbots}"
APP_PORT="${APP_PORT:-3001}"
SERVICE_NAME="bullbots-api"

DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}"
DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1}"
QWEN_MODEL="${QWEN_MODEL:-qwen-plus}"
DATABASE_URL="${DATABASE_URL:-}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root (use sudo)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Base packages. Alibaba Cloud's Ubuntu images already point apt at the
#    in-region mirrors, so this is fast and needs no NAT gateway.
# ---------------------------------------------------------------------------
log "Installing base packages (git, curl, nginx, ca-certificates)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git nginx

# ---------------------------------------------------------------------------
# 2. Node.js 20 from NodeSource (the distro package is too old for the ESM +
#    Fastify 5 stack). Skipped if a Node 20.x is already present.
# ---------------------------------------------------------------------------
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v20.* ]]; then
  log "Node $(node -v) already installed — skipping"
else
  log "Installing Node.js 20 from NodeSource"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
node -v
npm -v

# ---------------------------------------------------------------------------
# 3. Dedicated unprivileged service account. The API never needs a login shell.
# ---------------------------------------------------------------------------
if id -u "${APP_USER}" >/dev/null 2>&1; then
  log "Service user ${APP_USER} already exists"
else
  log "Creating service user ${APP_USER}"
  useradd --system --create-home --home-dir "/home/${APP_USER}" \
          --shell /usr/sbin/nologin "${APP_USER}"
fi

# ---------------------------------------------------------------------------
# 4. Clone (or fast-forward) the repo into APP_DIR.
# ---------------------------------------------------------------------------
if [[ -d "${APP_DIR}/.git" ]]; then
  log "Updating existing checkout at ${APP_DIR}"
  git -C "${APP_DIR}" remote set-url origin "${REPO_URL}"
  git -C "${APP_DIR}" fetch --depth 1 origin "${BRANCH}"
  git -C "${APP_DIR}" checkout -B "${BRANCH}" "origin/${BRANCH}"
  git -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
else
  log "Cloning ${REPO_URL} (${BRANCH}) into ${APP_DIR}"
  rm -rf "${APP_DIR}"
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# ---------------------------------------------------------------------------
# 5. Dependencies. `npm ci` for a lockfile-exact install; devDependencies are
#    kept only if you also want to build the SPA on the box (npm run build).
# ---------------------------------------------------------------------------
log "Installing production dependencies"
sudo -u "${APP_USER}" env HOME="/home/${APP_USER}" \
  npm --prefix "${APP_DIR}" ci --omit=dev

# ---------------------------------------------------------------------------
# 6. Environment file, root-readable only (it holds the DashScope key).
# ---------------------------------------------------------------------------
log "Writing /etc/${SERVICE_NAME}.env"
cat > "/etc/${SERVICE_NAME}.env" <<EOF
NODE_ENV=production
PORT=${APP_PORT}
DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
DASHSCOPE_BASE_URL=${DASHSCOPE_BASE_URL}
QWEN_MODEL=${QWEN_MODEL}
DATABASE_URL=${DATABASE_URL}
EOF
chown root:"${APP_USER}" "/etc/${SERVICE_NAME}.env"
chmod 0640 "/etc/${SERVICE_NAME}.env"

# ---------------------------------------------------------------------------
# 7. systemd unit — restarts on crash and on reboot.
# ---------------------------------------------------------------------------
log "Writing systemd unit ${SERVICE_NAME}.service"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=BullBots Design Lab API (Fastify)
Documentation=https://github.com/suspect-47/bullbots-design-lab
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/${SERVICE_NAME}.env
ExecStart=/usr/bin/node server/api/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Hardening — the API only ever reads its own checkout.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

# ---------------------------------------------------------------------------
# 8. nginx reverse proxy on :80 -> 127.0.0.1:APP_PORT
#    Open port 80 in the ECS security group for this to be reachable.
# ---------------------------------------------------------------------------
log "Configuring nginx reverse proxy on :80"
cat > "/etc/nginx/sites-available/${SERVICE_NAME}" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # CORS for the OSS-hosted frontend (tighten to your bucket domain in prod).
    add_header Access-Control-Allow-Origin  "*" always;
    add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;

    location / {
        if (\$request_method = OPTIONS) { return 204; }

        proxy_pass         http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";

        # /chat and /verdict can take a while when Qwen is reasoning.
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF

ln -sfn "/etc/nginx/sites-available/${SERVICE_NAME}" \
        "/etc/nginx/sites-enabled/${SERVICE_NAME}"
rm -f /etc/nginx/sites-enabled/default   # its default_server would collide
nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

# ---------------------------------------------------------------------------
# 9. Smoke test.
# ---------------------------------------------------------------------------
log "Waiting for the API to answer /health"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1/health" && echo
log "Done. Public URL: http://<ECS public IP>/health"
echo "Logs:    journalctl -u ${SERVICE_NAME} -f"
echo "Restart: systemctl restart ${SERVICE_NAME}"
