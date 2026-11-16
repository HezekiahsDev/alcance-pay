#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: pnpm run deploy

Builds locally, commits and pushes main, uploads the dist build (and the
runtime env file) to the server, then runs ./deploy.sh there.

Branch guard: only the main branch may deploy. The script aborts if your
checked-out branch is not main.

Required (set in .env.deploy, see .env.deploy.example):
  DEPLOY_HOST       SSH target, e.g. deploy-user@your-server-host.

Optional:
  DEPLOY_PATH       Existing repo path on server. Default: /home/alcance/projects/alcance/alcance-pay
  DEPLOY_BRANCH     Branch the server deploys. Default: main
  DEPLOY_SSH_PORT   SSH port. Default: 22
  APP_NAME          PM2 process name. Default: alcance-pay
  APP_PORT          PORT exported for the app. Default: 4500
  RUN_LINT=1        Run pnpm lint before build (note: lint uses --fix)
  RUN_TESTS=0       Skip pnpm test before build
  SYNC_ENV=0        Do not upload the runtime env file
  ENV_SOURCE        Runtime env file to upload as .env. Default: .env
  SKIP_GIT_PUSH=1   Do not commit and push before deploy
EOF
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "Unknown argument: $1" >&2
  echo "Usage: pnpm run deploy" >&2
  exit 1
fi

ENV_FILE=".env.deploy"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

EXPECTED_BRANCH="main"

APP_NAME="${APP_NAME:-alcance-pay}"
APP_PORT="${APP_PORT:-4500}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/alcance/projects/alcance/alcance-pay}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-22}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$EXPECTED_BRANCH}"
RUN_LINT="${RUN_LINT:-0}"
RUN_TESTS="${RUN_TESTS:-1}"
SKIP_GIT_PUSH="${SKIP_GIT_PUSH:-0}"
SYNC_ENV="${SYNC_ENV:-1}"
ENV_SOURCE="${ENV_SOURCE:-.env}"

if [[ -z "$DEPLOY_HOST" ]]; then
  echo "DEPLOY_HOST is required. Set it in $ENV_FILE (see ${ENV_FILE}.example)." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "Refusing to deploy: only branch '$EXPECTED_BRANCH' deploys but you are on '$CURRENT_BRANCH'." >&2
  echo "Run 'git checkout $EXPECTED_BRANCH' first." >&2
  exit 1
fi

for cmd in git pnpm ssh scp tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required."
    exit 1
  fi
done

echo "Installing dependencies locally..."
pnpm install --frozen-lockfile

if [[ -d prisma ]]; then
  echo "Generating Prisma client locally..."
  pnpm exec prisma generate
fi

if [[ "$RUN_LINT" == "1" ]]; then
  echo "Running lint..."
  pnpm lint
fi

if [[ "$RUN_TESTS" == "1" ]]; then
  echo "Running tests..."
  pnpm test
fi

echo "Building locally..."
pnpm build

if [[ ! -f dist/main.js ]]; then
  echo "Build did not create dist/main.js."
  exit 1
fi

release_id="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
build_artifact="/tmp/${APP_NAME}-dist-${release_id}.tar.gz"
remote_build_artifact="/tmp/${APP_NAME}-dist-${release_id}.tar.gz"
remote_env_file="/tmp/${APP_NAME}-env-${release_id}"
env_arg=""

cleanup() {
  rm -f "$build_artifact"
}
trap cleanup EXIT

echo "Packaging dist build..."
tar -czf "$build_artifact" dist

if [[ "$SKIP_GIT_PUSH" != "1" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Changes to commit:"
    git status --short

    if [[ -z "${COMMIT_MESSAGE:-}" ]]; then
      read -r -p "Enter commit message: " COMMIT_MESSAGE
    fi

    if [[ -z "$COMMIT_MESSAGE" ]]; then
      echo "Commit message is required."
      exit 1
    fi

    user="$(whoami)"
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    commit_msg="$user: $COMMIT_MESSAGE - $timestamp"

    echo "Committing changes..."
    git add -A
    git commit -m "$commit_msg"
  else
    echo "No source changes to commit."
  fi

  echo "Pushing $DEPLOY_BRANCH..."
  git push origin "$DEPLOY_BRANCH"
fi

if [[ "$SYNC_ENV" == "1" && -f "$ENV_SOURCE" ]]; then
  echo "Uploading $ENV_SOURCE..."
  scp -P "$DEPLOY_SSH_PORT" "$ENV_SOURCE" "$DEPLOY_HOST:$remote_env_file"
  env_arg="ENV_FILE='$remote_env_file'"
elif [[ "$SYNC_ENV" == "1" ]]; then
  echo "Warning: SYNC_ENV=1 but $ENV_SOURCE was not found locally; keeping the server's .env."
fi

echo "Uploading build artifact..."
scp -P "$DEPLOY_SSH_PORT" "$build_artifact" "$DEPLOY_HOST:$remote_build_artifact"

echo "Deploying on server..."
ssh -p "$DEPLOY_SSH_PORT" "$DEPLOY_HOST" "\
  set -euo pipefail; \
  cd '$DEPLOY_PATH'; \
  chmod +x ./deploy.sh; \
  DEPLOY_PATH='$DEPLOY_PATH' \
  DEPLOY_BRANCH='$DEPLOY_BRANCH' \
  BUILD_ARTIFACT='$remote_build_artifact' \
  $env_arg \
  APP_NAME='$APP_NAME' \
  APP_PORT='$APP_PORT' \
  bash ./deploy.sh; \
  rm -f '$remote_build_artifact' '$remote_env_file'"

echo "Local build deployed to $DEPLOY_HOST:$DEPLOY_PATH (branch $DEPLOY_BRANCH)"
