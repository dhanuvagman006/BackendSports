# SportyQo Backend

Production-ready REST backend for the SportyQo Flutter app (Player / Coach sports platform). Node.js + Express + PostgreSQL + S3-compatible object storage, JWT auth with role-based access control.

## 1. Architecture overview

```
Flutter app ──HTTPS/JSON──▶ Express API ──▶ PostgreSQL (data)
                               │
                               └──────────▶ S3 / MinIO (avatars, league & team logos,
                                            certification documents, chat attachments)
```

Layering inside `src/`:

| Layer | Path | Responsibility |
|---|---|---|
| Config | `src/config` | env parsing, PG pool + transactions |
| Middleware | `src/middleware` | JWT auth, `requireRole`, zod validation, error handler |
| Routes | `src/routes` | one router per domain (auth, me, sports, players, leagues, teams, coach, content) |
| Services | `src/services/storage.js` | object storage upload/delete/public URL |
| Utils | `src/utils` | response envelope, pagination, human-friendly code generators |

Design decisions worth knowing:

- **Server-generated IDs.** Player IDs use the same `SQP<year><6 digits>` format the frontend currently fakes, but they are generated and uniqueness-checked server-side (`utils/codes.js`). Coach access codes are `SQC<year><6 digits>`. The generating-ID screen just calls register and shows the returned `playerId`.
- **6-digit league codes** match the six-box join screen. Only one code is active per league (partial unique index); codes are revocable and rotatable, with optional `max_uses`/`expires_at`.
- **Sport-agnostic stats.** `player_stats.stats` is JSONB (`{"runs":78,"wickets":1}`), so cricket works today and football/basketball work later without migrations. Each stat line carries a `qo_points` delta; editing a line applies the *difference* to the player's profile `qo_score` transactionally and emits a notification ("+52 Qo points added to your profile").
- **Aggregate screen endpoints.** `/players/:id/home` and `/coach/dashboard` return everything the home screens need in one round trip (greeting, active league/team, upcoming match, notification preview, counts), with `null`s where the frontend already has fallback copy ("Not in a team", "Join a league to get started").

## 2. Database schema

See `migrations/001_init.sql`. Entity map:

```
users 1─1 player_profiles ──┐            users 1─1 coach_profiles ──┐
                            │                                       │ owns
sports ◀── leagues ◀────────┼──── league_memberships                │
             │  ▲           │                                       ▼
             │  └── league_codes (active/revoked, use counts)   coach_certifications
             ▼
           teams ◀── team_roster_memberships ── player_profiles
             │
           matches ◀── player_stats (JSONB stats + qo_points, edited_by coach)
           performance_metrics (monthly Qo Journey buckets)
notifications · chat_threads/chat_participants/dugout_messages · playbook_items
follows · recommendations · academy_history
```

Key indexes: active-code partial unique index on `league_codes(code)`, `(league_id, scheduled_at)` on matches, `(user_id, is_read, created_at)` on notifications, `(thread_id, created_at)` on dugout messages, roster and stats FK indexes.

## 3. API surface

Full request/response examples in **`docs/API.md`**. Summary:

```
POST /auth/register/player · /auth/register/coach · /auth/login · /auth/refresh
POST /auth/logout · /auth/forgot-password · /auth/reset-password · /auth/verify
POST /auth/social/:provider (501 stub)
GET  /me            PATCH /me/profile        POST /me/avatar
GET  /sports
GET  /players/:id/home · /players/:id/profile · /players/:id/performance
GET  /players?q= (coach search, paginated)
POST /leagues (multipart: payload + logo + teamLogo_i)   GET /leagues (mine)
GET  /leagues/:id · /leagues/:id/teams · /leagues/:id/code
POST /leagues/join · /leagues/:id/code/rotate · /leagues/:id/share
GET  /teams/:id/roster · /teams/:id/summary
POST /teams/:id/players
PATCH /teams/:id/players/:playerId/stats
GET  /coach/dashboard · /coach/performance · /coach/certifications
POST /coach/certifications (multipart)
GET  /playbook?sportId=&kind=&q=      POST /playbook
GET  /dugout · /dugout/:id/messages   POST /dugout/:id/messages
GET  /notifications?unread=true       POST /notifications/read
GET  /matches?leagueId=&teamId=&status=   POST /matches
GET  /health
```

Pagination: `?page=&limit=` (limit capped at 100), response `meta: {page, limit, total, totalPages}`. Search: `q` on player search and playbook. Filters: sport/kind/status/team/league where relevant.

## 4. Authentication & authorization

