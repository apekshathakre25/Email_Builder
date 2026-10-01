# Opterite — Frontend

React + Vite + Tailwind single-page app for the Opterite bulk email platform. It is a
pure client: every piece of data comes from the existing Node/Express API over HTTP.

```
┌──────────────────────────┐
│   React (this project)   │   Vite 8 · React 19 · Tailwind 4
│   Vite dev :5173         │   TanStack Query · React Router
└────────────┬─────────────┘
             │  HTTP + cookie auth (credentials: include)
             ▼
┌──────────────────────────┐
│  Node/Express backend    │   routes · controllers · services
│  :3000                   │   email sending · rate limiting · jobs
└────────────┬─────────────┘
       ┌─────┴─────┐
       ▼           ▼
   MongoDB       Redis
```

The backend remains an API and worker service. The separation-specific pieces are
CORS, an env-driven cookie `SameSite`, frontend-aware OAuth redirects, and a
`GET /api/app-config` endpoint — see [Backend requirements](#backend-requirements).

---

## Quick start

```bash
# 1. Backend (from the repository root) — needs MongoDB and Redis
npm install
npm run dev          # API on http://localhost:3000

# 2. Frontend
cd frontend
npm install
npm run dev          # app on http://localhost:5173
```

`.env.development` is committed and already points at `http://localhost:3000`, and the
backend allows `localhost:5173` by default outside production, so a fresh clone needs no
configuration.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with HMR on port 5173 (fails if the port is taken) |
| `npm run build` | Production bundle into `dist/` |
| `npm run preview` | Serve the built bundle on port 4173 |
| `npm run lint` | ESLint, including the React 19 hooks rules |

---

## Configuration

Only `VITE_`-prefixed variables reach the browser. **Nothing secret belongs in them** —
they are compiled into JavaScript any visitor can read.

| Variable | Default (dev) | Meaning |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3000` | Origin of the API. Leave empty to make every request same-origin, which is what you want when one reverse proxy serves both this bundle and the API. |

---

## Backend requirements

Three backend environment variables exist because of this separation. All are optional
with safe defaults, but two matter in production.

| Variable | Default | When you need it |
| --- | --- | --- |
| `CORS_ORIGINS` | dev: `localhost:5173`, `127.0.0.1:5173`, `:4173`<br>prod: *(none)* | Comma-separated origins allowed to call the API with credentials. **Required in production** if the SPA is served from a different origin to the API. Empty in production means cross-origin browser access is off, which is correct when both are served from one origin. |
| `FRONTEND_URL` | *(empty — same origin)* | Where `/auth/google/callback` sends the browser after OAuth. **Required for Google login** once the frontend is separate, otherwise the callback redirects to the old server-rendered `/interface`. |
| `COOKIE_SAMESITE` | `strict` | `strict` is correct whenever the SPA and the API share a registrable domain, including `localhost:5173 → localhost:3000` and `app.example.com → api.example.com`. Set it to `none` only when they are genuinely cross-site (`spa.vercel.app → api.example.com`); that forces a `Secure` cookie, so it requires HTTPS. |

A typical production block:

```bash
# SPA and API on the same registrable domain — Strict cookies still work
CORS_ORIGINS=https://app.example.com
FRONTEND_URL=https://app.example.com
COOKIE_SAMESITE=strict
```

### `GET /api/app-config`

Added so the SPA can read server-owned values at runtime:
the authorized-user list for the login dropdown, `maxUploadBytes` for the upload
preflight, and the validation bounds for Limit / Interval / Limit to Send. It is
unauthenticated because the login page needs it before anyone has signed in — the same
position the old `GET /` was in, where the rendered login page already listed every
authorized address. See `backend/routes/appConfig.js` for the reasoning and for why serving the
bounds removes a duplication rather than relocating it.

---

## Project layout

```
src/
├── api/               One module per backend area. Thin wrappers that document
│                      exact request/response shapes.
├── components/
│   ├── layout/        AppShell (nav, identity, logout), FullPageSpinner
│   └── ui/            Button, Field, Panel, Badge, Table, Modal, Stat, Pagination
├── features/
│   ├── auth/          Login (OTP + Google)
│   ├── dashboard/     Campaign console — the bulk of the app
│   ├── files/         Recipient file upload and management
│   ├── health/        System health strip
│   ├── imap/          IMAP accounts and inbox-placement results
│   └── misc/          404
├── hooks/             useKeepAlive
├── lib/               apiClient, queryClient, queryKeys, config, format, cn
├── providers/         AppConfig, Auth, Toast, Confirm
└── styles/index.css   Tailwind theme and shared frontend styling
```

### Routes

These routes are owned by the SPA. The backend serves JSON, auth, uploads, and other
application APIs; it does not render interface pages.

| Route | Page |
| --- | --- |
| `/login` | Sign in |
| `/` | Campaign dashboard |
| `/file-manager` | Recipient files |
| `/imap-accounts` | IMAP setup and test results |

---

## Things worth knowing before changing this code

These are the non-obvious constraints. Each one is also commented at the relevant place
in the source.

**The API client must send `Accept: application/json`.** `backend/middleware/auth.js` answers an
expired session with `res.redirect('/')` unless the request looks like JSON or XHR. A
plain `fetch` sends `Accept: */*`, follows the 302, and returns the login page's HTML with
status 200 — a dead session would look like a successful request returning nonsense. The
shared client sets the header on every call; see `src/lib/apiClient.js`.

**Auth is one httpOnly cookie, so every request needs `credentials: 'include'`.** There is
no token in JavaScript to inspect. `AuthProvider` tracks the server's answer to
`GET /check-auth`, and a single `onUnauthorized` subscription flips the whole app to
signed-out on any 401 from anywhere.

**`GET /campaign-lane` is the only thing that marks a campaign completed.** The server's
reconciler runs inside that poll. It is also the tab's heartbeat — a tab that stops polling
is pruned as abandoned. So the dashboard keeps polling the lane while it is *watching* a
campaign, not only while queued behind one. Stop polling and campaigns sit at
`in_progress` forever and the lane never drains.

**The SMTP password never enters browser storage.** It lives encrypted on the server, and
an empty password field is how the form asks `/send-email` to reuse the stored credential.
`useCampaignForm` additionally ignores changes to that field until a real gesture
(keydown / paste / pointerdown) has happened, because Chromium treats the SMTP user and
password inputs as a login form and injects a generated password on load — which used to be
saved as the operator's credential and submitted, so sending failed authentication with a
password nobody had typed.

**Rate inputs lock with `readOnly`, never `disabled`.** A disabled input is omitted from a
`FormData` snapshot, and an absent `interval-seconds` is precisely how the server is told
"no rate limit" — so locking with `disabled` silently converted a paced campaign into an
unpaced one sending every remaining recipient as fast as SMTP allowed. This app builds the
payload from state rather than FormData, so it is no longer load-bearing, but `readOnly` is
the honest expression of "visible, submitted, not editable".

**The rate inputs lock only while work is in flight**, not for the whole life of an
unfinished campaign. With no interval set, `limit` is a per-click batch size and the
campaign goes idle between batches; re-tuning it before the next click is the intended
workflow. Locking it there would leave the operator with a Send button and no way to change
what it sends.

**A rejected submission is not a failed campaign.** A 429 means only this batch was
refused — anything already queued keeps sending. The client retries once the window rolls
over, using the server's `Retry-After`, and re-checks the stop flag when the timer fires so
a retry cannot resurrect a campaign the operator stopped in the meantime.

**Message preview is defended twice.** `htmlPreview.js` strips `<script>`, every `on*`
handler and every executable URL scheme, and the frame it renders into ships its own
`default-src 'none'` CSP and a sandbox *without* `allow-scripts`. The original DOCTYPE is
preserved deliberately: many email templates are XHTML or quirks-mode and their layout
depends on the rendering mode it selects.

**The interval countdown is anchored to the server.** `/status` returns
`window.resetInMs`, read from the same Redis bucket the workers are gated on; the local
250 ms ticker only fills the gap between polls and is re-anchored on every response. A
browser-owned timer would keep counting down after a stop, which is the most misleading
thing that panel could do.

---

## Deployment

`npm run build` emits a static bundle to `dist/`. Two arrangements work:

**Same origin (recommended).** Serve `dist/` and proxy the API paths to Node from one
reverse proxy. Set `VITE_API_BASE_URL=` (empty) at build time. No CORS, and `SameSite=Strict`
cookies keep working. The SPA needs a catch-all rewrite to `index.html` so client-side
routes survive a refresh — for Caddy:

```
handle {
    try_files {path} /index.html
    file_server
}
```

**Separate origins.** Build with `VITE_API_BASE_URL=https://api.example.com`, add the SPA's
origin to the backend's `CORS_ORIGINS`, set `FRONTEND_URL`, and set `COOKIE_SAMESITE=none`
if the two are genuinely cross-site.

---

## Known gaps

- **Campaign logs have no UI.** `src/api/logsApi.js` covers the endpoints, but no page
  consumes it yet. The old dashboard had the same situation in reverse: the JavaScript was
  live but the buttons had been removed from the markup, so it was unreachable either way.
- **The authorized-user list is served unauthenticated**, matching the old login page which
  rendered every authorized address into public HTML. Replacing the dropdown with a plain
  email input would let that move behind auth — a product decision rather than a technical
  one.
- **No automated frontend tests.** The migration was verified manually against a live
  backend (login, upload, campaign adoption, validation, preview sanitising, IMAP CRUD,
  dialogs). A component/integration suite would be the natural next step.
