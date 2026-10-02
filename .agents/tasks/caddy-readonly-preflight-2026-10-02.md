# Caddy READ-ONLY preflight — production Contabo server

Date: 2026-10-02 (server local time ~08:00 CEST)
Server: SSH alias `contabo-opterite` / `213.136.89.187` / hostname `vmi3195139`, logged in as `root`
Docker Engine `29.8.0`, Docker Compose `v5.5.1`

## Nothing was modified.

Every command below is observational. No file on the server was created, edited or deleted. No container was started, stopped, restarted, recreated or removed. No `docker compose up/down/restart/pull/build` was run. No `caddy reload` and no `caddy validate`. No `docker network connect/disconnect`. No write to the Caddy admin API — only `GET /config/`. Nothing was deployed and `/opt/opterite` was not touched (it does not exist). The only file written is this report, on the local Windows workspace.

---

## VERIFICATION LOG — every command executed

All remote commands were invoked from Windows PowerShell as `ssh contabo-opterite "<command>"`.

| # | Command | Class |
|---|---------|-------|
| 1 | `hostname; whoami; uptime` | read |
| 2 | `ls -la /opt/bulk-email-docker/` | read |
| 3 | `stat /opt/bulk-email-docker/Caddyfile` | read |
| 4 | `ls -la /opt` | read |
| 5 | `cat /opt/bulk-email-docker/docker-compose.prod.yml` | read |
| 6 | `cat /opt/bulk-email-docker/Caddyfile` | read |
| 7 | `docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'` | read |
| 8 | `docker ps -a -q \| wc -l` | read |
| 9 | `docker version --format '{{.Server.Version}}'` | read |
| 10 | `docker compose version` | read |
| 11 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .Config}}'` | read |
| 12 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .Mounts}}'` | read |
| 13 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .HostConfig.RestartPolicy}}'` | read |
| 14 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .HostConfig.PortBindings}}'` | read |
| 15 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .State}}'` | read |
| 16 | `docker inspect bulk-email-sender-caddy-1 --format '{{.Image}}'` | read |
| 17 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .HostConfig.Binds}}'` | read |
| 18 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .Config.Healthcheck}}'` | read |
| 19 | `docker images --digests caddy` | read |
| 20 | `docker inspect caddy:2-alpine --format '{{.Id}} ... {{json .RepoDigests}}'` | read |
| 21 | `docker inspect 5f5c8640aae0 --format '...'` | read |
| 22 | `docker inspect bulk-email-sender-caddy-1 --format '{{json .NetworkSettings.Networks}}'` | read |
| 23 | `docker inspect bulk-email-sender-caddy-1 --format '{{.HostConfig.NetworkMode}}'` | read |
| 24 | `docker network ls` | read |
| 25 | `docker network inspect bulk-email-sender_default` | read |
| 26 | `docker inspect $(docker ps -aq) --format '<service> <name> <config-hash>'` | read |
| 27 | `docker volume ls` | read |
| 28 | `docker volume inspect bulk-email-sender_caddy-data bulk-email-sender_caddy-config bulk-email-sender_caddy-logs` | read |
| 29 | `docker exec bulk-email-sender-caddy-1 sh -c 'caddy version; command -v curl; command -v wget'` | read (version print only) |
| 30 | `docker exec bulk-email-sender-caddy-1 curl -s -X GET http://127.0.0.1:2019/config/` | read (HTTP GET) |
| 31 | `docker exec bulk-email-sender-caddy-1 ls -la /data/caddy` | read |
| 32 | `docker exec bulk-email-sender-caddy-1 find /data/caddy/certificates -maxdepth 3` | read |
| 33 | `docker exec bulk-email-sender-caddy-1 find /data/caddy/acme -maxdepth 4` | read |
| 34 | `docker exec bulk-email-sender-caddy-1 ls -la /config/caddy` | read |
| 35 | `docker exec bulk-email-sender-caddy-1 ls -la /srv` | read |
| 36 | `cd /opt/bulk-email-docker && docker compose -f docker-compose.prod.yml config --services` | parse only, applies nothing |
| 37 | `cd /opt/bulk-email-docker && docker compose -f docker-compose.prod.yml config \| sed -n '/^networks:/,/^[a-z]/p'` | parse only |
| 38 | `cd /opt/bulk-email-docker && docker compose -f docker-compose.prod.yml config \| sed -n '/^  caddy:/,/^  [a-z]/p'` | parse only |
| 39 | `ls -la /opt/opterite` (→ No such file or directory) | read |
| 40 | `ls -la /srv` (host) | read |
| 41 | `ss -tlnp \| head -30` | read |
| 42 | `grep -E '^(SITE_ADDRESS\|ACME_EMAIL)=' /opt/bulk-email-docker/.env` | read, two keys only |
| 43 | `grep -n 'networks' /opt/bulk-email-docker/docker-compose.prod.yml` | read |
| 44 | `grep -nE 'import\|file_server\|root \|handle\|:80\|respond' /opt/bulk-email-docker/Caddyfile` | read |
| 45 | `dig +short A/NS/SOA opterite.in`, `dig +short A www.opterite.in`, `dig +short A opterite.com`, `dig +short A www.opterite.com` | read |
| 46 | `dig +short @8.8.8.8 / @1.1.1.1 / @ns71.domaincontrol.com A opterite.in`, `dig +short @8.8.8.8 CAA opterite.in` | read |
| 47 | `openssl x509 -in /var/lib/docker/volumes/bulk-email-sender_caddy-data/_data/caddy/certificates/.../opterite.com.crt -noout -subject -dates -issuer` (and the `www` cert) | read |

`docker compose config` is a pure parser: it reads the YAML, interpolates `.env`, and prints the normalised result to stdout. It does not contact the Docker daemon to create or change anything.

Four commands failed on PowerShell→bash quote mangling and were re-run with corrected quoting. The failures produced `template parsing error` / `syntax error` and executed nothing.

---

## SUMMARY — answer first

1. **The prior report's findings are confirmed with one significant drift: `opterite.in` now resolves.** The apex `opterite.in` and `www.opterite.in` (CNAME → apex) both answer `213.136.89.187` from the authoritative GoDaddy nameservers and from both `8.8.8.8` and `1.1.1.1`. The SOA serial is `2026100201`, i.e. the zone was edited today. There are **no CAA records**, so nothing blocks Let's Encrypt. The DNS blocker from the earlier report is cleared. Everything else — container name, image, mounts, single network, Caddyfile content, admin API, no catch-all — matches exactly.

2. **Caddy needs no recreation to serve a new site.** The Caddyfile is a host bind mount (`/opt/bulk-email-docker/Caddyfile` → `/etc/caddy/Caddyfile`, `ro` inside the container, `-rw-rw-rw-` on the host). Content edits are visible to the container instantly; they take effect with a reload signal, not a recreation.

3. **Caddy *does* need recreation for either of the two things the question asked about:** an additional Docker network membership expressed in compose, or a new bind mount such as `/opt/opterite/site:/srv/opterite:ro`. Docker fixes mounts at container creation; there is no live mount API. A compose-declared network change alters the caddy service definition, which changes its `com.docker.compose.config-hash` and forces a recreate.

4. **Both can be avoided entirely.** Put Opterite's edge container on the existing `bulk-email-sender_default` network (declared `external: true` from Opterite's own compose project), serve Opterite's static files from that container rather than from a Caddy bind mount, and reverse-proxy to it by container name. Zero new host ports, zero new Caddy mounts, zero Caddy recreation, zero downtime. This is the recommended path.

