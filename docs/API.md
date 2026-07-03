# SportyQo API Reference

Base URL: `https://api.sportyqo.example` (dev: `http://localhost:8080`).
All endpoints except `/health`, `/sports`, and `/auth/*` require `Authorization: Bearer <accessToken>`.
Envelope: `{ "success": true, "data": ..., "meta"? }` or `{ "success": false, "error": { "code", "message", "details"? } }`.
Pagination: `?page=1&limit=20` → `meta: { page, limit, total, totalPages }`.

---

## Auth

### POST /auth/register/player
```json
{ "email": "arjun@example.com", "phone": "+919900000002", "password": "Password@123",
  "fullName": "Arjun Mehta", "sportId": "<uuid, optional>" }
```
→ `201`
```json
{ "success": true, "data": {
  "userId": "22b7…", "role": "PLAYER",
  "playerId": "SQP2026100002",
  "accessToken": "eyJ…", "refreshToken": "…", "tokenType": "Bearer", "expiresIn": 900 } }
```
The `playerId` is what the "Your Player ID is Ready!" screen displays. Email *or* phone is required.

### POST /auth/register/coach
Same shape plus optional `academy`. Returns `coachCode` (e.g. `SQC2026100001`) for the access-code screen.

### POST /auth/login
```json
{ "identifier": "arjun@example.com OR +919900000002", "password": "Password@123" }
```
→ `200` `{ "userId", "role", "accessToken", "refreshToken", … }`
Errors: `401 UNAUTHORIZED` "Incorrect email/phone or password".

### POST /auth/refresh — `{ "refreshToken" }` → new token pair (old refresh token is rotated/revoked).
### POST /auth/logout — `{ "refreshToken"? }` (omit to revoke all sessions).
### POST /auth/forgot-password — `{ "identifier" }` → always `200` (sends 6-digit OTP, 15 min TTL).
### POST /auth/reset-password — `{ "identifier", "code": "123456", "newPassword" }`.
### POST /auth/verify — `{ "identifier", "code" }` → `{ "verified": true }`.
### POST /auth/social/:provider — `501 NOT_IMPLEMENTED` stub for the social buttons.

---

## Me

### GET /me
```json
{ "success": true, "data": {
  "userId": "…", "role": "PLAYER", "email": "…", "phone": "…", "isVerified": true,
  "fullName": "Arjun Mehta", "dob": "2010-04-12", "gender": "MALE",
  "location": "Bangalore, Karnataka", "avatarUrl": "https://…",
  "sport": { "id": "…", "name": "Cricket", "emoji": "🏏", "slug": "cricket" },
  "playerId": "SQP2026100002", "qoScore": 742,
  "schoolAcademy": "Falcons Cricket Academy", "club": "Falcons FC",
  "bio": "…", "settings": { "notifications": true, "publicProfile": true } } }
```
Coaches get `coachCode`, `title`, `academy`, `yearsExperience`, `isVerifiedCoach` instead of the player fields.

### PATCH /me/profile
Partial update; player fields: `fullName, dob (YYYY-MM-DD), gender, location, schoolAcademy, club, sportId, bio, settings`; coach fields: `academy, title, yearsExperience` instead of school/club. Returns the updated `/me` payload.

### POST /me/avatar — multipart, field `avatar` (png/jpg/webp ≤ 5 MB) → `{ "avatarUrl" }`.

### Academy history (player only) — powers the editable "Academy Experience" list
- **GET /me/academy** → `[ { id, academy, role, startYear, endYear } ]`
- **POST /me/academy** — `{ "academy", "role"?, "startYear"?, "endYear"? }` → `201` with the created row.
- **PATCH /me/academy/:id** — same body; only your own rows.
- **DELETE /me/academy/:id** → `{ "deleted": true }`.
`endYear` must be ≥ `startYear` when both are provided; omit `endYear` for a current academy ("Present").

---

## Sports

### GET /sports (public)
```json
{ "success": true, "data": [
  { "id": "…", "slug": "cricket", "name": "Cricket", "emoji": "🏏", "iconUrl": null },
  { "id": "…", "slug": "football", "name": "Football", "emoji": "⚽", "iconUrl": null } ] }
```

---

## Players

