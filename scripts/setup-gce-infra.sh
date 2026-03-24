#!/bin/bash
# =============================================================================
# OpenClooda GCE Infrastructure Setup
# Creates an isolated GCP project with an always-on e2-micro VM running
# the OpenClaw gateway + tmux, accessible via Tailscale from anywhere.
#
# Usage:
#   ./scripts/setup-gce-infra.sh
#
# Prerequisites:
#   gcloud CLI authenticated (gcloud auth login)
#   Tailscale account + auth key (https://login.tailscale.com/admin/settings/keys)
# =============================================================================

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
PROJECT_ID="openclooda-infra"
PROJECT_NAME="OpenClooda Infrastructure"
BILLING_ACCOUNT="01091D-1C78F2-5A9BD6"   # CapOne — fewer projects
REGION="us-central1"
ZONE="us-central1-a"
MACHINE_TYPE="e2-micro"                   # Free tier eligible
DISK_SIZE="30GB"                          # Free tier: 30GB standard disk
VM_NAME="openclaw-gateway"
SA_NAME="openclaw-gateway-sa"

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC}   $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERR]${NC}  $1"; }

# ─── Banner ──────────────────────────────────────────────────────────────────
echo ""
echo "=================================================="
echo "  OpenClooda GCE Infrastructure Setup"
echo "=================================================="
echo "  Project:        $PROJECT_ID"
echo "  Billing:        CapOne ($BILLING_ACCOUNT)"
echo "  VM:             $VM_NAME ($MACHINE_TYPE, $ZONE)"
echo "  Disk:           $DISK_SIZE"
echo ""
echo "  This will create an always-on VM running:"
echo "    • OpenClaw gateway (systemd service)"
echo "    • tmux (persistent terminal sessions)"
echo "    • Tailscale (remote access from anywhere)"
echo "=================================================="
echo ""
if [[ "${AUTO_CONFIRM:-}" != "1" ]]; then
    read -p "Continue? (y/n) " -n 1 -r; echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && { log_error "Aborted."; exit 1; }
fi

# ─── Tailscale auth key ───────────────────────────────────────────────────────
echo ""
if [[ -z "${TAILSCALE_AUTH_KEY:-}" ]]; then
    log_info "You'll need a Tailscale auth key (reusable, ephemeral OK)."
    log_info "Generate one at: https://login.tailscale.com/admin/settings/keys"
    echo ""
    read -rsp "Tailscale auth key (ts-key-...): " TAILSCALE_AUTH_KEY; echo
    [[ -z "$TAILSCALE_AUTH_KEY" ]] && { log_error "Tailscale auth key required."; exit 1; }
else
    log_info "Using TAILSCALE_AUTH_KEY from environment"
fi

# ─── Prerequisites ───────────────────────────────────────────────────────────
log_info "Checking prerequisites..."
for cmd in gcloud ssh-keygen; do
    command -v "$cmd" &>/dev/null || { log_error "$cmd not found."; exit 1; }
done
gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q "@" \
    || { log_warn "Not authenticated — running gcloud auth login..."; gcloud auth login; }
log_success "Prerequisites OK"

# ─── SSH key ─────────────────────────────────────────────────────────────────
SSH_KEY_PATH="$HOME/.ssh/openclooda-gce"
if [[ ! -f "$SSH_KEY_PATH" ]]; then
    log_info "Generating SSH key → $SSH_KEY_PATH"
    ssh-keygen -t ed25519 -C "openclooda-gce" -f "$SSH_KEY_PATH" -N ""
    log_success "SSH key generated"
else
    log_warn "SSH key already exists: $SSH_KEY_PATH"
fi
SSH_PUB_KEY=$(cat "${SSH_KEY_PATH}.pub")

# ─── GCP Project ─────────────────────────────────────────────────────────────
log_info "Creating GCP project: $PROJECT_ID"
if gcloud projects describe "$PROJECT_ID" &>/dev/null; then
    log_warn "Project already exists — skipping creation"
else
    gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME"
    log_success "Project created"
fi
gcloud config set project "$PROJECT_ID"

# ─── Billing ─────────────────────────────────────────────────────────────────
log_info "Linking billing account (CapOne)..."
CURRENT_BILLING=$(gcloud billing projects describe "$PROJECT_ID" \
    --format="value(billingAccountName)" 2>/dev/null || echo "")
if [[ -n "$CURRENT_BILLING" ]]; then
    log_warn "Billing already linked: $CURRENT_BILLING"