5. **One live trap, now with an exact mechanism.** The Caddyfile's `dynamic a { name web; port 3000; refresh 10s }` is confirmed present in both the file and the running config. Docker Compose assigns every service a network alias equal to its *service name*. So an Opterite compose service literally named `web` joining the shared network would publish the alias `web` there, and Caddy would start load-balancing `opterite.com` production traffic into Opterite within 10 seconds. The same hazard applies to `redis`: bulk-email's `web`/`worker` use `REDIS_URL=redis://redis:6379`, so an Opterite service named `redis` on the shared network would steal a share of the production Bull queue.

6. **No catch-all exists** in the running config — verified via `GET 127.0.0.1:2019/config/`. The only HTTP route matches hosts `opterite.com` and `www.opterite.com` and is `terminal: true`. A new site block cannot be shadowed by, nor shadow, the existing one.

---

## A. Current Caddy container configuration

### Identity and state

| Property | Observed value |
|---|---|
| Container name | `bulk-email-sender-caddy-1` |
| Container ID / hostname | `6057a8976c03d5e367eb3d87c4d38aba7286fb2dcbe687eb15daaa7d23779c89` / `6057a8976c03` |
| Image (tag) | `caddy:2-alpine` |
| Image ID | `sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` |
| Repo digest | `caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` |
| Image created | `2026-06-22T20:09:05Z` (≈3 months old), 88.7 MB |
| Caddy version | `v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=` (from `caddy version` inside the container; also `CADDY_VERSION=v2.11.4` env and the `org.opencontainers.image.version` label) |
| Status | `running`, PID 1658, `ExitCode: 0`, not restarting, not OOM-killed |
| StartedAt | `2026-09-21T14:23:31.627Z` — `docker ps` shows `Up 10 days` |
| Restart policy | `{"Name":"unless-stopped","MaximumRetryCount":0}` |
| Healthcheck | `null` — **the caddy container has no healthcheck** |
| WorkingDir | `/srv` (empty inside the container) |

### Command / entrypoint

`Entrypoint` is `null`. `Cmd` is the image default, carried on the container:

```json
["caddy","run","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"]
```

### Ports — published vs merely exposed

`docker ps` PORTS column:

```
0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp, 443/udp, 2019/tcp
```

`HostConfig.PortBindings` — the authoritative list of what is actually published:

```json
{"443/tcp":[{"HostIp":"","HostPort":"443"}],"80/tcp":[{"HostIp":"","HostPort":"80"}]}
```

`Config.ExposedPorts` — image/`EXPOSE` metadata only:

```json
{"2019/tcp":{},"443/tcp":{},"443/udp":{},"80/tcp":{}}
```

So **80/tcp and 443/tcp are published to all host interfaces** (IPv4 + IPv6, `HostIp: ""`), while **443/udp (HTTP/3) and 2019/tcp (admin API) are EXPOSE-only and are not reachable from the host or the internet.** Confirmed on the host:

```
LISTEN 0 4096   0.0.0.0:80    users:(("docker-proxy",pid=2061,fd=8))
LISTEN 0 4096   0.0.0.0:443   users:(("docker-proxy",pid=2096,fd=8))
LISTEN 0 4096      [::]:80    users:(("docker-proxy",pid=2073,fd=8))
LISTEN 0 4096      [::]:443   users:(("docker-proxy",pid=2104,fd=8))
```

No host listener on `:2019`. Also listening on the host, unrelated to Caddy: `sshd` on `:22`, `mongod` on `127.0.0.1:27017`, `systemd-resolved` on `:53`, `code-07f806f999` on `127.0.0.1:36269`, a `MainThread` process on `127.0.0.1:40621`.

### Environment variables on the container

```
SITE_ADDRESS=opterite.com, www.opterite.com
ACME_EMAIL=n********@gmail.com          ← local part redacted; domain is gmail.com
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CADDY_VERSION=v2.11.4
XDG_CONFIG_HOME=/config
XDG_DATA_HOME=/data
```

Both app-level values come from `/opt/bulk-email-docker/.env` (read with a two-key grep, not a full `cat`):

```
SITE_ADDRESS=opterite.com, www.opterite.com
ACME_EMAIL=n********@gmail.com
```

`XDG_CONFIG_HOME=/config` and `XDG_DATA_HOME=/data` are why the autosaved config and the certificate store land on the two named volumes.

### Labels

```
com.docker.compose.config-hash           = 8238ae9c176d8ffff4261c6d5dfdcca95e3edc1842d9d0fba87378febfd40ae9
com.docker.compose.container-number      = 1
com.docker.compose.depends_on            = web:service_started:false
com.docker.compose.image                 = sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a
com.docker.compose.oneoff                = False
com.docker.compose.project               = bulk-email-sender
com.docker.compose.project.config_files  = /opt/bulk-email-docker/docker-compose.prod.yml
com.docker.compose.project.working_dir   = /opt/bulk-email-docker
com.docker.compose.service               = caddy
com.docker.compose.version               = 5.5.1
org.opencontainers.image.version         = v2.11.4
org.opencontainers.image.title           = Caddy
org.opencontainers.image.vendor          = Light Code Labs
org.opencontainers.image.source          = https://github.com/caddyserver/caddy-docker
(plus description, documentation, licenses, url)
```

**Noted discrepancy, unresolved:** the `com.docker.compose.image` label records `sha256:98eb57d8…` while the container's actual `.Image` is `sha256:5f5c8640…`, which is also what `caddy:2-alpine` resolves to today and also what `RepoDigests` reports. These are different digest namespaces (image config ID vs registry manifest digest), and the local `RepoDigests` value coinciding with the image ID is itself unusual. I could not verify which of the two Compose compares when deciding whether an image changed, because doing so would require running `docker compose up --dry-run`, which is outside the allowed command set. Treat this as a small unknown: if Compose keys off the label, a future `docker compose up -d` might consider the caddy image changed and recreate it even with no file edits. This is worth a dry-run check at deploy time, under the operator's eye.

### Compose service definition, verbatim from `/opt/bulk-email-docker/docker-compose.prod.yml`

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      # Set these in .env, e.g.
      #   SITE_ADDRESS=opterite.com, www.opterite.com
      #   ACME_EMAIL=you@example.com
      # Compose reads .env from the project directory for this interpolation.
      SITE_ADDRESS: ${SITE_ADDRESS:?set SITE_ADDRESS in .env, e.g. opterite.com}
      ACME_EMAIL: ${ACME_EMAIL:-}
    # Caddy writes certs to a volume and reloads config without a restart:
    #   docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      # caddy-data holds the issued certificates and ACME account key. Losing it
      # means re-issuing certs and burning Let's Encrypt rate limit.
      - caddy-data:/data
      - caddy-config:/config
      - caddy-logs:/var/log/caddy
    depends_on:
      - web
    logging: *logging
