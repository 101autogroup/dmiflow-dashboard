require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const { connectDB, getClientPromise } = require('./config/db');

// Import routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const callsRoutes = require('./routes/calls');
const agentsRoutes = require('./routes/agents');
const agentChangeRequestsRoutes = require('./routes/agentChangeRequests');
const adminRoutes = require('./routes/admin');
const visitorsRoutes = require('./routes/visitors');
const pixelWebhookRoutes = require('./routes/pixelWebhook');

const app = express();

// A rejected promise must not take the process down with it. The Mongo driver
// rejects in the background during an outage, and an unhandled rejection is
// fatal in Node 16+.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : reason);
});

// Deliberately no connect-at-boot here. A fire-and-forget connect is not
// awaited by any request, so Vercel can freeze the instance mid-handshake and
// the attempt dies unnoticed - production logs showed instances thawing minutes
// later still holding the dead connection. The readiness gate below is the only
// thing that opens a connection, which guarantees a live request is always
// waiting on it.

// Trust proxy - required for Render and other hosting platforms
app.set('trust proxy', 1);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json({ limit: '10mb' })); // AudienceLab webhooks can batch many events
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check - must not touch the database, so uptime monitoring can tell
// an app outage apart from a database outage.
app.get('/healthz', (req, res) => {
  const { isConnected } = require('./config/db');
  res.status(200).json({ ok: true, db: isConnected() ? 'connected' : 'disconnected' });
});

/**
 * Readiness gate.
 *
 * Everything past this point needs Mongo: the session store reads from it on
 * every request. If it is unreachable we answer 503 and let the caller retry,
 * rather than letting the session middleware throw or the process die. Static
 * assets are already served above, so they keep working during an outage.
 */
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    res.status(503)
    .set('Retry-After', '10')
    .type('html')
    .send('<!doctype html><title>Temporarily unavailable</title><h1>Temporarily unavailable</h1><p>We cannot reach the database right now. Please retry in a few seconds.</p>');
  }
});

// AudienceLab webhook - machine-to-machine, no session needed
app.use('/webhooks/audiencelab', pixelWebhookRoutes);

// Session configuration
const sessionStore = MongoStore.create({
  clientPromise: getClientPromise(),
  ttl: 24 * 60 * 60 // 1 day
});
// Without a listener, a store error surfaces as an unhandled rejection.
sessionStore.on('error', (err) => {
  console.error('Session store error:', err.message);
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

// Make user available to all views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

// Routes
app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/calls', callsRoutes);
app.use('/agents', agentsRoutes);
app.use('/agent-change-requests', agentChangeRequestsRoutes);
app.use('/admin', adminRoutes);
app.use('/visitors', visitorsRoutes);

// Home redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page Not Found',
    message: 'The page you are looking for does not exist.'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', {
    title: 'Server Error',
    message: process.env.NODE_ENV === 'production'
    ? 'Something went wrong.'
      : err.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