else
    gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
    log_success "Billing linked"
fi

# ─── APIs ────────────────────────────────────────────────────────────────────
log_info "Enabling required APIs..."
APIS=(
    "compute.googleapis.com"
    "iam.googleapis.com"
    "iamcredentials.googleapis.com"
    "secretmanager.googleapis.com"
    "logging.googleapis.com"
    "monitoring.googleapis.com"
    "oslogin.googleapis.com"
)
for api in "${APIS[@]}"; do
    gcloud services enable "$api" --project="$PROJECT_ID" --quiet
done
log_success "APIs enabled"

# ─── Service Account ─────────────────────────────────────────────────────────
log_info "Creating service account: $SA_NAME"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
    log_warn "Service account already exists"
else
    gcloud iam service-accounts create "$SA_NAME" \
        --display-name="OpenClaw Gateway SA" \
        --project="$PROJECT_ID"
    log_success "Service account created: $SA_EMAIL"
fi

# Minimal roles: logging writer + metric writer only
for role in roles/logging.logWriter roles/monitoring.metricWriter; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$SA_EMAIL" \
        --role="$role" \
        --condition=None --quiet
done
log_success "IAM roles bound (logging + monitoring)"

# ─── Firewall: SSH only ───────────────────────────────────────────────────────
log_info "Configuring firewall (SSH only — Tailscale handles the rest)..."
if ! gcloud compute firewall-rules describe allow-ssh --project="$PROJECT_ID" &>/dev/null; then
    gcloud compute firewall-rules create allow-ssh \
        --project="$PROJECT_ID" \
        --allow=tcp:22 \
        --source-ranges="0.0.0.0/0" \
        --description="SSH access for initial setup; post-Tailscale can restrict further"
    log_success "Firewall rule created"
else
    log_warn "Firewall rule already exists"
fi

# ─── Startup Script ──────────────────────────────────────────────────────────
log_info "Preparing VM startup script..."