```

The file declares `name: bulk-email-sender` at the top. Services are `web` (4 replicas), `worker` (8 replicas), `redis`, `caddy` — confirmed by `docker compose config --services`. Top-level `volumes:` declares `uploads, logs, redis-data, caddy-data, caddy-config, caddy-logs`. The file is mode `-rwxr-xr-x`, last modified Sep 30 09:00, and a backup `docker-compose.prod.yml.bak-20260930-085901` sits beside it — both confirmed.

### Live Caddyfile, verbatim

```
# Reverse proxy / TLS terminator for Opterite.
#
# Caddy obtains and renews Let's Encrypt certificates automatically, which
# replaces the host certbot setup app.js still probes for
# (/var/www/certbot/.well-known/acme-challenge). Nothing needs to be mounted
# there any more: Caddy answers the ACME challenge itself on :80.
#
# SITE_ADDRESS comes from .env via docker-compose.prod.yml. Multiple hostnames
# are comma-separated and both get certificates:
#   production → opterite.com, www.opterite.com   (HTTP auto-redirects to HTTPS)
#   local test → :80                              (plain HTTP, no ACME)
{
	email {$ACME_EMAIL}
}
{$SITE_ADDRESS} {
	request_body {
		max_size 30MB
	}
	reverse_proxy {
		dynamic a {
			name web
			port 3000
			refresh 10s
		}
		lb_policy least_conn
		fail_duration 10s
		max_fails 2
		lb_retries 2
		lb_try_duration 5s
	}
	log {
		output file /var/log/caddy/access.log {
			roll_size 20MB
			roll_keep 5
		}
	}
}
```

(Comments inside the site block are preserved in the file; elided above only where they repeat the prose. `stat` reports size 1849 bytes, mode `0666/-rw-rw-rw-`, uid/gid 0, Modify `2026-09-18 10:10:04`, Change `2026-09-28 17:32:27`.)

A targeted grep for `import`, `file_server`, `root `, `handle`, `respond` found **no matches outside comments**. There is exactly one global block, exactly one site block, no imports, no static-file serving, and no catch-all.

### Running config as Caddy actually loaded it

From `GET http://127.0.0.1:2019/config/` executed inside the container (read-only):

```json
{
  "apps": {
    "http": { "servers": { "srv0": {
      "listen": [":443"],
      "logs": { "logger_names": { "opterite.com": ["log0"], "www.opterite.com": ["log0"] } },
      "routes": [{
        "match": [{ "host": ["opterite.com", "www.opterite.com"] }],
        "terminal": true,
        "handle": [{ "handler": "subroute", "routes": [{ "handle": [
          { "handler": "request_body", "max_size": 30000000 },
          { "handler": "reverse_proxy",
            "dynamic_upstreams": { "source": "a", "name": "web", "port": "3000", "refresh": 10000000000 },
            "health_checks": { "passive": { "fail_duration": 10000000000, "max_fails": 2 } },
            "load_balancing": { "retries": 2, "try_duration": 5000000000,
                                "selection_policy": { "policy": "least_conn" } } }
        ]}]}]
      }]
    }}},
    "tls": { "automation": { "policies": [{
      "subjects": ["opterite.com", "www.opterite.com"],
      "issuers": [
        { "module": "acme", "email": "n********@gmail.com" },
        { "module": "acme", "email": "n********@gmail.com", "ca": "https://acme.zerossl.com/v2/DV90" }
      ]
    }]}}
  },
  "logging": { "logs": {
    "default": { "exclude": ["http.log.access.log0"] },
    "log0": { "include": ["http.log.access.log0"],
              "writer": { "output": "file", "filename": "/var/log/caddy/access.log",
                          "roll_size_mb": 20, "roll_keep": 5 } } } }
}
```

Three things to read off this:

- **There is exactly one server, `srv0`, listening on `:443`, with exactly one route.** That route is host-matched to the two `.com` names and `terminal: true`. **No catch-all site block exists.**
- **No `:80` server appears in the stored config.** That is expected: Caddy's automatic-HTTPS feature synthesises the HTTP→HTTPS redirect server at provision time rather than materialising it in the config JSON. Port 80 is still served (it is published and bound by docker-proxy) and is what answers ACME HTTP-01 challenges.
- **The TLS automation policy has explicit `subjects`.** Caddy will only manage certificates for those two names. There is no on-demand TLS. A TLS handshake for `opterite.in` today would find no certificate and no policy, so it fails at the handshake — which is also why adding the site block is the step that triggers issuance.

`/config/caddy/autosave.json` is dated `Sep 21 14:23`, matching `StartedAt`. **No reload has occurred since the container started**, so the file on disk and the running config are in sync.

---

## B. Current Caddy networks

### Attachments

Caddy is on **exactly one network**. `HostConfig.NetworkMode` is `bulk-email-sender_default`, and `NetworkSettings.Networks` has a single entry:

```json
{"bulk-email-sender_default":{
  "NetworkID":"057e2cbbb5dab89a269bc6aed1b79a0dfdb82c7d0d4232bd571adf10ebe4907c",
  "EndpointID":"5a93031d1bd7320af077491f05327a337e771e13c73a5e626cb267406544a245",
  "Gateway":"172.19.0.1","IPAddress":"172.19.0.12","IPPrefixLen":16,
  "MacAddress":"aa:9d:e8:68:a2:f9",
  "Aliases":["bulk-email-sender-caddy-1","caddy"],
  "DNSNames":["bulk-email-sender-caddy-1","caddy","6057a8976c03"],
  "IPAMConfig":null,"Links":null,"DriverOpts":null,"GwPriority":0,
  "IPv6Gateway":"","GlobalIPv6Address":"","GlobalIPv6PrefixLen":0
}}
```

### `docker network ls`

```
NETWORK ID     NAME                        DRIVER    SCOPE
de92460d1941   bridge                      bridge    local
057e2cbbb5da   bulk-email-sender_default   bridge    local
f3213a9ff988   host                        host      local
45b8d5f6aacb   none                        null      local
```

Only the one project network exists. There is no pre-existing `opterite`-anything network.

### `docker network inspect bulk-email-sender_default`

| Property | Value |
|---|---|
| Name / Id | `bulk-email-sender_default` / `057e2cbbb5dab89a269bc6aed1b79a0dfdb82c7d0d4232bd571adf10ebe4907c` |
| Created | `2026-09-15T15:01:42.410989818+02:00` |
| Driver / Scope | `bridge` / `local` |
| Subnet / Gateway | `172.19.0.0/16` / `172.19.0.1` |
| `Internal` | **`false`** |
| `Attachable` | **`false`** |
| `EnableIPv4` / `EnableIPv6` | `true` / **`false`** |
| `Ingress` / `ConfigOnly` | `false` / `false` |
| `Options` | `{}` (empty) |
| IPAM in use | 17 IPs in use, 65519 dynamic available |

Labels — these are what mark it compose-managed:

```
com.docker.compose.config-hash = c247e3ad18fa85ba5c96edd4ff9ba4ad0ea847512131e508b75413b5883f1246
com.docker.compose.network     = default
com.docker.compose.project     = bulk-email-sender
com.docker.compose.version     = 5.5.1
```

`com.docker.compose.network=default` plus `com.docker.compose.project=bulk-email-sender` confirms this is the **implicit default network created and owned by the `bulk-email-sender` compose project**. It is not user-managed and not external.

`Attachable: false` matters and is often misread: `attachable` governs whether *Swarm* overlay networks accept standalone containers. For a local `bridge` network it places no restriction on `docker network connect` — see D1.

All 14 attached containers:

| Container | IP |
|---|---|
| `bulk-email-sender-worker-2` | 172.19.0.2 |
| `bulk-email-sender-worker-5` | 172.19.0.3 |
| `bulk-email-sender-web-2` | 172.19.0.4 |
| `bulk-email-sender-web-4` | 172.19.0.5 |
| `bulk-email-sender-worker-8` | 172.19.0.6 |
| `bulk-email-sender-redis-1` | 172.19.0.7 |
| `bulk-email-sender-worker-6` | 172.19.0.8 |
| `bulk-email-sender-web-3` | 172.19.0.9 |
| `bulk-email-sender-web-1` | 172.19.0.10 |
| `bulk-email-sender-worker-4` | 172.19.0.11 |
| **`bulk-email-sender-caddy-1`** | **172.19.0.12** |
| `bulk-email-sender-worker-1` | 172.19.0.13 |
| `bulk-email-sender-worker-3` | 172.19.0.14 |
| `bulk-email-sender-worker-7` | 172.19.0.15 |

