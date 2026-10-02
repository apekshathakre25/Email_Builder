# Opterite deployment — READ-ONLY inspection findings

Date: 2026-10-02
Server: `contabo-opterite` / `213.136.89.187` / hostname `vmi3195139`
Local repo inspected: `d:\Bulk Email` (Opterite repo root)

**Nothing was changed.** All server commands were observation-only (`docker ps`, `docker inspect`, `docker network inspect`, `cat`, `ls`, `ss -tulpn`, `df`, `free`, `dig`, `curl`, `caddy validate`, Caddy admin API `GET /config/`). No container was started, stopped, rebuilt or removed; no file on the server was created or modified; no service was reloaded. Locally only read-only git commands were used. The only file written is this report.

---

## Summary

Five facts dominate the plan, and three of them are blockers.

1. **BLOCKER — `opterite.in` has no A record.** It is registered and delegated to GoDaddy nameservers, but the apex returns only an SOA, and `www.opterite.in` is a CNAME to an unresolvable apex. Caddy cannot complete an ACME HTTP-01 challenge, so HTTPS for `opterite.in` will fail until an A record pointing to `213.136.89.187` exists and propagates. Everything else can be built first, but the Caddy site block must not be added until DNS resolves, or the deployment will burn Let's Encrypt failure rate limit.

2. **BLOCKER — there are no Docker artifacts in the local repo at all.** No `Dockerfile`, no `.dockerignore`, no `docker-compose*.yml` anywhere in `d:\Bulk Email`, confirmed by both `git ls-files` and a recursive filesystem search. `README.md` documents all of them as existing. The README is aspirational, not descriptive. Every container artifact must be authored from scratch. The good news: the server holds a high-quality precedent at `/opt/bulk-email-docker/Dockerfile` (multi-stage, Node 22.20.0, non-root, healthcheck) that the new backend image should follow closely.

3. **BLOCKER-GRADE RISK — the "existing production application" is the same application.** `/opt/bulk-email-docker/package.json` declares `"name": "opterite"`, the existing `Caddyfile` is headed "Reverse proxy / TLS terminator for Opterite", and it already serves `opterite.com` + `www.opterite.com`. The server runs the older EJS-rendered monolith; `d:\Bulk Email` is the React-split refactor of that same codebase. Worse, the local `backend/.env` points `MONGODB_URI` at **the same Atlas cluster and the same database name** (`.../bulk-email-sender?...`) that production is using right now. Deploying as-is gives two application versions one shared database.

4. **Sharing Redis would cause duplicate email sends.** `backend/workprocess/queue.js` constructs `new Queue('emailQueue', …)` with a hardcoded name and **no `prefix` option**. If Opterite is pointed at the existing `bulk-email-sender-redis-1`, its 8 workers and Opterite's workers would consume the same Bull queue keys. Opterite needs its own Redis container. This is not a preference; it is a correctness requirement.

5. **The network path for Caddy is clean, and no new host ports are needed.** Caddy sits on exactly one network (`bulk-email-sender_default`), its Caddyfile is a read-only bind mount from `/opt/bulk-email-docker/Caddyfile`, `caddy validate` works, the admin API is live on `127.0.0.1:2019` inside the container so `caddy reload` works, and there is **no catch-all site block** — the running config matches only `opterite.com` and `www.opterite.com`. Opterite can join `bulk-email-sender_default` as an *external* network and be proxied by container name, publishing zero new host ports and touching zero existing containers.

Two additional non-obvious findings:

- **A routing collision exists.** The backend mounts its API at the **root** namespace, not under `/api`. `GET /login` is an SPA route (React Router) while `POST /login` is a backend auth route. Naive "`/api/*` to backend, everything else to frontend" routing will break authentication. An explicit, method-aware split is required.
- **A `git clone` on the server would produce a broken build.** The working tree has uncommitted modifications, and two **untracked** files (`backend/utils/headerResolver.js`, `backend/utils/contentTransferEncoding.js`) are `require`d by tracked, modified files. Cloning the pushed branch yields a backend that throws at startup. Code must reach the server by file copy, or be committed first.

Capacity is a non-issue: 425 GB free disk, 58 GB available RAM, 16 CPUs.

---

## Existing architecture on the server

### Traffic flow today

```
            Internet
               │
               │  :80 / :443  (host, via docker-proxy)
               ▼
   ┌───────────────────────────────┐
   │  bulk-email-sender-caddy-1    │   caddy:2-alpine (v2.11.4)
   │  TLS + ACME (Let's Encrypt)   │   Caddyfile bind-mounted :ro from
   │  serves opterite.com,         │   /opt/bulk-email-docker/Caddyfile
   │         www.opterite.com      │   admin API on 127.0.0.1:2019
   └───────────────┬───────────────┘
                   │ reverse_proxy  dynamic a → name "web", port 3000
                   │ (re-resolves every 10s, lb_policy least_conn)
                   ▼
   ┌────────────────────────────────────────────────────────┐
   │ network: bulk-email-sender_default  (bridge, 172.19.0.0/16) │
   │                                                        │
   │  web × 4   ──┐   (bulk-email-sender:latest, node app.js)│
   │  worker × 8 ─┼──► redis  (redis:7.4-alpine, AOF, 8gb cap)│
   │              │                                          │
   │              └──► MongoDB Atlas  (EXTERNAL, over the internet)
   │                   ac-qawk0j7-*.odb77cc.mongodb.net:27017 │
   │                   database: bulk-email-sender            │
   └────────────────────────────────────────────────────────┘

   Also on the host, unrelated to the app:
     mongod on 127.0.0.1:27017  (local, NOT used by the app — app uses Atlas)
     sshd :22,  systemd-resolved :53,  code-server 127.0.0.1:36269
```

### Compose project

One project, `bulk-email-sender`, declared via the `name:` key in `/opt/bulk-email-docker/docker-compose.prod.yml`. All 14 containers carry the label `com.docker.compose.project=bulk-email-sender`, with `com.docker.compose.project.config_files=/opt/bulk-email-docker/docker-compose.prod.yml`.

Four services: `web` (4 replicas, `node app.js`, `expose: 3000`, no host ports), `worker` (8 replicas, `node workprocess/mailer.js`, healthcheck disabled, `stop_grace_period: 60s`), `redis` (`redis:7.4-alpine`), `caddy` (the only service with `ports:`). Everything is `restart: unless-stopped`.

MongoDB is deliberately absent from the stack — the compose header states "No mongo service — MONGODB_URI in .env points at MongoDB Atlas."

### A second, older deployment also exists

`/opt/bulk-email-sender` (owner `ubuntu`, last touched Sep 15) is a pre-Docker PM2-era copy of the same app: `app.js`, `app.js.backup`, `ecosystem.config.js`, `node_modules/`, `uploads/`. It is **not** a git repository and nothing is currently running from it (no node process in `ss -tulpn`). It is dormant leftovers. Leave it alone, but be aware the name `/opt/bulk-email-sender` is already taken.

---

## Opterite project as it stands

`d:\Bulk Email` is the Opterite monorepo-by-convention: root `package.json` is `"name": "opterite"` with script-only delegation (`npm --prefix backend`, `npm --prefix frontend`); npm workspaces are deliberately not used.

### Backend — `d:\Bulk Email\backend\`

- Entry point `app.js`, Express 5, `main: "app.js"`.
- **Listens on `0.0.0.0`** — `app.listen(PORT, '0.0.0.0', …)`. Container-safe; no localhost-binding problem.
- Port from `env.port` = `parsePositiveInt('PORT', 3000)`. Configurable, defaults 3000.
- `engines.node: ">=18.0.0"` (root says `>=20.0.0`). The server's precedent Dockerfile pins `NODE_VERSION=22.20.0`.
- **Two process roles, same code**: `node app.js` (API) and `node workprocess/mailer.js` (Bull worker). `backend/package.json`'s `start`/`dev` run both together via `dotenvx run -- concurrently`. For Docker, do **not** use `npm start` — follow the server precedent and run the two commands as two separate services off one image.
- `backend/ecosystem.config.js` shows today's PM2 shape: app `opterite`, `script: app.js`, 4 instances, `exec_mode: cluster`, `PORT: 3000`, `kill_timeout: 30000`, `wait_ready: true`; app `opterite-worker`, `script: workprocess/mailer.js`, **14 instances**, `exec_mode: fork`, `WORKER_CONCURRENCY: "50"`. PM2 is to be dropped — the container runtime replaces it, exactly as the existing Dockerfile comment explains.
- Serves **no** static files except a conditional certbot ACME path that no longer applies (`fs.existsSync("/var/www/certbot/.well-known/acme-challenge")` — false in a container, so the branch is inert). **The SPA must be served by nginx.**
- Directories: `config/`, `middleware/`, `models/`, `routes/`, `services/`, `utils/`, `workprocess/`, plus runtime `logs/` and `uploads/`.
- Notable deps: `express@^5`, `bull@^4.16.5`, `ioredis`, `mongoose@^8`, `nodemailer`, `imapflow`, `mailparser`, `passport` + `passport-google-oauth20`, `jsonwebtoken`, `helmet`, `cors`, `express-rate-limit` + `rate-limit-redis`, `systeminformation` (needs `procps` in the image — the existing Dockerfile installs it for exactly this reason), `xlsx`, `csv-parse`, `multer`.

### Frontend — `d:\Bulk Email\frontend\`

- `"name": "opterite-frontend"`, `type: module`, `engines.node: ">=20.0.0"`.
- Build: `vite build` → **`dist/`** (`build.outDir: 'dist'`, `sourcemap: true`). `dist/` exists locally and is gitignored.
- React 19.3.0, `react-router-dom` 7.18.4, `@tanstack/react-query` 5.104.0, Vite 8.3.1.
- **Tailwind 4 via the Vite plugin** (`@tailwindcss/vite` 4.3.3). There is deliberately **no `tailwind.config.js`** — v4 is CSS-first and the theme lives in `frontend/src/styles/index.css` ("Opterite — Tailwind v4 theme"). Nothing extra is needed in the image build beyond `npm ci` + `vite build`.
- `vite.config.js` configures **no dev proxy**, on purpose, and notes the API origin comes from `VITE_API_BASE_URL`.
- Root files: `index.html`, `vite.config.js`, `eslint.config.js`, `.env`, `package-lock.json`.

### What is missing for containerisation

Everything Docker-related:

| Needed | Exists? |
|---|---|
| `backend/Dockerfile` | No |
| `backend/.dockerignore` | No |
| `frontend/Dockerfile` (build + nginx stage) | No |
| `frontend/.dockerignore` | No |
| `frontend/nginx.conf` (SPA fallback + API proxy) | No |
| `docker-compose.yml` / `docker-compose.prod.yml` | No |
| Production env file for Opterite | No (`backend/.env` is dev-shaped and points at prod Atlas) |

