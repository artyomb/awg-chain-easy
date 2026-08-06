#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() { printf 'Usage: ./prepare.sh [public-host-or-ip]\n'; }

main() {
  [[ ${1:-} != '-h' && ${1:-} != '--help' ]] || { usage; exit 0; }
  [[ $# -le 1 ]] || { usage >&2; exit 1; }
  [[ -f $ENV_FILE ]] || { cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
  if [[ -n ${1:-} ]]; then
    [[ $1 =~ ^[A-Za-z0-9._:-]+$ ]] || die 'WG_HOST contains unsupported characters.'
    set_env_value WG_HOST "$1"
  fi
  load_env
  [[ ${WG_HOST:-} != vpn.example.com && -n ${WG_HOST:-} ]] || die 'Set WG_HOST in .env or pass it to prepare.sh.'
  mkdir -p "$CONFIG_PATH"
  chmod 700 "$CONFIG_PATH"
  ensure_docker
  compose build --pull awg-chain-easy
  log 'image built and state directory prepared'
  if [[ -z ${PASSWORD_HASH:-} ]]; then
    log 'next: run ./set-password.sh, then ./manage.sh up'
  else
    log 'next: run ./manage.sh up'
  fi
}

main "$@"