- **Login identifier** is a single field accepted as email *or* phone (`/auth/login {identifier, password}`), matching the login screen.
- **Access tokens**: JWT (HS256), 15 min, payload `{sub: userId, role}`. Sent as `Authorization: Bearer <token>`.
- **Refresh tokens**: opaque random strings, SHA-256-hashed at rest, 30 days, rotated on every `/auth/refresh`, revocable (logout revokes one or all).
- **Passwords**: bcrypt cost 12. Reset flow issues a 6-digit OTP (hashed, 15 min TTL, single-use) and revokes all sessions on success. Forgot-password always returns 200 to prevent account enumeration.
- **RBAC**: `requireRole('COACH')` / `('PLAYER')` middleware plus resource-level ownership checks — coaches can only touch leagues/teams they own; players can only read their own aggregates; a coach can read a player only if that player is in one of the coach's leagues; chat requires thread membership.
- Rate limiting on `/auth/*` (50 req / 15 min / IP).

## 5. Validation & error format

All input validated with zod. Every response uses one envelope:

```jsonc
// success
{ "success": true, "data": { ... }, "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 } }

// error
{ "success": false,
  "error": {
    "code": "BAD_REQUEST",          // UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | INTERNAL | NOT_IMPLEMENTED
    "message": "Validation failed",
    "details": [ { "field": "password", "message": "Password must be at least 8 characters" } ]
  } }
```

HTTP codes: 400 validation, 401 missing/expired token, 403 role/ownership, 404 missing resource, 409 duplicates (also mapped from PG unique violations), 429 rate limit, 500 sanitized internal.

## 6. Seed data

`npm run seed` loads content mirroring the frontend mocks so screens render during incremental integration. All demo accounts use password **`Password@123`**:

| Account | Role | Notes |
|---|---|---|
| `coach.suneeth@sportyqo.dev` | Coach | "Coach Suneeth", Head Coach, Falcons Cricket Academy, verified badge, 2 approved certifications |
| `arjun@sportyqo.dev` | Player | `SQP2026100002`, Qo 742, Falcons FC captain, Qo Journey history, academy history, coach recommendation |
| `rahul@` / `vikram@` / `jason@sportyqo.dev` | Players | Falcons FC / Thunder Strikers roster |

Plus: league **"Falcons U16 Premier League"** (Bangalore, Men's, 🏆, active join code **`482913`**), teams Falcons FC / Thunder Strikers / Alpha Warriors / Royal Challengers, two completed matches ("78 Runs", "32 Runs / 2 Wickets" stat cards), one upcoming match, the five mock notifications from the home screen ("+52 Qo points…", "Summer League 2024 is now live!", "Jason liked your match highlight", …), a Falcons FC dugout thread, and three playbook items.

## 7. Running it

```bash
# everything (API + Postgres + MinIO, auto-migrate + seed)
docker compose up --build

# or locally
cp .env.example .env
npm install
npm run migrate && npm run seed
npm run dev
```

## 8. Flutter integration plan

1. **API client layer.** Add `dio` (or `http`) + a small `ApiClient` with the base URL from `--dart-define`, an auth interceptor that attaches the access token, and a 401 interceptor that calls `/auth/refresh` once and retries. Store tokens in `flutter_secure_storage`.
2. **Models.** Create DTOs mirroring `docs/API.md` responses (the JSON is already camelCase and mobile-shaped). Codegen with `json_serializable` is enough.
3. **Auth screens first.** Wire create-account → `POST /auth/register/player|coach`; the generating-ID screen becomes a loading state that shows `data.playerId` from the register response (delete `_generatePlayerId()`); login screen posts its single field as `identifier`.
4. **Home screens.** Replace `_activeLeague`/`_activeTeam` and the notification/match mock lists with `GET /players/:id/home` and `GET /coach/dashboard`. Keep the existing fallback strings for the `null` cases — the API intentionally returns `null` for "no team / no league".
5. **League flows.** Create-league screen submits multipart (`payload` JSON + `logo` + `teamLogo_0..n`) to `POST /leagues` and pushes the share screen with the returned `leagueCode`; join screen posts the 6 digits to `POST /leagues/join`.
6. **Rosters, stats, performance.** Team selection → `GET /leagues/:id/teams`; roster → `GET /teams/:id/roster`; coach stat editing → `PATCH /teams/:id/players/:playerId/stats`; performance screen → `GET /players/:id/performance` (`qoJourney` maps to the chart, `recentMatches` to the cards).
7. **Content screens.** Playbook, dugout, notifications map 1:1 to their endpoints; dugout can poll `GET /dugout/:id/messages` initially (WebSockets can be added later without changing the REST shapes).
8. **Rollout.** Integrate screen-by-screen behind a `useBackend` flag; the seed data guarantees each screen looks identical to the current mocks, so visual regressions are easy to spot.

## Enabling CI

The GitHub Actions workflow lives at `ci/github-actions-ci.yml` (pushing workflow files needs a token with the `workflow` scope, which the deploy token lacked). To enable CI:

```bash
mkdir -p .github/workflows && git mv ci/github-actions-ci.yml .github/workflows/ci.yml
git commit -m "Enable CI" && git push
```
