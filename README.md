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
- Create, view, and download AWG3, AWG2, or native WireGuard profiles and display configuration QR codes.
- Show latest handshake, endpoint, and transfer counters.
- Show the running container's AmneziaWG server image version in the Web UI.
- Import up to eight third-party AWG 3 or legacy AWG client configs as upstream
  tunnels.
- Route by domain or IPv4 CIDR to an upstream, directly to the server uplink,
  or to a fail-closed blocked destination.
- Isolate each upstream in its own network namespace, supporting duplicate tunnel addresses.
- Persist fixed upstream UDP ports and configure reverse initiation per server peer.
- Configure priority-based failover across multiple upstreams using HTTPS checks through each tunnel.
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

For an HTTPS reverse proxy, set `WEBUI_HTTPS=true`. Login and logout cookies then
include `Secure`, and responses include HSTS. Keep it `false` for the documented
HTTP-over-SSH setup. The proxy must serve HTTPS and redirect public HTTP to HTTPS;
this setting does not add TLS to the Node listener.

If the proxy forwards client addresses, set `TRUSTED_PROXY_IPS` to its exact peer
IP addresses as seen by the container, separated by commas. Docker may present
the bridge gateway instead of host loopback. Only those peers can supply
`X-Forwarded-For`; the chain is checked from right to left through trusted peers.
Configure the proxy to overwrite or append the real client address, restrict
direct access to its backend, and never trust arbitrary client-supplied headers.
Without this setting, clients sharing a proxy also share its login limit.

Authentication permits five failed or pending attempts per client address in
five minutes. At most four login requests can read bodies or verify passwords at
once; extra requests receive 503. Verification runs asynchronously with a
five-second process deadline. Login bodies are limited to 4 KiB and ten seconds.

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

Each imported upstream runs in its own network namespace. Its tunnel address
may match a local server, client, or another upstream. Imported profiles and
existing client profiles remain unchanged. Local clients still receive unique
addresses within their own pools. The application allocates separate internal
transit subnets automatically and translates traffic across the namespace boundary.

Upstream UDP listeners remain in the main container, preserving published ports
and reverse initiation. Fixed UDP ports must still be distinct. Docker Compose
grants `SYS_ADMIN` alongside `NET_ADMIN` for namespace creation; privileged mode
is not required. New namespaces must have IPv4 forwarding enabled on the Docker
host; an upstream fails to start with a clear error when that prerequisite is missing.
Forwarding is blocked during startup and teardown until safe routing is installed.

Existing saved upstreams move into namespaces on restart without a persistent
schema change. After importing overlapping addresses, rolling back to an older
image can make those upstreams fail its former address-conflict checks.

Domain rules are implemented by the container's DNS proxy. Client UDP and TCP
port 53 traffic is redirected to it, even if an external resolver is present
in an older client profile. Resolved IPv4 addresses enter the matching policy
set for the DNS TTL, bounded by `DNS_TTL_MIN` and `DNS_TTL_MAX`.