`docker ps -a -q | wc -l` = **14**, so there are no stopped or orphaned containers anywhere on the host — the project is exactly these 14.

### Resolved compose view of the network — important for D4

`docker compose config` normalises the implicit default and prints it explicitly:

```yaml
networks:
  default:
    name: bulk-email-sender_default
```

and on the caddy service:

```yaml
    networks:
      default: null
```

Meanwhile `grep -n 'networks' docker-compose.prod.yml` returns **`NO networks KEY ANYWHERE`**. So the YAML on disk declares no networks at all; Compose synthesises the `default` network with the project-prefixed name. This matters because it means the on-disk file and the resolved model already agree about the network's name.

---

## C. Current Caddy volumes

Four mounts, from `.Mounts`:

| # | Type | Source | Destination | RW | Mode | Propagation |
|---|---|---|---|---|---|---|
| 1 | `volume` | `bulk-email-sender_caddy-config` → `/var/lib/docker/volumes/bulk-email-sender_caddy-config/_data` | `/config` | `true` | `rw` | `""` |
| 2 | `volume` | `bulk-email-sender_caddy-data` → `/var/lib/docker/volumes/bulk-email-sender_caddy-data/_data` | `/data` | `true` | `rw` | `""` |
| 3 | **`bind`** | **`/opt/bulk-email-docker/Caddyfile`** | **`/etc/caddy/Caddyfile`** | **`false`** | **`ro`** | **`rprivate`** |
| 4 | `volume` | `bulk-email-sender_caddy-logs` → `/var/lib/docker/volumes/bulk-email-sender_caddy-logs/_data` | `/var/log/caddy` | `true` | `rw` | `""` |

`HostConfig.Binds` — the creation-time spec, note the fixed order and the explicit `:ro`:

```json
["bulk-email-sender_caddy-data:/data:rw",
 "bulk-email-sender_caddy-config:/config:rw",
 "bulk-email-sender_caddy-logs:/var/log/caddy:rw",
 "/opt/bulk-email-docker/Caddyfile:/etc/caddy/Caddyfile:ro"]
```

`Config.Volumes` is `null` — no anonymous image volumes.

### `docker volume inspect`

All three are `local` driver, created `2026-09-15T15:01:42+02:00`, `Options: null`, `Scope: local`, and carry compose ownership labels:

```
bulk-email-sender_caddy-data
  Mountpoint: /var/lib/docker/volumes/bulk-email-sender_caddy-data/_data
  Labels: com.docker.compose.project=bulk-email-sender
          com.docker.compose.volume=caddy-data
          com.docker.compose.version=5.5.1
          com.docker.compose.config-hash=2dd5325a0a6414509b05281a22d667d3178c83e829a845aeec0595ac3095d807

bulk-email-sender_caddy-config
  Mountpoint: /var/lib/docker/volumes/bulk-email-sender_caddy-config/_data
  Labels: ... com.docker.compose.volume=caddy-config
          com.docker.compose.config-hash=7a472cbfbf890c9c68270c90d4a86be1e0ef862dcd801570a4ae5b8a6586b26b

bulk-email-sender_caddy-logs
  Mountpoint: /var/lib/docker/volumes/bulk-email-sender_caddy-logs/_data
  Labels: ... com.docker.compose.volume=caddy-logs
          com.docker.compose.config-hash=4392e9472f20b19dbfc0e826eb60c0e698ecc1c4cf5f80f614361bc43b2371c0
```

`docker volume ls` shows six volumes total, all compose-owned by this project: the three caddy ones plus `bulk-email-sender_logs`, `bulk-email-sender_redis-data`, `bulk-email-sender_uploads`.

### ⚠️ `bulk-email-sender_caddy-data` carries the TLS certificates AND the ACME account key — MUST NOT BE DELETED

Verified contents (`/data` inside the container, `XDG_DATA_HOME=/data`):

```
/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/opterite.com/
    opterite.com.crt   opterite.com.key   opterite.com.json
/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/www.opterite.com/
    www.opterite.com.crt   www.opterite.com.key   www.opterite.com.json
/data/caddy/acme/acme-v02.api.letsencrypt.org-directory/users/n********@gmail.com/
    nihalbalki.json    ← ACME account registration
    nihalbalki.key     ← ACME ACCOUNT PRIVATE KEY
/data/caddy/acme/acme-v02.api.letsencrypt.org-directory/challenge_tokens
/data/caddy/instance.uuid
/data/caddy/last_clean.json   (Sep 30 14:23)
/data/caddy/locks             (Oct  2 05:23 — recent lock activity, normal)
```

Certificate validity, read from the host-side mountpoint:

```
subject=CN = opterite.com
notBefore=Sep 15 12:03:30 2026 GMT
notAfter =Dec 14 12:03:29 2026 GMT
issuer   =C = US, O = Let's Encrypt, CN = YE1

subject=CN = www.opterite.com
notBefore=Sep 15 12:03:29 2026 GMT
notAfter =Dec 14 12:03:28 2026 GMT
```

Both certs are live and have ~73 days left. Deleting or recreating `bulk-email-sender_caddy-data` would force re-issuance of both certificates *and* registration of a new ACME account, consuming Let's Encrypt rate limit and causing a TLS outage in the gap. **Never run `docker compose down -v` on this project. `down` without `-v` is survivable; `-v` is not.**

`bulk-email-sender_caddy-config` holds only `/config/caddy/autosave.json` (1058 bytes, Sep 21 14:23) — Caddy's autosaved last-loaded config. Losing it is harmless; Caddy rebuilds it from the Caddyfile.

`bulk-email-sender_caddy-logs` holds the rolled access log. Non-critical.

`/srv` inside the container is **empty** (`drwxr-xr-x 2 root root`, Jun 21 18:51 — image default), and it is the container's `WorkingDir`. Nothing currently mounts there, so `/srv/opterite` would be a new mount point.

---

## D. Does the proposed Opterite integration require Caddy recreation?

### D1. Can the running Caddy container be connected to an ADDITIONAL Docker network WITHOUT recreating it?

**Yes — `docker network connect` works on a running container with no restart, but the attachment is not durable, and for this project it is the wrong tool.**

Mechanics, point by point:

- **Does it require a restart?** No. `docker network connect <net> <container>` is a live operation: the daemon creates a new endpoint, injects a `veth` pair into the container's existing network namespace, and registers the container in the network's embedded DNS. The container's processes keep running; Caddy would not notice beyond a new interface appearing. The container does not even need to be stopped, and `Attachable: false` on `bulk-email-sender_default` does not block it — `attachable` only governs standalone-container access to *Swarm overlay* networks, and this is a local bridge network.
- **Is the attachment recorded in the container's config?** Yes. A live connect writes a new entry into the container's `NetworkSettings.Networks` *and* into its persisted `HostConfig`/endpoint settings in `/var/lib/docker/containers/<id>/`. That is why it survives a plain `docker restart` / `docker stop && docker start` — the endpoint is re-created from the stored spec.
- **Does it survive container recreation?** **No.** It is bound to the container ID. `docker compose up -d` that recreates the service, or any `docker rm` + create, produces a new container whose network set comes solely from the compose model. The manual attachment is silently lost.
- **What happens when compose later reconciles the service?** This is the real hazard. Compose's reconciliation compares the live container against the compose model. A network attached out-of-band is not in the model, so depending on the compose version and code path it either (a) is ignored until the next recreation and then dropped, or (b) is actively treated as drift and disconnected. Either way the manual attachment is not something Compose will preserve or defend. I did not verify which behaviour v5.5.1 picks — doing so would require mutating the system.
- **Verdict for this deployment:** a live `docker network connect` is technically zero-downtime, but it creates undeclared state that the next routine deploy erases, and the failure mode is a silent 502 on `opterite.in` at some later unrelated deploy. **Do not use it.** The recommended design (section E) inverts the direction — Opterite's containers join the *existing* network, so Caddy's own network set never changes and nothing is undeclared.

