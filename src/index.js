require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2,
  });
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please try again in 15 minutes' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// General write rate limit — 200 mutations per 15 min per IP
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down' },
});
app.use('/api/milestones',    writeLimiter);
app.use('/api/submissions',   writeLimiter);
app.use('/api/reviews',       writeLimiter);
app.use('/api/disputes',      writeLimiter);
app.use('/api/reports',       writeLimiter);
app.use('/api/messages',      writeLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/users', require('./routes/users'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/agreements', require('./routes/agreements'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/files', require('./routes/files'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/health', require('./routes/health'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
console.log('=== Environment Debug ===');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'MISSING');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('PORT:', process.env.PORT);
console.log('========================');

// Test network connectivity
const https = require('https');
https.get('https://www.google.com', (res) => {
  console.log('✓ Can reach Google:', res.statusCode);
}).on('error', (err) => {
  console.log('✗ Cannot reach Google:', err.message);
});

// Test DNS resolution
const dns = require('dns').promises;
dns.resolve4(process.env.DB_HOST).then(
  (ips) => console.log('✓ DNS resolved DB_HOST to:', ips),
  (err) => console.log('✗ DNS failed for DB_HOST:', err.message)
);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
