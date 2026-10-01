# Opterite

Bulk email platform. Two applications in one repository, talking over HTTP.

```
┌──────────────────────────┐
│   frontend/              │   React 19 · Vite 8 · Tailwind 4
│   React SPA              │   static bundle, no server of its own
└────────────┬─────────────┘
             │  HTTP + httpOnly cookie auth
             ▼
┌──────────────────────────┐
│   backend/               │   Node 22 · Express 5
│   API · worker           │   email sending · rate limiting · background jobs
└────────────┬─────────────┘
       ┌─────┴─────┐
       ▼           ▼
   MongoDB       Redis
```

## Layout

| Path | What it is |
| --- | --- |
| `backend/` | The Node/Express API and the Bull queue worker. Own `package.json`, lockfile, `node_modules`, `.env`, `Dockerfile` and PM2 config. |
| `frontend/` | The React SPA. Builds to static files; serves no requests itself. |
| `docker-compose.yml` | Local/self-hosted stack: web, worker, Redis, Mongo. |
| `docker-compose.prod.yml` | Single-VPS stack: web, worker, Redis, Caddy (TLS). Mongo is external. |
| `Caddyfile` | Reverse proxy and TLS config, used by the production compose file. |

The compose files and `Caddyfile` stay at the root because they orchestrate the
whole stack rather than belonging to either application. The `Dockerfile` and
`.dockerignore` live in `backend/`, because they build the backend's image and a
`.dockerignore` is only honoured next to its build context.

## Quick start

MongoDB and Redis need to be reachable — `docker compose up -d mongo redis` is
enough for development.

```bash
npm run install:all      # installs backend/ and frontend/

# two terminals
npm run backend          # API + worker on http://localhost:3000
npm run frontend         # SPA on http://localhost:5173
```

Open <http://localhost:5173>.

### Root scripts

The root `package.json` has no dependencies — it only forwards to the two
applications, so the entry points that used to work at the root still do.

| Command | Runs |
| --- | --- |
| `npm run install:all` | `npm install` in both applications |
| `npm run backend` | `backend`: API + worker with `concurrently` |
| `npm run frontend` | `frontend`: Vite dev server |
| `npm start` | `backend`: production start |
| `npm test` | `backend`: the Node test suite |
| `npm run build` | `frontend`: production bundle into `frontend/dist` |
| `npm run lint` | `frontend`: ESLint |

Anything not listed is still available inside each folder — `cd backend && npm run worker`,
for instance.

## Configuration

Each application owns its own environment file, and they are not
interchangeable:

| File | Contents | Committed |
| --- | --- | --- |
| `backend/.env` | Database URIs, JWT and encryption secrets, authorized users, Brevo and Google credentials, CORS and cookie settings. | No |
| `backend/.env.example` | Documents every backend variable. | Yes |
| `frontend/.env.development` | `VITE_API_BASE_URL` only. Nothing secret — everything here is compiled into the bundle. | Yes |

`backend/.env` is resolved from the backend directory rather than the working
directory (`backend/config/loadEnv.js`), so `cd backend && node app.js`,
`node backend/app.js` and PM2 all read the same file. A `.env` at the repository
root is also accepted as a fallback, for a deployment that prefers one
stack-level file; `backend/.env` wins where both define a key.

Three backend variables exist specifically because the frontend is served
separately — `CORS_ORIGINS`, `FRONTEND_URL` and `COOKIE_SAMESITE`. All have safe
defaults, but `FRONTEND_URL` is required for Google login and `CORS_ORIGINS` is
required in production when the two are on different origins. See
[`frontend/README.md`](frontend/README.md#backend-requirements) for the details
and a worked production example.

## Deployment

```bash
# Local / self-hosted
docker compose up -d --build
docker compose up -d --scale worker=4

# Production (single VPS, Caddy terminates TLS)
docker compose --env-file backend/.env -f docker-compose.prod.yml up -d --build
```

**`--env-file backend/.env` is required for the production file.** Two different
mechanisms read the env file and only one follows the `env_file:` key: compose
interpolates `${SITE_ADDRESS}` and `${ACME_EMAIL}` for the Caddy service *before*
any container exists, and for that it looks for `.env` in the directory holding
the compose file. The flag points it at `backend/.env` instead. Without it,
compose stops with a message naming `SITE_ADDRESS` rather than starting
misconfigured.

The frontend is not in the backend image. Build it (`npm run build`) and serve
`frontend/dist` as static files. Serving it from the same origin as the API is
the simplest arrangement: no CORS, and `SameSite=Strict` cookies keep working.
A catch-all rewrite to `index.html` is needed so client-side routes survive a
refresh — see [`frontend/README.md`](frontend/README.md#deployment).

## Documentation

- [`frontend/README.md`](frontend/README.md) — SPA architecture, configuration,
  deployment, and the non-obvious constraints worth knowing before changing it.
- [`backend/.env.example`](backend/.env.example) — every backend variable, with
  the reasoning behind the ones that are easy to get wrong.

