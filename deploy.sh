#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-alcance-pay}"
APP_PORT="${APP_PORT:-4500}"
DEPLOY_PATH="${DEPLOY_PATH:-$(cd "$(dirname "$0")" && pwd)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
BUILD_ARTIFACT="${BUILD_ARTIFACT:-}"
ENV_FILE="${ENV_FILE:-}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: ./deploy.sh

Server-side deploy script. Pulls the repo, installs the uploaded dist build,
runs pnpm install and prisma generate, and restarts the app with PM2. pnpm build
is NOT run here; dist must be uploaded first (pnpm run deploy from your local
machine does this). Database schema changes are NOT applied here.

Environment:
  APP_NAME        PM2 app name. Default: alcance-pay
  APP_PORT        Port exported as PORT. Default: 4500
  DEPLOY_PATH     Server repo path. Default: directory containing deploy.sh
  DEPLOY_BRANCH   Branch to fetch/check out. Default: main
  BUILD_ARTIFACT  Optional tar.gz containing local dist build output
  ENV_FILE        Optional uploaded env file to copy to .env
EOF
  exit 0
fi

cd "$DEPLOY_PATH"

# Non-interactive SSH sessions often have a minimal PATH (no nvm, no pnpm).
# Source the usual profile files so node/pnpm/pm2 installed via nvm are found.
load_runtime_path() {
  local had_nounset=0
  if [[ $- == *u* ]]; then
    had_nounset=1
    set +u
  fi

  for profile in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.nvm/nvm.sh"; do
    if [[ -f "$profile" ]]; then
      # shellcheck disable=SC1090
      source "$profile" >/dev/null 2>&1 || true
    fi
  done

  if [[ "$had_nounset" == "1" ]]; then
    set -u
  fi

  if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
}

load_runtime_path

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required on the server but was not found in PATH."
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is required on the server but was not found in PATH."
  exit 1
fi

PNPM_BIN="$(command -v pnpm)"
PM2_BIN="$(command -v pm2)"

echo "Fetching latest code..."
git fetch origin "$DEPLOY_BRANCH"
git checkout -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ENV_FILE was provided but does not exist: $ENV_FILE"
    exit 1
  fi

  echo "Updating .env..."
  cp "$ENV_FILE" .env
fi

if [[ -n "$BUILD_ARTIFACT" ]]; then
  if [[ ! -f "$BUILD_ARTIFACT" ]]; then
    echo "BUILD_ARTIFACT was provided but does not exist: $BUILD_ARTIFACT"
    exit 1
  fi

  echo "Installing uploaded build..."
  rm -rf dist
  tar -xzf "$BUILD_ARTIFACT" -C "$DEPLOY_PATH"
fi

if [[ ! -f dist/main.js ]]; then
  echo "Missing dist/main.js. Run pnpm run deploy from your local machine first."
  exit 1
fi

echo "Installing dependencies..."
"$PNPM_BIN" install --frozen-lockfile || "$PNPM_BIN" install

if [[ -d prisma ]]; then
  echo "Generating Prisma client..."
  "$PNPM_BIN" exec prisma generate
  # Schema changes are applied separately, not from here.
fi

echo "Restarting $APP_NAME with PM2..."
"$PM2_BIN" stop "$APP_NAME" || true
"$PM2_BIN" delete "$APP_NAME" || true
PORT="$APP_PORT" "$PM2_BIN" start "$PNPM_BIN" --name "$APP_NAME" -- start:prod
"$PM2_BIN" save

echo "Deploy complete."
