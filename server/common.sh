#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

die() { printf '[awg-chain-easy] error: %s\n' "$*" >&2; exit 1; }
log() { printf '[awg-chain-easy] %s\n' "$*"; }

load_env() {
  [[ -f $ENV_FILE ]] || die "Missing $ENV_FILE. Run ./prepare.sh <public-host> first."
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${CONFIG_DIR:=./config}"
  if [[ $CONFIG_DIR = /* ]]; then CONFIG_PATH="$CONFIG_DIR"; else CONFIG_PATH="$SCRIPT_DIR/${CONFIG_DIR#./}"; fi
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die 'Docker is not installed.'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required.'
  docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable.'
}

compose() {
  docker compose --project-directory "$SCRIPT_DIR" --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.yml" "$@"
}

set_env_value() {
  local key="$1" value="$2" quote="${3:-false}" tmp
  tmp="$(mktemp "$SCRIPT_DIR/.env.XXXXXX")"
  if [[ $quote == true ]]; then value="'$value'"; fi
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    index($0, key "=") == 1 { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}
