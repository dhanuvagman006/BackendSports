const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const config = require('./config');
const { errorHandler, notFound } = require('./middleware');

const authRoutes = require('./routes/auth');
const { meRouter } = require('./routes/me');
const sportsRoutes = require('./routes/sports');
const playerRoutes = require('./routes/players');
const leagueRoutes = require('./routes/leagues');
const teamRoutes = require('./routes/teams');
const coachRoutes = require('./routes/coach');
const { playbook, dugout, notifications, matches } = require('./routes/content');

const app = express();
app.set('trust proxy', 1);
if (config.env === 'production') app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ autoLogging: config.env === 'production' }));

// Locally stored uploads (dev fallback when S3/MinIO is not running).
const storage = require('./services/storage');
app.use('/uploads', express.static(storage.LOCAL_DIR, {
  maxAge: '7d',
  immutable: true,
}));

// Objects stored in S3/MinIO are streamed through the API, so clients only
// ever need the API host they already talk to. (Presigned URLs pointed at
// the Docker-internal http://minio:9000, which phones cannot resolve — the
// avatar uploaded fine but never displayed.) Keys are content-addressed
// UUIDs, so aggressive immutable caching is safe.
app.get('/uploads/*', async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params[0] || '');
    if (!key || key.includes('..')) return next();
    const obj = await storage.fetchObject(key);
    if (!obj || !obj.Body) return next();
    res.set('Content-Type', obj.ContentType || 'application/octet-stream');
    if (obj.ContentLength != null) res.set('Content-Length', String(obj.ContentLength));
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    obj.Body.on('error', () => res.destroy());
    obj.Body.pipe(res);
  } catch {
    next();
  }
});

// throttle auth endpoints against credential stuffing / OTP brute force
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true }));

// Version comes from package.json so a quick `curl /health` reveals whether
// the running container is a stale build (the cause of "Route not found"
// errors in the app after the code has moved on).
const { version } = require('../package.json');
app.get('/health', (_req, res) => res.json({ ok: true, version, ts: new Date().toISOString() }));

app.use('/auth', authRoutes);
app.use('/me', meRouter);
app.use('/sports', sportsRoutes);
app.use('/players', playerRoutes);
app.use('/leagues', leagueRoutes);
app.use('/teams', teamRoutes);
app.use('/coach', coachRoutes);
app.use('/playbook', playbook);
app.use('/dugout', dugout);
app.use('/notifications', notifications);
app.use('/matches', matches);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