DNS replies must match their upstream peer, transaction ID, and question. Only
IN A answers for the requested name or its CNAME chain populate routing sets;
negative and truncated replies never add addresses. TCP client queries use TCP
upstream and support fragmented and pipelined messages. Query matching follows
[RFC 5452 section 9.1](https://www.rfc-editor.org/rfc/rfc5452.html#section-9.1).

The proxy allows 256 outstanding queries overall and 16 per client IP, with a
four-second upstream deadline. TCP is limited to 128 connections overall, eight
per client, and 131,074 bytes of queued input per connection. Incomplete
frames have a five-second read deadline and idle connections close after ten
seconds. Overloaded UDP queries receive SERVFAIL; failed or overloaded TCP queries
close their connection. These bounds also apply to VPN clients.

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

## Default-route failover

In **Routing**, select and save an upstream as the **Default route**. In the
**Upstream tunnels** table, click its **Failover priority** value (or **Excluded**)
to edit it. Give at least two upstreams a priority, including the saved default,
and enable their tunnels. A blank priority excludes an upstream from failover.
Then open **Configure failover** and enable automatic failover. Check intervals,
thresholds, targets, and automatic return are shared settings. Up to eight
candidates are supported. Existing installations without failover stay disabled.
Existing priority lists migrate to each upstream’s metadata; older primary/backup
settings become priorities 10 and 20. Selection and automatic-return mode are
preserved. Destination policies keep their explicit routes and separate priorities.

Lower numbers are preferred. For example, A=10, B=20, C=20, D=30 uses A first.
If A fails, either healthy B or C is chosen at random. That choice remains in
use while it works; equal-priority recovery never triggers a switch. If both B
and C fail, healthy D takes over. This selects one exit for new default-route
connections, rather than distributing connections across the group.

| Setting | Default | Allowed values |
| --- | --- | --- |
| Failover priority (per upstream) | Excluded unless imported or already configured | 1–10000; equal values allowed; blank excludes |
| Check interval | 10 seconds | 5–300 seconds |
| Probe timeout | 5 seconds | 1–30 seconds, no longer than the interval |
| Failures before switching | 3 | 1–20 consecutive failed checks |
| Successes before recovery | 3 | 1–20 consecutive successful checks |
| Automatically return to a higher priority | Off | On or off |
| HTTPS health-check URLs | Cloudflare trace and Google connectivity check | 1–3 HTTPS URLs |

All candidates are checked concurrently. Each check probes all configured URLs
with one shared timeout; any HTTPS 2xx response passes. TLS certificates are
verified, redirects are rejected, and proxies are not used. IPv4 HTTPS and DNS
probe sockets run inside that upstream's namespace and are bound to its interface
and routing mark, so a broken tunnel cannot pass a check through the server's
normal uplink. Hostnames
use `DNS_UPSTREAM` through the tested tunnel. Select targets reachable through
all exits; failure of every target is treated as failure of the upstream.

The selected upstream remains in use during transient failures. After the
failure threshold, the selector chooses from the lowest-numbered group of
eligible candidates. A replacement must have passed its recovery checks and
its latest check must be successful and recent: no older than twice the check
interval plus the probe timeout. Stale results require a fresh recovery streak.
The health table shows each candidate's last check and last successful check.
If the selection is unusable and no replacement qualifies, new default-route
traffic is blocked instead of going directly to the Internet. Disabled or
stopped upstreams are unavailable; they must pass recovery checks after being
started again. Failed upstream processes are not automatically restarted.

With automatic return off, a working upstream stays selected until it fails or
**Use higher priority** is clicked. That button selects an eligible upstream
from the best available group with a lower number than the current selection.
Automatic return performs the same switch after recovery, including between
backup groups. Neither mode switches solely because an equal-priority candidate
recovers. On first activation, the lowest-numbered group is selected, preferring
the saved default when it belongs to that group. A persisted selection survives
service restarts; fresh checks start immediately, initially using that selection
if its interface is running.

Switches apply to **new connections**. Existing connection marks and learned DNS
sets remain intact; connections using a failed exit may need to reconnect because
the public IP changes. Changing the saved default explicitly resets the selected
upstream; while failover is enabled it must be an included candidate. Disable
failover before choosing Direct or Blocked as the default. Clear an upstream’s
failover priority before deleting it, even when failover is disabled. While
failover is enabled, edits must keep at least two candidates and include the
saved default.
Changing probe settings requires fresh recovery checks before candidates can
be chosen as replacements; a working selection continues during revalidation.
Editing priorities or automatic return keeps their health history. Priority
edits keep tunnels running and preserve learned DNS entries and connection marks.

### Portable upstream priorities

Upstream **Download** exports the imported VPN configuration with its current
priority as an optional comment:

```ini
# FailoverPriority = 20
[Interface]
# ...existing VPN settings...
```

Importing that file restores its priority. A file without this comment is excluded
from failover by default. Excluded downloads omit the comment. The app accepts one
priority comment per file; malformed, duplicate, or out-of-range values are
rejected. The VPN runtime ignores the comment.

The source of truth is `upstreams[id].failoverPriority` in `routing.json`
(`null` means excluded). Priority edits do not rewrite the original imported
profile; **Download** writes the current metadata value into the exported file
and preserves all VPN settings. Editing a comment in a stored file directly does
not update metadata. Global failover settings no longer persist a candidate list.

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

CI builds from a clean checkout, runs unit and loopback DNS tests in the built
image, initializes fresh VPN state, and starts all three VPN interfaces for the
isolated live API regression suite. Run `node --test server/test/auth.test.js
server/test/dns-proxy.test.js` for focused authentication and DNS regression tests.
The real bcrypt test requires `htpasswd` and always runs in the Docker image.

Run `bash server/test/run.sh` from the repository root. It builds the image
and tests client allocation and overlapping upstream addresses through the live API in
an isolated container. Docker access and `/dev/net/tun` are required; production
state is not mounted. Pass an existing image tag as the first argument to test
that image without rebuilding it.

Run `node --test server/test/connection-settings.test.js` for port, reverse-peer,
and connection-state validation without Docker.

Run `node --test server/test/failover.test.js` for failover validation and selection
tests. `bash server/test/run.sh [image-tag]` also tests failure/recovery, manual and
automatic return, policy/DNS-set preservation, and kernel default-route updates in
an isolated container. Probe tests use `go test server/probe/main.go
server/probe/main_test.go`; the socket-isolation test requires root with NET_ADMIN
and should run in an isolated container. The Docker build compiles the Go probe
using only the standard library and includes CA certificates for HTTPS checks.

Run `node --test server/test/upstream-network.test.js` for transit allocation and
missing-namespace checks. To exercise the production routing manager with a real
AWG3 client, two exits sharing the client's address, verified HTTPS/DNS probes,
reverse initiation, outages, rollback, and restart cleanup:

```sh
bash server/test/namespace-proof/run.sh IMAGE_TAG /tests/namespace-routing.test.js
```

This suite uses a disposable container with no external network or published
ports. Docker and host OpenSSL are required. Test profiles and certificates are
generated temporarily and removed afterward. See
[`server/test/namespace-proof/README.md`](server/test/namespace-proof/README.md)
for the original proof topology and the integration test mode.

## Image and privilege boundaries

The default AWG runtime and Go builder are pinned by digest, and WireGuard source
is pinned by commit. Existing `.env` files retain their `AWG_IMAGE` override;
copy the digest-pinned value from `.env.example` to adopt it. Review and update
these pins deliberately when upgrading. APK packages still follow the selected
Alpine repositories, so builds are not fully reproducible package snapshots.

The container uses `no-new-privileges`, but the web service still shares VPN keys
and network privileges with the tunnel manager. `NET_ADMIN` and `SYS_ADMIN` are
required by the present namespace design. Separating the web service from a
privileged networking helper requires a separate architecture change.


## Local enhancement bundle

This checkout adds an integrated Russian/English UI, per-client egress selection,
Amnezia VPN URI/QR exports, persistent statistics, and settings managed from the
browser. These changes are based on commit
`7540d91ff28fa9e184fe7c9e43367f36838c2ac3`; they do not introduce the original
three-protocol server, upstream namespaces or priority failover, which already
exist above.

### Client egress and exports

A client can use automatic destination policies/default-route failover, direct
server egress, or one explicitly selected upstream. A pinned client ignores
destination policies and shared failover; unavailable or missing upstreams fail
closed. Its UDP/TCP DNS is routed through the same upstream. Deleting an upstream
referenced by any client, including a disabled client, is rejected. Editing a
client name or egress mode preserves its keys and address; protocol changes still
require a separate client. A route change clears only that client's conntrack
entries and can interrupt its existing connections.

The config, `vpn://` and QR exports use the current server name. The Amnezia URI
wraps the same native configuration together with Amnezia metadata; its
`description` contains only the server name. Amnezia QR uses QDataStream-compatible
packets and 850-byte chunks, cycling once per second. A native `.conf` QR is also
available. Configure the format in Settings. All exports contain private
connection material and remain session-protected.

`AWG3_RANDOM_TRAILERS` and `AWG3_DISABLE_COOKIES` are initial on/off settings for new
AWG3 interfaces only. This implementation requires equal S1-S4 when
RandomTrailers is on. Existing interface parameters are not silently migrated.
The default AllowedIPs remains IPv4. Deployments needing Amnezia's client-side
split-tunneling recognition can explicitly use `0.0.0.0/0, ::/0`; this does not add
an IPv6 dataplane or establish leak-free IPv6 behavior.

### Settings and statistics

Settings contains the server name, ordered IPv4 DNS resolvers, failover probe
parameters and preferred QR format. Initial values come from ENV/defaults; after
creation, `/etc/wireguard/gui-settings.json` is authoritative. It is atomically
written and its preceding version is retained as `.bak`. The default resolver
list starts with `DNS_UPSTREAM`, followed by `8.8.8.8` and `1.0.0.1` with duplicates
removed. The proxy tries the next resolver on timeout or error; NXDOMAIN is a
valid answer. The DNS test checks response time from this server without saving
settings. **Pinned-client DNS bypasses the proxy and currently uses only the first
resolver through its pinned tunnel.**

Client traffic and saved last-handshake times persist in
`client-statistics.json`; upstream traffic persists in
`upstream-statistics.json`. Counter generations and raw baselines prevent ordinary
container/interface restarts from erasing totals or adding old samples twice.
Traffic is cumulative bytes, not speed or a delivery/online guarantee. RX/TX are
relative to the server. Client Online means a runtime handshake less than five
minutes old, not a continuous end-to-end health check.

Reset all or reset one row through a themed confirmation. Client reset clears
traffic plus saved handshake; upstream reset clears traffic only. Other rows,
keys, routes and active tunnels are preserved. New activity starts accumulating
immediately. A `.before-reset-<timestamp>` file is retained beside the statistics;
there is currently no automatic retention policy for these reset backups.

The global routing-policy switch bypasses destination policies without deleting
them or changing individual flags. Disabled rows are visually muted except for
status and controls; editing, individual toggling and deletion remain available
even while global policy application is off. New/import/edit forms use modal
windows. The language choice is stored in browser localStorage. About displays
the base version/commit, local build and AmneziaWG runtime; build metadata resides
in `server/app/build-info.json` and must be updated as part of release preparation.

### Additional verification

The workflow includes export, QR packet, settings, source-routing, statistics and
individual-reset unit tests, plus isolated enhancement API suites. For a local
Linux Docker run, build `awg-chain-easy:review` from `server/` and use the commands
in `.github/workflows/test.yml`, replacing its image tag as needed. API suites need
`NET_ADMIN`, `SYS_ADMIN`, `/dev/net/tun` and the documented IPv4 sysctls, and must
run in separate disposable containers with `--network none` and no production
config volume. A scan of the QR in every Amnezia application/version is outside
this automated matrix.

Known review items include the upstream keepalive-range parser (a range such as
`25-35` is still passed through the single-port parser when reading stats),
IPv4-only routing, the first-resolver-only pinned DNS path, local topology wording
in translations, and the absence of a broad filesystem/network transaction
across all configuration mutations.
