#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: ./manage.sh <up|down|restart|status|logs|build|clients|routing|version|config>
EOF
}

main() {
  local command="${1:-}"
  case "$command" in
    up)
      load_env; [[ -n ${PASSWORD_HASH:-} ]] || die 'Run ./set-password.sh before exposing the UI.'
      ensure_docker; compose up -d --build; compose ps
      ;;
    down) load_env; ensure_docker; compose down ;;
    restart) load_env; ensure_docker; compose restart awg-chain-easy; compose ps ;;
    status)
      load_env; ensure_docker; compose ps
      if compose ps --status running --services | grep -Fxq awg-chain-easy; then
        compose exec -T awg-chain-easy awg show awg3 | sed -E \
          -e 's/(private key: ).*/\1(hidden)/' \
          -e 's/(preshared key: ).*/\1(hidden)/' \
          -e 's/(header protection key: ).*/\1(hidden)/'
      fi
      ;;
    logs) load_env; ensure_docker; compose logs -f --tail=200 awg-chain-easy ;;
    build) load_env; ensure_docker; compose build --pull awg-chain-easy ;;
    clients)
      load_env; ensure_docker
      compose exec -T awg-chain-easy node /app/list-clients.js
      ;;
    routing)
      load_env; ensure_docker
      compose exec -T awg-chain-easy node /app/list-routing.js
      ;;
    version)
      load_env; ensure_docker
      compose run --rm --no-deps --entrypoint sh awg-chain-easy -lc 'node --version; amneziawg-go --version 2>/dev/null || true; awg --version'
      ;;
    config) load_env; ensure_docker; compose config ;;
    -h|--help|help|'') usage ;;
    *) usage >&2; die "Unknown command: $command" ;;
  esac
}

main "$@"
