#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_IMAGE="${1:-awg-chain-easy:address-conflict-test}"
if [[ $# -eq 0 ]]; then
  docker build -t "$TEST_IMAGE" "$SERVICE_DIR"
fi
docker run --rm --cap-add NET_ADMIN --device /dev/net/tun \
  --sysctl net.ipv4.ip_forward=1 \
  --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  --sysctl net.ipv4.conf.all.rp_filter=0 \
  --mount "type=bind,src=$SERVICE_DIR/test,dst=/tests,readonly" \
  --entrypoint node "$TEST_IMAGE" --test /tests/address-conflicts.test.js
