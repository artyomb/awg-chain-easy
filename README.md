# AWG Chain Easy

`server` recreates the operating model of
`ghcr.io/gennadykataev/awg-easy` for the AWG 3 protocol: one container runs the
userspace tunnel and an authenticated browser UI for client management.

It does not run the original image because that project predates the AWG 3
header-protection protocol. This local image builds on the pinned
`amneziavpn/amneziawg-go:3.0.20260805` runtime and adds the management service.

## Features

- Create, enable, disable, and delete clients in the Web UI.
- Download AWG 3 profiles and display configuration QR codes.
- Show latest handshake, endpoint, and transfer counters.
- Import up to eight third-party AWG 3 client configs as upstream tunnels.
- Route by domain or IPv4 CIDR to an upstream, directly to the server uplink,
  or to a fail-closed blocked destination.
- Keep each upstream in a separate interface and policy-routing table.
- Persist `wg0.json`, `wg0.conf`, keys, and exported profiles under `server/config`.
- Synchronize peer changes without restarting the tunnel.
- Bcrypt password authentication, same-site sessions, login throttling, and
  security response headers.
- Responsive desktop table and mobile client layout with light/dark theme
  support.

## Prepare and start

```bash
./prepare.sh vpn.example.com
./set-password.sh
./manage.sh up
./manage.sh status
```

The UI is intentionally published only on host loopback by default:

```text
http://127.0.0.1:51821
```

Use an SSH tunnel:

```bash
ssh -L 51821:127.0.0.1:51821 root@vpn.example.com
```

Then open `http://127.0.0.1:51821` locally. For public access, place a TLS
reverse proxy in front of the loopback listener. Setting
`WEBUI_BIND_ADDRESS=0.0.0.0` exposes the plain HTTP login directly and is not
recommended.

## Compatible environment settings

The `.env` file uses the familiar settings:

```dotenv
WG_HOST=vpn.example.com
WG_PORT=51820
WG_CONFIG_PORT=51820
WG_DEFAULT_ADDRESS=10.8.3.x
WG_DEFAULT_DNS=auto
WG_ALLOWED_IPS=0.0.0.0/0
WG_PERSISTENT_KEEPALIVE=25
WG_MTU=1280
PORT=51821
```

Custom server and UI ports can be selected before startup:

```dotenv
WG_PORT=41725
WG_CONFIG_PORT=41725
PORT=51822
```

After changing build inputs, run `./manage.sh up`; it rebuilds the local image
when necessary. Firewall rules must allow `WG_PORT/udp`. The UI TCP port does
not need public firewall access when using loopback binding.

## Destination routing

Open the **Routing** page after signing in. The normal setup sequence is:

1. Import each provider's AWG 3 client `.conf` under **Upstream tunnels**.
2. Create policies containing domains, IPv4 networks, or both.
3. Choose `Direct`, `Blocked`, or an imported upstream as the destination.
4. Set the default route used when no policy matches.

Lower priority numbers win. A plain domain such as `example.com` matches the
apex and its subdomains; `*.example.com` matches subdomains only. Networks use
CIDR notation, for example `203.0.113.0/24` or `198.51.100.20/32`.

Imported configs must have exactly one peer, an IPv4 interface address,
`AllowedIPs = 0.0.0.0/0`, and the AWG 3 header-protection fields. Hook commands
and executable `wg-quick` directives are rejected. The upstream endpoint must
be an IPv4 address or hostname. If an enabled upstream is unavailable, its
routing table contains a `prohibit default`; matching traffic fails closed
instead of escaping through the server's normal uplink.

Domain rules are implemented by the container's DNS proxy. Client UDP and TCP
port 53 traffic is redirected to it, even if an external resolver is present
in an older client profile. Resolved IPv4 addresses enter the matching policy
set for the DNS TTL, bounded by `DNS_TTL_MIN` and `DNS_TTL_MAX`.

Important limitations:

- Routing and domain learning are IPv4-only. Keep `WG_ALLOWED_IPS` at
  `0.0.0.0/0`; IPv6 policy routing is not implemented.
- DNS-over-HTTPS, DNS-over-TLS, hard-coded application IPs, and cached answers
  obtained outside the tunnel cannot be classified by domain. Add explicit
  network rules where deterministic routing is required.
- Shared CDN addresses can cause unrelated destinations to follow a learned
  domain policy until its TTL expires.
- Existing connections retain their selected route through connection marks;
  reconnect after changing a policy to apply it immediately.

The default `WG_DEFAULT_DNS=auto` writes the AWG server tunnel address into new
client profiles. `DNS_UPSTREAM` selects the IPv4 resolver used by the proxy.

## Persistent state

```text
config/
  wg0.json             # server and client metadata, including private keys
  wg0.conf             # generated active server configuration
  clients/*.conf       # generated client exports
  routing.json         # upstream metadata and destination policies
  upstreams/*.conf     # imported upstream profiles, including private keys
```

Treat the entire directory as secret and back it up securely. `wg0.json` from
an older AWG Easy V2 installation is not silently upgraded because it lacks
the AWG 3 header-protection key and parameters. Use a fresh directory, then
recreate clients in the UI.

## Operations

```bash
./manage.sh clients
./manage.sh routing
./manage.sh logs
./manage.sh restart
./manage.sh build
./manage.sh down
./set-password.sh       # replace the UI password hash
```

`down` removes the container and Compose network but preserves `server/config`.
Changing the UI password requires a container restart.