### GET /players/:id/home  — the player home screen in one call
```json
{ "success": true, "data": {
  "greeting": "Hi, Arjun!",
  "player": { "id": "…", "playerId": "SQP2026100002", "fullName": "Arjun Mehta",
              "avatarUrl": null, "qoScore": 742,
              "sport": { "id": "…", "name": "Cricket", "emoji": "🏏" } },
  "activeLeague": {
    "id": "…", "name": "Falcons U16 Premier League", "icon": "🏆", "logoUrl": null,
    "gender": "MENS", "season": "Summer League 2024",
    "team": { "id": "…", "name": "Falcons FC", "icon": "🦅" } },
  "upcomingMatch": {
    "id": "…", "scheduledAt": "2026-07-07T05:06:20Z", "venue": "City Stadium, Bangalore",
    "homeTeam": { "name": "Falcons FC", "icon": "🦅" },
    "awayTeam": { "name": "Alpha Warriors", "icon": "🛡️" } },
  "notifications": { "unreadCount": 5, "recent": [
    { "id": "…", "type": "QO_POINTS", "title": "Qo Points Earned",
      "body": "+52 Qo points added to your profile", "emoji": "⚡",
      "isRead": false, "createdAt": "…" } ] } } }
```
`activeLeague`, `team`, and `upcomingMatch` are `null` when absent — the frontend's existing fallback copy handles that.
Access: the player themself, or a coach whose league the player belongs to.

### GET /players/discover?sport=&q=&page=&limit=
Public-profile leaderboard for the Dugout screen. Each row now includes `isFollowing` (whether *you* follow that player) alongside `followers`, `matchesPlayed`, `verified`, etc.

### GET /players/:id/profile
Profile screen data: identity fields plus `followers`, `following`, `academyHistory[]` (`{academy, role, startYear, endYear}`), `recommendations[]` (`{text, coachName, coachTitle, createdAt}`), and `settings`.

### GET /players/:id/performance
```json
{ "success": true, "data": {
  "qoScore": 742,
  "qoJourney": [ { "label": "Feb", "period": "2026-02-01…", "qoScore": 540,
                   "matchesPlayed": 2, "aggregates": { "runs": 96 } }, … ],
  "recentMatches": [
    { "id": "…", "matchId": "…", "opponent": "vs Thunder Strikers",
      "playedAt": "…", "resultSummary": "Falcons FC won by 24 runs",
      "stats": { "runs": 78, "balls": 59, "strikeRate": 132.2 },
      "qoPoints": 52, "rating": "8.5" } ] } }
```

### GET /players?q=arjun&page=1&limit=20 (coach only)
Searches players inside the coach's leagues by name or player code (select-players screen).

---

## Leagues

### POST /leagues (coach) — `multipart/form-data`
Fields: `payload` (JSON string), optional `logo` file, optional `teamLogo_0 … teamLogo_n` files (index-aligned with `teams`).
```json
payload = { "name": "Falcons U16 Premier League", "location": "Bangalore, Karnataka",
  "gender": "Men's", "sportId": "<uuid>", "iconEmoji": "🏆", "season": "Summer League 2024",
  "teams": [ { "name": "Falcons FC", "iconEmoji": "🦅" }, { "name": "Thunder Strikers" } ] }
```
`gender` accepts the UI strings `Men's` / `Women's` / `Mixed`. → `201`:
```json
{ "success": true, "data": { "id": "…", "name": "…", "gender": "MENS", "icon": "🏆",
  "logoUrl": null, "teams": [ { "id": "…", "name": "Falcons FC", "icon": "🦅", "logoUrl": null } ],
  "leagueCode": "482913", "status": "ACTIVE", "createdAt": "…" } }
```

### POST /leagues/join (player) — `{ "code": "482913" }`
→ `{ "joined": true, "league": { "id", "name" } }`. Errors: `400` invalid/expired/limit-reached code, `409` already joined. The owning coach receives a "New player joined" notification.

### GET /leagues — my leagues (coach: owned; player: joined). Paginated; each item has `counts: {players, teams}`.
### GET /leagues/:id — details + `counts: { teams, players, matchesPlayed }`. Access: owner coach or member player.
### GET /leagues/:id/teams — `[ { id, name, icon, logoUrl, rosterCount } ]`. Access: owner coach or member player.
### GET /leagues/:id/code (owner) — `{ code, useCount, maxUses, expiresAt, createdAt }`.
### POST /leagues/:id/code/rotate (owner) — revokes the current code, issues a new one.
### POST /leagues/:id/share (owner) — `{ code, message, deepLink: "sportyqo://join?code=482913" }` for the share sheet.

---

## Teams

### GET /teams/:id/roster
```json
{ "success": true, "data": {
  "team": { "id": "…", "name": "Falcons FC", "icon": "🦅", "logoUrl": null, "leagueId": "…" },
  "roster": [ { "membershipId": "…", "playerId": "…", "playerCode": "SQP2026100002",
                "fullName": "Arjun Mehta", "avatarUrl": null, "qoScore": 742,
                "jerseyNo": 7, "position": "Batsman", "isCaptain": true, "status": "ACTIVE" } ] } }
```

### GET /teams/:id/summary — `{ teamId, name, rosterCount, matchesPlayed, upcomingMatches, averageQoScore }`.