STARTUP_SCRIPT=$(cat <<'STARTUP'
#!/bin/bash
set -euo pipefail
LOG=/var/log/openclaw-setup.log
exec >> "$LOG" 2>&1
echo "=== OpenClaw setup started: $(date) ==="

# ── System ────────────────────────────────────────────────────────────────────
apt-get update -qq
apt-get install -y -qq curl wget git tmux htop unzip jq

# ── Tailscale ─────────────────────────────────────────────────────────────────
if ! command -v tailscale &>/dev/null; then
    echo "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
fi
# Auth key injected by setup script via metadata
TS_KEY=$(curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/attributes/tailscale-auth-key" \
    -H "Metadata-Flavor: Google" || echo "")
if [[ -n "$TS_KEY" ]]; then
    tailscale up --authkey="$TS_KEY" --hostname="openclaw-gateway" --accept-routes --ssh || true
    echo "Tailscale connected"
fi

# ── Node.js (LTS) ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    echo "Installing Node.js LTS..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y -qq nodejs
fi
echo "Node: $(node --version)"

# ── OpenClaw ─────────────────────────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
    echo "Installing OpenClaw..."
    npm install -g openclaw 2>&1 | tail -5
fi
echo "OpenClaw: $(openclaw --version 2>/dev/null || echo 'installed')"

# ── openclaw user + workspace ────────────────────────────────────────────────
if ! id -u clawuser &>/dev/null; then
    useradd -m -s /bin/bash clawuser
fi
mkdir -p /home/clawuser/.openclaw/workspace
chown -R clawuser:clawuser /home/clawuser/.openclaw

# ── tmux default config ──────────────────────────────────────────────────────
cat > /home/clawuser/.tmux.conf <<'TMUX'
set -g history-limit 50000
set -g mouse on
set -g status-interval 5
set -g default-terminal "screen-256color"
set -g status-left "#[fg=green]#H #[fg=white]| "
set -g status-right "#[fg=yellow]%Y-%m-%d %H:%M"
TMUX
chown clawuser:clawuser /home/clawuser/.tmux.conf

# ── systemd: openclaw gateway ────────────────────────────────────────────────
cat > /etc/systemd/system/openclaw.service <<'SERVICE'
[Unit]
Description=OpenClaw Gateway
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=clawuser
Group=clawuser
WorkingDirectory=/home/clawuser
ExecStart=/usr/bin/openclaw gateway start --foreground
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable openclaw
systemctl start openclaw || echo "OpenClaw service start deferred (needs config)"

echo "=== OpenClaw setup complete: $(date) ==="
STARTUP
)

# ─── VM ──────────────────────────────────────────────────────────────────────
log_info "Creating VM: $VM_NAME ($MACHINE_TYPE in $ZONE)..."
if gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" &>/dev/null; then
    log_warn "VM already exists — skipping creation"
else
    gcloud compute instances create "$VM_NAME" \
        --project="$PROJECT_ID" \
        --zone="$ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --image-family="debian-12" \
        --image-project="debian-cloud" \
        --boot-disk-size="$DISK_SIZE" \
        --boot-disk-type="pd-standard" \
        --service-account="$SA_EMAIL" \
        --scopes="cloud-platform" \
        --metadata="tailscale-auth-key=${TAILSCALE_AUTH_KEY},ssh-keys=clawuser:${SSH_PUB_KEY}" \
        --metadata-from-file="startup-script=<(echo "${STARTUP_SCRIPT}")" \
        --no-address \
        --tags="openclaw-gateway" \
        --labels="app=openclaw,env=prod,managed-by=script"

    log_success "VM created"
fi

# ─── External IP (temporary for setup) ───────────────────────────────────────
# VM has no external IP (--no-address above). For initial SSH we use IAP tunnel.
log_info "VM has no external IP — using IAP tunnel for SSH access."
log_info "Waiting 60s for VM to boot and Tailscale to connect..."
sleep 60

# ─── SSH config entry ─────────────────────────────────────────────────────────
SSH_CONFIG="$HOME/.ssh/config"
log_info "Adding SSH config entry..."
if grep -q "Host openclaw-gce" "$SSH_CONFIG" 2>/dev/null; then
    log_warn "SSH config entry already exists"
else
    cat >> "$SSH_CONFIG" <<SSH

# OpenClooda GCE Gateway (via IAP tunnel)
Host openclaw-gce
    HostName $VM_NAME
    User clawuser
    IdentityFile $SSH_KEY_PATH
    ProxyCommand gcloud compute start-iap-tunnel $VM_NAME 22 --listen-on-stdin --project=$PROJECT_ID --zone=$ZONE
    StrictHostKeyChecking no

# OpenClooda Gateway (via Tailscale — use after Tailscale connects)
Host openclaw-ts
    HostName openclaw-gateway
    User clawuser
    IdentityFile $SSH_KEY_PATH
    StrictHostKeyChecking no
SSH
    log_success "SSH config updated — two entries: openclaw-gce (IAP) + openclaw-ts (Tailscale)"
fi

# ─── Budget alert ─────────────────────────────────────────────────────────────
log_info "Note: Set up a budget alert to catch runaway costs:"
log_warn "  https://console.cloud.google.com/billing/$BILLING_ACCOUNT/budgets?project=$PROJECT_ID"
log_warn "  Recommended: \$10/month alert (e2-micro + disk should be ~\$0 free tier)"

# ─── Verify ───────────────────────────────────────────────────────────────────
echo ""
echo "=================================================="
echo "  Setup Complete"
echo "=================================================="
log_success "Project:   $PROJECT_ID"
log_success "VM:        $VM_NAME ($MACHINE_TYPE, $ZONE)"
log_success "Tailscale: openclaw-gateway (check https://login.tailscale.com/admin/machines)"
echo ""
echo "Connect via IAP (no Tailscale needed for first login):"
echo "  ssh openclaw-gce"
echo ""
echo "Connect via Tailscale (after it connects):"
echo "  ssh openclaw-ts"
echo ""
echo "Check setup log on VM:"
echo "  ssh openclaw-gce 'tail -50 /var/log/openclaw-setup.log'"
echo ""
echo "Next steps:"
echo "  1. SSH in and run: openclaw configure"
echo "  2. Copy your openclaw.json config from laptop:"
echo "     scp ~/.openclaw/openclaw.json openclaw-gce:~/.openclaw/"
echo "  3. Restart the gateway: ssh openclaw-gce 'sudo systemctl restart openclaw'"
echo "  4. Verify: ssh openclaw-gce 'openclaw gateway status'"
echo "  5. Once Tailscale is connected, restrict SSH firewall to Tailscale CIDR only:"
echo "     gcloud compute firewall-rules update allow-ssh --source-ranges=100.64.0.0/10 --project=$PROJECT_ID"
echo ""
echo "Console: https://console.cloud.google.com/compute/instances?project=$PROJECT_ID"
echo "=================================================="
