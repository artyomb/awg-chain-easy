#!/bin/sh
set -eu

: "${WG_DEFAULT_ADDRESS:=10.8.3.x}"
: "${WG_MTU:=1280}"
: "${WG_DEVICE:=eth0}"
VPN_IFACE=awg3
SERVER_CONF=/etc/wireguard/wg0.conf
DAEMON_PID=''
UI_PID=''

network="${WG_DEFAULT_ADDRESS%x}0/24"
server_address="${WG_DEFAULT_ADDRESS%x}1/24"

cleanup() {
  if [ -n "$UI_PID" ]; then kill "$UI_PID" 2>/dev/null || true; wait "$UI_PID" 2>/dev/null || true; fi
  iptables -D FORWARD -i "$VPN_IFACE" -j ACCEPT 2>/dev/null || true
  iptables -D FORWARD -o "$VPN_IFACE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  iptables -t nat -D POSTROUTING -s "$network" -o "$WG_DEVICE" -j MASQUERADE 2>/dev/null || true
  if [ -n "$DAEMON_PID" ]; then kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; fi
  ip link delete dev "$VPN_IFACE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

mkdir -p /etc/wireguard
chmod 700 /etc/wireguard
node /app/server.js --initialize

amneziawg-go -f "$VPN_IFACE" &
DAEMON_PID=$!
attempt=0
while [ ! -S "/var/run/amneziawg/${VPN_IFACE}.sock" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    printf '[awg-chain-easy] userspace UAPI socket did not appear\n' >&2
    exit 1
  fi
  sleep 0.1
done

awg-quick strip "$SERVER_CONF" > /tmp/awg-chain-easy-stripped.conf
awg setconf "$VPN_IFACE" /tmp/awg-chain-easy-stripped.conf
rm -f /tmp/awg-chain-easy-stripped.conf
ip -4 address add "$server_address" dev "$VPN_IFACE"
ip link set mtu "$WG_MTU" up dev "$VPN_IFACE"

awg show "$VPN_IFACE" allowed-ips | while read -r _public_key allowed_ips; do
  for cidr in $(printf '%s' "$allowed_ips" | tr ',' ' '); do
    ip -4 route replace "$cidr" dev "$VPN_IFACE" proto static
  done
done

iptables -C FORWARD -i "$VPN_IFACE" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$VPN_IFACE" -j ACCEPT
iptables -C FORWARD -o "$VPN_IFACE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -o "$VPN_IFACE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -C POSTROUTING -s "$network" -o "$WG_DEVICE" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s "$network" -o "$WG_DEVICE" -j MASQUERADE

node /app/server.js &
UI_PID=$!
wait "$UI_PID"
