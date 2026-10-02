/**
 * Loads .env, resolved from this file's location rather than the process's
 * working directory.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `require('dotenv').config()` with no arguments looks for `.env` in
 * `process.cwd()`. That was fine while the backend *was* the repository root —
 * you could only sensibly run it from one place. Now that it lives in
 * `backend/`, cwd is no longer a reliable guide:
 *
 *   cd backend && node app.js         cwd = backend/      → found
 *   node backend/app.js               cwd = repo root     → NOT found
 *   pm2 start backend/ecosystem...    cwd = wherever pm2 was invoked
 *
 * The second and third forms are things people reasonably do, and the failure
 * they produce is confusing rather than obvious: config/env.js reports that
 * MONGODB_URI and JWT_SECRET are missing, which reads like the .env file is
 * wrong rather than simply unread.
 *
 * Resolving from `__dirname` removes cwd from the equation entirely.
 *
 * ── Why two locations ───────────────────────────────────────────────────────
 *
 * `backend/.env` is the normal home: these are the backend's own secrets, so
 * they live with the backend.
 *
 * The repository root is also accepted, because `.env` is additionally read by
 * Docker Compose — both for `env_file:` and, in docker-compose.prod.yml, for
 * interpolating SITE_ADDRESS and ACME_EMAIL into the Caddy service. A deployment
 * that prefers one stack-level file at the root therefore keeps working without
 * having to pass `--env-file` everywhere.
 *
 * dotenv does not overwrite a variable that is already set, and it processes the
 * list in order, so `backend/.env` wins for any key defined in both. Anything
 * already present in the real environment (a compose `environment:` block, a
 * shell export, a CI secret) beats both — which is the behaviour every one of
 * those mechanisms relies on.
 */

const path = require('path');
const dotenv = require('dotenv');

const BACKEND_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(BACKEND_DIR, '..');

const ENV_FILES = [path.join(BACKEND_DIR, '.env'), path.join(REPO_ROOT, '.env')];

// Idempotent: Node caches modules, so the many entry points that require this
// (app.js via config/env, the worker, the queue, the test helpers) all share one
// load. `quiet` suppresses dotenv's "injecting env" banner, which otherwise
// prints on every worker process.
dotenv.config({ path: ENV_FILES, quiet: true });

module.exports = { ENV_FILES, BACKEND_DIR, REPO_ROOT };
