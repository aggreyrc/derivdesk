# DerivDesk — Operations runbook

This is the document you open at 3 a.m. Everything here was written against the code in this repo;
anything that could **not** be verified in the environment it was built in is marked **UNVERIFIED**
and collected in [section 10](#10-what-has-not-been-verified).

Contents: [1 Topology](#1-topology) · [2 First deploy](#2-first-deploy) · [3 Routine deploys and rollback](#3-routine-deploys-and-rollback) · [4 Bot runner](#4-the-bot-runner) · [5 Monitoring](#5-monitoring-and-logs) · [6 Backups and restore](#6-backups-and-restoring) · [7 Key rotation](#7-rotating-secrets) · [8 Incident playbooks](#8-incident-playbooks) · [9 Launch checklist](#9-launch-checklist) · [10 Not verified](#10-what-has-not-been-verified)

## 1. Topology

`docker-compose.prod.yml` describes a single Docker host. Four application images plus Postgres and a
one-shot migration job:

| Service | What it is | Published port | Networks |
|---|---|---|---|
| `web` | static client SPA behind unprivileged nginx; proxies `/api` and `/ws` to `api` (same origin, so no CORS and cookies stay same-site) | `127.0.0.1:8080` | `public_net` |
| `api` | client backend (HTTP + WebSocket on `:4000`, internal metrics on `:9100`) | none | `public_net`, `db_net` |
| `admin` | admin SPA behind nginx; proxies `/api` to `admin-api` | `127.0.0.1:8081` | `admin_edge`, `admin_internal` |
| `admin-api` | admin backend (`:4100`) | none | `admin_internal`, `db_net` |
| `postgres` | PostgreSQL 16 | none | `db_net` |
| `migrate` | one-shot: migrations, roles, boundary check | none | `db_net` |

Why the networks look like this:

* `db_net` and `admin_internal` are Docker **internal** networks. Containers attached only to those have no route to the internet. `admin-api` is on nothing else, so a compromised admin API cannot call out, cannot reach Deriv, and cannot be reached from the client side.
* The admin deployment is separate on purpose: its own image, its own database role (`derivdesk_admin`, which Postgres itself forbids from reading Deriv tokens, users, sessions, trades or bots), its own cookies, sessions and encryption key. **Never put `admin` on the public listener.** Reach it over a VPN or an IP-allow-listed listener only.
* **TLS is not terminated by this stack.** Put a TLS terminator (cloud load balancer, Caddy, or host nginx) in front of `127.0.0.1:8080` and (separately, internal only) `127.0.0.1:8081`.
* **Same-site requirement.** There is no CSRF token; protection is `SameSite=Strict` cookies plus a single-origin CORS allow-list. The web app and API must therefore be served from the **same site**. This stack serves both from one origin, which satisfies it. Do not split them across unrelated domains.

## 2. First deploy

### 2.1 Prerequisites
A Linux host with Docker Engine 24+ and the Compose plugin; a DNS name for the app (e.g. `app.example.com`) and one for the admin UI that resolves only inside your VPN; a TLS terminator; a registered Deriv app (client id and secret, redirect URI exactly `https://<app host>/api/deriv/callback`).

### 2.2 Generate secrets
```bash
cd /opt/derivdesk
cp infra/prod/stack.env.example      infra/prod/stack.env
cp infra/prod/api.env.example        infra/prod/api.env
cp infra/prod/admin-api.env.example  infra/prod/admin-api.env
chmod 600 infra/prod/*.env

openssl rand -hex 24      # x3 → POSTGRES_SUPERUSER_PASSWORD, DERIVDESK_API_DB_PASSWORD, DERIVDESK_ADMIN_DB_PASSWORD (all different)
openssl rand -hex 32      # SESSION_SECRET (api.env) and a DIFFERENT one for admin-api.env
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY (api.env)
openssl rand -base64 32   # ADMIN_TOTP_ENCRYPTION_KEY (admin-api.env) — must differ from the one above
```
**Back up `TOKEN_ENCRYPTION_KEY` and `ADMIN_TOTP_ENCRYPTION_KEY` in a password manager or secret store that is *separate* from your database backups.** Database backups hold Deriv tokens and TOTP secrets only in encrypted form; without these keys a restore cannot decrypt them (every user would have to reconnect Deriv and every admin re-enrol 2FA). Keeping keys and backups together would defeat the encryption.

The apps **refuse to start in production** if a secret still looks like a placeholder, a URL is not `https`, `ADMIN_REQUIRE_TOTP` is not `true`, or the two deployments share a key. If a container exits at boot, read its log: the message names the setting.

### 2.3 Build and start
```bash
docker compose -f docker-compose.prod.yml --env-file infra/prod/stack.env config -q   # validates the file
docker compose -f docker-compose.prod.yml --env-file infra/prod/stack.env up -d --build
docker compose -f docker-compose.prod.yml logs migrate
```
The `migrate` job runs first and the apps only start if it succeeded. It: creates the two application roles with your real passwords (never the development placeholders), runs `prisma migrate deploy` (applies only what is pending; never resets), applies `infra/db-init/001_roles.sql`, sets the role passwords, and finally **verifies the privilege boundary** (admin cannot read tokens/users/bots; api cannot read admin tables or edit the audit log). If that check fails it exits `70` and the apps do not start. Exit `64` means a password was missing, short, a placeholder, or the two were equal.

### 2.4 Create the first admin
Admin accounts are never created over HTTP. From the host:
```bash
docker compose -f docker-compose.prod.yml exec admin-api npm run create-admin -- --email you@example.com --password '<12+ chars>'
docker compose -f docker-compose.prod.yml exec admin-api npm run enroll-totp  -- --email you@example.com
```
`enroll-totp` prints a secret / `otpauth://` URI once; add it to an authenticator app. Admin sign-in is impossible without an enrolled authenticator. (The password appears in the process list and shell history for a moment: use a throw-away password and change it, or clear your history.) A lost authenticator is recovered the same way — re-run `enroll-totp` as an operator; there is deliberately no web path and no backup codes.

### 2.5 Verify
```bash
curl -fsS http://127.0.0.1:8080/nginx-health                    # web container up
docker compose -f docker-compose.prod.yml exec api node -e "fetch('http://127.0.0.1:4000/ready').then(r=>r.text()).then(console.log)"
```
`/ready` should say `"status":"ready","database":"ok"` and `botRunner` of `leader` or `standby`. Then, through your TLS terminator: click **Continue with Deriv** and sign in with a **demo** Deriv account (this creates the user — there is no separate registration), and place a demo trade before anything else.

## 3. Routine deploys and rollback

```bash
git pull   # or unpack the new release
docker compose -f docker-compose.prod.yml --env-file infra/prod/stack.env up -d --build
```
Migrations run on every deploy before the apps restart; there is no separate step.

**Migrations are forward-only.** `prisma migrate deploy` never rolls back. To keep rollbacks possible, write migrations in two releases (*expand* then *contract*): release N adds the new column/table (old code ignores it); only release N+1, after N is proven, removes or tightens the old one. A release whose migration only *adds* things can be rolled back by redeploying the previous images. A release that dropped or rewrote data can only be undone by restoring a backup ([section 6](#6-backups-and-restoring)) — **take a backup immediately before any such deploy**: `scripts/backup-db.sh`.

**The Deriv-only sign-up migration (`20261022000000_deriv_identity`) can stop a deploy on purpose.** It makes a Deriv account id belong to exactly one user. If any `deriv_account_id` is attached to more than one user (only possible from the old email sign-up connecting the same Deriv account twice), it aborts with `Cannot make deriv_accounts.deriv_account_id unique … Merge or remove the duplicate users first` and changes nothing; `migrate` fails, the old containers keep running. Decide which user keeps the account, delete or detach the other's `deriv_accounts` row (take a backup first, section 6), and redeploy. On a fresh install nothing needs doing. Existing users get `handle` = a REAL Deriv account id, else any, else their old email. Legacy `email`/`password_hash` stay (nullable) until a later contract migration.

**Support playbook — sign-in errors** (the user sees a plain message; the code is in the URL as `deriv_error`): `account_conflict` — the Deriv accounts on that login belong to two different app users (never merged automatically; an operator must decide which user keeps them); `account_mismatch` — a signed-in user tried to reconnect a Deriv login that belongs to another user; `no_accounts` — Deriv returned no trading accounts (the user needs an options account at Deriv); `suspended` — the user is suspended in the admin UI. Anonymous failures (bad code, state expired) are logged as `warn`, not audited, since there is no user to attribute them to.

Restarting `api` is safe for bots: the bot-runner lease hands leadership over ([section 4](#4-the-bot-runner)), and WebSocket clients reconnect on their own. A brief overlap of an old and a new replica during a deploy is fine for the same reason; keeping **more than one replica serving users** long-term is a separate decision ([section 4.3](#43-scaling-beyond-one-api-replica)).

## 4. The bot runner

Bots run **server-side and always-on**, trading each owner's *own* Deriv account through that owner's *own* stored authorisation. Nothing can trade without an OWNER-ENCRYPTED token the user connected.

### 4.1 One leader, enforced by the database
`BOT_RUNNER_ENABLED=true` means "this process **may** run bots", not "this process does". Processes compete for a lease row in `runner_leases`:

* acquire/renew is one atomic SQL statement using the **database clock** (so host clock skew cannot create two leaders);
* the leader renews every `ttl/3` (default ttl 30 s, `BOT_RUNNER_LEASE_TTL_MS`);
* if the leader cannot **confirm** a renewal it stops trading *before* the database lease could expire (`ttl − ttl/6`), so a standby can never take over while the old leader still believes it leads;
* the runner re-checks leadership **immediately before every order** is sent;
* on graceful shutdown (SIGTERM) the leader stops trading and releases the lease, so a standby takes over within one renewal interval (≈10 s), not a full ttl.

So `BOT_RUNNER_ENABLED=true` is safe on every replica you run — a standby or an overlapping replica during a deploy can never double-trade a bot: exactly one leads, the rest stand by. A leader that crashes or loses the database is replaced within about one ttl (≤ 30 s by default). On takeover the new leader re-attaches every `RUNNING` bot and resumes watching any trade still `OPEN` before trading again.

A bot started or stopped through *any* replica only changes its database row; the leader notices at its next reconcile (≤ 10 s). So "Start" may take up to ~10 s to begin evaluating.

### 4.2 What to look at
* `GET /ready` → `botRunner`: `leader`, `standby`, or `disabled`.
* Metric `derivdesk_bot_runner_leader` (1 on exactly one replica at a time) and `derivdesk_bots_attached`.
* **Alert if no replica reports leader for more than ~2 ttl while bots are `RUNNING`** — the UI would still say "Running" but nothing is evaluating. Alert also if **more than one** replica reports leader for more than a few seconds (should be impossible; treat as a Sev-1 and run section 4.4).

### 4.3 Scaling beyond one `api` replica
**The lease only protects bot trading.** Everything else in `api` keeps its state in process memory, so with more than one replica serving users:

* **The double-buy guard is per process.** It stops a double-click from placing two identical manual trades — but only if both requests hit the same replica. Behind plain round-robin they can hit two. Use **sticky routing per user** (e.g. nginx `hash $cookie_derivdesk_session consistent;` on the upstream) before you add a second serving replica.
* **Rate limiters (including the sign-in limiter on `/api/deriv/login`) are per process**, so every limit is effectively ×N (still bounded, not exact).
* **Token-refresh de-duplication is per process.** Two replicas can refresh the same user's Deriv authorisation at once. If Deriv invalidates the older refresh token the user must reconnect Deriv (recoverable, but a visible failure). *Not tested against live Deriv.*
* Each replica opens its **own** Deriv public market-data connection and its own per-user private sockets.

Realistic recommendation: run **one** `api` replica. The lease still earns its keep: restarts and deploys, a standby you start by hand, and a future move to several replicas cannot cause double-trading. Moving the other state to Redis is the work needed for true horizontal scaling and is **not done**.

### 4.4 Emergency stop (all bots, immediately)
1. Set `BOT_RUNNER_ENABLED=false` in `infra/prod/api.env` and `docker compose … up -d api` (or `docker compose … stop api`). The leader stops trading and releases the lease on SIGTERM. Bots stay `RUNNING` in the database but nothing evaluates. Replicas whose flag is `false` never compete for the lease, so make sure **every** replica has the flag off — one stray replica with it on would take over and resume trading.
2. Trades **already placed** are real contracts on Deriv: they settle regardless of this app. They are recorded when the next leader (or a later start) resumes watching them.
3. To make the stop durable in the data too (so re-enabling does not silently resume trading), as the database owner:
   `UPDATE bot_instances SET status = 'STOPPED', stop_reason = 'OPERATOR_EMERGENCY_STOP' WHERE status = 'RUNNING';`
   (An operator action on user data: record it in your incident log.)

### 4.5 Residual risk
A process that is frozen (VM pause, long GC) *between* its final leadership check and the network write of an order could, in principle, still send one order after losing the lease. The window is microseconds wide, a frozen process sees its validity expired on resume, and every order is bounded by the per-bot stake ladder and stop-loss — but there is no cross-system fencing token available from Deriv, so this cannot be reduced to zero. Throttles and caches remain per process.

## 5. Monitoring and logs

### 5.1 Endpoints
| Where | Path | Meaning |
|---|---|---|
| api `:4000` | `/health` | liveness: process is up (used by the Docker HEALTHCHECK) |
| api `:4000` | `/ready` | readiness: database answers within 2 s; reports `botRunner` role. `503` = take out of rotation |
| api `:9100` (**internal only, unauthenticated**) | `/metrics` | Prometheus text. **Never publish this port.** Scrape it from a container on `db_net`/`public_net` or via `docker exec` |
| admin-api `:4100` | `/health`, `/ready` | same, for the admin API |
| web / admin | `/nginx-health` | nginx up |

`/ready` and `/metrics` are deliberately coarse: no usernames, no per-route labels, no error text.

### 5.2 Metrics
`derivdesk_http_requests_total{status_class}`, `derivdesk_http_request_duration_seconds` (histogram), `derivdesk_ws_connections`, `derivdesk_bot_runner_leader`, `derivdesk_bots_attached`, `derivdesk_deriv_market_connected`, `derivdesk_process_uptime_seconds`, `derivdesk_process_resident_memory_bytes`.

Suggested alerts (starting points — tune after you see real traffic):

| Alert | Condition |
|---|---|
| API not ready | `/ready` ≠ 200 for 2 min |
| Error rate | `5xx` > 2 % of requests for 5 min |
| Latency | p95 above 1 s for 10 min |
| No bot leader | no replica with `derivdesk_bot_runner_leader == 1` for > 90 s while `bot_instances.status='RUNNING'` rows exist |
| Two leaders | `sum(derivdesk_bot_runner_leader) > 1` for > 15 s |
| Market feed down | `derivdesk_deriv_market_connected == 0` for 5 min |
| Memory | RSS above 80 % of the container limit (`api` 768 MB) |
| Backups | newest file in `backups/` older than 8 h (with the 6-hourly cron below) |

### 5.3 Logs
Every service logs structured JSON to stdout (pino). Docker keeps `10 MB × 5` per container (`json-file`); ship them off-host with your agent of choice (Promtail/Loki, Vector, CloudWatch, …) — **UNVERIFIED here: no shipper is bundled.** Every request carries a correlation id (`X-Request-Id`), echoed to the client and present in the 500 body, so a user's error report maps to one log line. Authorization headers, cookies and any `*token*`/`*password*` field are redacted by the logger; never add logging of request bodies. Treat logs as sensitive anyway (they contain email addresses and IPs) and set a retention period.

Security-relevant events to alert on from the logs/audit table: repeated `admin.login_failed`, `payments.withdrawal_outcome_unknown` (**always investigate** — a withdrawal's outcome could not be confirmed), `bots.*` stop reasons of `TRADE_RECORD_FAILED`.

## 6. Backups and restoring

### 6.1 Taking backups
`scripts/backup-db.sh` makes a `pg_dump` custom-format archive, **reads it back** before reporting success (a backup that was never read is not a backup), writes it mode `0600`, optionally encrypts it to a GPG recipient, and prunes old files. Schedule it from cron on the host:
```cron
0 */6 * * *  cd /opt/derivdesk && BACKUP_GPG_RECIPIENT=ops@example.com scripts/backup-db.sh >> /var/log/derivdesk-backup.log 2>&1
```
Settings: `BACKUP_DIR` (default `./backups`), `BACKUP_KEEP_DAYS` (default 14; `0` = keep all). **Copy backups off the host** (object storage with versioning, a second machine); a backup on the same disk dies with the disk.

*Honest limits:* this is a logical dump every N hours, so your recovery point objective is **N hours** of data (trades are re-readable from Deriv, but sessions, watchlists, bot state and audit rows written since the last dump are lost). There is no point-in-time recovery. If you need minutes, use a managed Postgres with PITR or add WAL archiving — **not built here.**

### 6.2 Restoring (never overwrites anything)
`scripts/restore-db.sh` restores into a **new** database and refuses to touch an existing one:
```bash
export DERIVDESK_API_DB_PASSWORD=… DERIVDESK_ADMIN_DB_PASSWORD=…
scripts/restore-db.sh backups/derivdesk-20261021T060000Z.dump.gpg derivdesk_restored
```
Then:
1. Check it: row counts of `users`, `deriv_accounts`, `audit_logs`, `bot_instances`; newest `audit_logs.occurred_at` is what you expect.
2. **Check the keys.** Point a throw-away `api` at the restored database with the *production* `TOKEN_ENCRYPTION_KEY` (plus `TOKEN_ENCRYPTION_KEYS_EXTRA` if you were mid-rotation) and confirm a Deriv token decrypts. If you only have the *current* key but the backup predates a rotation, the old key is needed — see 7.1 step 6.
3. Maintenance window: stop `api` and `admin-api`; swap names (`ALTER DATABASE derivdesk RENAME TO derivdesk_old; ALTER DATABASE derivdesk_restored RENAME TO derivdesk;` — terminate remaining connections first); re-run the `migrate` job so grants and passwords are re-asserted and the boundary check runs; start the apps.
4. **Bots after a restore.** Restored `bot_instances` rows can be *behind* reality (a trade placed after the backup is unknown locally). Before bots resume, reconcile with Deriv's statement for each real-money account, or stop all bots (4.4) and let owners restart them.
5. Keep `derivdesk_old` until you are satisfied, then drop it.

The suite in `packages/db/tests/backupRestore.test.ts` exercises backup → verify → encrypt → restore → grants against a real Postgres, so these scripts are tested — but only with `DIRECT_PG=1` (outside Docker) in this repo's environment. The `docker compose exec` path is **UNVERIFIED**.

**Run a restore drill before launch and then quarterly.** An untested restore procedure is a hope, not a procedure.

## 7. Rotating secrets

### 7.1 `TOKEN_ENCRYPTION_KEY` (Deriv tokens at rest)
Values are `v1.<iv>.<tag>.<ciphertext>` (AES-256-GCM). GCM is authenticated, so a wrong key **fails** instead of returning garbage; that is what makes "try the keys in order" safe. Do it in **three deploys** so a rolling restart never has a replica that cannot read what another wrote:

1. Generate the new key: `openssl rand -base64 32`.
2. **Deploy A — teach everyone the new key first.** `TOKEN_ENCRYPTION_KEY` stays the *old* key; add `TOKEN_ENCRYPTION_KEYS_EXTRA=<new>`. Nothing changes in behaviour; every replica can now *read* the new key.
3. **Deploy B — switch.** `TOKEN_ENCRYPTION_KEY=<new>`, `TOKEN_ENCRYPTION_KEYS_EXTRA=<old>`. New writes use the new key; old values still decrypt.
4. **Re-encrypt the rest.** Dry run, then for real (safe under traffic and safe to repeat):
   ```bash
   docker compose -f docker-compose.prod.yml exec api node dist/cli/rotateTokenKey.js --dry-run
   docker compose -f docker-compose.prod.yml exec api node dist/cli/rotateTokenKey.js
   ```
   Output is counts and row ids only. Exit `3` = some rows changed under you (normal; run again until `raced` is 0). Exit `2` = a value **no** configured key can open: **stop**, do not retire the old key, investigate those ids.
5. **Deploy C — retire the old key** (remove it from `…_EXTRA`) only when the command reports everything current.
6. **Backups.** Backups taken before step 4 contain values encrypted under the **old** key. Keep the old key (in your secret store) for as long as you might restore one — at least `BACKUP_KEEP_DAYS` plus margin. Losing it makes those backups' tokens unrecoverable (users reconnect Deriv; nothing else is lost).

### 7.2 `ADMIN_TOTP_ENCRYPTION_KEY` (admin 2FA secrets)
Same three-deploy pattern with `ADMIN_TOTP_ENCRYPTION_KEYS_EXTRA`, and:
```bash
docker compose -f docker-compose.prod.yml exec admin-api npm run rotate-totp-key -- --dry-run
docker compose -f docker-compose.prod.yml exec admin-api npm run rotate-totp-key
```
If a key is lost outright, admins are not locked out forever: an operator re-runs `enroll-totp` per admin.

### 7.3 Database role passwords
Edit `DERIVDESK_API_DB_PASSWORD` / `DERIVDESK_ADMIN_DB_PASSWORD` in `stack.env`, then `docker compose … up -d` — the `migrate` job sets the new passwords before the apps restart with them. Expect a brief reconnect.

### 7.4 Others
* **`SESSION_SECRET`** is required but currently unused (sessions are opaque random ids), so rotating it has no effect today.
* **Deriv client secret:** rotate at Deriv, update `api.env`, redeploy `api`. Existing user authorisations are unaffected unless Deriv revokes them.
* **Kill all browser sessions** (e.g. after a suspected leak): as the database owner, `DELETE FROM sessions;` (clients) and/or `DELETE FROM admin_sessions;` (admins). Sockets close on their next re-validation (≤ 30 s).

## 8. Incident playbooks

**Suspected leak of Deriv tokens (database dump, backup, or `api` host).** The tokens are AES-256-GCM encrypted, so a dump alone is not usable without `TOKEN_ENCRYPTION_KEY`. If the key *may* also be exposed: (1) stop bots (4.4); (2) `DELETE FROM sessions;` (3) delete the stored authorisations: `DELETE FROM deriv_oauth_tokens;` — every user must reconnect, which also means the leaked tokens are no longer in your data; (4) **tell users to revoke the app in their Deriv account settings**, which is the only thing that invalidates a token on Deriv's side; (5) rotate `TOKEN_ENCRYPTION_KEY` and `DERIVDESK_*_DB_PASSWORD`; (6) review `audit_logs`.

**`payments.withdrawal_outcome_unknown` in the audit log.** A payment-agent withdrawal request was sent but Deriv's answer could not be confirmed (timeout/5xx). The local row is deliberately kept as REQUESTED and the user got a 502. Check the user's Deriv statement/payment history; do not tell them to retry until you know. The app never moves funds itself.

**Database down.** `/ready` → 503 and the load balancer should stop routing; `/health` stays 200 so the container is not restart-looped. The bot leader cannot renew, stops trading within ~25 s, and a standby cannot take over either (it cannot reach the database), so **no bot trades while the database is down** — fail closed. Deriv contracts already open settle on their own; they are reconciled after recovery.

**Deriv unavailable.** Market data shows `reconnecting` and retries with backoff; trading calls fail with a clear error; a bot that sees five consecutive errors stops itself with a reason (`ERROR`) rather than guessing. Re-start bots after recovery.

**Admin locked out (lost authenticator).** `enroll-totp` as in 2.4.

**A replica seems stuck as leader but the process is unhealthy.** Stop it (`docker compose … stop api` or kill the container). SIGTERM releases the lease; after a hard kill the lease expires on its own within one ttl.

**Everything is on fire and you are unsure.** Stop `api` and `admin-api` (`docker compose … stop api admin-api`). This stops bots from trading and blocks logins; open contracts settle regardless; data is untouched.

## 9. Launch checklist

Do all of these, in this order, **on a staging host with a Deriv demo account first**:

- [ ] Images build in CI (`docker compose … build`). **The first real build is also the first time `tsc` compiles against the genuine generated Prisma client** — see section 10 — so expect to fix type errors here, not at 3 a.m.
- [ ] `docker compose -f docker-compose.prod.yml config -q` passes with your real env files.
- [ ] `migrate` exits 0; its boundary check passed.
- [ ] `/ready` is `ready`; `botRunner` is `leader` on exactly one replica if you run more than one.
- [ ] If you run a standby: kill the leader (`docker kill`) and a standby leads within ~30 s and bots keep evaluating; no trade is duplicated (check `bot_trades` for repeated `contract_id`).
- [ ] Sign in with a **demo** Deriv account (first sign-in creates the user; the OAuth redirect URI matches exactly), trade, withdraw is blocked/behaves as expected on demo, start and stop a demo bot.
- [ ] Admin sign-in requires TOTP; the admin UI is **not** reachable from the public internet; the admin API container has no internet route (`docker compose -f docker-compose.prod.yml exec admin-api node -e "fetch('https://example.com',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('REACHED (bad)'),()=>console.log('blocked (good)'))"` must print `blocked (good)`; the slim image has no `wget`/`curl`).
- [ ] Backup cron runs, the file is off-host, **and a restore drill into a side database succeeded**, including decrypting a token with the stored keys.
- [ ] Keys are in the secret store, separate from backups.
- [ ] Alerts from 5.2 exist and have fired in a test (stop the DB; stop all replicas).
- [ ] TLS terminator in place; HSTS is set by the containers; app and API are same-site.
- [ ] Rate-limit proxy count (`TRUST_PROXY`) matches reality: from two different client IPs the API must see two different addresses (check a log line).
- [ ] Legal/compliance review for your jurisdiction: this app is **not a broker and holds no client funds**, but offering automated trading tooling can still be regulated. This runbook does not cover that.

## 10. What has not been verified

Be clear-eyed about these; none is hidden elsewhere:

1. **No Docker daemon was available** where this was built. `docker compose config` validates the compose file, and the API image's *runtime stage* was simulated (production-only dependencies + compiled output, booted with `NODE_ENV=production`), but **no image was actually built or run**, including the migration image and both nginx images.
2. **The Prisma engine never ran.** The sandbox could not download Prisma's binaries, so its generated client is a hand-authored stand-in and all application database access has been exercised through mocks and raw SQL, not through the real Prisma query engine. The Docker build runs the real `prisma generate`; the **first CI build will type-check the code against the real generated types for the first time**. The migrations are hand-authored for the same reason: regenerate them with `prisma migrate dev` from a normal environment and diff.
3. **Nothing has talked to live Deriv** in a test. Verify demo first.
4. **No load, soak or failover test under real traffic** (the lease and WebSocket limits are tested for correctness, not throughput).
5. **No browser/E2E tests** of the two SPAs.
6. **Log shipping and alert rules are not bundled**; section 5 tells you what to wire up.
7. **No point-in-time recovery**; see 6.1.
8. Single-host Compose is not high availability. The lease gives bot failover between `api` replicas on that host; losing the host or Postgres is an outage until restored.
