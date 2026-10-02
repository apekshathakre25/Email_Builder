# Opterite deployment bundle

This bundle describes a future Opterite deployment. Preparing or validating
these files does not deploy the project or change the existing Caddy service.

## Architecture

```text
Existing Caddy (keeps ownership of host ports 80/443)
    |
    | existing bulk-email-sender_default Docker network
    v
opterite-edge (nginx:1.27-alpine; no published host ports)
    | serves the production Vite build from /usr/share/nginx/html
    | proxies selected backend methods and paths
    v
opterite-api (Node app.js, internal port 3000)
    |                     |
    | private Redis       +--> MongoDB Atlas database: opterite
    v
opterite-redis (redis:7.4-alpine)

opterite-worker (node workprocess/mailer.js) also uses private Redis.
```

The `opterite-private` network connects `opterite-edge`, `opterite-api`,
`opterite-worker`, and `opterite-redis`. The edge must join this network to
proxy to the API. Only `opterite-edge` also joins the pre-existing external
`bulk-email-sender_default` network. The API, worker, and Redis do not join that
shared network; in particular, the API is not exposed to the Bulk Email Sender
network. Redis has no host port, and both API and worker use
`REDIS_URL=redis://opterite-redis:6379`.

No Opterite service publishes a host port. Caddy remains the sole owner of
ports 80/443 and reaches Nginx at `opterite-edge:80` over the existing network.
No Caddy volume or additional Caddy network is part of this bundle.

## Frontend and routing

`Dockerfile.edge` builds the React frontend with Vite in production mode and
copies only `frontend/dist` into `nginx:1.27-alpine`. The build sets an empty
`VITE_API_BASE_URL`, so browser API and auth requests remain same-origin. The
frontend source, development server, and Vite preview server are not served in
production.

`nginx.conf` serves static files and falls back to `index.html` for React
routes. Backend routing is method/path-aware: `GET /login` serves the React
SPA, while `POST /login` reaches Node. The root-level auth, status, email,
campaign, logs, files, IMAP, health, OAuth, and `/api/...` routes used by the
frontend are proxied without assuming all API paths start with `/api`.

## Secrets and persistent data

Copy `.env.example` to `.env` on the deployment host and replace all example
values with Opterite-specific production values. Keep `.env` out of source
control and out of images. `MONGODB_URI` must select the MongoDB Atlas database
`opterite`; use a dedicated least-privilege MongoDB user and do not reuse the
Bulk Email Sender database credentials or database.

The API and worker share the named `opterite-uploads` volume. Redis data is kept
in `opterite-redis-data`, which is accessible only to the Redis container on
`opterite-private`.

## Future deployment sequence

Run these steps only in a separately approved deployment window. None of them
is part of local bundle preparation.

1. Copy this self-contained deployment bundle to `/opt/opterite` and securely
   create `/opt/opterite/.env` from `.env.example`. Generate unique JWT and
   encryption secrets, and set the approved MongoDB Atlas URI with database
   path `/opterite`.
2. Confirm that the existing `bulk-email-sender_default` network exists. Do not
   attach the API, worker, or Redis to it. Compose creates the private
   `opterite-private` network.
3. Validate the Compose configuration, then build and start only this Opterite
   Compose project during the approved window. The edge image builds the
   production frontend and Nginx image; the API image runs `node app.js`, and
   the worker runs `node workprocess/mailer.js`.
4. Add `Caddyfile.opterite.snippet` as a future additive site block for
   `opterite.in` and `www.opterite.in`. Caddy reverse proxies to
   `opterite-edge:80` using its existing membership in
   `bulk-email-sender_default`. Do not replace existing site blocks or modify
   the production Caddyfile as part of this bundle.
5. Verify frontend hard refreshes (including `/login`), OTP/login, authenticated
   APIs, Google OAuth if enabled, email delivery, Redis health, Atlas database
   selection, and that existing Caddy sites remain unaffected.

## Bundle files

- `compose.yaml` defines exactly `opterite-edge`, `opterite-api`,
  `opterite-worker`, and `opterite-redis`.
- `Dockerfile.edge` builds the production Vite output and packages Nginx plus
  the routing configuration.
- `Dockerfile` builds the production Node backend image shared by API and
  worker.
- `nginx.conf` routes frontend requests and selected backend paths/methods.
- `Dockerfile.dockerignore` limits the API image build context to runtime
  backend files; `Dockerfile.edge.dockerignore` limits the frontend build
  context and excludes local environment files.
- The bundle includes only the backend runtime source and frontend build source
  needed by these Dockerfiles. Both image builds use `/opt/opterite` as their
  context and do not require the repository root or sibling application
  directories on the server.
- `.env.example` documents server-only runtime variables without real
  credentials.
- `Caddyfile.opterite.snippet` is the future additive reverse-proxy site block;
  it does not configure Caddy networks, volumes, or host ports.
