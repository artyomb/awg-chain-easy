#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

main() {
  load_env
  ensure_docker
  local password confirm hash
  if [[ $# -gt 1 ]]; then die 'Usage: ./set-password.sh [password]'; fi
  if [[ $# -eq 1 ]]; then
    password="$1"
  else
    read -r -s -p 'New UI password: ' password; printf '\n'
    read -r -s -p 'Confirm password: ' confirm; printf '\n'
    [[ $password == "$confirm" ]] || die 'Passwords do not match.'
  fi
  [[ ${#password} -ge 12 ]] || die 'Password must contain at least 12 characters.'
  hash="$(printf '%s' "$password" | compose run --rm --no-deps -T --entrypoint node awg-chain-easy /app/hash-password.js | tail -n 1)"
  [[ $hash == \$2* ]] || die 'Failed to generate a bcrypt password hash.'
  set_env_value PASSWORD_HASH "$hash" true
  log 'password hash saved to .env'
}

main "$@"
