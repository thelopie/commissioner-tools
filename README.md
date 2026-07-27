# Dinkel Portal

A private, noncommercial companion application for a long-running Yahoo Fantasy
Football league.

Yahoo stays the source of truth for live fantasy data — scores, rosters, matchups,
standings. The portal becomes the source of truth for the league operations Yahoo
does not manage: dues, prize structure, weekly challenges, the LLWS-based
draft-order workflow, announcements, recaps, and an audit trail. The goal is that a
future commissioner can run the league from the portal alone, without a legacy
spreadsheet or knowledge of anyone's manual processes.

Not affiliated with, endorsed by, or sponsored by Yahoo.

---

## Read this first: Yahoo API access is gated

Yahoo Fantasy Sports API access is **not self-service**. You apply and wait for
review:

> "Complete the application below to begin the process of accessing the Yahoo
> Fantasy Sports API. Our team reviews every submission and will reach out with next
> steps, including credentials and onboarding resources."
> — <https://sports.yahoo.com/developer/access/>

Access is **read-only by default**, which is all this portal needs or requests.

Until credentials arrive you can still run and develop the entire application:
`YAHOO_MODE=mock` serves synthetic fixtures from a local mock server that reproduces
Yahoo's documented response shapes. Every weekly challenge will report **blocked**
until a real league confirms the Yahoo fields exist — that is intended behavior, not
a bug. See [Yahoo capabilities](#yahoo-capabilities).

---

## Architecture

```
apps/web/                React + Vite + MUI + React Router + TanStack Query
apps/api/                Hono on one Lambda behind API Gateway HTTP API
apps/mock-yahoo/         Local fake Yahoo v2 server (synthetic fixtures only)
packages/shared/         Zod schemas, entity types, single-table keys, env validation
packages/yahoo-client/   OAuth, token refresh, v2 reads, retry, pagination, parsing
packages/challenge-engine/  Pure challenge calculators — no I/O, no model calls
packages/draft-order/    LLWS assignment, seeded randomization, selection order
packages/csv-import/     Parse, validate, dry-run, conflict detection, rollback
infrastructure/          AWS CDK (TypeScript)
scripts/                 Local certs, dev orchestration, Yahoo verification
```

Two structural choices worth naming:

- **`apps/mock-yahoo` exists because credentials are approval-gated.** Without it,
  nothing could be built or demonstrated until Yahoo replied.
- **`packages/draft-order` is separate from `challenge-engine`** because LLWS
  ordering is seeded-random workflow logic, not weekly stat math. Mixing them would
  make both harder to test.

### Cross-cutting decisions

| Decision                          | Reasoning                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-table DynamoDB             | Every access pattern is a league-scoped lookup. One table keeps IAM and CDK minimal.                                                                      |
| One Lambda, Hono router           | Cheaper cold starts and far less infrastructure than per-route functions.                                                                                 |
| Opaque session IDs, not JWTs      | Sessions must be revocable the instant a commissioner is removed. A self-contained token cannot be withdrawn.                                             |
| Yahoo OAuth as the only sign-in   | The Yahoo GUID is one of the few values Yahoo permits storing indefinitely, so it is a natural identity anchor — and there is no password to store badly. |
| Portal roles independent of Yahoo | Yahoo decides who runs the Yahoo league. It does not decide who may spend league money or finalize a paid result here.                                    |
| Money in integer cents            | `12.34` as a float reads back as `12.339999999999998` and corrupts dues reconciliation.                                                                   |

---

## Prerequisites

- **Node.js 22.13 or newer.** 22.12 works but emits engine warnings from a
  transitive dependency.
- **npm 10+** (ships with Node 22).
- **openssl** for local HTTPS certificates. Ships with Git for Windows, macOS, and
  most Linux distributions.
- **A Yahoo account** that is a member of the league you want to read.
- For deployment only: an AWS account and the AWS CLI configured.

---

## Yahoo developer setup

1. **Apply for API access** at <https://sports.yahoo.com/developer/access/>.

   You will be asked for an expected-user estimate (choose the smallest band — this
   is a private league of about a dozen people), an existing App ID if you have one,
   and notes if you want more than read-only access. **Do not request read/write.**
   It is unnecessary (no Yahoo write endpoint is documented), and asking may slow
   approval.

   Read the API Access and Use Agreement presented during the application. A
   Fantasy-Sports-specific terms URL is referenced publicly but returned HTTP 404 as
   of 2026-07-26, so the application flow is the authoritative source. If it differs
   from what `yahoo-capabilities.json` records, update that file.

2. **Register redirect URIs** once Yahoo issues credentials. Yahoo requires HTTPS and
   matches the URI **exactly** — scheme, host, port, and path:

   ```
   https://localhost:5173/auth/yahoo/callback     ← local development
   https://your-domain/auth/yahoo/callback        ← deployed
   ```

   There is no `http://localhost` option. That is why local development needs a
   certificate (see below).

3. **Put the credentials in `.env`** (local) or Secrets Manager (deployed). Never in
   the repository — this one is public.

---

## Local setup

```bash
git clone https://github.com/thelopie/commissioner-tools.git
cd commissioner-tools
npm install
```

Create `.env` from the template:

```bash
cp .env.example .env
```

Generate the two required keys and paste each into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # TOKEN_ENCRYPTION_KEY
```

Generate a local HTTPS certificate, because Yahoo will not accept `http://localhost`:

```bash
npm run certs
```

The certificate is self-signed, so your browser will warn once. Proceeding is
expected for a loopback development server. Both files land in `certs/`, which is
git-ignored.

### DynamoDB for local development

The API needs a table. Either point it at DynamoDB Local:

```bash
docker run -p 8000:8000 amazon/dynamodb-local
# DYNAMODB_ENDPOINT=http://localhost:8000 in .env (the default)
```

...or clear `DYNAMODB_ENDPOINT` and let it use a real table in your AWS account.

### Run it

```bash
npm run dev
```

This starts three processes together — the mock Yahoo server, the API, and the
frontend — so one Ctrl-C stops all of them.

|            |                          |
| ---------- | ------------------------ |
| Web        | <https://localhost:5173> |
| API        | <http://127.0.0.1:4300>  |
| Mock Yahoo | <http://127.0.0.1:4310>  |

With `YAHOO_MODE=mock` you need **no Yahoo credentials at all**. The mock server
completes a real OAuth redirect flow, rotates refresh tokens on every renewal (so
the rotation path is exercised in normal development rather than discovered in
production), and serves a twelve-team fixture league.

---

## Development commands

```bash
npm run lint          # ESLint across every workspace
npm run format:check  # Prettier
npm run typecheck     # tsc --build across all project references
npm test              # Vitest
npm run build         # Build every workspace
npm run synth         # cdk synth — validates templates, no AWS account needed
```

All of these pass on a clean checkout, and CI runs the same set.

```bash
npm run test:watch    # Vitest in watch mode
npm run verify:yahoo  # Probe the real Yahoo API (see below)
```

---

## Verifying Yahoo connectivity

Once Yahoo grants access, set `YAHOO_MODE=live` with real credentials in `.env`, sign
in through the portal, then probe the real API:

```bash
npm run verify:yahoo -- --token "<yahoo access token>"
npm run verify:yahoo -- --token "<token>" --league "nnn.l.nnnnnn"
```

The script reports which capabilities actually work and prints the exact
`verifiedCapabilities` block to paste into `yahoo-capabilities.json`. It deliberately
does **not** edit that file: the whole point of the file is that a human reviewed
each entry.

The two probes to watch:

- **Roster bench detection.** Most challenges depend on `selected_position` being
  `BN` for bench players. That is a widely-used convention, not documented behavior.
  If the observed code differs, the script tells you which constant to change.
- **Projected points.** Nothing in Yahoo's current or archived documentation
  describes projections as an API field. A failure here is the expected result and
  confirms that Overachiever and Bullseye stay blocked.

---

## Yahoo capabilities

`yahoo-capabilities.json` at the repository root is **not documentation**. The
application reads it at runtime and refuses to calculate anything depending on an
unverified capability. The `/yahoo-capabilities` page in the app renders it.

Each entry records confidence and test status:

| Confidence          | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `documented`        | Stated in current official Yahoo documentation               |
| `documented-legacy` | Only in the archived, unofficial mirror of Yahoo's old guide |
| `inferred`          | Widely used by third-party clients, absent from current docs |
| `unknown`           | No reliable source found                                     |

| Test status | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `untested`  | Never exercised against a real Yahoo league        |
| `mock-only` | Exercised against local fixtures only              |
| `verified`  | Exercised successfully against a real Yahoo league |
| `failed`    | Exercised and did not behave as documented         |

`verifiedCapabilities` ships **empty**. That is why every challenge currently reports
blocked.

### What is known about Yahoo, as of 2026-07-26

| Finding                                                                                           | Source                                                                                 |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Access requires application and approval; read-only by default                                    | [sports.yahoo.com/developer/access](https://sports.yahoo.com/developer/access/)        |
| The old guide 308-redirects to a landing page; real docs moved                                    | verified fetch; base URL `https://fantasysports.yahooapis.com/fantasy/v2`              |
| **Zero write operations documented** — GET only                                                   | [sports.yahoo.com/developer/docs](https://sports.yahoo.com/developer/docs/)            |
| OAuth: `api.login.yahoo.com/oauth2/request_auth` and `/get_token`, HTTP Basic, refresh may rotate | [oauth2 flow docs](https://developer.yahoo.com/oauth2/guide/flows_authcode/)           |
| Yahoo data must be purged within 24 hours unless explicitly storable indefinitely                 | [API ToS](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html) |
| Prohibited uses include gambling; monetization needs written permission                           | same                                                                                   |
| No published rate limit found                                                                     | — the client is conservative regardless                                                |

---

## Deployment

The CDK stack is account-, region-, and domain-agnostic. `cdk synth` runs with no
AWS credentials, which is how CI validates it.

```bash
cd infrastructure
npx cdk bootstrap                                  # once per account/region
npx cdk deploy -c environment=dev -c alertEmail=you@example.com
```

Optional custom domain (all three are required together):

```bash
npx cdk deploy -c environment=prod \
  -c domainName=portal.example.com \
  -c hostedZoneId=Z0123456789ABC \
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/...
```

The certificate must be in **us-east-1** — CloudFront requires it.

### After the first deploy

1. Note the `AppUrl` and `YahooRedirectUri` outputs.
2. Register `YahooRedirectUri` on your Yahoo application, exactly as printed.
3. Put the real Yahoo client ID and secret into the secret named in `AppSecretArn`.
4. Redeploy with `APP_BASE_URL` set to the real URL (the first deploy uses a
   placeholder, since the CloudFront domain is not known until it exists).
5. Build and upload the frontend:

   ```bash
   npm run build --workspace @dinkel/web
   aws s3 sync apps/web/dist "s3://$(aws cloudformation describe-stacks \
     --stack-name DinkelPortal-dev \
     --query 'Stacks[0].Outputs[?OutputKey==`WebBucketName`].OutputValue' --output text)" --delete
   aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'
   ```

6. Open the URL and complete commissioner setup.

### What gets created

DynamoDB table (encrypted, point-in-time recovery, TTL, two GSIs) · Lambda (ARM64,
Node 22, X-Ray) · API Gateway HTTP API · CloudFront distribution with security
headers and a strict CSP · two S3 buckets (frontend, and encrypted imports with
seven-day expiry) · two Secrets Manager secrets · six EventBridge schedules · an SQS
dead-letter queue · three CloudWatch alarms with an SNS topic · least-privilege IAM
including explicit denies on `DeleteTable`, `UpdateTable`, and `Scan`.

---

## Environment variables

| Variable               | Required | Notes                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `YAHOO_CLIENT_ID`      | yes      | From Yahoo after approval. Placeholder is accepted in mock mode.      |
| `YAHOO_CLIENT_SECRET`  | yes      | Same. Never commit it.                                                |
| `YAHOO_REDIRECT_URI`   | yes      | Must be HTTPS and match Yahoo's registration exactly.                 |
| `APP_BASE_URL`         | yes      | Public origin. Must be HTTPS in production.                           |
| `AWS_REGION`           | yes      |                                                                       |
| `DYNAMODB_TABLE_NAME`  | yes      |                                                                       |
| `SESSION_SECRET`       | yes      | Base64, exactly 32 bytes.                                             |
| `TOKEN_ENCRYPTION_KEY` | yes      | Base64, exactly 32 bytes. Rotating it forces every user to reconnect. |
| `YAHOO_MODE`           | no       | `mock` (default) or `live`.                                           |
| `YAHOO_MOCK_BASE_URL`  | no       | Default `http://localhost:4310`.                                      |
| `NODE_ENV`             | no       | Default `development`.                                                |
| `API_PORT`             | no       | Default `4300`.                                                       |
| `DYNAMODB_ENDPOINT`    | no       | DynamoDB Local. Must be unset in production.                          |
| `IMPORT_BUCKET_NAME`   | no       | Imports fall back to in-memory handling without it.                   |
| `ANTHROPIC_API_KEY`    | no       | Enables recap prose. Recaps fall back to templates without it.        |
| `ANTHROPIC_MODEL`      | no       | Default `claude-sonnet-5`.                                            |
| `LOG_LEVEL`            | no       | `error`, `warn`, `info` (default), `debug`.                           |

Validated at startup by `packages/shared/src/env.ts`, which reports every problem at
once and never echoes a secret value in an error.

**No configuration is exposed through Vite environment variables.** Anything a
`VITE_` variable holds is inlined into publicly served JavaScript, so the frontend
receives what it needs from API responses instead. An ESLint rule forbids
`process.env` in the browser bundle.

---

## Data retention

The short version: **Yahoo data is fetched, not stored.**

Yahoo's API Terms of Use require removing Yahoo user data within 24 hours unless it
is explicitly identified as storable indefinitely. Public summaries identify exactly
two such values: the **GUID** and the **token value**.

So:

- Standings, matchups, rosters, scores, team names, and manager nicknames are read
  live on every request and cached for **2–60 minutes**, never more than 24 hours.
  The ceiling is enforced by the database's TTL attribute and by a unit test that
  fails if any code path tries to exceed it.
- There is **no permanent entity** for players, rosters, matchups, transactions,
  standings, draft results, or weekly statistics. A test asserts those names never
  appear in the persisted-entity registry.
- A **persistence firewall** walks every persisted schema and fails the build if a
  field looks like retained Yahoo content. Adding `yahooTeamName` to a record breaks
  CI rather than shipping a policy violation.
- Finalized challenge results keep only derived values: season, week, challenge,
  winning member, winning value, a sentence of arithmetic, timestamps, approval, and
  payment status.

**The one durable name** is the display name each person confirms in their profile.
It is prefilled from their Yahoo nickname and then confirmed, which makes it this
application's data rather than Yahoo's. Without it, a 2021 challenge result could not
be rendered after that manager left the league.

Full detail in [PRIVACY.md](PRIVACY.md).

---

## Security notes

- TypeScript strict mode with `noUncheckedIndexedAccess` throughout.
- Yahoo tokens encrypted at rest with AES-256-GCM in a versioned, self-describing
  envelope. GCM authenticates the ciphertext, so tampering fails to decrypt rather
  than yielding attacker-influenced plaintext.
- **The browser never receives the Yahoo refresh token.** It has no token at all.
- Sessions are opaque random IDs in `HttpOnly; Secure; SameSite=Lax` cookies, backed
  by revocable database records. `Lax` rather than `Strict` because the OAuth
  callback is a cross-site top-level navigation that must carry the session.
- CSRF double-submit on every state-changing request.
- OAuth state is 32 CSPRNG bytes, single-use, expiring in ten minutes, compared in
  constant time. A replayed callback is rejected with a distinct error code.
- Logging redacts by key name **and** by value shape, so a secret logged under an
  innocent-looking field name is still caught. No token, secret, or raw Yahoo payload
  can reach CloudWatch.
- Every privileged route is authorized on the backend. Hidden UI is presentation, not
  a security boundary.
- Removing commissioner access revokes that user's sessions immediately.
- The last commissioner cannot be demoted, and the primary commissioner cannot be
  removed without transferring the role first — a league with no commissioner cannot
  grant anyone access back.
- Uniqueness is enforced by conditional writes and transactions, not read-then-write:
  one LLWS team cannot be assigned twice, and two managers cannot claim the same
  draft slot.
- Optimistic-concurrency version checks on every entity write.
- Safe error responses: stack traces and upstream error bodies stay in logs.
- Strict CSP, HSTS, `nosniff`, `DENY` framing, `no-referrer`, and `no-store` on API
  responses.
- Explicit single-origin CORS allowlist — no wildcard, no origin reflection.
- Dependency audit in CI.

---

## Current limitations

**Yahoo**

- API access is not granted yet, so nothing has been verified against a real league.
  Every weekly challenge reports blocked.
- No Yahoo write operation is used, or possible. The LLWS workflow produces a
  printable draft order for **manual entry** in Yahoo.
- Projected points appear to have no API field, blocking Overachiever and Bullseye.
- Raw stat ids are undocumented, blocking Air Raid, Catch Everything, and Touchdown
  Dependency. Their configured ids are conventional and **unverified**.
- The bench slot code `BN` is a convention, not documented behavior.
- No published rate limit, so the client is deliberately conservative: sequential
  roster reads, exponential backoff with jitter, `Retry-After` honoured.

**Portal**

- The thirteen challenge rules are **proposals**, not the league's actual rules. Every
  knob is editable in the portal without a code change.
- CSV import validates, previews, and detects conflicts for all nine data kinds, but
  only **seasons** and **league rules** are applied on commit. Other kinds report
  their rows as skipped rather than silently claiming to have imported them.
- Scheduled jobs are designed, scheduled, and wired with dead-letter handling, but
  the handlers are not implemented.
- Recaps assemble facts and templated prose; the pluggable model provider is not
  wired up.
- No email or SMS is sent. Reminders and invitations are recorded, and the
  commissioner passes them along.
- Single league per deployment. The data model is league-scoped throughout, so
  lifting that needs no migration.

---

## Testing

```bash
npm test
```

Covers: OAuth state generation, validation, expiry, and replay; callback failures;
token refresh and rotation; Yahoo pagination; response parsing against fixtures
shaped like Yahoo's real awkward JSON; error, rate-limit, and retry behavior;
commissioner authorization in both directions; CSRF; token encryption and tamper
detection; the cache TTL ceiling; the persistence firewall; CSV validation, dry runs,
duplicates, conflicts, and rollback; every unblocked challenge including ties and
stat-correction recalculation; override and finalized-result protection; LLWS
assignment uniqueness; deterministic seeded randomization; draft-slot locking; and
audit-log creation.

Fixtures are entirely synthetic. **No real league data, manager name, or Yahoo
response is committed** — this repository is public, and Yahoo's terms forbid
retaining that data regardless.

---

## Removing a Yahoo connection

In the app: **Dashboard → Remove Yahoo connection**. This deletes the stored
encrypted tokens and every cached Yahoo response for your account immediately, and
writes an audit record.

You can also revoke access directly in Yahoo's account settings, independently of the
portal. The next portal request then reports `yahoo_needs_reconnect` and offers a
reconnect button.

---

## License

[MIT](LICENSE).

Not affiliated with, endorsed by, or sponsored by Yahoo. This is a hobby project for
one private league; it processes no payments and is not a gambling or wagering
product.