### D2. Exactly how is the Caddyfile mounted, and does changing its CONTENT require recreation?

**It is a single-file host bind mount, and content changes require NO recreation and NO restart — only a config reload signal.**

Confirmed facts:

- Host path: `/opt/bulk-email-docker/Caddyfile`
- Container path: `/etc/caddy/Caddyfile`
- Compose source: `./Caddyfile:/etc/caddy/Caddyfile:ro`, resolved by compose to an absolute `type: bind, source: /opt/bulk-email-docker/Caddyfile, target: /etc/caddy/Caddyfile, read_only: true`
- Live mount: `{"Type":"bind","Source":"/opt/bulk-email-docker/Caddyfile","Destination":"/etc/caddy/Caddyfile","Mode":"ro","RW":false,"Propagation":"rprivate"}`
- Host-side permissions: `0666/-rw-rw-rw-`, uid 0 / gid 0, size 1849 bytes

**The `ro` flag constrains the container, not the host.** `RW: false` means processes inside the Caddy container cannot write `/etc/caddy/Caddyfile`. On the host the file is `-rw-rw-rw-` and root can edit it freely. There is no lock, no copy: the bind mount makes the container see the same inode, so an edit on the host is visible inside the container the instant it is written.

One important subtlety for a **single-file** bind mount: Docker binds the *inode*, not the directory entry. An editor that writes in place (`cat > file`, `sed -i` with the right flags off, `vim` with `backupcopy=yes`) keeps the inode and the container keeps seeing the file. An editor that writes a temp file and renames over the target **replaces the inode**, and the container would keep seeing the old, now-unlinked file forever. `stat` shows `Change: 2026-09-28 17:32:27` with `Birth: 2026-09-28 17:32:27` and `Links: 1` — the Birth timestamp being later than `Modify` (Sep 18) indicates the file *was* replaced by a new inode on Sep 28, after the container started on Sep 21. **This means the container may currently be holding the pre-Sep-28 inode.** The running config matches the current file's content (same two hostnames, same `dynamic a`, same 30MB body limit), so no behavioural divergence is observable — but any future edit must be done in place, and the safe check before reloading is `docker exec bulk-email-sender-caddy-1 cat /etc/caddy/Caddyfile` compared against the host file. I am flagging this as a verified-but-unquantified risk; I did not attempt to compare inode numbers across the mount boundary.

**Applying a content change is a reload, not a recreation.** The compose file documents the exact command in a comment on the caddy service:

```
docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

This is the command that **WOULD** be used later. **It was NOT run.** `caddy reload` POSTs the newly adapted config to the admin API on `127.0.0.1:2019` inside the container. Caddy then performs a graceful config swap: it provisions the new config, starts new listeners/handlers, and drains the old ones. Existing connections are not cut and the listening sockets on `:80`/`:443` are never closed, so it is genuinely zero-downtime. The admin API is confirmed reachable inside the container (the `GET /config/` above succeeded) and `curl` and `wget` are both present in the image, so the reload path is live and ready.

### D3. Would adding `/opt/opterite/site:/srv/opterite:ro` require recreating the Caddy container?

**Yes. Definitively and unavoidably.**

Docker fixes a container's mount table at creation time. The mounts are part of the `HostConfig` passed to `POST /containers/create`, they are realised as the container's mount namespace when the container starts, and **there is no Docker API to add or remove a mount on a running container.** No `docker mount` command exists; `docker update` cannot change `Binds` or `Mounts`. Adding `/opt/opterite/site:/srv/opterite:ro` therefore means: stop the container, remove it, create a new one with the extra bind, start it. Via compose that is `docker compose up -d caddy` after editing the service's `volumes:` list, and compose will detect the changed service definition and recreate.

(The theoretical escape hatches — `nsenter` into the container's mount namespace, or a bind-mount-propagating parent directory — are not viable here. The existing mounts use `Propagation: rprivate`, and `/srv` has no shared-subtree parent mount, so a host-side mount under a mounted directory would not propagate in. Attempting it would also leave state Docker does not know about.)

**Current state of the proposed source paths — neither exists:**

```
$ ls -la /opt
total 20
drwxr-xr-x  5 root   root   4096 Sep 15 14:44 .
drwxr-xr-x 23 root   root   4096 Sep 12 12:01 ..
drwxr-xr-x 10 root   root   4096 Sep 30 09:01 bulk-email-docker
drwxr-xr-x 13 ubuntu ubuntu 4096 Sep 15 12:17 bulk-email-sender
drwx--x--x  4 root   root   4096 Sep  4 21:31 containerd

$ ls -la /opt/opterite
ls: cannot access '/opt/opterite': No such file or directory
```

So `/opt/opterite` does not exist, and therefore neither does `/opt/opterite/site`. The host `/srv` also exists but is empty (`drwxr-xr-x 2 root root 4096 Mar 21 2026`).

**The Docker auto-create behaviour this makes relevant:** when a bind-mount source path does not exist at container-create time, the Docker daemon creates it as an **empty directory owned by `root:root` with mode 0755** rather than failing. The consequence is a specific and confusing failure: if the caddy service were given `/opt/opterite/site:/srv/opterite:ro` before the site content was staged, `docker compose up -d caddy` would succeed, Docker would silently create an empty `/opt/opterite/site`, and Caddy would serve HTTP 404 for every Opterite static asset with nothing in the logs to suggest a mount problem. Worse, if the content were later placed at a slightly different path, the stray root-owned empty directory would remain and keep shadowing it. (The stricter long-form `--mount type=bind` syntax errors out instead of auto-creating, but the compose short syntax `./x:/y:ro` used by this project follows the auto-create behaviour.)

**This is a strong argument for avoiding the bind mount entirely** — see E, where Opterite's static files are served by Opterite's own container.

### D4. Can the compose project be updated with an additional network and an additional read-only volume WITHOUT changing any existing service configuration?

Four separate answers.

**(i) Does adding a top-level `networks:` key to a file that currently declares none change the default network's name or identity?**

**No, provided you only *add* a new entry and do not redeclare `default`.** The evidence is that Compose already models the default network explicitly even though the YAML says nothing:

```yaml
# docker compose -f docker-compose.prod.yml config
networks:
  default:
    name: bulk-email-sender_default
