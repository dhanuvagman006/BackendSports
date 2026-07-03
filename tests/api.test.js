// Integration tests for the SportyQo API.
// Runs against a real Postgres (DATABASE_URL) with migrations + seeds applied:
//   npm run db:reset && npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const db = require('../src/config/db');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

const api = async (method, path, { body, token, raw } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON (static files) */ }
  return { status: res.status, json };
};

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const PASS = 'Password@123';

// A tiny valid PNG for upload tests.
const png = () => {
  const zlib = require('zlib');
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(require('zlib').crc32
      ? zlib.crc32(Buffer.concat([Buffer.from(t), d]))
      : crc32(Buffer.concat([Buffer.from(t), d])));
    return Buffer.concat([len, Buffer.from(t), d, crc]);
  };
  function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc & 0xffffff00) >>> 8 ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
};

const multipart = (fields, fileField, filename, fileBuf, mime) => {
  const boundary = `----test${uniq()}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
};

// ── health ────────────────────────────────────────────────────────────
test('health endpoint responds', async () => {
  const r = await api('GET', '/health');
  assert.strictEqual(r.status, 200);
});

test('unknown route returns structured 404', async () => {
  const r = await api('GET', '/nope');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.error.code, 'NOT_FOUND');
});

// ── auth ──────────────────────────────────────────────────────────────
test('register → login → refresh rotation → logout', async () => {
  const email = `t${uniq()}@test.dev`;
  const reg = await api('POST', '/auth/register/player',
    { body: { email, password: PASS, fullName: 'Test Player' } });
  assert.strictEqual(reg.status, 201);
  assert.ok(reg.json.data.playerId.length >= 6);

  const login = await api('POST', '/auth/login', { body: { identifier: email, password: PASS } });
  assert.strictEqual(login.status, 200);
  const { refreshToken } = login.json.data;

  const ref1 = await api('POST', '/auth/refresh', { body: { refreshToken } });
  assert.strictEqual(ref1.status, 200);

  // rotation: the used refresh token must now be rejected
  const ref2 = await api('POST', '/auth/refresh', { body: { refreshToken } });
  assert.strictEqual(ref2.status, 401);

  const out = await api('POST', '/auth/logout',
    { token: ref1.json.data.accessToken, body: {} });
  assert.strictEqual(out.status, 200);
  const ref3 = await api('POST', '/auth/refresh',
    { body: { refreshToken: ref1.json.data.refreshToken } });
  assert.strictEqual(ref3.status, 401, 'logout revokes refresh tokens');
});

test('wrong password and weak password are rejected', async () => {
  const email = `t${uniq()}@test.dev`;
  await api('POST', '/auth/register/player', { body: { email, password: PASS, fullName: 'PW Test' } });
  const bad = await api('POST', '/auth/login', { body: { identifier: email, password: 'nope' } });
  assert.strictEqual(bad.status, 401);
  const weak = await api('POST', '/auth/register/player',
    { body: { email: `w${uniq()}@test.dev`, password: 'short', fullName: 'Weak' } });
  assert.strictEqual(weak.status, 400);
});

test('duplicate email maps to 409, protected routes need auth', async () => {
  const email = `t${uniq()}@test.dev`;
  await api('POST', '/auth/register/player', { body: { email, password: PASS, fullName: 'Dup A' } });
  const dup = await api('POST', '/auth/register/player', { body: { email, password: PASS, fullName: 'Dup B' } });
  assert.strictEqual(dup.status, 409);
  const noauth = await api('GET', '/me');
  assert.strictEqual(noauth.status, 401);
});

// ── players / profile / academy ───────────────────────────────────────
const newPlayer = async (name = 'Flow Player') => {
  const email = `p${uniq()}@test.dev`;
  const r = await api('POST', '/auth/register/player', { body: { email, password: PASS, fullName: name } });
  return { token: r.json.data.accessToken, userId: r.json.data.userId };
};

test('player home/profile/performance respond with expected shapes', async () => {
  const { token, userId } = await newPlayer();
  for (const ep of ['home', 'profile', 'performance']) {
    const r = await api('GET', `/players/${userId}/${ep}`, { token });
    assert.strictEqual(r.status, 200, ep);
  }
  const home = await api('GET', `/players/${userId}/home`, { token });
  assert.ok(home.json.data.player.playerId);
});

test('profile PATCH persists and academy CRUD is owner-scoped', async () => {
  const a = await newPlayer('Owner A');
  const b = await newPlayer('Intruder B');

  const patch = await api('PATCH', '/me/profile',
    { token: a.token, body: { location: 'Mysuru', gender: 'MALE', bio: 'test bio' } });
  assert.strictEqual(patch.status, 200);
  assert.strictEqual(patch.json.data.location, 'Mysuru');

  const add = await api('POST', '/me/academy',
    { token: a.token, body: { academy: 'Test Academy', role: 'Batsman', startYear: 2022, endYear: 2024 } });
  assert.strictEqual(add.status, 201);
  const id = add.json.data.id;

  const badYears = await api('POST', '/me/academy',
    { token: a.token, body: { academy: 'Bad Years', startYear: 2024, endYear: 2020 } });
  assert.strictEqual(badYears.status, 400);

  // another user cannot edit or delete it
  const hack = await api('PATCH', `/me/academy/${id}`,
    { token: b.token, body: { academy: 'Hacked' } });
  assert.strictEqual(hack.status, 404);
  const hackDel = await api('DELETE', `/me/academy/${id}`, { token: b.token });
  assert.strictEqual(hackDel.status, 404);

  const del = await api('DELETE', `/me/academy/${id}`, { token: a.token });
  assert.strictEqual(del.status, 200);
});

test('discover supports search and reports isFollowing', async () => {
  const { token } = await newPlayer();
  const r = await api('GET', '/players/discover?q=rahul', { token });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.data));
  if (r.json.data.length) assert.ok('isFollowing' in r.json.data[0]);
});

// ── uploads ───────────────────────────────────────────────────────────
test('avatar upload works and serves; wrong type is a clean 400', async () => {
  const { token } = await newPlayer();
  const good = multipart({}, 'avatar', 'a.png', png(), 'image/png');
  const up = await fetch(`${base}/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': good.type },
    body: good.body,
  });
  assert.strictEqual(up.status, 200);
  const { avatarUrl } = (await up.json()).data;
  const img = await fetch(`${base}${avatarUrl}`);
  assert.strictEqual(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/png/);

  const bad = multipart({}, 'avatar', 'a.txt', Buffer.from('hi'), 'text/plain');
  const upBad = await fetch(`${base}/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': bad.type },
    body: bad.body,
  });
  assert.strictEqual(upBad.status, 400, 'non-image rejected with 400, not 500');
});

test('uploads path traversal is blocked', async () => {
  const r = await fetch(`${base}/uploads/..%2f..%2fpackage.json`);
  assert.ok([400, 403, 404].includes(r.status));
});

// ── leagues / dugout / RBAC ───────────────────────────────────────────
test('coach-only routes reject players; league code join flow works', async () => {
  const player = await newPlayer('League Player');
  const forbidden = await api('GET', '/coach/dashboard', { token: player.token });
  assert.strictEqual(forbidden.status, 403);

  const wrongCode = await api('POST', '/leagues/join',
    { token: player.token, body: { code: '000000' } });
  assert.ok([400, 404].includes(wrongCode.status), 'unknown code rejected');

  const join = await api('POST', '/leagues/join',
    { token: player.token, body: { code: '482913' } }); // seeded league
  assert.ok([200, 201].includes(join.status));
  const leagueId = join.json.data.leagueId ?? join.json.data.league_id ?? join.json.data.league?.id;

  const teams = await api('GET', `/leagues/${leagueId}/teams`, { token: player.token });
  assert.strictEqual(teams.status, 200, 'member can view teams');

  const outsider = await newPlayer('Outsider');
  const denied = await api('GET', `/leagues/${leagueId}/teams`, { token: outsider.token });
  assert.strictEqual(denied.status, 403, 'non-member cannot view teams');
});

test('direct messages require a shared league', async () => {
  const a = await newPlayer('Msg A');
  const b = await newPlayer('Msg B');
  const direct = await api('POST', '/dugout/direct',
    { token: a.token, body: { userId: b.userId } });
  assert.strictEqual(direct.status, 403, 'no shared league → forbidden');

  await api('POST', '/leagues/join', { token: a.token, body: { code: '482913' } });
  await api('POST', '/leagues/join', { token: b.token, body: { code: '482913' } });
  const direct2 = await api('POST', '/dugout/direct',
    { token: a.token, body: { userId: b.userId } });
  assert.ok([200, 201].includes(direct2.status));
  const threadId = direct2.json.data.threadId;

  const send = await api('POST', `/dugout/${threadId}/messages`,
    { token: a.token, body: { body: 'hello from tests' } });
  assert.strictEqual(send.status, 201);
  const msgs = await api('GET', `/dugout/${threadId}/messages`, { token: b.token });
  assert.strictEqual(msgs.status, 200);
  assert.ok(msgs.json.data.some((m) => m.body === 'hello from tests'));

  // an unrelated user cannot read the thread
  const c = await newPlayer('Msg C');
  const spy = await api('GET', `/dugout/${threadId}/messages`, { token: c.token });
  assert.ok([403, 404].includes(spy.status));
});

test('notifications list and mark-read', async () => {
  const { token } = await newPlayer();
  const list = await api('GET', '/notifications', { token });
  assert.strictEqual(list.status, 200);
  const mark = await api('POST', '/notifications/read-all', { token, body: {} });
  assert.ok([200, 404].includes(mark.status)); // route optional
});

// ── playbook media uploads ────────────────────────────────────────────
const newCoach = async (name = 'Flow Coach') => {
  const email = `c${uniq()}@test.dev`;
  const r = await api('POST', '/auth/register/coach',
    { body: { email, password: PASS, fullName: name, academy: 'Test Academy' } });
  assert.strictEqual(r.status, 201);
  return { token: r.json.data.accessToken, userId: r.json.data.userId };
};

const uploadPlaybook = async (token, fields, filename, buf, mime) => {
  const m = multipart(fields, 'media', filename, buf, mime);
  const res = await fetch(`${base}/playbook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': m.type },
    body: m.body,
  });
  return { status: res.status, json: await res.json() };
};