### POST /teams/:id/players (coach) — `{ "playerId", "jerseyNo"?, "position"?, "isCaptain"? }`
Adds a league member to the roster (400 if the player hasn't joined the league).

### PATCH /teams/:id/players/:playerId/stats (coach)
```json
{ "matchId": "<uuid>", "stats": { "runs": 85, "wickets": 1, "strikeRate": 140.3 },
  "qoPoints": 60, "rating": 8.8 }
```
Upserts the stat line for that match. The player's profile `qoScore` is adjusted by the *delta* vs the previous value, and a `QO_POINTS` notification is sent. → `{ id, matchId, playerId, stats, qoPoints, rating, updatedAt }`.

---

## Coach

### GET /coach/dashboard
```json
{ "success": true, "data": {
  "coach": { "id": "…", "fullName": "Coach Suneeth", "title": "Head Coach",
             "academy": "Falcons Cricket Academy", "coachCode": "SQC2026100001",
             "isVerified": true, "avatarUrl": null, "sport": { "name": "Cricket", "emoji": "🏏" } },
  "counts": { "leagues": 1, "players": 4, "unreadNotifications": 1 },
  "leagues": [ { "id": "…", "name": "Falcons U16 Premier League", "icon": "🏆",
                 "status": "ACTIVE", "counts": { "players": 4, "teams": 4 } } ],
  "notifications": { "recent": [ … ] },
  "showCreateLeagueCta": false } }
```
`showCreateLeagueCta: true` when the coach owns no leagues → show the "Create your first league" card.

### GET /coach/performance
`{ totals: { matchesCompleted, matchesUpcoming, qoPointsAwarded }, topPlayers: [ {fullName, playerCode, qoScore, avatarUrl} ], recentMatches: [ {homeTeam, awayTeam, homeScore, awayScore, resultSummary, leagueName, playedAt} ] }`.

### GET /coach/certifications — `[ { id, title, issuer, issuedOn, status: PENDING|APPROVED|REJECTED, documentUrl, createdAt } ]`.
### POST /coach/certifications — multipart: `document` file + `title`, `issuer?`, `issuedOn?`.

---

## Playbook

### GET /playbook?sportId=&kind=DRILL|STRATEGY|VIDEO|NOTE&q=&page=&limit=
Visibility: global **coach-authored** items, items scoped to your teams/leagues, and your own items.
Player-authored items are always private to their author.
`[ { id, kind, title, description, tags[], mediaUrl, sport: {name, emoji}, authorName, isMine, createdAt } ]`.

### POST /playbook (player or coach)
Two request styles:
- `application/json` — `{ title, description?, kind?, sportId?, teamId?, leagueId?, tags? }` (metadata only).
- `multipart/form-data` — same fields as form values plus a `media` file (photo ≤ 10 MB: PNG/JPG/WEBP/GIF; video ≤ 100 MB: MP4/MOV/WEBM). `tags` may be a JSON array string or comma-separated.

`kind` defaults from the media type when omitted (video → `VIDEO`, photo → `DRILL`, none → `NOTE`).
Players cannot scope items to teams/leagues (their items are personal); coaches can scope to leagues/teams they own.
Returns `201 { id, kind, title, description, tags[], mediaUrl, isMine, createdAt }`.

### DELETE /playbook/:id (author only)
Deletes the item and its stored media. `200 { deleted: true }`.

---

## Dugout (chat)

### GET /dugout — my threads
`[ { id, scope: TEAM|LEAGUE|DIRECT, title: "Falcons FC Dugout", icon: "🦅", lastMessage: { body, senderName, at } } ]`.

### GET /dugout/:id/messages?page=&limit=50 — newest first
`[ { id, body, senderId, senderName, isMine, attachmentUrl, createdAt } ]`.

### POST /dugout/:id/messages — `{ "body": "Great win, team!" }` → `201` message object.
403 unless you are a thread participant.

---

## Notifications

### GET /notifications?unread=true&page=&limit=
`[ { id, type, title, body, emoji, data, isRead, createdAt } ]`.
Types: `QO_POINTS · LEAGUE_UPDATE · SOCIAL · MATCH · ACHIEVEMENT`.

### POST /notifications/read — `{ "ids": ["…"] }` or `{}` for mark-all.

---

## Matches

### GET /matches?leagueId=&teamId=&status=scheduled|live|completed|cancelled
`[ { id, scheduledAt, status, venue, homeScore, awayScore, resultSummary, homeTeam: {id,name,icon}, awayTeam: {…}, leagueName } ]`.

### POST /matches (coach, own league) — `{ leagueId, homeTeamId, awayTeamId, scheduledAt (ISO), venue? }`.