```

Compose's rule is: the project always has a `default` network named `<project>_default` unless the file overrides it. Introducing a top-level `networks:` block that declares *other* networks does not remove or rename `default`; it coexists. Equally important, a service that has **no** `networks:` key still joins `default` — Compose only stops attaching a service to `default` when that service declares its own `networks:` list. So `web`, `worker` and `redis` would be untouched.

The genuine risk is **redeclaring `default` yourself.** The existing network carries `com.docker.compose.config-hash=c247e3ad18fa85ba5c96edd4ff9ba4ad0ea847512131e508b75413b5883f1246`. Compose compares that label against the hash of the declared network config; if it differs, Compose wants to recreate the network — and recreating a network requires disconnecting every one of the 14 containers, which in practice means a full-stack recreate. Writing `default: { name: bulk-email-sender_default }` *should* hash identically to the resolved model shown above, but I could not verify the hash computation without running `docker compose up --dry-run`, which is outside the allowed command set. **Recommendation: do not declare `default` at all. Leave the `networks:` key absent from this file entirely** (which the recommended design in E achieves) **or, if a new network is unavoidable, add only the new entry and never mention `default`.**

**(ii) Would `docker compose up -d` recreate only caddy, or also web/worker/redis?**

**Only the services whose definitions changed.** Compose computes a per-service config hash and stores it on each container as `com.docker.compose.config-hash`. Current values, read off the live containers:

| service | containers | `com.docker.compose.config-hash` |
|---|---|---|
| `caddy` | `bulk-email-sender-caddy-1` | `8238ae9c176d8ffff4261c6d5dfdcca95e3edc1842d9d0fba87378febfd40ae9` |
| `redis` | `bulk-email-sender-redis-1` | `e66a2e42b385eeb2ec53510304dec4027c2848f9bef4e088a32aca17c0e27c94` |
| `web` | `web-1` … `web-4` | `4860d804b3dd4e7b32de9b5be2596565dd105eaab69daa25b44a3af02a42b966` (all four identical) |
| `worker` | `worker-1` … `worker-8` | `50e56526df2afbeb3186d26c47b30cb5982b694c79e9a3533ab47a4340c9c761` (all eight identical) |

On `docker compose up -d`, Compose recomputes each service's hash from the merged file + interpolated env, compares with the label, and recreates only where they diverge (it also recreates if the resolved image ID changed, or if a dependency was recreated). Editing **only** the `caddy:` service block changes only `8238ae9c…`, so **only `bulk-email-sender-caddy-1` would be recreated; `web`×4, `worker`×8 and `redis` would be left running untouched.**

Three caveats, all material:

- `caddy` has `depends_on: [web]`. Dependencies are started-before, not restarted-with; a changed `caddy` does **not** drag `web` into a restart. The reverse is what to fear — recreating `web` can cascade to `caddy`.
- **Never run a bare `docker compose up -d` casually on this project without `--no-build`.** The `web`/`worker` services share an `x-app` anchor with `build: { context: ., dockerfile: Dockerfile }`. A plain `up -d` can rebuild `bulk-email-sender:latest` from the current working tree, producing a new image ID and recreating all 12 app containers. Target the one service: `docker compose -f docker-compose.prod.yml up -d --no-deps --no-build caddy`.
- The `com.docker.compose.image` label discrepancy noted in section A is an unquantified risk that caddy might be considered image-changed even with no edits. Check with `--dry-run` at deploy time.

**(iii) Adding an additional read-only volume without changing existing service configuration?**

**Not possible as stated.** A volume or bind mount is attached to a *service*, so adding one *is* a change to that service's configuration — it adds an entry to `caddy.volumes`, changes `8238ae9c…`, and forces the caddy container to be recreated (consistent with D3). What you *can* do without touching any existing service is add a new **top-level** `volumes:` entry — that only creates a named volume and is inert until a service references it. But an inert volume serves no purpose here.

**(iv) Bottom line for D**

| Change | Caddy recreated? | Other services affected? |
|---|---|---|
| Edit Caddyfile content + `caddy reload` | **No** | No |
| Live `docker network connect` to caddy | No (but undeclared and lost on next recreate) | No |
| Add a compose-declared network to the `caddy` service | **Yes** | No |
| Add `/opt/opterite/site:/srv/opterite:ro` to `caddy` | **Yes** | No |
| Opterite's own project joins `bulk-email-sender_default` as `external: true` | **No** | No |
| Redeclare `default` under a new top-level `networks:` key | Possibly, plus network-recreate risk | **Possibly all 14** |
| `docker compose up -d` without `--no-build` | Possibly | **Yes — all 12 app containers** |
| `docker compose down -v` | Yes, and **certificates destroyed** | Yes, all |

So: **the proposed integration as literally specified (extra network on caddy + `/srv/opterite` bind mount) DOES require recreating the Caddy container. But the integration does not need to be done that way, and the alternative in section E requires no recreation at all.**

---

## Pre-requisite re-checks for section E

### DNS — DRIFT from the prior report: `opterite.in` now resolves

The earlier report recorded `opterite.in` as having **no A record** and called it a blocker. **That is no longer true.**

```
$ dig +short A opterite.in                      → 213.136.89.187
$ dig +short A www.opterite.in                   → opterite.in.
                                                   213.136.89.187
$ dig +short NS opterite.in                      → ns71.domaincontrol.com.
                                                   ns72.domaincontrol.com.
$ dig +short SOA opterite.in
    ns71.domaincontrol.com. dns.jomax.net. 2026100201 28800 7200 604800 600

$ dig +short @8.8.8.8 A opterite.in              → 213.136.89.187
$ dig +short @1.1.1.1 A opterite.in              → 213.136.89.187
$ dig +short @8.8.8.8 A www.opterite.in          → opterite.in.
                                                   213.136.89.187
$ dig +short @ns71.domaincontrol.com A opterite.in → 213.136.89.187
$ dig +short @8.8.8.8 CAA opterite.in            → (empty)
```

For comparison, the already-working domain:

```
$ dig +short A opterite.com      → 213.136.89.187
$ dig +short A www.opterite.com  → opterite.com.
                                   213.136.89.187
