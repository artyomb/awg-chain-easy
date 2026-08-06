#!/bin/sh
set -eu

: "${WG_DEFAULT_ADDRESS:=10.8.3.x}"
: "${AWG2_DEFAULT_ADDRESS:=10.8.4.x}"
: "${WG_MTU:=1280}"
: "${WG_DEVICE:=eth0}"
UI_PID=''
AWG3_PID=''
AWG2_PID=''

network3="${WG_DEFAULT_ADDRESS%x}0/24"
network2="${AWG2_DEFAULT_ADDRESS%x}0/24"

remove_firewall() {
  interface="$1" network="$2"
  iptables -D FORWARD -i "$interface" -j ACCEPT 2>/dev/null || true
  iptables -D FORWARD -o "$interface" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  iptables -t nat -D POSTROUTING -s "$network" -o "$WG_DEVICE" -j MASQUERADE 2>/dev/null || true
}

cleanup() {
  if [ -n "$UI_PID" ]; then kill "$UI_PID" 2>/dev/null || true; wait "$UI_PID" 2>/dev/null || true; fi
  remove_firewall awg3 "$network3"
  remove_firewall awg2 "$network2"
  if [ -n "$AWG3_PID" ]; then kill "$AWG3_PID" 2>/dev/null || true; wait "$AWG3_PID" 2>/dev/null || true; fi
  if [ -n "$AWG2_PID" ]; then kill "$AWG2_PID" 2>/dev/null || true; wait "$AWG2_PID" 2>/dev/null || true; fi
  ip link delete dev awg3 2>/dev/null || true
  ip link delete dev awg2 2>/dev/null || true
}
trap cleanup EXIT INT TERM

start_tunnel() {
  interface="$1" config="$2" address="$3" network="$4"
  amneziawg-go -f "$interface" &
  tunnel_pid=$!
  if [ "$interface" = awg3 ]; then AWG3_PID=$tunnel_pid; else AWG2_PID=$tunnel_pid; fi
  attempt=0
  while [ ! -S "/var/run/amneziawg/${interface}.sock" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 50 ]; then
      printf '[awg-chain-easy] userspace UAPI socket did not appear for %s\n' "$interface" >&2
      exit 1
    fi
    sleep 0.1
  done
  stripped="/tmp/awg-chain-easy-${interface}.conf"
  awg-quick strip "$config" > "$stripped"
  awg setconf "$interface" "$stripped"
  rm -f "$stripped"
  ip -4 address add "$address" dev "$interface"
  ip link set mtu "$WG_MTU" up dev "$interface"
  awg show "$interface" allowed-ips | while read -r _public_key allowed_ips; do
    for cidr in $(printf '%s' "$allowed_ips" | tr ',' ' '); do
      ip -4 route replace "$cidr" dev "$interface" proto static
    done
  done
  iptables -C FORWARD -i "$interface" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$interface" -j ACCEPT
  iptables -C FORWARD -o "$interface" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
    iptables -A FORWARD -o "$interface" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -t nat -C POSTROUTING -s "$network" -o "$WG_DEVICE" -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -s "$network" -o "$WG_DEVICE" -j MASQUERADE
}

mkdir -p /etc/wireguard
chmod 700 /etc/wireguard
node /app/server.js --initialize

start_tunnel awg3 /etc/wireguard/wg0.conf "${WG_DEFAULT_ADDRESS%x}1/24" "$network3"
start_tunnel awg2 /etc/wireguard/wg2.conf "${AWG2_DEFAULT_ADDRESS%x}1/24" "$network2"

node /app/server.js &
UI_PID=$!
wait "$UI_PID"