The repo root `Caddyfile` does exist, but it is a **byte-identical copy of the old monolith's Caddyfile** (same comments, same `{$SITE_ADDRESS}` block, same `dynamic a { name web }`). It is not usable for the new split frontend/backend architecture and should not be confused with the live one.

---

## Findings per inspection item

### 1. Existing Docker containers

`docker ps -a --format 'table {{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'`:

```
NAMES                       IMAGE                     STATUS                  PORTS
bulk-email-sender-worker-1..8  bulk-email-sender:latest  Up 44 hours          3000/tcp
bulk-email-sender-web-1..4     bulk-email-sender:latest  Up 45 hours (healthy) 3000/tcp
bulk-email-sender-redis-1      redis:7.4-alpine          Up 10 days (healthy)  6379/tcp
bulk-email-sender-caddy-1      caddy:2-alpine            Up 10 days            0.0.0.0:80->80/tcp, [::]:80->80/tcp,
                                                                               0.0.0.0:443->443/tcp, [::]:443->443/tcp,
                                                                               443/udp, 2019/tcp
```

14 containers, **all** belonging to compose project `bulk-email-sender`. Verified via labels on the Caddy container:

```
"com.docker.compose.project":"bulk-email-sender"
"com.docker.compose.service":"caddy"
"com.docker.compose.project.config_files":"/opt/bulk-email-docker/docker-compose.prod.yml"
"com.docker.compose.project.working_dir":"/opt/bulk-email-docker"
"com.docker.compose.version":"5.5.1"
```

Only `bulk-email-sender-caddy-1` publishes host ports. `3000/tcp` on web/worker is `expose`, not a host binding. Nothing else runs on this Docker daemon — there are no non-`bulk-email-sender` containers, stopped or running.

### 2. Existing Docker networks

```
NETWORK ID     NAME                        DRIVER    SCOPE
de92460d1941   bridge                      bridge    local
057e2cbbb5da   bulk-email-sender_default   bridge    local
f3213a9ff988   host                        host      local
45b8d5f6aacb   none                        null      local
```

Only one application network. `docker network inspect bulk-email-sender_default`:

```
bulk-email-sender_default  bridge  172.19.0.0/16  gateway 172.19.0.1
```

All 14 containers are attached to it and to **nothing else** — including Caddy:

```
bulk-email-sender-caddy-1   172.19.0.12/16
bulk-email-sender-redis-1   172.19.0.7/16
bulk-email-sender-web-1..4  172.19.0.10, .4, .9, .5
bulk-email-sender-worker-1..8  172.19.0.13, .2, .14, .11, .3, .8, .15, .6
```

`docker inspect bulk-email-sender-caddy-1 --format '{{json .NetworkSettings.Networks}}'` confirms a single network membership and shows the DNS aliases:

```json
{"bulk-email-sender_default":{
  "Aliases":["bulk-email-sender-caddy-1","caddy"],
  "IPAddress":"172.19.0.12","Gateway":"172.19.0.1","IPPrefixLen":16,
  "DNSNames":["bulk-email-sender-caddy-1","caddy","6057a8976c03"]}}
```

**Consequence for Opterite:** Caddy is on one network only, so a new container on a brand-new isolated network is unreachable from it. The two ways to bridge that are evaluated in item 11. Note also that the in-network DNS aliases `web`, `worker`, `redis`, `caddy` are taken — see the warning in item 3.

### 3. Existing Caddy configuration

Full contents of `/opt/bulk-email-docker/Caddyfile` (1849 bytes, comments trimmed here for length; the operative directives are verbatim):

