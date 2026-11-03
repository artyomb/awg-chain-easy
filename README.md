# AWG Chain Easy

`server` recreates the operating model of
`ghcr.io/gennadykataev/awg-easy` with AWG3, legacy AWG2, and native WireGuard
inbounds: one container runs all three userspace tunnels and an authenticated
browser UI.

It does not run the original image because that project predates the AWG 3
header-protection protocol. This local image builds on the pinned
`amneziavpn/amneziawg-go:3.1.20260828` runtime and adds the management service.
Existing AWG3 profiles continue to use their current settings; the optional
3.1 `RandomTrailers` and `DisableCookies` settings are not enabled.

## Features

- Create, enable, disable, and delete clients in the Web UI.
- Create and download AWG3, AWG2, or native WireGuard profiles and display configuration QR codes.
- Show latest handshake, endpoint, and transfer counters.
- Show the running container's AmneziaWG server image version in the Web UI.
- Import up to eight third-party AWG 3 or legacy AWG client configs as upstream
  tunnels.
- Route by domain or IPv4 CIDR to an upstream, directly to the server uplink,
  or to a fail-closed blocked destination.
- Keep each upstream in a separate interface and policy-routing table.
- Persist fixed upstream UDP ports and configure reverse initiation per server peer.
- Distinguish a running upstream interface from a recent peer handshake.
- Persist `wg0.json`, all generated server configs, keys, and exported profiles under `server/config`.
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
AWG2_PORT=51822
AWG2_CONFIG_PORT=51822
AWG2_DEFAULT_ADDRESS=10.8.4.x
AWG2_DEFAULT_DNS=auto
AWG2_JMIN=10
AWG2_JMAX=50
AWG2_S3=19
AWG2_S4=4
AWG2_I1='<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>'
NATIVE_WG_PORT=51823
NATIVE_WG_CONFIG_PORT=51823
NATIVE_WG_DEFAULT_ADDRESS=10.8.5.x
NATIVE_WG_DEFAULT_DNS=auto
WG_ALLOWED_IPS=0.0.0.0/0
WG_PERSISTENT_KEEPALIVE=25
WG_MTU=1280
PORT=51821
```

Custom server and UI ports can be selected before startup:

```dotenv
WG_PORT=41725
WG_CONFIG_PORT=41725
AWG2_PORT=41726
AWG2_CONFIG_PORT=41726
NATIVE_WG_PORT=41727
NATIVE_WG_CONFIG_PORT=41727
PORT=51821
```

After changing build inputs, run `./manage.sh up`; it rebuilds the local image
when necessary. Firewall rules must allow `WG_PORT/udp`, `AWG2_PORT/udp`, and
`NATIVE_WG_PORT/udp`.
The UI TCP port does
not need public firewall access when using loopback binding.

## Destination routing

Open the **Routing** page after signing in. The normal setup sequence is:

1. Import each provider's AWG client `.conf` under **Upstream tunnels**.
2. Create policies containing domains, IPv4 networks, or both.
3. Choose `Direct`, `Blocked`, or an imported upstream as the destination.
4. Set the default route used when no policy matches.

Lower priority numbers win. A plain domain such as `example.com` matches the
apex and its subdomains; `*.example.com` matches subdomains only. Networks use
CIDR notation, for example `203.0.113.0/24` or `198.51.100.20/32`.

Imported configs must have exactly one peer, an IPv4 interface address, the
complete AWG parameter set for their protocol version, and
`AllowedIPs = 0.0.0.0/0`. AWG 3 profiles additionally require the
header-protection key and `S3`/`S4`. Hook commands and executable `wg-quick`
directives are rejected. The upstream endpoint must be an IPv4 address or
hostname. If an enabled upstream is unavailable, its routing table contains a
`prohibit default`; matching traffic fails closed instead of escaping through
the server's normal uplink.

Imported upstream interface addresses are reserved even while the upstream is
disabled. New clients skip those addresses. Imports that reuse a server,
client, or another upstream's interface address are rejected. When chaining
servers, keep their interface addresses distinct; an existing collision must
be corrected on both ends of the affected link before it can start.

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

## Stable upstream ports and reverse initiation

Use reverse initiation when one server can reach the other but new connections
in the opposite direction are filtered. For a chain `A → B`, B can initiate
the encrypted link back to A; client traffic still exits through B.

1. On A, configure the published upstream UDP ports in `server/.env`:

   ```dotenv
   UPSTREAM_BIND_ADDRESS=0.0.0.0
   UPSTREAM_PORT_RANGE=54323-54330
   ```

   A single port such as `54323` is also supported. The range must contain
   1–8 consecutive ports, distinct from the inbound tunnel ports and DNS
   port 53. Use A's public interface address as the bind address when a
   specific host interface is required. Apply Compose changes with
   `./manage.sh up`; editing `.env` alone does not update Docker bindings.
2. On A, open **Routing → Upstream tunnels → Port** and set B's imported
   upstream to a fixed local UDP port, for example `54323`. The same field
   is available during import. Each upstream needs its own port; disabled
   upstreams retain their reservations. Changing an active port briefly
   restarts that upstream. Allow this UDP port in the host/provider firewall.
3. Confirm `docker port awg-chain-easy 54323/udp` shows A's intended host
   binding. The published host and container ports must be identical.
   The UI reports the configured range; it cannot verify Docker or provider
   firewall rules.
4. On B, open **Clients → Connection** for the existing peer belonging to A.
   Enable **Initiate connections to this peer**, set the remote endpoint to
   `A_PUBLIC_IP:54323`, and keep **Keepalive (seconds)** at `25`. Save.
   These settings are stored in `wg0.json` and regenerated into B's server
   peer configuration after restarts and client edits. Keys, addresses, and
   downloaded client profiles are preserved.
5. Verify a fresh handshake and traffic through A's upstream. If an external
   helper previously enforced these settings, retire it only after the native
   setting and live peer configuration have been verified. Otherwise that
   helper can override later changes.

Clearing **Fixed local UDP port** uses automatic allocation. During import,
a blank field preserves the profile's original `ListenPort`, if present.
Existing profiles are never silently renumbered. Imported fixed ports outside
the published range remain accepted for compatibility and appear with a
warning; publish them before relying on reverse initiation. Explicit port
edits must use the configured range. Unchecking reverse initiation stops
server-side keepalives; a previously learned live endpoint can remain until
the interface restarts. `WG_PERSISTENT_KEEPALIVE` still controls downloaded
client profiles and is separate from this server-peer setting.

### Upstream connection state

The **Interface** column reports process availability; **Connection** reports
peer handshake state. A recent handshake does not prove that client forwarding
or Internet access works. Check the actual routed traffic when diagnosing a
failure.

| Connection | Meaning |
| --- | --- |
| Connected | A recent handshake was observed. |
| Awaiting | No handshake yet; startup grace is active or local keepalive is off. |
| Idle | The last handshake is old and local keepalive is off; inactivity alone does not prove failure. |
| Stale | Keepalive is enabled but no recent handshake was observed after startup grace. |
| Unknown | Runtime peer status could not be read reliably. |
| Unavailable / Disabled | The upstream process is unavailable or the upstream is disabled. |

The recency/grace threshold is the largest of 180 seconds, the configured
maximum rekey interval plus 60 seconds, and three keepalive intervals.
Connection status is observational: it does not restart tunnels or change
routing automatically. `/api/health` continues to report service/interface
availability, independently of remote connectivity.

## Persistent state

```text
config/
  wg0.json             # server and client metadata, including private keys
  wg0.conf             # generated AWG3 server configuration
  wg2.conf             # generated AWG2 server configuration
  wg-native.conf       # generated native WireGuard server configuration
  clients/*.conf       # generated client exports
  routing.json         # upstream metadata and destination policies
  upstreams/*.conf     # imported upstream profiles, including private keys
```

Treat the entire directory as secret and back it up securely. Existing version
3 AWG Chain Easy state is migrated automatically: current clients remain AWG3,
and an independent AWG2 server identity is generated. This does not import the
unrelated state format used by upstream AWG Easy V2 installations.

Version 4 state is also upgraded automatically without rotating keys. The AWG2
interface and exported AWG2 clients receive the mobile-oriented defaults
`Jmin=10`, `Jmax=50`, `S3=19`, `S4=4`, and a DNS-shaped `I1` signature packet.

Version 5 state is upgraded automatically to version 6 without rotating AWG
keys. The upgrade creates an independent native WireGuard server identity;
existing clients keep their original protocol.

## Operations

```bash
./manage.sh clients
./manage.sh routing
./manage.sh version
./manage.sh logs
./manage.sh restart
./manage.sh build
./manage.sh down
./set-password.sh       # replace the UI password hash
```

`down` removes the container and Compose network but preserves `server/config`.
Changing the UI password requires a container restart.
The `version` command shows the configured AWG image tag alongside versions
from the locally built image. The upstream `amneziawg-go --version` banner in
the `3.1.20260828` image still reports `0.0.20250522`.

## Regression checks

Run `bash server/test/run.sh` from the repository root. It builds the image
and tests client allocation and upstream collisions through the live API in
an isolated container. Docker access and `/dev/net/tun` are required; production
state is not mounted. Pass an existing image tag as the first argument to test
that image without rebuilding it.

Run `node --test server/test/connection-settings.test.js` for port, reverse-peer,
and connection-state validation without Docker.