test('player uploads a playbook photo: saved, listed, served, deletable', async () => {
  const { token } = await newPlayer('Uploader');
  const up = await uploadPlaybook(token,
    { title: 'My batting form', tags: '["batting","form"]' }, 'form.png', png(), 'image/png');
  assert.strictEqual(up.status, 201);
  assert.ok(up.json.data.mediaUrl, 'upload returns a media URL');
  assert.strictEqual(up.json.data.kind, 'DRILL', 'photos default to DRILL');
  assert.deepStrictEqual(up.json.data.tags, ['batting', 'form']);

  const served = await fetch(`${base}${up.json.data.mediaUrl}`);
  assert.strictEqual(served.status, 200, 'uploaded media is downloadable');

  const list = await api('GET', '/playbook?q=My batting form', { token });
  const mine = list.json.data.find((i) => i.id === up.json.data.id);
  assert.ok(mine, 'uploaded item appears in GET /playbook');
  assert.strictEqual(mine.isMine, true);

  const del = await api('DELETE', `/playbook/${up.json.data.id}`, { token });
  assert.strictEqual(del.status, 200);
  const after = await api('GET', '/playbook?q=My batting form', { token });
  assert.ok(!after.json.data.some((i) => i.id === up.json.data.id), 'deleted item disappears');
});