```caddyfile
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

- **Exactly one site block.** Its hostname is **not a literal** — it is the env placeholder `{$SITE_ADDRESS}`, injected by the compose `environment:` block from `/opt/bulk-email-docker/.env`, where `SITE_ADDRESS=opterite.com, www.opterite.com`.
- **Global options block** sets only `email {$ACME_EMAIL}` for ACME registration. TLS is fully automatic Let's Encrypt; no explicit certs, no `tls` directive anywhere.
- **No `import` directives** (`grep -n 'import'` returned nothing). **No `/etc/caddy` on the host** (`ls: cannot access '/etc/caddy': No such file or directory`). Inside the container `/etc/caddy` holds only the single bind-mounted `Caddyfile`. There is no `conf.d`-style directory, so a new site means editing this one file.
- The running config confirms the hostnames actually served, via the admin API:

```
GET 127.0.0.1:2019/config/apps/http/servers
{"srv0":{"listen":[":443"], ... "match":[{"host":["opterite.com" ...
```
```
"logs":{"logger_names":{"opterite.com":["log0"],"www.opterite.com":["log0"]}}
```

- **No catch-all.** There is no `:80`/`:443` bare block and no wildcard host matcher. `srv0` listens on `:443` with explicit host matchers only, plus Caddy's generated HTTP→HTTPS redirect server (`"enabling automatic HTTP->HTTPS redirects","server_name":"srv0"`). Adding `opterite.in` therefore cannot be shadowed by, or shadow, the existing site.

> **Trap to avoid:** `dynamic a { name web }` resolves the bare DNS name `web` on Caddy's network every 10 seconds and load-balances across every A record returned. If an Opterite container were given the alias `web` on `bulk-email-sender_default`, production traffic for `opterite.com` would start being routed into Opterite. **No Opterite service may be named or aliased `web`** (nor `redis`/`worker`/`caddy`) on the shared network.

### 4. Existing Caddy networking

- Image `caddy:2-alpine`, `org.opencontainers.image.version: v2.11.4`; `caddy version` → `v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=`.
- Published host ports: `0.0.0.0:80->80`, `[::]:80->80`, `0.0.0.0:443->443`, `[::]:443->443`. `443/udp` and `2019/tcp` are image `EXPOSE` only, not published.
- Networks: `bulk-email-sender_default` only (see item 2).
- Restart policy: `unless-stopped` (from compose).
- Mounts, from `docker inspect --format '{{json .Mounts}}'`:

```json
[{"Type":"volume","Name":"bulk-email-sender_caddy-config","Destination":"/config","RW":true},
 {"Type":"volume","Name":"bulk-email-sender_caddy-data","Destination":"/data","RW":true},
 {"Type":"bind","Source":"/opt/bulk-email-docker/Caddyfile",
  "Destination":"/etc/caddy/Caddyfile","Mode":"ro","RW":false},
 {"Type":"volume","Name":"bulk-email-sender_caddy-logs","Destination":"/var/log/caddy","RW":true}]
```

- **The Caddyfile is a host bind mount, not baked into the image.** Host path `/opt/bulk-email-docker/Caddyfile` → container path `/etc/caddy/Caddyfile`, read-only *from the container's side only*. The host file is freely editable (it is `-rw-rw-rw-`), and the container sees changes immediately. **Editing the host file plus a reload is sufficient; no rebuild and no container recreation is needed.**
- Certificates and the ACME account key persist in the named volume `bulk-email-sender_caddy-data` at `/data` (host path `/var/lib/docker/volumes/bulk-email-sender_caddy-data/_data`). This volume must not be deleted — losing it means re-issuing all certs.
- **Admin API is live**, which is what makes a hot reload possible. Inside the container:

```
$ netstat -tulpn
tcp  0  0 127.0.0.1:2019   0.0.0.0:*  LISTEN  1/caddy
tcp  0  0 :::443           :::*       LISTEN  1/caddy
tcp  0  0 :::80            :::*       LISTEN  1/caddy
```

  (An earlier probe using `http://localhost:2019` was refused because `localhost` resolved to `::1`; `127.0.0.1` works and returned the full running config.)

- **Validate command — confirmed working right now:**

```
$ docker exec bulk-email-sender-caddy-1 caddy validate --config /etc/caddy/Caddyfile
... "msg":"servers shutting down with eternal grace period"
Valid configuration
```

  (`caddy validate` spins up and tears down a throwaway config in-process; it does **not** affect the running server. That is why it was safe to run during a read-only inspection.)

- **Reload command to use later** (zero-downtime, no container restart):

```
docker exec bulk-email-sender-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

  Equivalently via compose: `docker compose -f /opt/bulk-email-docker/docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile` — the compose file's own comment documents exactly this. Prefer the plain `docker exec` form: it cannot accidentally reconcile other services the way a compose subcommand might.

### 5. Existing `docker-compose.prod.yml`

`ls -la /opt/bulk-email-docker`:

```
-rw-rw-rw-  .dockerignore            549
-rw-------  .env                     2273   (mode 600 — secrets)
-rw-r--r--  .env.example             5266
-rw-rw-rw-  Caddyfile                1849
-rw-rw-rw-  Dockerfile               3522
-rw-rw-rw-  app.js                   8624
drwxrwxrwx  config/
-rwxr-xr-x  docker-compose.prod.yml  5950
-rw-rw-rw-  docker-compose.prod.yml.bak-20260930-085901   4270
drwxrwxrwx  middleware/  models/  public/  routes/  utils/  views/  workprocess/
-rw-rw-rw-  package.json             1605
-rw-rw-rw-  package-lock.json      152004
-rw-r--r--  reconcile-once.js         957
```

Note there is **no `.git`** directory — the server copy is not a clone.

Key structure of the compose file (verbatim directives):

```yaml
name: bulk-email-sender
x-logging: &logging
  driver: json-file
  options: { max-size: "10m", max-file: "5" }
x-app: &app
  build: { context: ., dockerfile: Dockerfile }
  image: bulk-email-sender:latest
  restart: unless-stopped
  init: true
  env_file: [.env]
  environment:
    NODE_ENV: production
    REDIS_URL: redis://redis:6379
    TRUST_PROXY: "1"
  volumes: [uploads:/app/uploads, logs:/app/logs]
  depends_on: { redis: { condition: service_healthy } }
services:
  web:    { <<: *app, command: ["node","app.js"],                 deploy: {replicas: 4}, expose: ["3000"] }
  worker: { <<: *app, command: ["node","workprocess/mailer.js"],  deploy: {replicas: 8},
            stop_grace_period: 60s, healthcheck: {disable: true} }
  redis:  image: redis:7.4-alpine
          command: [redis-server, --appendonly, "yes", --maxmemory, 8gb,
                    --maxmemory-policy, noeviction]
          volumes: [redis-data:/data]
          healthcheck: {test: ["CMD","redis-cli","ping"], interval: 10s, timeout: 3s, retries: 5}
  caddy:  image: caddy:2-alpine
          ports: ["80:80", "443:443"]
          environment:
            SITE_ADDRESS: ${SITE_ADDRESS:?set SITE_ADDRESS in .env, e.g. opterite.com}
            ACME_EMAIL: ${ACME_EMAIL:-}
          volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro, caddy-data:/data,
                    caddy-config:/config, caddy-logs:/var/log/caddy]
          depends_on: [web]
volumes: { uploads:, logs:, redis-data:, caddy-data:, caddy-config:, caddy-logs: }
```

- **Networks are not declared at all.** Compose therefore auto-creates the implicit `bulk-email-sender_default`. Nothing is marked `external`. This matters: because the network is compose-managed rather than externally declared, Opterite should reference it as `external: true` from its own compose file (see item 11) rather than the other way round.
- No healthcheck is declared in compose for `web`; the `(healthy)` status comes from the image's `HEALTHCHECK` (item 9).
- `.env` exists at mode `600`. **Keys only** (no values printed), from `grep -oE '^[A-Za-z_][A-Za-z0-9_]*='`:

  `REDIS_URL`, `PORT`, `MONGODB_URI`, `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `AUTHORIZED_USERS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `MAX_UPLOAD_MB`, `WORKER_CONCURRENCY`, `MAX_REQUEST_BODY_MB`, `TRUST_PROXY`, `BREVO_API_KEY`, `SMTP_FROM_EMAIL`, `NODE_ENV`, `SITE_ADDRESS`, `ACME_EMAIL`, `GOOGLE_CALLBACK_URL`, `DB_CLEANUP_ENABLED`, `DB_CLEANUP_DAYS`, `DB_CLEANUP_INTERVAL_HOURS`, `DB_CLEANUP_UPLOADED_FILES`

  Non-sensitive values only: `PORT=3000`, `NODE_ENV=production`, `TRUST_PROXY=1`, `MAX_UPLOAD_MB=25`, `MAX_REQUEST_BODY_MB=10`, `WORKER_CONCURRENCY=20`, `DB_CLEANUP_ENABLED=true`, `DB_CLEANUP_DAYS=3`, `SITE_ADDRESS=opterite.com, www.opterite.com`, `GOOGLE_CALLBACK_URL=https://opterite.com/auth/google/callback`, `SMTP_FROM_EMAIL=niksdate0337@gmail.com`. Secrets were not read.

### 6. Opterite project structure

Local tree (excluding `node_modules`, `.git`, `dist`):

```
d:\Bulk Email\
├── .gitignore
├── A_Inbox_Pattern (1) (2) (1).txt
├── Caddyfile                      ← copy of the OLD monolith Caddyfile
├── README.md
├── package.json                   ← "name": "opterite", scripts delegate only
├── backend\
│   ├── .env                       ← gitignored, mode-equivalent secret file
│   ├── app.js                     ← entry point
│   ├── ecosystem.config.js        ← PM2 (to be dropped)
│   ├── package.json  package-lock.json
│   ├── config\      cookies.js env.js inboxPatterns.js loadEnv.js mongodb.js redis.js
│   ├── middleware\  models\  services\ (inboxPatternRenderer.js)  utils\
│   ├── routes\      appConfig.js auth.js campaignQueue.js imap.js patterns.js
│   │                sendemails.js system-health.js
│   ├── workprocess\ mailer.js queue.js
│   └── logs\  uploads\            ← runtime, gitignored
└── frontend\
    ├── .env                       ← gitignored; VITE_API_BASE_URL=http://localhost:3000
    ├── index.html  vite.config.js  eslint.config.js
    ├── package.json  package-lock.json
    └── src\
        ├── main.jsx  App.jsx
        ├── api\     appConfigApi.js authApi.js campaignApi.js filesApi.js
        │            healthApi.js imapApi.js laneApi.js logsApi.js patternsApi.js
        ├── lib\     config.js apiClient.js
        ├── features\dashboard\ …
        └── styles\  index.css     ← Tailwind v4 theme (CSS-first config)
```

**Docker artifact search — definitive.** `git ls-files` filtered for `docker|Docker|compose` returned **nothing**. A recursive filesystem search excluding `node_modules`:

```powershell
Get-ChildItem -Recurse -Force -File -Include "Dockerfile*",".dockerignore","docker-compose*","*.dockerfile"
  | Where-Object { $_.FullName -notmatch "node_modules" }
# → (no output)
```

**Zero** Dockerfiles, dockerignores or compose files exist in the repo.

**Reconciliation with the README.** `README.md` asserts the opposite:

- line 25: "`backend/` | … Own `package.json`, lockfile, `node_modules`, `.env`, **`Dockerfile`** and PM2 config."
- line 27: "`docker-compose.yml` | Local/self-hosted stack: web, worker, Redis, Mongo."
- line 28: "`docker-compose.prod.yml` | Single-VPS stack: web, worker, Redis, Caddy (TLS). Mongo is external."
- lines 31–34: "The compose files and `Caddyfile` stay at the root … The `Dockerfile` and `.dockerignore` live in `backend/`, because they build the backend's image and a `.dockerignore` is only honoured next to its build context."
- line 101: "`docker compose --env-file backend/.env -f docker-compose.prod.yml up -d --build`"

**Conclusion:** the README documents the *intended* post-refactor layout, written before (or without) actually creating the files. The commit that produced this state is `06a765c refactor: restructure backend and add frontend` — the restructure moved the backend into `backend/`, added the React frontend, and updated the README to describe where Docker files *should* live, but the Docker files themselves were never added. The only real Docker artifacts for this codebase are the pre-refactor ones living on the server at `/opt/bulk-email-docker/` (`Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`), which target the flat monolith layout and will not work against the new `backend/` + `frontend/` split without being rewritten.

**Git state** (read-only):

```
origin  https://github.com/apekshathakre25/Email_Builder.git (fetch/push)
HEAD -> perf/large-campaign-freeze-phases-1-3a, origin/perf/large-campaign-freeze-phases-1-3a
06a765c refactor: restructure backend and add frontend
134 tracked files
```

Working tree is **dirty**:

```
 M backend/routes/sendemails.js
 M backend/workprocess/mailer.js
 M frontend/package.json
 M frontend/src/api/campaignApi.js
 M frontend/src/features/dashboard/campaignFormStorage.js
 M frontend/src/features/dashboard/components/EmailConfigCard.jsx
 M frontend/src/features/dashboard/useCampaignSend.js
 D backend/tests/… (21 test files deleted)
?? backend/utils/contentTransferEncoding.js
?? backend/utils/headerResolver.js
?? frontend/src/features/dashboard/contentTransferEncoding.js
```

The entire `backend/tests/` suite is deleted in the working tree, so there is no runnable backend test suite in the current state. See item on code transfer below for why the untracked files matter.

### 7. Frontend API configuration

**The API base URL is baked in at BUILD time.** `frontend/src/lib/config.js`:

```javascript
export const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

export const GOOGLE_LOGIN_URL = `${API_BASE_URL}/auth/google`;
```

`import.meta.env` is statically replaced by Vite during `vite build`. **The value must therefore be correct at `docker build` time, not at container start.** Changing it later requires rebuilding the frontend image.

Exact variable name: **`VITE_API_BASE_URL`**. It is the only `import.meta.env` consumer of note; the three usages are `src/lib/config.js:12`, `src/api/campaignApi.js:74`, `src/api/laneApi.js:97` (the latter two inline the same `import.meta.env.VITE_API_BASE_URL ?? ''` fallback).

`frontend/.env` (gitignored, confirmed by `git check-ignore -v` → `frontend/.gitignore:8:.env`):

```
VITE_API_BASE_URL=http://localhost:3000
```

> **Build hazard.** If `frontend/.env` is present in the Docker build context, Vite will read it and bake `http://localhost:3000` into the production bundle — every API call from the browser would then target the user's own machine and fail. The frontend `.dockerignore` must exclude `.env`, **and** the build must pass `VITE_API_BASE_URL=` (empty) explicitly. Empty is the correct production value: `config.js` documents that "An empty string … makes every request same-origin, which is what a deployment serving this bundle and the API behind one reverse proxy wants."

**Client-side routing: yes.** `frontend/src/main.jsx:3,31` uses `BrowserRouter` from `react-router-dom`. `App.jsx` declares routes from `ROUTES` plus a `path="*"` catch-all `NotFoundPage`. SPA routes (`frontend/src/lib/config.js`):

```javascript
export const ROUTES = {
  login:        '/login',
  dashboard:    '/',
  fileManager:  '/file-manager',
  imapAccounts: '/imap-accounts'
};
```

**nginx must serve `/index.html` as a fallback** for these paths, or a browser refresh on `/file-manager` returns 404.

**Auth: httpOnly cookie.** `backend/config/cookies.js`:

```javascript
const AUTH_COOKIE_NAME = 'auth_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.cookieSecure,       // true whenever NODE_ENV=production
  sameSite: env.cookieSameSite,   // default 'strict'
  maxAge: 24 * 60 * 60 * 1000,
  path: '/'
};
```

**Same-origin is strongly indicated.** `backend/config/env.js` `parseCorsOrigins()` documents: "Production has no defaults: if CORS_ORIGINS is unset there, cross-origin browser access is simply off, which is the correct posture for a deployment that serves the built SPA from the same origin as the API." Serving both the SPA and the API from `https://opterite.in` means CORS is never consulted, `SameSite=strict` works unchanged, and `CORS_ORIGINS`/`COOKIE_SAMESITE` can be left unset. That is the arrangement to aim for. A split-origin design (e.g. `api.opterite.in`) would require setting `CORS_ORIGINS=https://opterite.in` and keeping `SameSite=strict` (still same-site across subdomains of one registrable domain) — more moving parts for no benefit here.

One same-origin requirement is not optional: `FRONTEND_URL`. `env.js` explains Google OAuth "is a top-level browser redirect, so the callback cannot answer with JSON — it has to redirect the browser somewhere, and with a separate frontend that somewhere is no longer a route on this server. Empty means 'same origin'." With nginx serving the SPA on the same origin as the API, leaving `FRONTEND_URL` empty is correct.

### 8. Backend routes

Mounting order in `backend/app.js`:

```javascript
app.get('/healthz', …)                                    // unauthenticated
app.use(appConfigRouter)                                   // before auth, deliberately
app.use('/', authRouter)
app.use('/', authenticateToken, patternsRouter)
app.use('/', authenticateToken, sendEmailsRouter)
app.use('/', authenticateToken, campaignQueueRouter)
app.use('/', authenticateToken, systemHealthRouter)
app.use('/imap', authenticateToken, imapRouter)
app.get('/ssl-test', …)                                    // returns 'ssl-ok'
app.use((req,res) => res.status(404).json({success:false,error:'Not found'}))
```

Enumerated endpoints per file:

| File | Mount | Endpoints |
|---|---|---|
| `routes/appConfig.js` | `/` | `GET /api/app-config` |
| `routes/patterns.js` | `/` | `GET /api/patterns` |
| `routes/system-health.js` | `/` | `GET /api/system-health` |
| `routes/auth.js` | `/` | `POST /send-otp`, `POST /login`, `POST /logout`, `GET /check-auth`, `GET /auth/google`, `GET /auth/google/callback` |
| `routes/campaignQueue.js` | `/` | `POST /campaign-lane/claim`, `GET /campaign-lane`, `POST /campaign-lane/start`, `POST /campaign-lane/leave` |
| `routes/sendemails.js` | `/` | `GET\|POST\|DELETE /email-config`, `POST /recipients`, `POST /stop-sending`, `POST /send-email`, `GET /status`, `GET /log-download`, `GET /logs`, `GET /logs/:sessionId`, `GET /logs-stats`, `DELETE /logs/:sessionId`, `DELETE /logs`, `GET /logs/:sessionId/download`, `GET /files`, `GET /files-stats`, `GET /files/:sessionId/original`, `GET /files/:sessionId/sent`, `GET /files/:sessionId/failed`, `GET /files/:sessionId/pending`, `DELETE /files/delete-all`, `DELETE /files/:sessionId` |
| `routes/imap.js` | `/imap` | `POST /check-inbox`, `POST /check-spam`, `POST /list-mailboxes`, `GET\|POST /email-accounts`, `DELETE /email-accounts/:id`, `GET /account-password/:id`, `GET\|POST /credentials`, `POST /save-test-result`, `POST /save-manual-test-results`, `POST /check-auto-test`, `GET /test-results`, `DELETE /test-results/:testId` |

**The API is NOT namespaced under `/api`.** Only three endpoints carry an `/api` prefix. Everything else occupies the root path namespace alongside the SPA's own routes.

> **ROUTING COLLISION — `/login`.** `GET /login` must render the React login page; `POST /login` must reach `routes/auth.js`. The split must be **method-aware**, not path-aware. `/file-manager` and `/imap-accounts` do not collide (backend's IMAP endpoints live under `/imap/`, a distinct prefix), and `/` (dashboard) does not collide because the backend mounts no `GET /`.

Other key facts:

- **Health endpoint: `GET /healthz`**, unauthenticated, `Cache-Control: no-store`, returns `{status, uptimeSeconds, timestamp}`. Ideal for container healthchecks and post-deploy verification. Also `GET /ssl-test` → `ssl-ok`.
- **Port**: `const PORT = env.port` → `parsePositiveInt('PORT', 3000)`. Configurable via `PORT`, default 3000.
- **Bind address**: `app.listen(PORT, '0.0.0.0', …)` — **binds all interfaces**, so it is reachable from Caddy/nginx inside Docker. No localhost-binding problem.
- **Serves no static files.** The only `express.static` is guarded by `fs.existsSync("/var/www/certbot/.well-known/acme-challenge")`, which is false in the container, so the branch never activates. Caddy already answers ACME challenges itself (the Caddyfile comment says so explicitly). **nginx must serve the SPA.**
- **CORS**: `cors({origin: <allowlist callback>, credentials: true, exposedHeaders: ['Content-Disposition','Content-Type','Retry-After'], maxAge: 600, optionsSuccessStatus: 204})`. Requests with no `Origin` header are always allowed (`if (!origin) return callback(null, true)`), which covers same-origin navigation, `curl` and healthchecks. In production with `CORS_ORIGINS` unset the allowlist is empty — inert under same-origin serving.
- **trust proxy**: `app.set('trust proxy', env.trustProxy)`; `env.trustProxy` defaults to `1` in production. Correct for exactly one proxy hop. **With Caddy → nginx → backend there are two hops**, so `TRUST_PROXY` should be `2` if rate limiting and logging must see the real client IP. Flagging this: `express-rate-limit` keys on the client IP, and an incorrect hop count makes every request appear to come from the nginx container, collapsing all users into one rate-limit bucket.
- **Security headers**: `helmet` with a CSP whose `connectSrc: ["'self'"]` — another reason the API must be same-origin, since a cross-origin API would be blocked by the SPA's own CSP unless the directive changed. `hsts` enabled in production. CSP `scriptSrc` still allows `https://cdn.tailwindcss.com` and `cdnjs.cloudflare.com`, leftovers from the EJS era; harmless.
- **Hardcoded hostnames**: none found in the backend source. Host-specific values come from env (`GOOGLE_CALLBACK_URL`, `FRONTEND_URL`, `CORS_ORIGINS`). The only host-coupled value needing change for `opterite.in` is `GOOGLE_CALLBACK_URL` — and `backend/.env` already has `https://opterite.in/auth/google/callback`.
- Dedicated rate-limit buckets mounted ahead of the global limiter: `/send-email` (`sendLimiter`), `/status` and `/api/system-health` (`monitoringLimiter`).
- Body limits: `env.maxRequestBodyBytes` from `MAX_REQUEST_BODY_MB` (default 10 MB); uploads `MAX_UPLOAD_MB` (default 25 MB). Caddy's existing site allows 30 MB; the new site block needs the same allowance, and nginx needs `client_max_body_size` ≥ 30 MB or it will 413 before the app can answer usefully.
- Graceful shutdown on SIGTERM/SIGINT with a 25 s backstop; `module.exports = server`.

### 9. Existing Dockerfiles

**Local repo: none** (item 6).

**Server: `/opt/bulk-email-docker/Dockerfile`** — the precedent to follow. Verbatim operative content:

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=22.20.0

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install --no-install-recommends -y procps curl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node middleware ./middleware
COPY --chown=node:node models ./models
COPY --chown=node:node public ./public
COPY --chown=node:node routes ./routes
COPY --chown=node:node utils ./utils
COPY --chown=node:node views ./views
COPY --chown=node:node workprocess ./workprocess
COPY --chown=node:node app.js ./
RUN mkdir -p /app/uploads/sample /app/logs \
 && chown -R node:node /app/uploads /app/logs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "app.js"]
```

Header comment states the design intent plainly: "One image, two roles… Scale the worker with `docker compose up --scale worker=N` rather than baking PM2 into the image — the container runtime already supplies the process supervision and restart behaviour `ecosystem.config.js` was doing."

Two stages: `deps` (npm ci --omit=dev with a BuildKit npm cache mount) and `runtime`. Base `node:22.20.0-bookworm-slim` for both. Runs as the unprivileged `node` user. `procps` is installed because `routes/system-health.js` shells out via `systeminformation`; `curl` for the healthcheck. The healthcheck hits `/healthz`, which is why `web` containers report `(healthy)`.

**Differences the new backend image needs:** build context becomes `backend/` not the repo root; `views/` no longer exists and `public/` is no longer meaningful (the SPA replaces it); add `services/`; keep `config/ middleware/ models/ routes/ utils/ workprocess/ app.js`. Everything else transfers directly.

**`/opt/bulk-email-docker/.dockerignore`** (also a good precedent — it already excludes `.env`, `.env.*`, `dist`, `Dockerfile*`, `docker-compose*.yml`, `node_modules`, `logs`, `uploads/*`).

No Dockerfile exists anywhere else on the server; `/opt/bulk-email-sender` is the pre-Docker copy and has none.

### 10. Existing environment variables / configuration

**Local `backend/.env` keys** (values withheld except non-sensitive):

`REDIS_URL`, `PORT`, `NODE_ENV`, `MONGODB_URI`, `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `AUTHORIZED_USERS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `SESSION_SECRET`, `MAX_UPLOAD_MB`, `WORKER_CONCURRENCY`, `MAX_REQUEST_BODY_MB`, `TRUST_PROXY`, `BREVO_API_KEY`, `SMTP_FROM_EMAIL`, `DB_CLEANUP_DAYS`, `DB_CLEANUP_INTERVAL_HOURS`, `DB_CLEANUP_ENABLED`, `DB_CLEANUP_UPLOADED_FILES`, `DB_CLEANUP_BATCH_SIZE`, `DB_CLEANUP_MAX_DELETES_PER_RUN`

Non-sensitive values: `PORT=3000`, `NODE_ENV=development`, `TRUST_PROXY=1`, `REDIS_URL=redis://127.0.0.1:6379`, `GOOGLE_CALLBACK_URL=https://opterite.in/auth/google/callback`, `SMTP_FROM_EMAIL=niksdate0337@gmail.com`.

Two observations: `NODE_ENV=development` and `REDIS_URL=redis://127.0.0.1:6379` are dev values that **must** be overridden for production (compose `environment:` overrides `env_file:`, and `config/loadEnv.js` documents that real environment variables beat both — so the existing stack's pattern of forcing `NODE_ENV`/`REDIS_URL` in the compose `environment:` block works and should be reused). Also note `GOOGLE_CALLBACK_URL` is **already** set to `opterite.in` locally, while the server's is `opterite.com` — further evidence of a rebrand-to-`.in` in progress.

**Required vs optional**, cross-checked against `backend/config/env.js`:

| Variable | Status | Enforcement in `env.js` |
|---|---|---|
| `REDIS_URL` | **Required always** | `required('REDIS_URL')` |
| `MONGODB_URI` | **Required always** | `required('MONGODB_URI')` |
| `JWT_SECRET` | **Required**, ≥32 chars, no placeholder | `requiredSecret` — placeholder is **fatal in production** |
| `CREDENTIAL_ENCRYPTION_KEY` | **Required**, exactly 64 hex chars | `parseEncryptionKey` |
| `AUTHORIZED_USERS` | **Required**, `email:Name,…` | `parseAuthorizedUsers`; zero valid users is fatal |
| `BREVO_API_KEY` | **Required in production** | `requiredInProduction` |
| `SMTP_FROM_EMAIL` | **Required in production** | `requiredInProduction`; warns on free-mail domains — `gmail.com` **will** warn |
| `SESSION_SECRET` | Optional, ≥32 if set | `optionalSecret` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional (both ⇒ OAuth enabled) | `google.enabled` getter |
| `GOOGLE_CALLBACK_URL` | Optional; warns if `http://` in production | — |
| `PORT` | Optional, default 3000 | `parsePositiveInt` |
| `TRUST_PROXY` | Optional, default 1 in production | `parsePositiveIntOrZero` |
| `MAX_UPLOAD_MB` / `MAX_REQUEST_BODY_MB` / `WORKER_CONCURRENCY` | Optional; 25 / 10 / 20 | `parsePositiveInt` |
| `DB_CLEANUP_*` | Optional; `enabled=true`, `DAYS=3` (1–3650), `INTERVAL_HOURS=6`, `BATCH_SIZE=1000`, `MAX_DELETES_PER_RUN=250000` | `parseBoolean` / `parseIntInRange` |
| `CORS_ORIGINS` | Optional; **no production default** | `parseCorsOrigins` |
| `COOKIE_SAMESITE` | Optional, default `strict` | `parseCookieSameSite` |
| `FRONTEND_URL` | Optional; empty = same origin | `normalizeOrigin` |

`config/env.js` **throws and refuses to start** if any required check fails — a misconfigured Opterite container will crash-loop with an explicit list of problems in `docker logs`, which is the desired behaviour.

**Three variables are new in the refactored backend and absent from both `.env` files**: `CORS_ORIGINS`, `COOKIE_SAMESITE`, `FRONTEND_URL`. Under the recommended same-origin design all three can stay unset.

`frontend/.env`: single key `VITE_API_BASE_URL` (item 7). Both `.env` files are gitignored:

```
$ git check-ignore -v frontend/.env backend/.env
frontend/.gitignore:8:.env    frontend/.env
.gitignore:5:.env             backend/.env
```

Neither is tracked (`git ls-files` matching `.env` → empty). **The remote repo contains no env file, so secrets must be transferred out of band.** (The `frontend/.env` comment claims it is "Committed deliberately"; it is not, in fact, committed.)

**External runtime dependencies:**

| Dependency | Where it lives | Notes |
|---|---|---|
| **MongoDB** | **External — MongoDB Atlas.** Not a container. | `mongodb://<redacted>@ac-qawk0j7-shard-00-00.odb77cc.mongodb.net:27017,…-01…,…-02…/bulk-email-sender?<redacted>` — identical cluster **and database name** in both the server's `.env` and local `backend/.env`. |
| **Redis** | Container `bulk-email-sender-redis-1` (`redis:7.4-alpine`) in the existing stack. | AOF on, `maxmemory 8gb`, `maxmemory-policy noeviction`. Used for the Bull queue, login OTPs, rate-limit buckets, campaign stop markers, and the cleanup lock. |
| **SMTP / Brevo** | External SaaS (`BREVO_API_KEY`) for login OTP delivery. | Campaign sending uses operator-supplied SMTP credentials stored encrypted in Mongo. |
| **Google OAuth** | External, optional. | Callback URL must match the deployed hostname. |
| Host `mongod` | `127.0.0.1:27017`, running | **Unused by the application** — the app points at Atlas. Do not assume it is available or intended for Opterite. |

**Is there a reusable Redis/Mongo in the bulk-email-sender stack?** Technically yes for Redis (`bulk-email-sender-redis-1`, reachable as `redis:6379` on `bulk-email-sender_default`), and Mongo is Atlas so it is reachable from anywhere. **Both are listed as decisions, not resolved here** — see "Risks and open decisions". My recommendation and the tradeoffs are recorded there; the short version is that Redis **must** be separate for correctness, and Mongo **should** be a separate database for safety.

### 11. Available ports

`ss -tulpn` on the host:

```
tcp LISTEN 0.0.0.0:22        sshd
tcp LISTEN [::]:22           sshd
tcp LISTEN 0.0.0.0:80        docker-proxy      ← bulk-email-sender-caddy-1
tcp LISTEN [::]:80           docker-proxy      ← bulk-email-sender-caddy-1
tcp LISTEN 0.0.0.0:443       docker-proxy      ← bulk-email-sender-caddy-1
tcp LISTEN [::]:443          docker-proxy      ← bulk-email-sender-caddy-1
tcp LISTEN 127.0.0.1:27017   mongod            (host-local, unused by the app)
tcp LISTEN 127.0.0.54:53     systemd-resolve
tcp LISTEN 127.0.0.53%lo:53  systemd-resolve
tcp LISTEN 127.0.0.1:36269   code-07f806f999   (code-server)
tcp LISTEN 127.0.0.1:40621   MainThread        (code-server helper)
udp UNCONN 127.0.0.54:53     systemd-resolve
udp UNCONN 127.0.0.53%lo:53  systemd-resolve
```

Published container ports (`docker ps`): only `0.0.0.0:80->80`, `[::]:80->80`, `0.0.0.0:443->443`, `[::]:443->443`, all from Caddy. `3000/tcp` on web/worker and `6379/tcp` on redis are `expose`-only — no host binding.

**Host ports in use:** 22, 80, 443 (public); 53, 2019*, 27017, 36269, 40621 (loopback-only; *2019 is inside the Caddy container, not on the host).

**Recommended: publish NO new host ports.** This is feasible and is the better option, confirmed by items 2 and 4:

- Caddy is attached to `bulk-email-sender_default`, a compose-managed bridge network with embedded DNS (its own aliases prove name resolution works: `DNSNames: ["bulk-email-sender-caddy-1","caddy","6057a8976c03"]`).
- The existing site already proxies by **service name** (`dynamic a { name web }`), so name-based proxying on this network is proven in production.
- Therefore the Opterite nginx container can be reached as `reverse_proxy opterite-frontend:80` with no host binding at all. Nothing is exposed to the internet except through Caddy, which matches the existing stack's security posture ("Deliberately no `ports:` — only Caddy is reachable from the internet").

**How to bridge the networks — two options, one clear winner:**

- **Chosen: Opterite declares `bulk-email-sender_default` as an `external` network and attaches only its nginx container to it**, while backend↔nginx↔redis traffic uses Opterite's own private `opterite_default`. This touches **zero** existing containers, requires no restart of anything, and survives any future `docker compose up` on either project. The Opterite backend and Redis never join the shared network, so they remain unreachable from the bulk-email stack.
- **Rejected: `docker network connect opterite_default bulk-email-sender-caddy-1`.** It is hot and non-disruptive in the moment, but it mutates the *existing* production container's networking, and Compose does not know about it — the next `docker compose up -d` on `bulk-email-sender` would reconcile the container and silently drop the attachment, taking `opterite.in` down with no obvious cause. Avoid.

**If a host port is nonetheless wanted** (e.g. for direct debugging without going through Caddy), free and safe choices are **8081** for nginx and **8082** for the backend, bound to loopback only (`127.0.0.1:8081:80`) so nothing new is internet-facing. Not required, and not recommended as a permanent arrangement.

**Server capacity:**

```
$ df -h /
Filesystem  Size  Used Avail Use% Mounted on
/dev/root   464G   40G  425G   9% /

$ free -h
              total  used  free  shared  buff/cache  available
Mem:           62Gi  4.7Gi  57Gi   2.2Mi       1.0Gi       58Gi
Swap:            0B     0B    0B

$ nproc
16

$ docker system df
TYPE          TOTAL  ACTIVE  SIZE      RECLAIMABLE
Images            5       3  612.5MB   15.7MB (2%)
Containers       14      14  221.2kB   0B (0%)
Local Volumes     6       6  407.8MB   0B (0%)
Build Cache     109       0  1.209GB   297.5MB
```

`/var/lib/docker` is on the same `/dev/root` filesystem. **Ample headroom**: 425 GB free against an expected few GB for two images plus build cache (the existing backend image is 450 MB disk / 100 MB content; an nginx-served SPA image is tens of MB). RAM is 58 GB available against 4.7 GB in use by 14 containers. No swap, but with 58 GB free that is not a concern. `node:22.20.0-bookworm-slim` is **already present locally**, so the backend build will not even re-pull a base image. Disk is not tight; no flag needed.

---

## Answers to the explicit questions

### Is the existing `bulk-email-sender` deployment an older deployment of THIS SAME codebase?

**Yes. Confidently yes.** Evidence:

1. `head -8 /opt/bulk-email-docker/package.json` on the server:

```json
{
  "name": "opterite",
  "version": "1.0.0",
  "description": "Opterite — a bulk email platform with file upload, SMTP configuration, and real-time status tracking",
  "main": "app.js",
  "scripts": {
    "start": "dotenvx run -- concurrently \"node app.js\" \"node workprocess/mailer.js\"",
```

   This is **character-for-character identical** to local `backend/package.json` in name, version, description, main and the `start`/`dev` scripts.

2. Shared route files with the same names: server `routes/` has `auth.js`, `campaignQueue.js`, `imap.js`, `sendemails.js`, `system-health.js` — all present locally. Server `workprocess/` has exactly `mailer.js` and `queue.js`, same as local.

3. `backend/config/env.js` sets `const APP_NAME = 'Opterite'`, and the server's Caddyfile opens with "Reverse proxy / TLS terminator for Opterite."

4. The server's deployed `SITE_ADDRESS=opterite.com, www.opterite.com`.

**The difference is the frontend generation.** The server runs the EJS-rendered monolith — `views/` contains `404.ejs`, `file-upload.ejs`, `imapac.ejs`, `index.ejs`, `login.ejs`, and `routes/api.js` exists there but not locally. The local repo has **no `views/`**, has `routes/appConfig.js` + `routes/patterns.js` (new), adds `services/`, and adds the React SPA. Commit `06a765c refactor: restructure backend and add frontend` is that transition.

**Conclusion: this is a rebranded/refactored second instance of the same application, not a different product.** The user is deploying the React version at `opterite.in` alongside the live EJS version at `opterite.com`.

**Risk of the two instances fighting — concrete and serious:**

- **Shared MongoDB database — CONFIRMED.** Both `.env` files resolve to the same Atlas hosts `ac-qawk0j7-shard-00-{00,01,02}.odb77cc.mongodb.net:27017` **and the same database path segment `/bulk-email-sender`**. Two app generations would read and write the same collections. Because the refactor changed models (`routes/patterns.js`, `services/inboxPatternRenderer.js`, new inbox-pattern fields), schema drift between versions is likely.
- **Shared retention sweeper.** `app.js` calls `startCleanupScheduler()` in the **web** process, and `config/env.js` documents it "coordinates through a Redis lock so only one of the PM2 cluster instances actually sweeps." That lock lives in **Redis**, not Mongo. Two stacks on **separate** Redis instances therefore have **independent locks** — both sweepers would run against the **same Mongo database**, each deleting data older than `DB_CLEANUP_DAYS=3`. They would not corrupt each other (both are deleting the same expired rows), but it doubles the delete load and means Opterite's retention setting silently applies to production data. If Opterite's `DB_CLEANUP_DAYS` were ever set lower, **it would delete live production campaign data.** This is the sharpest edge of the shared-database problem.
- **Shared Bull queue — would happen only if Redis is shared.** `workprocess/queue.js`: `new Queue('emailQueue', { redis: redisOptions, … })`. The queue name is a hardcoded literal and **no `prefix` is set**, so Bull uses its default `bull` prefix and the key space is identical between the two deployments. With a shared Redis, Opterite's workers would pick up `bulk-email-sender` campaign jobs and vice versa — producing **duplicate sends to real recipients**, split status reporting, and cross-talk on stop markers (`isCampaignStopped`) and per-campaign tallies. Giving Opterite its own Redis container eliminates this entirely.
- **Shared rate-limit buckets and login OTPs** — same mechanism, same mitigation (separate Redis).

### DNS for `opterite.in`

Run from the server:

```
$ dig +short opterite.in
(no output)

$ dig opterite.in A +noall +answer +authority
opterite.in.  575  IN  SOA  ns71.domaincontrol.com. dns.jomax.net. 2026100200 28800 7200 604800 600

$ dig +short NS opterite.in
ns72.domaincontrol.com.
ns71.domaincontrol.com.

$ dig www.opterite.in +noall +answer
www.opterite.in.  574  IN  CNAME  opterite.in.
```

For comparison, the already-working domain:

```
$ dig +short opterite.com
213.136.89.187

$ dig +short www.opterite.com
opterite.com.
213.136.89.187
```

**No, `opterite.in` does not resolve to `213.136.89.187`.** The domain is registered and delegated to GoDaddy nameservers (`ns71/ns72.domaincontrol.com`), which answer authoritatively — but the apex has **no A record** (only an SOA in the authority section, the signature of NODATA). `www.opterite.in` is a CNAME to that unresolvable apex, so it is equally dead.

**This is a hard prerequisite.** Caddy's automatic HTTPS uses the ACME HTTP-01 challenge on port 80; Let's Encrypt must resolve `opterite.in` to this server and reach it. Until the A record exists:

- Adding the `opterite.in` site block and reloading Caddy will produce repeated certificate-issuance failures in the Caddy log.
- Let's Encrypt applies **failed-validation rate limits** (5 failures per account/hostname/hour), so repeated attempts delay eventual success.
- The existing `opterite.com` site is **not** affected — Caddy manages certificates per-site, and a failure for one hostname does not revoke or disturb another. The risk is noise and rate-limit burn, not an outage. Still, do not add the site block before DNS is live.

**Required DNS change (to be made by the user at GoDaddy):** `A  opterite.in  →  213.136.89.187`. The existing `www` CNAME then resolves automatically. Verify with `dig +short opterite.in` returning `213.136.89.187` from the server before touching Caddy.

### What hostnames does the existing Caddy serve, and would `opterite.in` collide?

Served today: **`opterite.com` and `www.opterite.com`**, and nothing else. From the live admin API:

```
"logs":{"logger_names":{"opterite.com":["log0"],"www.opterite.com":["log0"]}}
"match":[{"host":["opterite.com" …
```

**No collision, and no catch-all.** There is exactly one `srv0` listening on `:443` whose routes are gated by an explicit `host` matcher. There is no bare `:80` or `:443` site block and no wildcard (`*.opterite.com` or similar). Caddy routes by most-specific host match, so a new `opterite.in, www.opterite.in` block is fully independent — requests for `opterite.com` cannot fall into it and vice versa.

One nuance worth stating: the existing block's hostname is the **env placeholder** `{$SITE_ADDRESS}`, not a literal. The new block should use a **literal** `opterite.in, www.opterite.in` rather than introducing a second placeholder, because `SITE_ADDRESS` is already consumed by the bulk-email Caddy service and adding another variable would require editing that project's compose `environment:` block — which means recreating the production Caddy container. A literal avoids touching `docker-compose.prod.yml` entirely.

### Does the existing Caddy's Caddyfile come from a bind mount?

**Yes.**

- **Host path:** `/opt/bulk-email-docker/Caddyfile`
- **In-container path:** `/etc/caddy/Caddyfile`
- **Mount:** `{"Type":"bind","Source":"/opt/bulk-email-docker/Caddyfile","Destination":"/etc/caddy/Caddyfile","Mode":"ro","RW":false}`, declared in compose as `./Caddyfile:/etc/caddy/Caddyfile:ro`.

The `:ro` applies to the container's view only; the host file is `-rw-rw-rw-` and writable by root. Appending a site block to the host file and running `caddy reload` is sufficient — **no image rebuild, no container recreation, no restart.** Take a timestamped backup of the host file first so the change is trivially revertible (the previous operator already followed this habit — note `docker-compose.prod.yml.bak-20260930-085901`).

### Server capacity

See item 11 for raw output. **Yes, comfortably.** 425 GB of 464 GB free (9% used); 58 GB of 62 GB RAM available with 14 containers running; 16 CPUs. Existing Docker consumption is 612 MB images + 408 MB volumes + 1.2 GB build cache. Two more images (a ~450 MB backend sharing the already-present `node:22.20.0-bookworm-slim` base, and a small nginx+static frontend) and three more containers are negligible against this. **Disk is not tight; no flag required.** Builds should still be done on the server rather than cross-built locally, since the base image is already cached there.

### Where should the Opterite code live on the server?

**Proposal: `/opt/opterite`.**

```
$ ls -ld /opt/opterite
ls: cannot access '/opt/opterite': No such file or directory
```

**Confirmed it does not exist.** `/opt` currently holds only `bulk-email-docker`, `bulk-email-sender` and `containerd`. `/opt/opterite` is free, unambiguous, consistent with the existing convention, and clearly separate from both existing directories. Using the compose project name `opterite` means Docker will create the network `opterite_default`, which also does not collide with anything (only `bulk-email-sender_default` exists).

### How will the code get to the server?

- **`git` is installed:** `git version 2.43.0`.
- **The repo has a reachable remote:** `origin https://github.com/apekshathakre25/Email_Builder.git`, and the server can reach it anonymously — `curl` against `…/info/refs?service=git-upload-pack` returned **200**, so the repo is public and cloneable with no credentials.
- **But cloning is NOT viable as-is**, for two independent reasons:

  1. **The pushed branch is missing files the code requires.** `backend/utils/headerResolver.js` and `backend/utils/contentTransferEncoding.js` are **untracked**, yet tracked-and-modified files `require` them:

```
backend/routes/sendemails.js:27:  const { HeaderValidationError, parseCustomHeaders } = require('../utils/headerResolver');
backend/routes/sendemails.js:30:  } = require('../utils/contentTransferEncoding');
backend/workprocess/mailer.js:33: const { resolveCampaignHeaders } = require('../utils/headerResolver');
backend/workprocess/mailer.js:37: } = require('../utils/contentTransferEncoding');
```

     Those modified files are also uncommitted, so a clone of `origin/perf/large-campaign-freeze-phases-1-3a` would get the *older* versions that do not require the missing modules — meaning a clone builds a **different, older application** than the one in the working tree, silently. If the modified files were committed without the untracked ones, the backend would instead crash at startup with `MODULE_NOT_FOUND`. Either way, a clone does not reproduce the intended state.
  2. **No `.env` in the repo.** Both `.env` files are gitignored and untracked, so secrets must be transferred out of band regardless of the code-transfer method.

- **Viable method: copy from the local machine.** `scp`/`rsync` over the already-working `contabo-opterite` SSH alias, excluding `node_modules`, `.git`, `dist`, `logs`, `uploads`. This captures the exact working-tree state including the untracked files. On Windows, `scp -r` works out of the box; `rsync` requires WSL or Git Bash, so `scp` of a locally-built archive (or `tar` via SSH from WSL) is the dependable route.

  **Recommendation: commit the work first, then copy.** Specifically: `git add` the three untracked files and commit the pending modifications, so the deployed state is identified by a commit hash and is reproducible — then still deploy by file copy for this round (fastest, and avoids a server-side clone needing the branch pushed). Deciding whether to commit is the user's call; it is listed as a decision below. Note that committing is a **write** and was therefore not performed during this inspection.

---

## Risks and open decisions

These need the user's decision. I have given a recommendation and the tradeoff for each, but have deliberately **not** resolved them.

### D1 — DNS A record for `opterite.in` (BLOCKER, user action required)

No A record exists. **Recommendation:** add `A opterite.in → 213.136.89.187` at GoDaddy before any Caddy change; keep the existing `www` CNAME. **Tradeoff:** none — this is simply a prerequisite. **Impact if skipped:** the containers can still be built and started and verified over the internal network, but HTTPS for `opterite.in` cannot work and attempting it burns Let's Encrypt failure rate limit. The deployment can legitimately be done in two phases (build + start now, Caddy site block once DNS resolves).

### D2 — Redis: reuse or separate (strong recommendation: SEPARATE)

**Recommendation: give Opterite its own `redis:7.4-alpine` container on its own private network, with its own volume.** **Tradeoff:** ~30 MB more RAM at idle and one more container to operate — negligible. **Why reuse is not merely coupling but a correctness bug:** `new Queue('emailQueue', …)` in `backend/workprocess/queue.js` has a hardcoded name and no `prefix`, so a shared Redis means a shared Bull key space. Opterite's workers would consume production campaign jobs, causing **duplicate emails to real recipients**, corrupted per-campaign counters, and stop-markers that do not stop the right campaign. It would also share login-OTP and rate-limit keys. There is no safe way to reuse the existing Redis without a code change to add a queue `prefix`, which is out of scope for a deployment task. **This one I would treat as settled unless the user objects.**

### D3 — MongoDB: shared Atlas database (recommendation: SEPARATE DATABASE)

Both `.env` files currently point at the same Atlas cluster **and the same `/bulk-email-sender` database**. **Recommendation: change only the database name in Opterite's `MONGODB_URI`** — e.g. `…mongodb.net:27017/opterite?…`, same cluster, same credentials, different database. **Tradeoff:** Opterite starts with an **empty** database — no existing campaigns, logs, saved SMTP/IMAP credentials or inbox-test history, and operators would re-enter their email configuration. If the intent is for `opterite.in` to be the **same live service** under a new domain with all existing data, then the database must stay shared, and the consequences in D4 must be accepted. **This is genuinely the user's call, because it hinges on intent I cannot infer:** is `opterite.in` a fresh parallel instance, or the new front door to the existing data? Note that a middle path exists (Atlas-side copy of `bulk-email-sender` into `opterite`), which gives Opterite the existing data without ongoing coupling; it is the best option if the answer is "same data, but independent going forward."

### D4 — If the Mongo database stays shared: the retention sweeper (safety issue)

If D3 is resolved as "keep sharing", then two independent cleanup schedulers run against one database, because the coordinating lock lives in Redis and Redis is being separated (D2). **Recommendation in that case: set `DB_CLEANUP_ENABLED=false` on the Opterite web container**, leaving the existing production stack as the single sweeper. **Tradeoff:** none meaningful — the data still gets swept, just by one owner. **Impact if ignored:** doubled delete load, and — more dangerous — Opterite's `DB_CLEANUP_DAYS` would silently govern deletion of **live production** data. If D3 is resolved as "separate database", this decision disappears and Opterite can keep cleanup enabled.

### D5 — Is this a second instance, or a replacement?

Established as the same codebase, two generations (see Answers). **Recommendation: deploy as a genuinely independent second instance** (own Redis, own database per D3) and treat `opterite.com` as untouched legacy until the user decides to cut over. **Tradeoff:** two stacks to operate, and two sets of operator-entered SMTP credentials. **The alternative** — treating `opterite.in` as the new front end over shared production data — is the riskier shape, since the React version is a refactor with model changes (`routes/patterns.js`, inbox-pattern fields, `services/inboxPatternRenderer.js`) and running two schema generations against one database invites drift. The user should confirm the intent explicitly; it determines D3 and D4.

### D6 — How the code reaches the server

**Recommendation: commit the pending work (including the two untracked `backend/utils/` modules), then transfer the working tree by `scp`/`tar`-over-SSH**, excluding `node_modules`, `.git`, `dist`, `logs`, `uploads`. **Tradeoff:** a copy-based deploy has no provenance on the server (which is exactly the situation `/opt/bulk-email-docker` is in — no `.git`), so committing first is what preserves reproducibility. **Why not a plain server-side `git clone`:** the current working tree is not represented by any commit, and the untracked modules it requires are not in the remote, so a clone yields either an older application or a `MODULE_NOT_FOUND` crash. **Why not skip committing:** then the deployed state is unidentifiable. Committing is a write operation and was not performed here.

### D7 — `TRUST_PROXY` with two proxy hops

With Caddy → nginx → backend, there are two hops, but `TRUST_PROXY=1` in both `.env` files and the existing compose forces `"1"`. **Recommendation: set `TRUST_PROXY=2` for the Opterite backend.** **Tradeoff:** if nginx is later removed from the path, 2 becomes wrong in the other direction. **Impact if left at 1:** `express-rate-limit` would key every request on the nginx container's IP, collapsing all users into a single rate-limit bucket — so one busy operator could 429 everyone, and the dedicated `/send-email` bucket would be shared rather than per-client. Low severity, easy to get right, worth deciding deliberately. (An alternative is to have Caddy proxy the API path directly to the backend, keeping one hop for API traffic — see the note in the plan.)

### D8 — Frontend/API routing split: nginx or Caddy

Because the API occupies the root namespace and `GET`/`POST /login` collide, the split must be explicit and method-aware. **Recommendation: put the split in nginx inside the Opterite project**, and give the shared Caddyfile a single simple site block that proxies everything for `opterite.in` to `opterite-frontend:80`. **Tradeoff:** one extra proxy hop for API calls (hence D7). **Why:** it keeps all Opterite-specific routing in Opterite's own repo and reduces the edit to the **shared** production Caddyfile to the smallest, lowest-risk form — which matters because that file is read by the container serving live `opterite.com` traffic. Putting a long matcher list in the shared Caddyfile would mean every future Opterite route change requires editing production config and reloading the shared Caddy. **The user may prefer the opposite** if they would rather avoid the second hop.

### D9 — `SMTP_FROM_EMAIL` on a free-mail domain (pre-existing, informational)

`SMTP_FROM_EMAIL=niksdate0337@gmail.com` in both env files. `config/env.js` will emit a startup warning: Brevo accepts it only if that exact address is verified under Senders, and it "can never be SPF/DKIM-aligned for gmail.com, so expect spam-foldering or rejection." This affects **login OTP delivery**, not campaign sending. It is pre-existing and already the case in production, so it is not a deployment blocker — noted so the warning in `docker logs` is not mistaken for a new fault. **Recommendation:** eventually move to an address on a domain the user controls and has authenticated in Brevo.

---

## Recommended deployment plan (proposal only, NOT executed)

### Target architecture

```
                         Internet
                            │
                            │ :80 / :443   (existing Caddy, unchanged binding)
                            ▼
              ┌──────────────────────────────────┐
              │   bulk-email-sender-caddy-1      │  ← ONLY change: one new site
              │   /opt/bulk-email-docker/Caddyfile│    block appended + hot reload
              └───────┬──────────────────┬───────┘
                      │                  │
         opterite.com │                  │ opterite.in, www.opterite.in
      (UNCHANGED)     │                  │ (NEW)
                      ▼                  ▼
   ┌──────────────────────────┐   ┌──────────────────────────────┐
   │ network                  │   │ opterite-frontend  (nginx)   │
   │ bulk-email-sender_default│   │  joined to BOTH networks     │
   │  web ×4 ─► redis         │◄──┤  serves SPA + proxies API    │
   │  worker ×8               │   └──────────┬───────────────────┘
   └──────────────────────────┘              │ (private)
                                              ▼
                       ┌───────────────────────────────────────────┐
                       │ network: opterite_default  (NEW, private) │
                       │   opterite-backend  (node app.js, :3000)  │
                       │   opterite-worker   (node workprocess/…)  │
                       │   opterite-redis    (redis:7.4-alpine)    │
                       └───────────────┬───────────────────────────┘
                                       ▼
                             MongoDB Atlas (same cluster,
                             database per decision D3)
```

Only `opterite-frontend` straddles the two networks. The Opterite backend, worker and Redis are **not** reachable from the bulk-email stack.

### Files to create

**Local (in `d:\Bulk Email`), all new:**

| Path | Purpose |
|---|---|
| `backend/Dockerfile` | Multi-stage, modelled on `/opt/bulk-email-docker/Dockerfile`: `node:22.20.0-bookworm-slim`, `deps` stage with `npm ci --omit=dev`, runtime stage installing `procps` + `curl`, copying `config middleware models routes services utils workprocess app.js`, `USER node`, `EXPOSE 3000`, `HEALTHCHECK` on `/healthz`, `CMD ["node","app.js"]`. Omit `views/` and `public/` (gone in the refactor); **add `services/`** (new). |
| `backend/.dockerignore` | Port of the server's, adjusted: exclude `node_modules`, `.env`, `.env.*`, `logs`, `uploads/*`, `tests`, `ecosystem.config.js`, `Dockerfile*`, `.dockerignore`. |
| `frontend/Dockerfile` | Stage 1 `node:22.20.0-bookworm-slim`: `npm ci`, then `ARG VITE_API_BASE_URL=""` → `ENV` → `npm run build` → `/app/dist`. Stage 2 `nginx:1.27-alpine`: copy `dist` to `/usr/share/nginx/html`, copy `nginx.conf`. |
| `frontend/.dockerignore` | **Must exclude `.env`** (otherwise Vite bakes `http://localhost:3000` — see item 7), plus `node_modules`, `dist`, `Dockerfile*`, `.dockerignore`. |
| `frontend/nginx.conf` | The routing split (below). |
| `docker-compose.yml` | Opterite production stack, `name: opterite`. |
| `.env.opterite.example` | Documents the required keys for the new stack without secrets. |

**Remote, to be created:**

| Path | Purpose |
|---|---|
| `/opt/opterite/` | New project directory (confirmed absent). |
| `/opt/opterite/backend/`, `/opt/opterite/frontend/` | Copied source. |
| `/opt/opterite/docker-compose.yml` | Copied. |
| `/opt/opterite/.env` | **Created by hand on the server, mode 600.** Never committed, never copied in a world-readable way. |

**Remote, to be modified — exactly one file:**

| Path | Change |
|---|---|
| `/opt/bulk-email-docker/Caddyfile` | **Append one new site block.** The existing global options block and the `{$SITE_ADDRESS}` block are left byte-identical. Back up first to `/opt/bulk-email-docker/Caddyfile.bak-<timestamp>`. |

**Explicitly NOT touched:** `/opt/bulk-email-docker/docker-compose.prod.yml`, `/opt/bulk-email-docker/.env`, `/opt/bulk-email-docker/Dockerfile`, any file under `/opt/bulk-email-docker/{app.js,config,routes,models,middleware,utils,views,public,workprocess}`, all `bulk-email-sender_*` volumes, all 14 existing containers, `/opt/bulk-email-sender`.

### Required ports

**No new host ports.** Nothing new binds to the host. 80 and 443 remain owned solely by `bulk-email-sender-caddy-1`. Internal only:

- `opterite-frontend` listens on container port 80 (reached by Caddy by name)
- `opterite-backend` listens on container port 3000 (reached by nginx by name)
- `opterite-redis` listens on 6379 (reached by backend and worker by name)

All three use `expose`, never `ports`, mirroring the existing stack's posture.

### Required Docker networks

- **`opterite_default`** — new, created automatically by Compose from `name: opterite`. Carries frontend↔backend↔redis. Verified non-colliding (`docker network ls` shows only `bulk-email-sender_default`).
- **`bulk-email-sender_default`** — declared in Opterite's compose as **`external: true`**, with **only `opterite-frontend` attached**, so the existing Caddy can reach it by name. Declaring it external means Compose will **never create, modify or remove** it.

**Service naming constraint (critical):** no Opterite service on the shared network may be named or aliased `web`, `worker`, `redis` or `caddy`. The existing Caddyfile's `dynamic a { name web }` resolves the bare name `web` on that network and would route live `opterite.com` traffic into any container answering to it. Use `opterite-frontend`, `opterite-backend`, `opterite-worker`, `opterite-redis`. Only `opterite-frontend` is on the shared network anyway, which limits the exposure, but the naming discipline should hold throughout.

### The routing split (`frontend/nginx.conf`)

Resolves the root-namespace collision from item 8. Shape:

```nginx
client_max_body_size 30M;          # must match Caddy's 30MB and exceed MAX_UPLOAD_MB=25

# POST /login → backend;  GET /login → SPA.  (See item 8.)
location = /login {
    error_page 418 = @api;
    if ($request_method = POST) { return 418; }
    try_files /index.html =404;
}

# Unambiguous API prefixes → backend
location ~ ^/(api|auth|imap|campaign-lane|email-config|recipients|send-email|stop-sending|
              status|logs|logs-stats|log-download|files|files-stats|send-otp|logout|
              check-auth|healthz|ssl-test)(/|$) { ... proxy_pass ... }

location @api {
    proxy_pass http://opterite-backend:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP         $remote_addr;
}

# SPA fallback for /, /file-manager, /imap-accounts and any client route
location / {
    try_files $uri $uri/ /index.html;
}
```

The API prefix list is derived from the enumeration in item 8 and must be reviewed against it line by line when written; a missed prefix presents as the SPA's `NotFoundPage` rendering where an API response was expected. `/healthz` is routed to the backend so it can be curled through the public hostname for verification.

> **Alternative worth noting (ties to D7/D8):** Caddy could proxy the API prefixes straight to `opterite-backend:3000` and send only SPA traffic to nginx, keeping API traffic at one proxy hop so `TRUST_PROXY=1` stays correct. The cost is a much larger edit to the **shared** production Caddyfile and a production reload for every future route change. I recommend the nginx-owned split with `TRUST_PROXY=2`.

### Caddy site block to append

Appended to `/opt/bulk-email-docker/Caddyfile`, after the existing block, leaving it untouched:

```caddyfile
# ── Opterite (opterite.in) ──────────────────────────────────────────────
# Separate compose project (/opt/opterite). Reached over the shared
# bulk-email-sender_default network by container name; publishes no host
# ports. Literal hostnames deliberately — SITE_ADDRESS belongs to the
# block above and adding a second variable would require recreating this
# container.
opterite.in, www.opterite.in {
	request_body {
		max_size 30MB
	}
	reverse_proxy opterite-frontend:80
	log {
		output file /var/log/caddy/opterite-in-access.log {
			roll_size 20MB
			roll_keep 5
		}
	}
}
```

A static `reverse_proxy` is correct here (unlike the existing block's `dynamic a`) because `opterite-frontend` is a single replica, not a scaled service. `ACME_EMAIL` from the existing global options block applies to this site too, so certificate registration needs no extra config.

### Exact ordered deployment steps

**Phase 0 — prerequisites (user action, no server changes)**

1. Resolve decisions **D2** (separate Redis — recommended as settled), **D3** (database name), **D4** (cleanup flag, only if D3 keeps sharing), **D6** (commit then copy), **D7** (`TRUST_PROXY=2`), **D8** (nginx-owned split).
2. Add the DNS A record: `opterite.in → 213.136.89.187` at GoDaddy. Confirm from the server:

```bash
ssh contabo-opterite "dig +short opterite.in"        # must print 213.136.89.187
ssh contabo-opterite "dig +short www.opterite.in"    # must resolve via the CNAME
```

   Do not proceed to Phase 4 until both resolve.

**Phase 1 — author artifacts locally (no server contact)**

3. Create the seven local files listed above.
4. Verify the frontend builds and bakes a same-origin base URL:

```bash
cd frontend && npm ci && VITE_API_BASE_URL= npm run build
grep -r "localhost:3000" dist/ || echo "OK: no localhost baked in"
```

5. Commit the pending work including the two untracked `backend/utils/` modules (per D6), so the deployed state has a commit hash.

**Phase 2 — stage code on the server (additive only)**

6. Create `/opt/opterite` and copy `backend/`, `frontend/`, `docker-compose.yml`, excluding `node_modules`, `.git`, `dist`, `logs`, `uploads`, `.env`.
7. Create `/opt/opterite/.env` by hand, `chmod 600`. Required keys (from item 10): `MONGODB_URI` (database name per D3), `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` (64 hex), `AUTHORIZED_USERS`, `BREVO_API_KEY`, `SMTP_FROM_EMAIL`, and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALLBACK_URL=https://opterite.in/auth/google/callback` if OAuth is wanted. **Generate fresh `JWT_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`** rather than reusing production's — unless the shared-database path in D3 is chosen, in which case `CREDENTIAL_ENCRYPTION_KEY` **must** match production or the stored SMTP/IMAP credentials will not decrypt. Compose supplies `NODE_ENV=production`, `REDIS_URL=redis://opterite-redis:6379`, `TRUST_PROXY=2` via the `environment:` block so the dev values in the copied file cannot leak through.
8. Sanity-check the compose file **without starting anything** (read-only, prints the resolved config):

```bash
ssh contabo-opterite "docker compose -f /opt/opterite/docker-compose.yml config"
```

   Confirm: project name `opterite`, `bulk-email-sender_default` marked external, no `ports:` on any service, no service named `web`/`redis`/`worker`.

**Phase 3 — build and start ONLY the new containers**

9. Build:

```bash
ssh contabo-opterite "cd /opt/opterite && docker compose build"
```

   This creates new images only. It cannot affect `bulk-email-sender:latest` — a different project, a different image tag, a different build context.
10. Start:

```bash
ssh contabo-opterite "cd /opt/opterite && docker compose up -d"
```

   Scoped to `/opt/opterite/docker-compose.yml`, so Compose only reconciles project `opterite`. **It will not touch the 14 existing containers.**
11. Confirm the existing stack is untouched before going further:

```bash
ssh contabo-opterite "docker ps --format '{{.Names}}|{{.Status}}' | grep bulk-email"
```

   Expect all 14 still `Up`, the 4 `web` still `(healthy)`, redis `(healthy)`, and uptimes **continuous** (not reset).
12. Verify Opterite internally, before any public exposure:

```bash
# backend health, from inside the Opterite network
ssh contabo-opterite "docker exec opterite-backend curl -fsS http://127.0.0.1:3000/healthz"
# frontend serves the SPA
ssh contabo-opterite "docker exec opterite-frontend wget -qO- http://127.0.0.1/ | head -20"
# the API reaches through nginx
ssh contabo-opterite "docker exec opterite-frontend wget -qO- http://127.0.0.1/healthz"
# Caddy can resolve and reach the frontend over the shared network
ssh contabo-opterite "docker exec bulk-email-sender-caddy-1 wget -qO- http://opterite-frontend:80/healthz"
```

   The last command is the decisive one: it proves the cross-network path works **before** any Caddyfile change. If it fails, fix the network wiring and do not touch Caddy.
13. Check for startup config errors:

```bash
ssh contabo-opterite "docker logs --tail 50 opterite-backend"
```

   `config/env.js` throws with an explicit problem list on misconfiguration. Expect the known free-mail `SMTP_FROM_EMAIL` warning (D9).

**Phase 4 — integrate into the existing Caddy (the one disruptive-adjacent step)**

14. Back up the live Caddyfile:

```bash
ssh contabo-opterite "cp /opt/bulk-email-docker/Caddyfile /opt/bulk-email-docker/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
```

15. Append the new site block to `/opt/bulk-email-docker/Caddyfile`, leaving existing content byte-identical. Diff against the backup to prove only an append occurred:

```bash
ssh contabo-opterite "diff /opt/bulk-email-docker/Caddyfile.bak-<ts> /opt/bulk-email-docker/Caddyfile"
```

   Expect only added lines (`>`), never changed or removed ones.
16. **VALIDATE BEFORE RELOADING** — confirmed working during this inspection:

```bash
ssh contabo-opterite "docker exec bulk-email-sender-caddy-1 caddy validate --config /etc/caddy/Caddyfile"
```

   Must end with `Valid configuration`. **If it does not, restore the backup and stop.** `caddy validate` builds a throwaway config in-process and does not disturb the running server, so this is safe. Note it will not catch a bad `{$SITE_ADDRESS}` interpolation, since validate runs without the compose environment — another reason the new block uses literal hostnames.
17. Hot reload (zero downtime, no container restart):

```bash
ssh contabo-opterite "docker exec bulk-email-sender-caddy-1 caddy reload --config /etc/caddy/Caddyfile"
```

   This uses the admin API on `127.0.0.1:2019` (confirmed live). Caddy swaps config in place; `opterite.com` connections are not dropped. **Do not** use `docker compose restart caddy` or `docker compose up -d` — either would recreate the production container.
18. Watch certificate issuance for the new hostname:

```bash
ssh contabo-opterite "docker logs --tail 80 bulk-email-sender-caddy-1"
```

   Expect ACME success for `opterite.in` and `www.opterite.in`. If DNS is not yet live this is where failures appear — revert the Caddyfile from the backup and reload rather than leaving it to retry.

**Phase 5 — post-deploy verification**

19. Frontend over HTTPS, with a valid certificate:

```bash
curl -sS -I https://opterite.in
curl -sS -I https://www.opterite.in
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://opterite.in
curl -sS -I http://opterite.in            # expect 308 redirect to HTTPS
```

   Expect `200` for the SPA shell and `ssl_verify_result 0`. Also confirm an SPA deep link does not 404, which proves the nginx fallback:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://opterite.in/file-manager   # expect 200
```

20. Backend/API through the public hostname:

```bash
curl -sS https://opterite.in/healthz
# expect {"status":"ok","uptimeSeconds":N,"timestamp":"..."}
curl -sS https://opterite.in/ssl-test                 # expect: ssl-ok
curl -sS -o /dev/null -w '%{http_code}\n' https://opterite.in/api/app-config   # expect 200
curl -sS -o /dev/null -w '%{http_code}\n' https://opterite.in/status           # expect 401 (auth works)
```

   A `401` on `/status` is the **desired** result: it proves the request reached the authenticated backend router rather than falling through to the SPA. A `200` with HTML would mean the nginx prefix list is wrong.

21. **Existing application still healthy — the most important check:**

```bash
ssh contabo-opterite "docker ps --format '{{.Names}}|{{.Status}}' | grep bulk-email"
curl -sS https://opterite.com/healthz
curl -sS -o /dev/null -w 'opterite.com -> %{http_code}\n' https://opterite.com/healthz
curl -sS -o /dev/null -w 'www -> %{http_code}\n' https://www.opterite.com/healthz
```

   Expect all 14 containers `Up` with **uninterrupted** uptimes, `web` replicas `(healthy)`, and `opterite.com` returning `200` with `{"status":"ok",...}`. Baseline captured during this inspection for comparison:

```
opterite.com -> 200
{"status":"ok","uptimeSeconds":165041,"timestamp":"2026-10-02T04:15:24.885Z"}
```

   `uptimeSeconds` must be **larger** than this baseline, not reset — a reset would mean a production container was restarted.

22. Confirm no new host port was opened and port ownership is unchanged:

```bash
ssh contabo-opterite "ss -tulpn | grep -E ':(80|443)\s'"
ssh contabo-opterite "docker ps --format '{{.Names}}|{{.Ports}}' | grep -v '^opterite'"
```

   Expect 80/443 still owned by `docker-proxy` for the bulk-email Caddy, and no Opterite container publishing anything.

### Rollback

Fully reversible at every phase, and no step modifies production data:

- **Caddy change:** restore `/opt/bulk-email-docker/Caddyfile` from the timestamped backup, `caddy validate`, then `caddy reload`. `opterite.com` is unaffected throughout.
- **Opterite stack:** `cd /opt/opterite && docker compose down` — scoped to project `opterite`, so it removes only Opterite's containers and network. (This is the one legitimate use of `down`; it must always carry `-f /opt/opterite/docker-compose.yml` or be run from `/opt/opterite`, never from `/opt/bulk-email-docker`.)
- **Images:** `docker image rm opterite-backend opterite-frontend` if desired. Never `docker system prune` — it would reclaim the existing stack's 1.2 GB build cache and any dangling layers it depends on.

### Open gaps I could not determine

- **Whether `opterite.in` is intended to carry the existing production data.** This is intent, not something the codebase reveals. It drives D3/D4 and is the single most consequential unanswered question.
- **Whether the Atlas user's credentials permit creating/writing a second database** (`opterite`) on that cluster. The connection string's credentials were not read and no connection was attempted, so Atlas-side role scope is unverified. If D3 chooses a separate database, this needs confirming in the Atlas UI before Phase 3 — a role scoped to `bulk-email-sender` only would make the Opterite backend fail to authenticate at startup.
- **Whether the Atlas project's IP access list already permits `213.136.89.187`.** It must, since production connects from this host, so a second stack on the same host should be fine. Not independently verified.
- **The exact complete set of API path prefixes** needed in `nginx.conf` was derived from the route enumeration in item 8. That enumeration came from a regex over `router.<method>('<path>')` calls and should be re-checked against the route files when the config is actually written, in case any route is registered dynamically or via a variable.
- **Google OAuth client configuration.** Whether the OAuth client in Google Cloud has `https://opterite.in/auth/google/callback` registered as an authorised redirect URI could not be checked from here. If not, Google login will fail with `redirect_uri_mismatch` even though the app is configured correctly.