```

Reading:

- The apex `opterite.in` has an **A record pointing at this server**, authoritative and already propagated to both Google and Cloudflare public resolvers.
- `www.opterite.in` is a **CNAME to the apex**, which now resolves. Both names are reachable.
- SOA serial `2026100201` follows the `YYYYMMDDnn` convention and decodes to 2026-10-02 revision 01 — **the zone was edited today**, which is exactly why this differs from the earlier report.
- **No CAA records**, so there is no CAA restriction that could refuse Let's Encrypt. (An absent CAA record permits any CA.)
- Port 80 on this host is published and bound by docker-proxy into Caddy, so an HTTP-01 challenge for both names will reach Caddy.

**Conclusion: a Caddy site block for `opterite.in, www.opterite.in` would now succeed at ACME, not fail.** Let's Encrypt rate limits are scoped per registered domain; `opterite.in` is a distinct registered domain from `opterite.com` with zero certificates issued, so the full allowance is available and there is no risk of burning the `opterite.com` budget. The DNS gate is **satisfied**, but keep it as an explicit gate in the sequence below and re-verify immediately before adding the site block — a zone edited hours ago can still be edited again.

### The `dynamic a` trap — re-confirmed present in the live config

Still present in `/opt/bulk-email-docker/Caddyfile`:

```
	reverse_proxy {
		dynamic a {
			name web
			port 3000
			refresh 10s
		}
		lb_policy least_conn
```

and in the running config from the admin API:

```json
"dynamic_upstreams": { "source": "a", "name": "web", "port": "3000", "refresh": 10000000000 }
```

**The constraint, restated with the mechanism that makes it dangerous.** Caddy resolves the bare DNS name `web` against Docker's embedded DNS resolver on `bulk-email-sender_default` every 10 seconds and load-balances `opterite.com` traffic across **every A record returned**. Docker Compose automatically gives each service a network alias equal to its **service name** on every network it joins — the existing caddy container demonstrates this: `Aliases: ["bulk-email-sender-caddy-1","caddy"]`, where `caddy` is the service name. So:

- An Opterite compose service named **`web`** joining `bulk-email-sender_default` would register the alias `web` on that network. Within 10 seconds, a share of live `opterite.com` production traffic would be load-balanced into Opterite. No config change, no restart, no warning.
- An Opterite service named **`redis`** on the shared network would register the alias `redis`. The production `web` and `worker` containers connect with `REDIS_URL=redis://redis:6379`, so a share of them would resolve to Opterite's Redis — splitting the Bull `emailQueue` across two Redis instances. Jobs would be lost or duplicated.
- `worker` and `caddy` are the remaining reserved names.

**Directive: no Opterite service may be named — or aliased — `web`, `redis`, `worker`, or `caddy` on the shared network.** Safest form: Opterite's internal services (its Redis, its backend) sit on a **private** Opterite network and never join the shared one; only a single edge container joins `bulk-email-sender_default`, under a distinctly prefixed service name such as `opterite-edge`, with an explicit `aliases:` list so the alias is deliberate rather than inherited.

### No catch-all — re-confirmed

The running config's only route is `match: [{host: ["opterite.com","www.opterite.com"]}]` with `terminal: true`, and the TLS automation policy's `subjects` are the same two names. There is no catch-all, no `:80`-only block in the stored config, and no on-demand TLS. Therefore a new `opterite.in` site block:

- **cannot be shadowed** by the existing block (host matchers are disjoint, and Caddy routes by most-specific host match regardless of file order), and
- **cannot shadow** the existing block (it names different hosts).

This is the clean case. Adding the block is safe from a routing standpoint.

---

## E. Safest sequence for adding Opterite with zero interruption

### The design this sequence implements, and why

Two viable architectures were considered.

**Rejected: extend the `caddy` service.** Add a network and `/opt/opterite/site:/srv/opterite:ro` to the caddy service in `docker-compose.prod.yml`, then `docker compose up -d caddy`. This works but forces a caddy recreation (D3, D4), which means a brief loss of `:80`/`:443`, and it entangles Opterite's lifecycle with the production bulk-email compose file — every future Opterite change risks touching the file that governs 14 production containers.

**Chosen: Opterite as a separate compose project that joins the existing network as a consumer.** Opterite gets its own project directory, its own compose file, its own Redis on its own private network, and a single edge container (nginx serving the static build, proxying its own API) that additionally joins `bulk-email-sender_default` as an `external` network. Caddy reaches it by container name. **Caddy's service definition is never edited, so Caddy is never recreated.** The only change to the bulk-email project is the Caddyfile's *content*, applied by hot reload. Static files are served by Opterite's nginx, which eliminates `/srv/opterite` and with it the entire reason to recreate Caddy.

Answering the question directly: **yes, static files can and should be served by an Opterite container rather than a Caddy bind mount.** Caddy becomes a pure reverse proxy for `opterite.in`, exactly as it already is for `opterite.com`. This removes the bind mount, removes the D3 recreation requirement, removes the auto-created-empty-directory failure mode, and keeps Opterite's assets inside Opterite's own image or volume where its own deploy process owns them.

The `external: true` declaration is correct here because `bulk-email-sender_default` is compose-managed by *another* project (labels `com.docker.compose.project=bulk-email-sender`, `com.docker.compose.network=default`). Declaring it external tells Opterite's compose project to look the network up by name and never create, modify or delete it. `docker compose down` on Opterite will not remove it.

### The sequence

**Step 0 — Gate: confirm DNS still resolves.**
Action: `dig +short @8.8.8.8 A opterite.in` and `dig +short @8.8.8.8 A www.opterite.in`; both must return `213.136.89.187`.
Zero-downtime: yes, read-only.
Touches: nothing.
Rollback: n/a. **Do not proceed past Step 6 if this fails** — adding a site block for a non-resolving host makes Caddy retry ACME in a backoff loop and consumes Let's Encrypt failure budget.

**Step 1 — Back up the Caddyfile and record the current config hashes.**
Action: `cp -p /opt/bulk-email-docker/Caddyfile /opt/bulk-email-docker/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)`, and save the current admin config: `docker exec bulk-email-sender-caddy-1 curl -s http://127.0.0.1:2019/config/ > /root/caddy-config-before.json`. Record `8238ae9c…` (caddy), `4860d804…` (web), `50e56526…` (worker), `e66a2e42…` (redis).
Zero-downtime: yes.
Touches: creates one new backup file in the project directory and one file in `/root`. Note the backup filename must not match `Caddyfile` itself and is not referenced by any mount, so it is inert.
Rollback: delete the backup.

**Step 2 — Create the Opterite project directory and stage its code.**
Action: `mkdir -p /opt/opterite`, copy the Opterite source there (by file copy, not `git clone` — the earlier report established that the pushed branch is missing two `require`d untracked files and would not start). Author `/opt/opterite/docker-compose.yml`.
Zero-downtime: yes — nothing running is touched.
Touches: new paths under `/opt/opterite` only. **Do not create `/opt/opterite/site`** unless something actually mounts it; it is not needed in this design.
Rollback: `rm -rf /opt/opterite`.

**Step 3 — Write the Opterite compose file with the network topology that avoids every collision.**
Shape (names illustrative; the constraints are the point):

```yaml
name: opterite

networks:
  internal:                      # private: Opterite's own services only
    driver: bridge
  proxy:                         # the EXISTING bulk-email network, borrowed
    name: bulk-email-sender_default
    external: true

services:
  opterite-redis:                # NOT "redis"
    image: redis:7.4-alpine
    networks: [internal]         # never on proxy
    ...

  opterite-api:                  # NOT "web"
    networks: [internal]         # never on proxy
    ...

  opterite-edge:                 # the only service Caddy talks to
    image: nginx:1.27-alpine     # serves the static build, proxies /api to opterite-api
    networks:
      internal:
      proxy:
        aliases: [opterite-edge] # explicit, deliberate alias
    expose: ["80"]
    # NO ports: — publishes nothing to the host
    restart: unless-stopped
```

Checks before applying: no service is named or aliased `web`, `redis`, `worker` or `caddy`; `opterite-redis` and `opterite-api` are **not** on `proxy`; no service has a `ports:` key; `proxy` is `external: true` with `name: bulk-email-sender_default`.
Zero-downtime: yes — authoring a file changes nothing.
Touches: one new file.
Rollback: delete it.

**Step 4 — Bring Opterite up, in its own project, and verify it in isolation.**
Action: `cd /opt/opterite && docker compose up -d`.
Zero-downtime: **yes.** This is a different compose project (`name: opterite`). It creates `opterite_internal`, looks up `bulk-email-sender_default` by name without modifying it, and starts only Opterite containers. Because `proxy` is `external`, compose will not touch the existing network's config or labels. The 14 bulk-email containers are not inspected, not recreated, not restarted. No host port is bound, so there is no conflict with `:80`/`:443`.
Verify: `docker network inspect bulk-email-sender_default` — confirm the Id is still `057e2cbbb5da…`, the config-hash label is still `c247e3ad…`, all 14 original containers are still attached with their original IPs, and the only addition is `opterite-edge`. Then confirm the reserved names did not leak: `docker exec bulk-email-sender-caddy-1 getent hosts web` must still return only the four `172.19.0.{4,5,9,10}` addresses, and `docker exec bulk-email-sender-web-1 getent hosts redis` must still return only `172.19.0.7`.
Touches: new Opterite containers; one new endpoint on the shared network.
Rollback: `cd /opt/opterite && docker compose down` (no `-v` if Opterite has data worth keeping). This removes only Opterite's containers and `opterite_internal`; the external network is left alone.

**Step 5 — Verify Caddy can reach Opterite before any Caddy config change.**
Action: `docker exec bulk-email-sender-caddy-1 curl -sS -o /dev/null -w '%{http_code}\n' http://opterite-edge:80/` and a check of the API path.
Zero-downtime: yes, read-only probe.
Touches: nothing. Production routing is unchanged because no Caddy config mentions Opterite yet.
Rollback: n/a. **A non-2xx/3xx here means stop and fix Opterite — do not edit the Caddyfile.**

**Step 6 — Re-run the Step 0 DNS gate.** Same commands, same pass criterion. This is deliberately repeated because Steps 2–5 may span hours.

**Step 7 — Edit the Caddyfile IN PLACE to add the `opterite.in` site block.**
Action: append a new site block to `/opt/bulk-email-docker/Caddyfile`:

```
opterite.in, www.opterite.in {
	reverse_proxy opterite-edge:80
	log {
		output file /var/log/caddy/opterite-in.log {
			roll_size 20MB
			roll_keep 5
		}
	}
}
```

Critical constraints:
- **Edit in place** (`cat >>`, or an editor configured to preserve the inode). Do **not** write-temp-and-rename: per D2 that swaps the inode and the container keeps reading the old file. Verify the container sees the edit with `docker exec bulk-email-sender-caddy-1 cat /etc/caddy/Caddyfile` and diff it against the host file **before** reloading.
- Do not touch the existing `{$SITE_ADDRESS}` block, the global block, or anything else.
- A static `reverse_proxy opterite-edge:80` is correct here and `dynamic a` is not needed — Opterite's edge is a single replica.

Zero-downtime: **yes.** Editing the file alone changes nothing at runtime; Caddy does not watch the file.
Touches: one file's content. No container, no mount, no network.
Rollback: `cp -p` the Step 1 backup back over it (again in place), then reload.

**Step 8 — Validate, then hot-reload Caddy.**
Action: `docker compose -f /opt/bulk-email-docker/docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`
(Optionally `caddy validate --config /etc/caddy/Caddyfile` first, which only parses.)
Zero-downtime: **yes, and this is the key property of the whole plan.** `caddy reload` POSTs the adapted config to the admin API on `127.0.0.1:2019`. Caddy provisions the new config, swaps handlers, and drains the old ones without closing the listening sockets on `:80`/`:443`. **The container is not restarted, no process is killed, in-flight requests complete, and `opterite.com` traffic is uninterrupted.** The existing `opterite.com` certificates are untouched in `bulk-email-sender_caddy-data`.
Then: Caddy immediately begins an ACME HTTP-01 order for `opterite.in` and `www.opterite.in` on port 80, writing new certs into the same volume. Expect certificates within seconds to a minute.
Verify: `docker exec bulk-email-sender-caddy-1 curl -s http://127.0.0.1:2019/config/ | grep -c opterite.in` to confirm the new route is live; `docker logs --tail 100 bulk-email-sender-caddy-1` for the ACME result; `docker exec bulk-email-sender-caddy-1 ls /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/` to confirm new cert directories; then externally `curl -I https://opterite.in` and, as the regression check that matters most, `curl -I https://opterite.com`.
Rollback: restore the Step 1 Caddyfile backup in place and run `caddy reload` again. Rollback is itself zero-downtime and takes seconds. Note the `opterite.in` certificate persists in the volume after rollback, which is a benefit — a retry will not re-issue.

**Step 9 — Do NOT run `docker compose up -d` on the bulk-email project at any point in this sequence.**
Nothing in Steps 0–8 requires it. Per D4, a bare `up -d` can rebuild `bulk-email-sender:latest` from the working tree and recreate all 12 app containers. If a caddy recreation ever does become necessary, the only acceptable form is `docker compose -f docker-compose.prod.yml up -d --no-deps --no-build caddy`, preceded by `--dry-run`. **And never `docker compose down -v`** — that destroys `bulk-email-sender_caddy-data` and with it both live certificates and the ACME account key.

### What a Caddy recreation would actually cost, if the fallback path were ever taken

Quantified, because the decision to avoid it should be informed rather than reflexive:

- **`:80`/`:443` unavailability:** from `docker stop` to the new container's listeners being ready. The stop sends SIGTERM; Caddy shuts down gracefully and typically exits in well under the 10-second default grace period. Then `rm`, `create`, `start`, plus Caddy provisioning its config. Realistically **1–5 seconds**, worst case ~15 if Caddy uses the full grace period. During that entire window the host ports are **unbound** — `docker-proxy` exits with the container — so clients get TCP connection-refused, not a queue or a retry.
- **In-flight connections:** **dropped.** There is no connection draining across a container swap, because the socket itself disappears. Any request mid-flight, any upload in progress (the 30MB body limit means uploads can be long-running), and any open HTTPS keep-alive connection is terminated. Browsers will generally retry a GET; a POST mid-upload will fail visibly to the user.
- **Certificates:** **they survive.** They live in the named volume `bulk-email-sender_caddy-data`, which compose re-attaches to the new container by name. `docker compose up -d` never deletes volumes — only `down -v` or an explicit `docker volume rm` does. On start, Caddy finds the existing `opterite.com` and `www.opterite.com` certs in `/data/caddy/certificates/` and loads them. **No re-issuance, no ACME traffic, no rate-limit consumption, no TLS error.** This is the single most important reason the `caddy-data` volume is flagged must-not-delete in section C.
- **Everything else:** `web`×4, `worker`×8 and `redis` keep running throughout (D4(ii)), so no email send is interrupted and no queued job is lost. The outage is strictly the public HTTP(S) edge for a few seconds.

So a recreation is survivable and would be a reasonable maintenance-window action. It is simply unnecessary, which makes it the wrong default.

---

## Conclusions

1. **Nothing was modified.** All 47 commands were observational.

2. **The prior report is confirmed in every structural detail** — container name, image, version, restart policy, published vs exposed ports, the single network and its subnet/IP/aliases, all four mounts, the Caddyfile content, the absence of a `networks:` key, the admin API on `127.0.0.1:2019`, the absence of a catch-all, and the `.bak-20260930-085901` backup file.

3. **One drift, and it is favourable: `opterite.in` now has an A record** pointing at `213.136.89.187`, propagated to public resolvers, with `www` as a CNAME to the apex and no CAA restriction. The earlier DNS blocker is cleared.

4. **The integration as literally proposed requires recreating Caddy** — both the compose-declared network membership and the `/srv/opterite` bind mount are creation-time properties.

5. **The integration does not need to be done that way.** Running Opterite as its own compose project that borrows `bulk-email-sender_default` as an `external` network, serving its static files from its own nginx container, and having Caddy proxy to it by name, requires **no new Caddy mount, no new Caddy network, no Caddy recreation, and no new host port.** The only change to the production project is the Caddyfile's content, applied by hot reload.

6. **The two active hazards are naming and inode replacement.** Compose's automatic service-name aliasing means an Opterite service named `web` or `redis` on the shared network would silently hijack production traffic or the production job queue. And `stat` on the Caddyfile shows `Birth` (Sep 28) later than `Modify` (Sep 18) and later than the container's `StartedAt` (Sep 21), indicating the file was inode-replaced after the container started — so future edits must be in place, and the container's view should be diffed against the host file before any reload.

### Recommendations, none implemented

- Adopt the separate-compose-project design in section E. Do not add a network or a bind mount to the `caddy` service.
- Prefix every Opterite service name (`opterite-edge`, `opterite-api`, `opterite-redis`) and keep Opterite's Redis and API off the shared network entirely.
- Before the first deploy, run `docker compose -f docker-compose.prod.yml up -d --dry-run caddy` in the bulk-email project to resolve the `com.docker.compose.image` label question from section A — it will show whether compose currently considers caddy drifted.
- Consider giving the caddy service a healthcheck; it currently has none, so an unhealthy-but-running Caddy is invisible to `docker ps`.
- Treat `bulk-email-sender_caddy-data` as protected state. A periodic `tar` of `/var/lib/docker/volumes/bulk-email-sender_caddy-data/_data` would make certificate loss recoverable without ACME.
- The deeper issues from the earlier report are unchanged by this inspection and still gate the deployment: the local repo has no Docker artifacts, Opterite's `MONGODB_URI` points at the same Atlas database as production, and Bull's queue name has no prefix. Those are application-level and outside this preflight's scope, but they must be resolved before Step 2.