test('player uploads a video: kind defaults to VIDEO', async () => {
  const { token } = await newPlayer('Video Uploader');
  const fakeMp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 7)]);
  const up = await uploadPlaybook(token, { title: 'Net session' }, 'net.mp4', fakeMp4, 'video/mp4');
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.json.data.kind, 'VIDEO');
  assert.match(up.json.data.mediaUrl, /\.mp4$/);
});

test('player-authored playbook items are private to the author', async () => {
  const author = await newPlayer('Private Author');
  const secretTitle = `Secret drill ${uniq()}`;
  const up = await uploadPlaybook(author.token, { title: secretTitle }, 'p.png', png(), 'image/png');
  assert.strictEqual(up.status, 201);

  const stranger = await newPlayer('Stranger');
  const list = await api('GET', `/playbook?q=${encodeURIComponent(secretTitle)}`, { token: stranger.token });
  assert.strictEqual(list.status, 200);
  assert.ok(!list.json.data.some((i) => i.title === secretTitle),
    'another user must not see a player-private item');

  const delOther = await api('DELETE', `/playbook/${up.json.data.id}`, { token: stranger.token });
  assert.strictEqual(delOther.status, 404, 'only the author can delete');
});

test('coach JSON-only playbook create still works (back-compat)', async () => {
  const coach = await newCoach();
  const r = await api('POST', '/playbook',
    { token: coach.token, body: { title: 'Zone press', kind: 'STRATEGY', tags: ['defence'] } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.data.kind, 'STRATEGY');
  assert.strictEqual(r.json.data.mediaUrl, null);
});

test('playbook rejects wrong file types and missing titles cleanly', async () => {
  const { token } = await newPlayer('Validator');
  const badType = await uploadPlaybook(token, { title: 'Nope' }, 'x.pdf', Buffer.from('%PDF'), 'application/pdf');
  assert.strictEqual(badType.status, 400);
  const noTitle = await uploadPlaybook(token, {}, 'y.png', png(), 'image/png');
  assert.strictEqual(noTitle.status, 400);
});

test('404 message names the missing route for diagnosability', async () => {
  const { token } = await newPlayer();
  const r = await api('GET', '/dugout//messages', { token });
  assert.strictEqual(r.status, 404);
  assert.match(r.json.error.message, /GET \/dugout\/\/messages/);
});

test('academy entries persist through the profile reload path the app uses', async () => {
  const { token, userId } = await newPlayer('Academy Persister');
  const add = await api('POST', '/me/academy',
    { token, body: { academy: 'Persistence FC', role: 'Winger', startYear: 2020, endYear: 2024 } });
  assert.strictEqual(add.status, 201);

  // The profile screen reloads via GET /players/:id/profile → academyHistory
  const prof = await api('GET', `/players/${userId}/profile`, { token });
  assert.strictEqual(prof.status, 200);
  assert.ok(prof.json.data.academyHistory.some((a) => a.academy === 'Persistence FC'));

  // And the dedicated endpoint agrees
  const mine = await api('GET', '/me/academy', { token });
  assert.ok(mine.json.data.some((a) => a.academy === 'Persistence FC'));
});
