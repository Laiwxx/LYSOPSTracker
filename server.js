require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const msal = require('@azure/msal-node');
const multer = require('multer');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { AsyncLocalStorage } = require('async_hooks');
const _authStore = new AsyncLocalStorage();

// ── MSAL: single CCA instance + cached token ──────────────────────────────────
let _msalCCA = null;
let _cachedToken = null;
function _getMSALCCA() {
  if (_msalCCA) return _msalCCA;
  const clientId     = process.env.AZURE_CLIENT_ID;
  const tenantId     = process.env.AZURE_TENANT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!clientId || !tenantId || !clientSecret) return null;
  _msalCCA = new msal.ConfidentialClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, clientSecret }
  });
  return _msalCCA;
}
async function getAccessToken() {
  const cca = _getMSALCCA();
  if (!cca) return null;
  // Reuse cached token only if it expires more than 5 minutes from now
  if (
    _cachedToken &&
    _cachedToken.accessToken &&
    _cachedToken.expiresOn &&
    new Date(_cachedToken.expiresOn) > new Date(Date.now() + 5 * 60 * 1000)
  ) {
    return _cachedToken.accessToken;
  }
  // Acquire a fresh token
  try {
    _cachedToken = await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
    if (!_cachedToken || !_cachedToken.accessToken) {
      console.error('[MSAL] acquireTokenByClientCredential returned empty result');
      _cachedToken = null;
      return null;
    }
    return _cachedToken.accessToken;
  } catch (e) {
    console.error('[MSAL] Token acquisition failed:', e.message);
    logError('msal.token.acquisition', e);
    _cachedToken = null;
    return null;
  }
}

const app = express();

// ── Security hardening — headers ──────────────────────────────────────────────
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none';");
  next();
});

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://lys-ops.cloud';
const DATA_FILE  = path.join(__dirname, 'data', 'projects.json');
const STAFF_FILE = path.join(__dirname, 'config', 'staff.json');
const ADMIN_FILE = path.join(__dirname, 'config', 'admin.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer: PDF uploads only, max 20 MB
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Route project uploads into per-project subdirectories
    const projectId = req.params.id;
    if (projectId) {
      const safeId = path.basename(projectId); // prevent path traversal
      const projectDir = path.join(UPLOADS_DIR, 'projects', safeId);
      if (!projectDir.startsWith(path.resolve(UPLOADS_DIR))) return cb(new Error('Invalid project ID'));
      if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
      return cb(null, projectDir);
    }
    cb(null, UPLOADS_DIR);
  },
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});

// PDF-only (used by DO photo route, kept strict)
const upload = multer({
  storage: uploadStorage,
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Images + PDF (used by project upload route — FAB photos, drawings, docs)
const uploadImageOrPdf = multer({
  storage: uploadStorage,
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /^image\//.test(file.mimetype);
    cb(null, ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Log-photo upload: used by the fab-row daily log accountability model.
// Every log entry must carry a photo. Files land in
// `public/uploads/fab-logs/<projectId>/<logId>.jpg`, dynamically resolved
// per request. Memory-storage multer is used so we can run the image
// through sharp (EXIF strip, HEIC→JPEG normalize, resize cap) before
// writing the final file to disk. Max 15MB inbound — phone photos are
// 4–8MB, HEIC bursts can be larger, 15MB gives headroom without letting
// a single upload hog the server.
const sharp = require('sharp');
const FAB_LOGS_DIR = path.join(__dirname, 'public', 'uploads', 'fab-logs');
if (!fs.existsSync(FAB_LOGS_DIR)) fs.mkdirSync(FAB_LOGS_DIR, { recursive: true });
const uploadLogPhoto = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(express.json());

// ── Graceful shutdown — must be registered early so SIGTERM works during startup
process.on('SIGTERM', () => { console.log('[SHUTDOWN] SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { console.log('[SHUTDOWN] SIGINT received'); process.exit(0); });

// ── Per-staff Session Auth ───────────────────────────────────────────────────
// Each staff member has their own username/password in config/credentials.json.
// Sessions are cookie-based — works cleanly on mobile (no Basic Auth popup).
const CREDS_FILE = path.join(__dirname, 'config', 'credentials.json');
let _credsCache = null;
let _credsMtime = 0;
function readCredentials() {
  try {
    const stat = fs.statSync(CREDS_FILE);
    if (_credsCache && stat.mtimeMs === _credsMtime) return _credsCache;
    _credsCache = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    _credsMtime = stat.mtimeMs;
    return _credsCache;
  } catch { return {}; }
}
function getAuthUser() { return _authStore.getStore() || 'System'; }

const crypto = require('crypto');
// Persistent session secret: read from env, or generate once and cache to disk
const SESSION_SECRET_FILE = path.join(__dirname, 'config', '.session-secret');
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SESSION_SECRET_FILE, s); } catch {}
  return s;
}
app.set('trust proxy', 1); // Trust nginx reverse proxy
app.use(session({
  store: new FileStore({
    path: path.join(__dirname, 'data', 'sessions'),
    ttl: 30 * 24 * 60 * 60, // 30 days max
    retries: 0,
    reapInterval: 3600, // clean expired sessions every hour
    logFn: () => {} // silence file-store logs
  }),
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' } // 7 days default; extended to 30 days with "remember me"
}));

// Health check — no auth required, for uptime monitors
app.get('/api/health', (req, res) => {
  try {
    // Quick sanity: can we read a data file?
    const projects = readProjects();
    res.json({ ok: true, uptime: Math.floor(process.uptime()), projects: projects.length, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Public paths that don't require auth
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/api/auth/login', '/api/auth/forgot-password', '/api/health']);

app.use((req, res, next) => {
  // Allow public paths
  if (PUBLIC_PATHS.has(req.path)) return next();
  // Allow static assets for login page
  if (req.path.startsWith('/css/') || req.path === '/js/utils.js' || req.path === '/js/nav.js' || req.path === '/manifest.json') return next();

  // Check session first — fastest path, no file I/O
  if (req.session && req.session.user) {
    req.authUser = req.session.user;
    _authStore.run(req.session.user, () => next());
    return;
  }

  // Also accept Basic Auth (for API/curl usage) — use email:password
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Basic ')) {
    const creds = readCredentials();
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx).toLowerCase().trim() : '';
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    const entry = creds[user];
    if (entry) {
      bcrypt.compare(pass, entry.hash).then(ok => {
        if (ok) {
          req.authUser = entry.name;
          _authStore.run(entry.name, () => next());
        } else {
          if (req.path.startsWith('/api/')) res.status(401).json({ error: 'Authentication required' });
          else res.redirect('/login');
        }
      }).catch(() => {
        if (req.path.startsWith('/api/')) res.status(401).json({ error: 'Authentication required' });
        else res.redirect('/login');
      });
      return;
    }
  }

  // Not authenticated
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Authentication required' });
  } else {
    res.redirect('/login');
  }
});

// ── Login / Logout endpoints ─────────────────────────────────────────────────
// Login brute-force protection: 5 attempts per IP per 5 minutes
const _loginAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _loginAttempts) if (now - v.start > 5 * 60 * 1000) _loginAttempts.delete(k);
}, 60000).unref();
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = _loginAttempts.get(ip);
  if (!entry || now - entry.start > 5 * 60 * 1000) {
    entry = { count: 0, start: now };
  }
  entry.count++;
  _loginAttempts.set(ip, entry);
  if (entry.count > 5) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes.' });
  }
  next();
}

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { username, password, rememberMe } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Email and password required' });
  const creds = readCredentials();
  const key = username.toLowerCase().trim();
  const entry = creds[key];
  if (entry && await bcrypt.compare(password, entry.hash)) {
    // Clear login attempts on success
    _loginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
    // Extend session to 30 days if "remember me" checked
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    }
    req.session.user = entry.name;
    req.session.username = key;
    res.json({ ok: true, name: entry.name });
  } else {
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// Block direct access to locked pages — force through route handlers
app.use((req, res, next) => {
  if (req.path === '/sales.html') {
    const user = req.session && req.session.user;
    const SALES_ALLOWED = new Set(['Lai Wei Xiang', 'Janessa', 'Alex Chew']);
    if (!user || !SALES_ALLOWED.has(user)) return res.redirect('/');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Login page (served without auth)
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// Clean URL routes for SPA-style pages
app.get('/tasks',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'tasks.html')));
app.get('/my-tasks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-tasks.html')));
app.get('/factory',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'factory.html')));
app.get('/feedback',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'feedback.html')));
app.get('/installation', (req, res) => res.sendFile(path.join(__dirname, 'public', 'installation.html')));
app.get('/planning',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'planning.html')));
app.get('/attendance',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'attendance.html')));
app.get('/sales', (req, res) => {
  const user = req.session && req.session.user;
  const SALES_ALLOWED = new Set(['Lai Wei Xiang', 'Janessa', 'Alex Chew']);
  if (!user || !SALES_ALLOWED.has(user)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'sales.html'));
});
app.get('/procurement',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'procurement.html')));

// ── Delivery Orders ─────────────────────────────────────────────────────────
const DO_UPLOADS_DIR = path.join(UPLOADS_DIR, 'delivery-orders');
if (!fs.existsSync(DO_UPLOADS_DIR)) fs.mkdirSync(DO_UPLOADS_DIR, { recursive: true });
const uploadDO = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Organize into project subfolders when projectCode is provided
      const projectCode = (req.body.projectCode || '').trim();
      if (projectCode) {
        const safeCode = path.basename(projectCode);
        const projectDir = path.join(DO_UPLOADS_DIR, safeCode);
        if (!projectDir.startsWith(path.resolve(DO_UPLOADS_DIR))) return cb(new Error('Invalid project code'));
        if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
        return cb(null, projectDir);
      }
      cb(null, DO_UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /^image\//.test(file.mimetype);
    cb(null, ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ── PO Document upload ──────────────────────────────────────────────────────
const PO_DOCS_DIR = path.join(UPLOADS_DIR, 'po-docs');
if (!fs.existsSync(PO_DOCS_DIR)) fs.mkdirSync(PO_DOCS_DIR, { recursive: true });
const SALES_UPLOADS_DIR = path.join(UPLOADS_DIR, 'sales');
if (!fs.existsSync(SALES_UPLOADS_DIR)) fs.mkdirSync(SALES_UPLOADS_DIR, { recursive: true });
const TICKETS_UPLOADS_DIR = path.join(UPLOADS_DIR, 'tickets');
if (!fs.existsSync(TICKETS_UPLOADS_DIR)) fs.mkdirSync(TICKETS_UPLOADS_DIR, { recursive: true });
// Multer for feedback ticket attachments. Files land in TICKETS_UPLOADS_DIR
// with a timestamp+random prefix; route handler moves them into a per-ticket
// subfolder once the ticket id is known.
const uploadTicketAttachment = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TICKETS_UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ok = /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only images and PDFs allowed'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }
});
const uploadPODoc = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Organize into project subfolders when projectCode is provided
      const projectCode = (req.body.projectCode || '').trim();
      if (projectCode) {
        const safeCode = path.basename(projectCode);
        const projectDir = path.join(PO_DOCS_DIR, safeCode);
        if (!projectDir.startsWith(path.resolve(PO_DOCS_DIR))) return cb(new Error('Invalid project code'));
        if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
        return cb(null, projectDir);
      }
      cb(null, PO_DOCS_DIR);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    }
  }),
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.post('/api/upload-po-doc', uploadPODoc.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
    const projectCode = (req.body.projectCode || '').trim();
    const subPath = projectCode ? `${path.basename(projectCode)}/` : '';
    const filePath = `/uploads/po-docs/${subPath}${req.file.filename}`;
    logActivity('po.doc.uploaded', { prId: req.body.prId || null, projectCode: projectCode || null, filename: req.file.filename });
    res.json({ filePath, filename: req.file.filename });
  } catch (e) { logError('route.post.upload-po-doc', e); res.status(500).json({ error: 'Upload failed' }); }
});

app.get('/api/delivery-orders', (req, res) => {
  try { res.json(readDOs()); }
  catch (e) { logError('route.get.delivery-orders', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/delivery-orders', uploadDO.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const dos = readDOs();
    const doProjectCode = (req.body.projectCode || '').trim();
    const doSubPath = doProjectCode ? `${path.basename(doProjectCode)}/` : '';
    const entry = {
      id: 'do_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      filename: `delivery-orders/${doSubPath}${req.file.filename}`,
      originalName: req.file.originalname,
      fileSize: req.file.size,
      prId: req.body.prId || null,
      prNumber: req.body.prNumber || null,
      projectCode: req.body.projectCode || null,
      notes: typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : '',
      uploadedBy: typeof req.body.uploadedBy === 'string' ? req.body.uploadedBy.slice(0, 100) : '',
      uploadedAt: new Date().toISOString()
    };
    dos.push(entry);
    writeDOs(dos);
    logActivity('do.uploaded', { id: entry.id, prId: entry.prId, prNumber: entry.prNumber, filename: entry.filename });
    res.status(201).json(entry);

    // Email Purchaser + Finance about the DO
    const purchaserEmail = getRoleEmail('Purchaser');
    const purchaserName = (readStaff()['Purchaser'] || {}).name || 'Purchaser';
    const financeEmail = getRoleEmail('Finance');
    const financeName = (readStaff()['Finance'] || {}).name || 'Finance';
    const prLabel = entry.prNumber ? `linked to ${entry.prNumber}` : 'no PR linked';
    const projLabel = entry.projectCode || 'General';
    const doUrl = `${APP_URL}/uploads/${entry.filename}`;
    const emailBody = `<p style="margin:0 0 16px;">A Delivery Order has been uploaded.</p>` +
      emailTable([
        ['File', escHtml(entry.originalName)],
        ['PR', escHtml(prLabel)],
        ['Project', escHtml(projLabel)],
        ['Uploaded by', escHtml(entry.uploadedBy || '—')],
        entry.notes ? ['Notes', escHtml(entry.notes)] : null
      ]) +
      `<p style="margin:0;"><a href="${doUrl}">View DO</a> · <a href="${APP_URL}/procurement">Open Procurement</a></p>`;
    if (purchaserEmail) {
      sendEmail(purchaserEmail, purchaserName,
        `[DO] Delivery Order received — ${escHtml(projLabel)}${entry.prNumber ? ' · ' + entry.prNumber : ''}`,
        emailWrap(`Hi ${escHtml(purchaserName)},`, emailBody, null, null),
        financeEmail ? [financeEmail] : []
      ).catch(err => console.error('[EMAIL] DO notify failed:', err.message));
    }
  } catch (e) { logError('route.post.delivery-orders', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/delivery-orders/:id', postRateLimit, (req, res) => {
  try {
    const dos = readDOs();
    const idx = dos.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'DO not found' });
    const entry = dos[idx];
    dos.splice(idx, 1);
    writeDOs(dos);
    // Try to delete file from disk (filename includes subdirectory)
    try {
      const filePath = path.resolve(UPLOADS_DIR, entry.filename || '');
      if (filePath.startsWith(path.resolve(UPLOADS_DIR)) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
    logActivity('do.deleted', { id: entry.id, filename: entry.filename });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.delivery-orders', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- Data helpers ---
const TASKS_FILE         = path.join(__dirname, 'data', 'tasks.json');
const EOD_FILE           = path.join(__dirname, 'data', 'eod-logs.json');
const FLAG_FILE          = path.join(__dirname, 'data', 'eod-flags.json');
const TICKETS_FILE       = path.join(__dirname, 'data', 'tickets.json');
const WORKERS_FILE       = path.join(__dirname, 'data', 'workers.json');
const ATTENDANCE_FILE    = path.join(__dirname, 'data', 'attendance.json');
const MANPOWER_FILE      = path.join(__dirname, 'data', 'manpower-plans.json');
const TRANSPORT_FILE     = path.join(__dirname, 'data', 'transport.json');
const EOD_HISTORY_FILE   = path.join(__dirname, 'data', 'eod-history.json');
const ACTIVITY_LOG_FILE  = path.join(__dirname, 'data', 'activity.log');
const ERRORS_LOG_FILE    = path.join(__dirname, 'data', 'errors.log');
const CLAIMS_FILE        = path.join(__dirname, 'data', 'claims.json');
const SITE_REQUESTS_FILE = path.join(__dirname, 'data', 'site-requests.json');
const MONDAY_FLAGS_FILE  = path.join(__dirname, 'data', 'monday-flags.json');
const SUPPLIERS_FILE     = path.join(__dirname, 'data', 'suppliers.json');
const PRICES_FILE        = path.join(__dirname, 'data', 'prices.json');
const PO_FILE            = path.join(__dirname, 'data', 'purchase-orders.json');
const PR_FILE            = path.join(__dirname, 'data', 'purchase-requisitions.json');
const DO_FILE            = path.join(__dirname, 'data', 'delivery-orders.json');

// ── Email template helpers ───────────────────────────────────────────────────
// Consistent wrapper for all outgoing HTML emails.
// greeting: optional string like "Hi John," (pass null/empty to skip)
// bodyHtml: the unique content — tables, paragraphs, etc.
// ctaLabel/ctaUrl: optional call-to-action button (pass null to skip)
function emailWrap(greeting, bodyHtml, ctaLabel, ctaUrl) {
  const greetHtml = greeting ? `<p style="margin:0 0 16px;">${greeting}</p>` : '';
  const ctaHtml = ctaLabel && ctaUrl
    ? `<p style="margin:20px 0 0;"><a href="${ctaUrl}" style="background:#2563eb;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;display:inline-block;">${ctaLabel} →</a></p>`
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;color:#1a1a1a;line-height:1.5;">${greetHtml}${bodyHtml}${ctaHtml}<p style="margin:24px 0 0;font-size:11px;color:#999;">LYS Operations Tracker</p></div>`;
}

// Build a consistent label→value table from an array of [label, value] pairs.
// Falsy pairs are automatically filtered out.
function emailTable(rows) {
  const filtered = rows.filter(r => r && r[0] && r[1] !== undefined && r[1] !== null && r[1] !== '');
  if (!filtered.length) return '';
  const trs = filtered.map(([label, value]) =>
    `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;">${value}</td></tr>`
  ).join('');
  return `<table style="border-collapse:collapse;width:100%;margin:12px 0 16px;">${trs}</table>`;
}

// Warning/info box (amber)
function emailWarnBox(text) {
  return `<p style="margin:16px 0 0;padding:10px 14px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;color:#92400e;">${text}</p>`;
}

// Urgent/red box
function emailUrgentBox(text) {
  return `<p style="margin:16px 0 0;padding:10px 14px;background:#fef2f2;border-left:3px solid #ef4444;border-radius:4px;font-size:12px;color:#991b1b;">${text}</p>`;
}

// ── Email helper ──────────────────────────────────────────────────────────────
// cc may be a string, an array of strings, or omitted.
async function sendEmail(toEmail, toName, subject, htmlBody, cc, opts) {
  const fallbackSender = process.env.SENDER_EMAIL;
  if (!fallbackSender) return;

  // Suppress emails triggered by scenario test accounts
  const actor = getAuthUser();
  if (actor === 'Scenario Tester') return;

  // Determine who this email is sent FROM:
  // If the logged-in user has a mailbox, send from their email.
  // Otherwise fall back to SENDER_EMAIL (boss).
  const bossEmail = fallbackSender; // laiwx — always CC'd
  let fromEmail = fallbackSender;
  if (opts && opts.fromEmail) {
    fromEmail = opts.fromEmail;
  } else {
    const actorEmail = actor ? getStaffEmail(actor) : null;
    if (actorEmail && actorEmail.endsWith('@laiyewseng.com.sg')) {
      fromEmail = actorEmail;
    }
  }

  // TEST MODE: override recipient so all emails go to Lai during testing
  const recipient = process.env.EMAIL_TEST_OVERRIDE || toEmail;

  // Normalize cc → array, de-dupe, drop self-cc and the recipient, drop falsy
  let ccList = Array.isArray(cc) ? cc.slice() : cc ? [cc] : [];
  // Auto-CC boss on every email (non-negotiable) unless boss IS the sender AND recipient
  if (bossEmail) ccList.push(bossEmail);
  ccList = ccList.filter(Boolean);
  if (process.env.EMAIL_TEST_OVERRIDE) {
    // In test mode every email is already redirected to Lai — no CC leak to staff.
    ccList = [];
  } else {
    const seen = new Set([String(recipient).toLowerCase(), String(fromEmail).toLowerCase()]);
    ccList = ccList.filter(e => {
      const k = String(e).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  const ccRecipients = ccList.map(e => ({ emailAddress: { address: e } }));

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      console.warn(`[EMAIL SKIP] No access token — skipping email to ${recipient} ("${subject}")`);
      return;
    }
    const message = {
      subject,
      body: { contentType: 'HTML', content: htmlBody },
      toRecipients: [{ emailAddress: { address: recipient, name: toName || recipient } }]
    };
    if (ccRecipients.length) message.ccRecipients = ccRecipients;
    // Retry on 429 (MailboxConcurrency / ApplicationThrottled). Graph honors
    // Retry-After header; fall back to exponential backoff (1s, 3s, 7s).
    let res;
    let attempt = 0;
    const maxAttempts = 4;
    while (true) {
      res = await fetch(`https://graph.microsoft.com/v1.0/users/${fromEmail}/sendMail`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message })
      });
      // If sending from user's mailbox fails (403 = no permission), fall back to boss
      if ((res.status === 403 || res.status === 404) && fromEmail !== fallbackSender) {
        console.warn(`[EMAIL] Cannot send as ${fromEmail} (${res.status}), falling back to ${fallbackSender}`);
        fromEmail = fallbackSender;
        continue; // retry with fallback sender
      }
      if (res.status !== 429 || attempt >= maxAttempts - 1) break;
      const retryAfterHeader = parseInt(res.headers.get('retry-after'), 10);
      const waitMs = (Number.isFinite(retryAfterHeader) ? retryAfterHeader : Math.pow(2, attempt + 1) - 1) * 1000;
      console.warn(`[EMAIL] 429 throttled on "${subject}" → ${recipient}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, waitMs));
      attempt++;
    }
    if (!res.ok) {
      let errBody = '';
      try { errBody = await res.text(); } catch {}
      const msg = `Graph API ${res.status} ${res.statusText} — ${errBody}`;
      console.error(`[EMAIL] Failed to send "${subject}" → ${recipient} (from ${fromEmail}): ${msg}`);
      logError('email.send.graphapi', new Error(msg), { from: fromEmail, to: recipient, subject, status: res.status, attempts: attempt + 1 });
      return;
    }
    console.log(`[EMAIL] Sent "${subject}" from ${fromEmail} → ${recipient}${ccList.length ? ' cc:' + ccList.join(',') : ''}${attempt > 0 ? ` (after ${attempt} retries)` : ''}`);
  } catch (e) {
    console.error('[EMAIL] Exception sending to', recipient, ':', e.message);
    logError('email.send.exception', e, { from: fromEmail, to: recipient, subject });
  }
}

// ── Outlook Calendar helpers (Graph API /events) ─────────────────────────────
// Requires Calendars.ReadWrite application permission on the Azure app.
// If the assignee has no dueDate, no event is created.
// All events are created in the staff member's own calendar (not the sender's).

function _taskEventBody(task, assignedByName) {
  const lines = [];
  lines.push(`<p><strong>${escHtml(task.title)}</strong></p>`);
  if (task.description) lines.push(`<p>${escHtml(task.description)}</p>`);
  if (task.projectJobCode || task.projectName) {
    lines.push(`<p><em>Project:</em> ${escHtml(task.projectJobCode || '')} ${escHtml(task.projectName || '')}</p>`);
  }
  if (assignedByName) lines.push(`<p><em>Assigned by:</em> ${escHtml(assignedByName)}</p>`);
  lines.push(`<p><a href="${APP_URL}/my-tasks">Open in LYS Ops Tracker →</a></p>`);
  return lines.join('');
}

// Build a start/end pair for the task. Calendar events need a time window —
// we default to a 30-minute block at 9am SGT on the due date so it lands
// as an all-morning reminder rather than a full-day event that's easy to miss.
function _taskEventWindow(dueDate) {
  // dueDate is a YYYY-MM-DD string (local SGT).
  return {
    start: { dateTime: `${dueDate}T09:00:00`, timeZone: 'Asia/Singapore' },
    end:   { dateTime: `${dueDate}T09:30:00`, timeZone: 'Asia/Singapore' },
  };
}

// Create a calendar event on the assignee's mailbox for this task.
// Returns { eventId, ownerEmail } or null on failure. Non-throwing.
// Respects CALENDAR_TEST_OVERRIDE — when set, every event is routed to
// that single mailbox (mirrors EMAIL_TEST_OVERRIDE so pre-launch testing
// doesn't spam real staff calendars).
async function createTaskCalendarEvent(task, assigneeEmail, assignedByName) {
  if (!task || !task.dueDate || !assigneeEmail) return null;
  if (getAuthUser() === 'Scenario Tester') return null;
  const accessToken = await getAccessToken();
  if (!accessToken) { console.warn('[CAL SKIP] No access token'); return null; }
  const targetEmail = process.env.CALENDAR_TEST_OVERRIDE || assigneeEmail;
  const testMode = !!process.env.CALENDAR_TEST_OVERRIDE;
  const { start, end } = _taskEventWindow(task.dueDate);
  const subject = testMode
    ? `[TEST — would go to ${assigneeEmail}] [Task] ${task.title}`
    : `[Task] ${task.title}`;
  const bodyHtml = testMode
    ? `<p style="background:#fef3c7;border:1px solid #f59e0b;padding:8px;border-radius:4px;font-size:12px;"><strong>TEST MODE:</strong> this event would normally go to <strong>${assigneeEmail}</strong>. CALENDAR_TEST_OVERRIDE is active.</p>${_taskEventBody(task, assignedByName)}`
    : _taskEventBody(task, assignedByName);
  const body = {
    subject,
    body: { contentType: 'HTML', content: bodyHtml },
    start,
    end,
    isReminderOn: true,
    reminderMinutesBeforeStart: 60,
    categories: ['LYS Ops Tracker'],
    showAs: 'busy',
  };
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${targetEmail}/events`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[CAL] Create failed for ${targetEmail}: ${res.status} ${res.statusText} — ${errText}`);
      logError('calendar.create', new Error(`${res.status} ${res.statusText}`), { targetEmail, subject: body.subject });
      return null;
    }
    const json = await res.json();
    console.log(`[CAL] Event created for ${targetEmail}${testMode ? ' (TEST MODE, real assignee ' + assigneeEmail + ')' : ''} — ${json.id}`);
    return json.id ? { eventId: json.id, ownerEmail: targetEmail } : null;
  } catch (e) {
    console.error('[CAL] Exception creating event:', e.message);
    logError('calendar.create.exception', e, { targetEmail });
    return null;
  }
}

// Delete a calendar event from the assignee's mailbox. Non-throwing.
async function deleteTaskCalendarEvent(userEmail, eventId) {
  if (!userEmail || !eventId) return;
  const accessToken = await getAccessToken();
  if (!accessToken) return;
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${userEmail}/events/${eventId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[CAL] Delete failed for ${userEmail} event ${eventId}: ${res.status}`);
    } else {
      console.log(`[CAL] Event deleted for ${userEmail} — ${eventId}`);
    }
  } catch (e) {
    console.warn('[CAL] Exception deleting event:', e.message);
  }
}

// ── Staff email lookup ─────────────────────────────────────────────────────────
function getStaffEmail(name) {
  try {
    const staff = safeReadJSON(STAFF_FILE);
    const match = Object.values(staff).find(s => s.name === name);
    return match ? (match.email || null) : null;
  } catch { return null; }
}

// Role-based email lookup. Resolves a role alias (e.g. "Factory Manager")
// via staff.json key first, then falls back to name search, then boss.
function getRoleEmail(role) {
  try {
    const staff = safeReadJSON(STAFF_FILE);
    // Direct key lookup (role aliases like "Factory Manager", "Purchaser")
    if (staff[role] && staff[role].email) return staff[role].email;
  } catch {}
  // Fallback: maybe `role` is a person's name
  const byName = getStaffEmail(role);
  if (byName) return byName;
  // Final fallback: boss
  try {
    const staff = safeReadJSON(STAFF_FILE);
    if (staff['Project Manager'] && staff['Project Manager'].email) return staff['Project Manager'].email;
  } catch {}
  return process.env.ADMIN_EMAIL || null;
}

// Staff loaded dynamically from STAFF_FILE — no hardcoded list
function getStaffNames() {
  const raw = readStaff();
  const seen = new Set();
  return Object.values(raw)
    .filter(s => s.name && !seen.has(s.name) && seen.add(s.name))
    .map(s => s.name)
    .sort();
}

// ── Activity / Error logging helpers ─────────────────────────────────────────
// Size-based log rotation. Activity log grows unbounded — at 500 projects it
// would be 10–50 MB/year. When the active file exceeds LOG_ROTATE_BYTES,
// rename to .1 (and shift .1→.2, .2→.3) keeping LOG_ROTATE_KEEP archives.
// Cheap and stateless; runs inline on each write but bails fast when the file
// is below the threshold (the common case).
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;  // 10 MB
const LOG_ROTATE_KEEP  = 5;                 // keep up to 5 rotated archives

function _rotateLogIfNeeded(file) {
  try {
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.size < LOG_ROTATE_BYTES) return;
    // Drop the oldest, shift others up by one
    for (let i = LOG_ROTATE_KEEP; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (i === LOG_ROTATE_KEEP && fs.existsSync(dst)) { try { fs.unlinkSync(dst); } catch {} }
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch {} }
    }
  } catch (_) { /* tolerate — logging must never crash the request */ }
}

function logActivity(event, details = {}) {
  try {
    _rotateLogIfNeeded(ACTIVITY_LOG_FILE);
    const by = details.by || getAuthUser();
    const line = JSON.stringify({ ts: new Date().toISOString(), event, by, ...details }) + '\n';
    fs.appendFileSync(ACTIVITY_LOG_FILE, line);
  } catch {}
}
function logError(event, err, details = {}) {
  try {
    _rotateLogIfNeeded(ERRORS_LOG_FILE);
    const line = JSON.stringify({ ts: new Date().toISOString(), event, error: err && err.message ? err.message : String(err), ...details }) + '\n';
    fs.appendFileSync(ERRORS_LOG_FILE, line);
  } catch {}
}
// Strip BOM and parse JSON — use for all file reads
function safeReadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    // Primary file corrupt — try the .tmp backup left by safeWriteJSON
    const tmp = file + '.tmp';
    if (fs.existsSync(tmp)) {
      try {
        const data = JSON.parse(fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, ''));
        logError('safeReadJSON.recovered', new Error(`Corrupt ${path.basename(file)} — recovered from .tmp`));
        // Restore the good copy
        fs.copyFileSync(tmp, file);
        return data;
      } catch {}
    }
    // Both files bad — log and rethrow
    logError('safeReadJSON.corrupt', new Error(`Cannot parse ${path.basename(file)}: ${err.message}`));
    throw err;
  }
}

function readTasks() {
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]');
  return safeReadJSON(TASKS_FILE);
}
function writeTasks(tasks) {
  safeWriteJSON(TASKS_FILE, tasks);
}
function readEOD() {
  if (!fs.existsSync(EOD_FILE)) fs.writeFileSync(EOD_FILE, '[]');
  return safeReadJSON(EOD_FILE);
}

function todaySGT() {
  const sgt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  return sgt.getFullYear() + '-' + String(sgt.getMonth() + 1).padStart(2, '0') + '-' + String(sgt.getDate()).padStart(2, '0');
}
function dateSGT(offsetDays) {
  const sgt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  sgt.setDate(sgt.getDate() + offsetDays);
  return sgt.getFullYear() + '-' + String(sgt.getMonth() + 1).padStart(2, '0') + '-' + String(sgt.getDate()).padStart(2, '0');
}
function getWeekStart(date) {
  // Use SGT-aware date to determine the correct Monday
  const d = date ? new Date(date) : new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function readProjects() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const projects = safeReadJSON(DATA_FILE);
  // Normalize every fab row's qtyDone from its logs[] on the read path.
  // Any row with a `logs` array (including empty) gets its qtyDone
  // reconciled to sum(deltas) — empty array → 0, so deleting the last
  // log makes the row zero out as the user expects. Rows with no `logs`
  // field at all are left untouched (legacy transition only).
  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (Array.isArray(p.fabrication)) {
        for (const r of p.fabrication) recomputeQtyDone(r);
      }
      if (Array.isArray(p.installation)) {
        for (const r of p.installation) recomputeQtyDone(r);
      }
    }
  }
  return projects;
}
// ── Atomic write: tmp + rename prevents corruption on crash ──────────────────
// Write queue per file — prevents concurrent writes from corrupting data
const _writeQueues = new Map();
function safeWriteJSON(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = filePath + '.tmp';
  // Acquire per-file lock (queues writes so they execute sequentially)
  const absPath = path.resolve(filePath);
  const pending = _writeQueues.get(absPath) || Promise.resolve();
  const next = pending.then(() => {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, filePath);
  }).catch(err => {
    console.error('[safeWriteJSON] write failed:', absPath, err.message);
  });
  _writeQueues.set(absPath, next);
}

function writeProjects(projects) {
  safeWriteJSON(DATA_FILE, projects);
}
function readStaff() {
  if (!fs.existsSync(STAFF_FILE)) return {};
  return safeReadJSON(STAFF_FILE);
}
function writeStaff(staff) {
  safeWriteJSON(STAFF_FILE, staff);
}
function readAdmin() {
  if (!fs.existsSync(ADMIN_FILE)) return { pin: '' };
  return safeReadJSON(ADMIN_FILE);
}
function writeAdmin(data) {
  safeWriteJSON(ADMIN_FILE, data);
}

function readTickets() {
  if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, '[]');
  return safeReadJSON(TICKETS_FILE);
}
function writeTickets(tickets) {
  safeWriteJSON(TICKETS_FILE, tickets);
}
function readWorkers() {
  if (!fs.existsSync(WORKERS_FILE)) fs.writeFileSync(WORKERS_FILE, '[]');
  return safeReadJSON(WORKERS_FILE);
}
function writeWorkers(workers) {
  safeWriteJSON(WORKERS_FILE, workers);
}
function readManpowerPlans() {
  if (!fs.existsSync(MANPOWER_FILE)) fs.writeFileSync(MANPOWER_FILE, '[]');
  return safeReadJSON(MANPOWER_FILE);
}
function writeManpowerPlans(plans) {
  safeWriteJSON(MANPOWER_FILE, plans);
}
function readTransport() {
  if (!fs.existsSync(TRANSPORT_FILE)) fs.writeFileSync(TRANSPORT_FILE, '[]');
  return safeReadJSON(TRANSPORT_FILE);
}
function writeTransport(plans) {
  safeWriteJSON(TRANSPORT_FILE, plans);
}
function readEODHistory() {
  if (!fs.existsSync(EOD_HISTORY_FILE)) fs.writeFileSync(EOD_HISTORY_FILE, '[]');
  return safeReadJSON(EOD_HISTORY_FILE);
}

// ── HTML escape for email bodies ──────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Boss / role helpers ──────────────────────────────────────────────────────
function getBossEmail() {
  return getRoleEmail('Project Manager');
}
function getBossName() {
  return (readStaff()['Project Manager'] || {}).name || 'Boss';
}
function getFactoryManagerName() {
  return (readStaff()['Factory Manager'] || {}).name || 'Factory Manager';
}

// ── Input sanitization helpers ────────────────────────────────────────────────
function sanitizeStr(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}
function isValidDate(str) {
  if (!str || typeof str !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str).getTime());
}

// Allowed enum values
const VALID_TICKET_TYPES    = ['Bug', 'UI Feedback', 'Feature Request'];
const VALID_TICKET_STATUSES = ['New', 'In Review', 'Done'];
const VALID_PRIORITIES      = ['Low', 'Medium', 'High'];

// ── Rate limiting (30 POST requests/min per IP) ───────────────────────────────
const _rlMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rlMap) if (now - v.start > 60000) _rlMap.delete(k);
}, 60000).unref();
function postRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = _rlMap.get(ip);
  if (!entry || now - entry.start > 60000) {
    entry = { count: 0, start: now };
  }
  entry.count++;
  _rlMap.set(ip, entry);
  if (entry.count > 30) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  next();
}

// --- API: Tickets (Feedback / Bug Reports / Feature Requests) ---

// GET /api/tickets — return all tickets, newest first
app.get('/api/tickets', (req, res) => {
  try {
    const tickets = readTickets();
    res.json(tickets.slice().reverse());
  } catch (e) { logError('route.get.tickets', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/tickets — create a new ticket. Accepts multipart with up to 5
// image/PDF attachments under the `attachments` field. Falls back gracefully
// to JSON-only requests (no Content-Type guard) so older clients still work.
app.post('/api/tickets', postRateLimit, uploadTicketAttachment.array('attachments', 5), (req, res) => {
  try {
    const title       = sanitizeStr(req.body.title, 200);
    const type        = sanitizeStr(req.body.type, 50);
    const description = sanitizeStr(req.body.description, 2000);
    const submittedBy = sanitizeStr(req.body.submittedBy, 100);
    const priority    = sanitizeStr(req.body.priority, 20) || 'Medium';
    if (!title || !type || !submittedBy) return res.status(400).json({ error: 'title, type, and submittedBy are required' });
    if (!VALID_TICKET_TYPES.includes(type))   return res.status(400).json({ error: 'Invalid ticket type' });
    if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
    const tickets = readTickets();
    const ticket = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title,
      type,
      description,
      submittedBy,
      submittedAt: new Date().toISOString(),
      status: 'New',
      priority,
      notes: '',
      attachments: []
    };

    // Move any uploaded attachments into a per-ticket subfolder
    if (Array.isArray(req.files) && req.files.length) {
      const ticketDir = path.join(TICKETS_UPLOADS_DIR, ticket.id);
      if (!path.resolve(ticketDir).startsWith(path.resolve(TICKETS_UPLOADS_DIR) + path.sep)) {
        return res.status(400).json({ error: 'Invalid ticket id' });
      }
      if (!fs.existsSync(ticketDir)) fs.mkdirSync(ticketDir, { recursive: true });
      for (const f of req.files) {
        try {
          const dest = path.join(ticketDir, f.filename);
          fs.renameSync(f.path, dest);
          ticket.attachments.push({
            filename: f.filename,
            originalName: f.originalname || '',
            mimetype: f.mimetype,
            size: f.size,
            url: `/uploads/tickets/${ticket.id}/${f.filename}`
          });
        } catch (mvErr) { logError('ticket.attachment.move', mvErr); }
      }
    }

    tickets.push(ticket);
    writeTickets(tickets);
    res.status(201).json(ticket);

    // Write feedback as MD file for Claude to pick up next session
    // Skip for test accounts to avoid polluting memory
    if (ticket.submittedBy === 'Scenario Tester') { /* skip memory write for tests */ }
    else try {
      const memDir = path.join(__dirname, '..', '.claude', 'projects', '-home-ubuntu-ops-tracker', 'memory');
      const memFile = path.join(memDir, `feedback_${ticket.id}.md`);
      const memIndex = path.join(memDir, 'MEMORY.md');
      const md = `---\nname: Feedback — ${ticket.title}\ndescription: ${ticket.type} reported by ${ticket.submittedBy} on ${ticket.submittedAt.slice(0,10)}. Priority: ${ticket.priority}.\ntype: project\n---\n\n**${ticket.type}** reported by ${ticket.submittedBy}\n\n**Title:** ${ticket.title}\n\n**Description:** ${ticket.description || 'No description'}\n\n**Priority:** ${ticket.priority}\n\n**Status:** ${ticket.status}\n\n**How to apply:** Read the feedback, investigate the issue in the relevant page, fix it, then delete this memory file once resolved.\n`;
      fs.writeFileSync(memFile, md);
      // Append to MEMORY.md index
      const indexLine = `\n- [Feedback: ${ticket.title}](feedback_${ticket.id}.md) — ${ticket.type} by ${ticket.submittedBy}, ${ticket.priority} priority`;
      fs.appendFileSync(memIndex, indexLine);
      console.log(`[FEEDBACK] Written to Claude memory: feedback_${ticket.id}.md`);
    } catch (memErr) {
      console.error('[FEEDBACK] Failed to write memory file:', memErr.message);
    }

    // Trigger 6: email boss on every new feedback ticket
    const laiEmail = getBossEmail() || process.env.ADMIN_EMAIL || '';
    if (laiEmail) {
      sendEmail(laiEmail, getBossName(),
        `[New Feedback] ${ticket.title} — ${ticket.type}`,
        emailWrap(null,
          `<p style="margin:0 0 16px;">A new feedback ticket has been submitted:</p>` +
          emailTable([
            ['Title', escHtml(ticket.title)],
            ['Type', escHtml(ticket.type)],
            ['Submitted By', escHtml(ticket.submittedBy)],
            ['Priority', escHtml(ticket.priority)],
            ticket.description ? ['Description', escHtml(ticket.description)] : null
          ]),
          'View Feedback', `${APP_URL}/feedback`)
      ).catch(() => {});
    } else {
      console.warn('[EMAIL SKIP] No email for: Lai Wei Xiang (new ticket notification)');
    }
  } catch (e) { logError('route.post.tickets', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/tickets/:id — update status, priority, or notes
app.put('/api/tickets/:id', (req, res) => {
  try {
    const tickets = readTickets();
    const idx = tickets.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Ticket not found' });
    const status   = req.body.status   != null ? sanitizeStr(req.body.status, 20)   : undefined;
    const priority = req.body.priority != null ? sanitizeStr(req.body.priority, 20) : undefined;
    const notes    = req.body.notes    != null ? sanitizeStr(req.body.notes, 2000)   : undefined;
    if (status   !== undefined && !VALID_TICKET_STATUSES.includes(status))   return res.status(400).json({ error: 'Invalid status' });
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
    if (status   !== undefined) tickets[idx].status   = status;
    if (priority !== undefined) tickets[idx].priority = priority;
    if (notes    !== undefined) tickets[idx].notes    = notes;
    writeTickets(tickets);
    res.json(tickets[idx]);

    // Clean up Claude memory file when ticket is resolved
    if (status === 'Done') {
      try {
        const memDir = path.join(__dirname, '..', '.claude', 'projects', '-home-ubuntu-ops-tracker', 'memory');
        const memFile = path.join(memDir, `feedback_${req.params.id}.md`);
        if (fs.existsSync(memFile)) fs.unlinkSync(memFile);
      } catch {}
    }
  } catch (e) { logError('route.put.tickets', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/tickets/:id/comments — add a comment to a ticket
app.post('/api/tickets/:id/comments', postRateLimit, (req, res) => {
  try {
    const tickets = readTickets();
    const idx = tickets.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Ticket not found' });
    const text = sanitizeStr(req.body.text, 2000);
    const author = sanitizeStr(req.body.author, 100);
    if (!text || !author) return res.status(400).json({ error: 'text and author are required' });
    if (!Array.isArray(tickets[idx].comments)) tickets[idx].comments = [];
    const comment = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text,
      author,
      createdAt: new Date().toISOString(),
    };
    tickets[idx].comments.push(comment);
    writeTickets(tickets);
    res.status(201).json(comment);
  } catch (e) { logError('route.post.ticket-comment', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/tickets/:id/comments/:commentId — remove a comment
app.delete('/api/tickets/:id/comments/:commentId', (req, res) => {
  try {
    const tickets = readTickets();
    const idx = tickets.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Ticket not found' });
    if (!Array.isArray(tickets[idx].comments)) return res.status(404).json({ error: 'Comment not found' });
    const cIdx = tickets[idx].comments.findIndex(c => c.id === req.params.commentId);
    if (cIdx === -1) return res.status(404).json({ error: 'Comment not found' });
    // Only the comment author can delete their own comment
    const currentUser = req.authUser || (req.session && req.session.user);
    const comment = tickets[idx].comments[cIdx];
    if (comment.author !== currentUser) return res.status(403).json({ error: 'You can only delete your own comments' });
    const removedComment = tickets[idx].comments.splice(cIdx, 1)[0];
    writeTickets(tickets);
    logActivity('ticket.comment.deleted', { ticketId: req.params.id, commentId: req.params.commentId, author: removedComment.author, reason: sanitizeStr(req.body?.reason, 500) || '' });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.ticket-comment', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/tickets/:id — remove a ticket and its attachment folder
app.delete('/api/tickets/:id', (req, res) => {
  try {
    const tickets = readTickets();
    const idx = tickets.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Ticket not found' });
    const removed = tickets.splice(idx, 1)[0];
    writeTickets(tickets);

    // Clean up attachments folder if any (cascade rule)
    let filesUnlinked = 0;
    try {
      const safeId = path.basename(removed.id);
      const ticketDir = path.join(TICKETS_UPLOADS_DIR, safeId);
      if (path.resolve(ticketDir).startsWith(path.resolve(TICKETS_UPLOADS_DIR) + path.sep) && fs.existsSync(ticketDir)) {
        filesUnlinked = fs.readdirSync(ticketDir).length;
        fs.rmSync(ticketDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) { logError('ticket.delete.cleanup', cleanupErr); }

    logActivity('ticket.deleted', { ticketId: removed.id, title: removed.title, reason: sanitizeStr(req.body?.reason, 500) || '', filesUnlinked });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.tickets', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Staff ---
app.get('/api/staff', (req, res) => {
  try {
    res.json(readStaff());
  } catch (e) { logError('route.get.staff', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Reusable admin auth middleware ─────────────────────────────────────────────
// Checks admin password from body.pin or x-admin-pin header.
// Resolves true if auth passes (or no password set), sends 403 and resolves false otherwise.
async function requireAdminAuth(req, res) {
  const pin = req.body?.pin || req.headers['x-admin-pin'];
  const adminData = readAdmin();
  if (!adminData.pin) return true;  // no password set — allow
  if (!pin) { res.status(403).json({ error: 'Admin password required' }); return false; }
  const ok = await verifyAdminPassword(pin, adminData.pin);
  if (!ok) { res.status(403).json({ error: 'Invalid password' }); return false; }
  return true;
}

// POST /api/staff — add or update a staff member { name, email }
// If a new staff member has an email and no credentials yet, auto-create login and send welcome email.
app.post('/api/staff', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const name  = sanitizeStr(req.body.name, 100);
    const email = sanitizeStr(req.body.email, 200);
    if (!name) return res.status(400).json({ error: 'name required' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    // Prevent overwriting role aliases (e.g. "Factory Manager", "Purchaser", "QS")
    const ROLE_ALIASES = ['Factory Manager','Purchaser','QS','QS2','Site Engineer','Project Manager','GM','Finance','Accounts','Drafter','Project Manager/Site Engineer'];
    if (ROLE_ALIASES.includes(name)) return res.status(400).json({ error: `"${name}" is a reserved role alias — use the person's real name` });
    const staff = readStaff();
    const isNew = !staff[name];
    staff[name] = { name, email };
    writeStaff(staff);
    logActivity('staff.updated', { name, email });

    // Auto-create login credentials for new staff with email
    let welcomeSent = false;
    if (isNew && email) {
      const creds = readCredentials();
      const emailKey = email.toLowerCase().trim();
      if (!creds[emailKey]) {
        const newPass = crypto.randomBytes(4).toString('hex');
        creds[emailKey] = { name, hash: await bcrypt.hash(newPass, 10) };
        safeWriteJSON(CREDS_FILE, creds);
        _credsCache = null; _credsMtime = 0; // bust cache
        logActivity('auth.auto-created', { user: name, email: emailKey });

        // Send welcome email with login details
        const APP_URL_VAL = process.env.APP_URL || 'https://lys-ops.cloud';
        sendEmail(email, name,
          'Welcome to LYS Ops Tracker — Your Login Details',
          emailWrap(`Hi ${escHtml(name.split(' ')[0])},`,
            `<p style="margin:0 0 16px;">Your LYS Ops Tracker account is ready. Here are your login details:</p>` +
            emailTable([
              ['URL', `<a href="${APP_URL_VAL}">${APP_URL_VAL}</a>`],
              ['Email', `<span style="font-family:monospace;font-size:15px;">${escHtml(emailKey)}</span>`],
              ['Password', `<span style="font-family:monospace;font-size:15px;">${escHtml(newPass)}</span>`]
            ]) +
            `<p style="margin:16px 0 0;font-size:12px;color:#888;">You can change your password anytime from the app.</p>`,
            'Open LYS Ops', APP_URL_VAL)
        ).catch(err => console.error('[EMAIL] Welcome email failed for', name, err.message));
        welcomeSent = true;
      }
    }

    res.status(isNew ? 201 : 200).json({ ...staff[name], welcomeSent });
  } catch (e) { logError('route.post.staff', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/staff/:name — remove staff member, role aliases, and login credentials
app.delete('/api/staff/:name', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const staff = readStaff();
    const name = decodeURIComponent(req.params.name);
    if (!staff[name]) return res.status(404).json({ error: 'Not found' });
    const targetName = staff[name].name;
    // Collect emails before removing so we can clean up credentials
    const emails = new Set();
    Object.keys(staff).forEach(k => {
      if (staff[k].name === targetName) {
        if (staff[k].email) emails.add(staff[k].email.toLowerCase().trim());
        delete staff[k];
      }
    });
    writeStaff(staff);
    // Remove login credentials for this person
    if (emails.size) {
      const creds = readCredentials();
      let changed = false;
      for (const em of emails) {
        if (creds[em]) { delete creds[em]; changed = true; }
      }
      if (changed) {
        safeWriteJSON(CREDS_FILE, creds);
        _credsCache = null; _credsMtime = 0;
      }
    }
    logActivity('staff.deleted', { name: targetName });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.staff', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/admin/pin — returns whether a password has been set
app.get('/api/admin/pin', (req, res) => {
  try {
    const admin = readAdmin();
    res.json({ pinSet: !!admin.pin });
  } catch (e) { logError('route.get.admin.pin', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Auth: change own password ─────────────────────────────────────────────────
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields required' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const creds = readCredentials();
    // Find the current user's entry
    const username = Object.keys(creds).find(k => creds[k].name === req.authUser);
    if (!username) return res.status(403).json({ error: 'User not found' });
    if (!await bcrypt.compare(currentPassword, creds[username].hash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    creds[username].hash = await bcrypt.hash(newPassword, 10);
    safeWriteJSON(CREDS_FILE, creds);
    _credsCache = null; _credsMtime = 0;
    logActivity('auth.password-changed', { user: req.authUser });
    res.json({ ok: true });
  } catch (e) { logError('route.post.auth.change-password', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Auth: who am I ───────────────────────────────────────────────────────────
app.get('/api/auth/me', (req, res) => {
  res.json({ name: req.authUser || 'anonymous' });
});

// ── Auth: forgot password (self-service) ─────────────────────────────────────
// No auth required — user can't log in, so this is outside the auth gate.
// Rate-limited to prevent abuse. Accepts { username: "email@..." } for backwards compat with login form field name.
const _resetAttempts = {};
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(_resetAttempts)) {
    _resetAttempts[k] = _resetAttempts[k].filter(t => now - t < 3600000);
    if (!_resetAttempts[k].length) delete _resetAttempts[k];
  }
}, 600000).unref(); // prune every 10 minutes
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Email required' });
    const key = username.toLowerCase().trim();
    // Rate limit: max 3 resets per email per hour
    const now = Date.now();
    if (!_resetAttempts[key]) _resetAttempts[key] = [];
    _resetAttempts[key] = _resetAttempts[key].filter(t => now - t < 3600000);
    if (_resetAttempts[key].length >= 3) return res.status(429).json({ error: 'Too many reset attempts. Try again in an hour.' });

    const creds = readCredentials();
    const entry = creds[key];
    if (!entry) return res.json({ ok: true, message: 'If that email is registered, a new password has been sent.' });

    // Generate new password and save
    const newPass = crypto.randomBytes(4).toString('hex');
    creds[key].hash = await bcrypt.hash(newPass, 10);
    safeWriteJSON(CREDS_FILE, creds);
    _credsCache = null; _credsMtime = 0;
    _resetAttempts[key].push(now);

    // Email the new password
    const APP_URL_VAL = process.env.APP_URL || 'https://lys-ops.cloud';
    sendEmail(key, entry.name,
      'Your LYS Ops Tracker password has been reset',
      emailWrap(`Hi ${escHtml(entry.name.split(' ')[0])},`,
        `<p style="margin:0 0 16px;">Your password has been reset. Here are your new login details:</p>` +
        emailTable([
          ['Email', `<span style="font-family:monospace;font-size:15px;">${escHtml(key)}</span>`],
          ['Password', `<span style="font-family:monospace;font-size:15px;">${escHtml(newPass)}</span>`]
        ]) +
        emailWarnBox('If you didn\'t request this, contact your admin immediately.'),
        'Open LYS Ops', APP_URL_VAL)
    ).catch(() => {});

    logActivity('auth.password-reset', { by: 'System', user: entry.name });
    res.json({ ok: true, message: 'If that email is registered, a new password has been sent.' });
  } catch (e) { logError('route.post.auth.forgot-password', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Auth: admin reset (requires admin PIN) ───────────────────────────────────
app.post('/api/auth/admin-reset', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const { username } = req.body; // "username" field = email address
    if (!username) return res.status(400).json({ error: 'Email required' });
    const key = username.toLowerCase().trim();
    const creds = readCredentials();
    if (!creds[key]) return res.status(404).json({ error: 'Email not found' });

    const newPass = crypto.randomBytes(4).toString('hex');
    creds[key].hash = await bcrypt.hash(newPass, 10);
    safeWriteJSON(CREDS_FILE, creds);
    _credsCache = null; _credsMtime = 0;

    logActivity('auth.admin-reset', { user: creds[key].name, resetBy: req.authUser });
    res.json({ ok: true, username: key, name: creds[key].name, newPassword: newPass });
  } catch (e) { logError('route.post.auth.admin-reset', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Auth: send welcome emails (one-time, admin-only) ─────────────────────────
app.post('/api/auth/send-welcome-emails', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const creds = readCredentials();
    const APP_URL_VAL = process.env.APP_URL || 'https://lys-ops.cloud';
    const results = [];

    for (const [emailKey, entry] of Object.entries(creds)) {
      const email = emailKey; // credentials are now keyed by email
      if (!email) { results.push({ name: entry.name, status: 'skipped', reason: 'no email' }); continue; }

      // For welcome emails we generate a fresh password so we have the plaintext
      const newPass = crypto.randomBytes(4).toString('hex');
      creds[emailKey].hash = await bcrypt.hash(newPass, 10);

      try {
        await sendEmail(email, entry.name,
          'Welcome to LYS Ops Tracker — Your Login Details',
          emailWrap(`Hi ${escHtml(entry.name.split(' ')[0])},`,
            `<p style="margin:0 0 16px;">Your LYS Ops Tracker account is ready. Here are your login details:</p>` +
            emailTable([
              ['URL', `<a href="${APP_URL_VAL}">${APP_URL_VAL}</a>`],
              ['Email', `<span style="font-family:monospace;font-size:15px;">${escHtml(emailKey)}</span>`],
              ['Password', `<span style="font-family:monospace;font-size:15px;">${escHtml(newPass)}</span>`]
            ]) +
            `<p style="margin:16px 0 0;font-size:12px;color:#888;">You can change your password anytime from the app.</p>`,
            'Open LYS Ops', APP_URL_VAL)
        );
        results.push({ name: entry.name, status: 'sent', email });
      } catch (e) {
        results.push({ name: entry.name, status: 'failed', error: e.message });
      }
      // 2s gap between sends for Graph API throttle
      await new Promise(r => setTimeout(r, 2000));
    }

    safeWriteJSON(CREDS_FILE, creds);
    logActivity('auth.welcome-emails-sent', { by: req.authUser, count: results.filter(r => r.status === 'sent').length });
    res.json({ ok: true, results });
  } catch (e) { logError('route.post.auth.send-welcome-emails', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Rate limiter for admin password verify ────────────────────────────────────
const _adminAttempts = new Map();  // ip → [timestamps] of recent failed attempts
const ADMIN_MAX_ATTEMPTS = 5;     // max failures per IP per window
const ADMIN_WINDOW_MS = 60000;    // 1-minute window

function checkAdminRateLimit(ip) {
  const now = Date.now();
  let arr = _adminAttempts.get(ip) || [];
  arr = arr.filter(ts => now - ts < ADMIN_WINDOW_MS);
  _adminAttempts.set(ip, arr);
  return arr.length < ADMIN_MAX_ATTEMPTS;
}
function recordAdminFailure(ip) {
  const arr = _adminAttempts.get(ip) || [];
  arr.push(Date.now());
  _adminAttempts.set(ip, arr);
}

// Verify a plaintext password against stored hash (or legacy plaintext)
async function verifyAdminPassword(plain, stored) {
  if (!stored) return false;
  // bcrypt hashes start with $2
  if (stored.startsWith('$2')) return bcrypt.compare(plain, stored);
  // Legacy plaintext — compare directly (will be upgraded on next set)
  return plain === stored;
}

// POST /api/admin/pin — action: 'set' or 'verify'
app.post('/api/admin/pin', async (req, res) => {
  try {
    const { action, pin, oldPin } = req.body;
    const admin = readAdmin();

    if (action === 'set') {
      if (!pin || typeof pin !== 'string' || pin.length < 4 || pin.length > 30) {
        return res.status(400).json({ error: 'Password must be 4-30 characters' });
      }
      // If a password already exists, require the old one
      if (admin.pin) {
        if (!oldPin) return res.status(400).json({ error: 'Current password required' });
        const ok = await verifyAdminPassword(oldPin, admin.pin);
        if (!ok) return res.status(403).json({ error: 'Current password is incorrect' });
      }
      admin.pin = await bcrypt.hash(pin, 10);
      writeAdmin(admin);
      logActivity('admin.password.changed', {});
      return res.json({ ok: true });
    }

    if (action === 'verify') {
      if (!admin.pin) return res.json({ ok: false, noPinSet: true });
      const adminIp = req.ip || req.socket.remoteAddress || 'unknown';
      if (!checkAdminRateLimit(adminIp)) {
        return res.status(429).json({ error: 'Too many attempts. Wait 1 minute.' });
      }
      const ok = await verifyAdminPassword(pin, admin.pin);
      if (!ok) { recordAdminFailure(adminIp); return res.json({ ok: false }); }
      return res.json({ ok: true });
    }

    res.status(400).json({ error: 'action must be set or verify' });
  } catch (e) { logError('route.post.admin.pin', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/projects/:id/upload/:filename — remove an uploaded file from disk
// Handles both flat filenames and project-subdir paths (projects/<id>/<file>)
app.delete('/api/projects/:id/upload/:filename(*)', (req, res) => {
  try {
    const { id, filename } = req.params;
    // Security: prevent path traversal — sanitize both id and filename
    const safeId = path.basename(id);
    const normalized = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
    if (normalized.includes('..')) return res.status(400).json({ error: 'Invalid filename' });

    // Try project-specific path first, then flat uploads root
    let diskPath = path.resolve(UPLOADS_DIR, normalized);
    if (!diskPath.startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(diskPath)) {
      diskPath = path.resolve(UPLOADS_DIR, 'projects', safeId, path.basename(normalized));
      if (!diskPath.startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(diskPath)) {
      // File already gone — treat as success
      logActivity('project.upload.deleted', { projectId: id, filename, fileDeleted: false });
      return res.json({ ok: true, fileDeleted: false });
    }

    fs.unlinkSync(diskPath);
    logActivity('project.upload.deleted', { projectId: id, filename, fileDeleted: true });
    res.json({ ok: true, fileDeleted: true });
  } catch (e) { logError('route.delete.upload', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/projects/:id/upload — upload an image or PDF (FAB photos, drawings, docs)
app.post('/api/projects/:id/upload', uploadImageOrPdf.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or unsupported type (allowed: images, PDF)' });
    const project = readProjects().find(p => p.id === req.params.id);
    logActivity('project.upload', {
      projectId: req.params.id,
      jobCode: project ? project.jobCode : '',
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      itemName: (req.body && req.body.itemName) || '',
      uploadedBy: (req.body && req.body.uploadedBy) || ''
    });
    // Return path relative to /uploads/ so client can link: /uploads/<relativePath>
    const relativePath = req.params.id
      ? 'projects/' + req.params.id + '/' + req.file.filename
      : req.file.filename;
    res.json({ filename: relativePath, originalName: req.file.originalname });
  } catch (e) { logError('route.post.upload', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Summary KPIs ---
app.get('/api/summary', (req, res) => {
  try {
  const projects = readProjects().map(p => deriveFields(p));
  const activeProjects = projects.filter(p => p.lifecycle === 'active');
  const summary = {
    total: projects.length,
    activeCount: activeProjects.length,
    dlpCount: projects.filter(p => p.lifecycle === 'dlp').length,
    settledCount: projects.filter(p => p.lifecycle === 'settled').length,
    archivedCount: projects.filter(p => p.lifecycle === 'archived').length,
    completed: projects.filter(p => p.status === 'Completed').length,
    onTrack: activeProjects.filter(p => p.status === 'On Track').length,
    delayed: activeProjects.filter(p => p.status === 'Delayed').length,
    onHold: activeProjects.filter(p => p.status === 'On Hold').length,
    totalContract: projects.reduce((s, p) => s + (p.contractValue || 0), 0),
    totalVO: projects.reduce((s, p) => s + (p.voValue || 0), 0),
    totalClaimed: projects.reduce((s, p) => s + (p.paidAmount || 0), 0),
    prPending: projects.reduce((s, p) => {
      const pending = (p.prpo || []).filter(r => r.status === 'PR Pending').length;
      return s + pending;
    }, 0),
    inTransit: projects.reduce((s, p) => {
      const transit = (p.prpo || []).filter(r => r.status === 'In Transit').length;
      return s + transit;
    }, 0)
  };
  summary.claimPct = summary.totalContract > 0
    ? ((summary.totalClaimed / summary.totalContract) * 100).toFixed(1)
    : '0.0';
  summary.outstanding = (summary.totalContract + summary.totalVO) - summary.totalClaimed;
  summary.avgFabPct = activeProjects.length
    ? Math.round(activeProjects.reduce((s, p) => s + (parseFloat(p.fabPercent) || 0), 0) / activeProjects.length)
    : 0;
  summary.avgInstallPct = activeProjects.length
    ? Math.round(activeProjects.reduce((s, p) => s + (parseFloat(p.installPercent) || 0), 0) / activeProjects.length)
    : 0;
  // DLP projects approaching expiry (within 30 days)
  const dlpProjects = projects.filter(p => p.lifecycle === 'dlp');
  const in30d = dateSGT(30);
  summary.dlpExpiringSoon = dlpProjects.filter(p => p.dlpEndDate && p.dlpEndDate <= in30d).length;
  summary.totalRetentionHeld = dlpProjects.reduce((s, p) => s + (p.retentionAmount || 0), 0);
  res.json(summary);
  } catch (e) { logError('route.get.summary', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Action Required (Pending/In Progress stages across all projects) ---
app.get('/api/actions', (req, res) => {
  try {
    const projects = readProjects().map(p => deriveFields(p));
    const now = Date.now();
    const actions = [];
    for (const p of projects) {
      if (p.lifecycle !== 'active') continue;
      for (const stage of (p.stages || [])) {
        if (stage.status === 'Pending' || stage.status === 'In Progress') {
          const changedAt = stage.statusChangedAt ? new Date(stage.statusChangedAt).getTime() : now;
          const daysInStatus = Math.floor((now - changedAt) / 86400000);
          actions.push({
            projectId: p.id,
            projectName: p.projectName,
            jobCode: p.jobCode,
            stageNum: stage.num,
            stageName: stage.name,
            owner: stage.owner,
            stageStatus: stage.status,
            daysInStatus,
            notes: stage.notes || ''
          });
        }
      }
    }
    // Sort: most days first
    actions.sort((a, b) => b.daysInStatus - a.daysInStatus);
    res.json(actions);
  } catch (e) { logError('route.get.actions', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: List all projects (summary fields) ---
app.get('/api/projects', (req, res) => {
  try {
    let projects = readProjects().map(p => deriveFields(p));
    // ?lifecycle=active (default for ops pages), ?lifecycle=all, or ?lifecycle=dlp,settled
    const lcFilter = req.query.lifecycle;
    if (lcFilter && lcFilter !== 'all') {
      const allowed = lcFilter.split(',').map(s => s.trim());
      projects = projects.filter(p => allowed.includes(p.lifecycle));
    }
    // ?full=true returns complete project objects (used by installation page)
    if (req.query.full === 'true') return res.json(projects);
    const summary = projects.map(p => ({
      id: p.id,
      jobCode: p.jobCode,
      projectName: p.projectName,
      product: p.product,
      contractValue: p.contractValue,
      voValue: p.voValue,
      status: p.status,
      lifecycle: p.lifecycle,
      fabPercent: p.fabPercent,
      installPercent: p.installPercent,
      latestNotes: p.latestNotes,
      paidAmount: p.paidAmount,
      client: p.client,
      currentStage: p.currentStage,
      actionBy: p.actionBy,
      endDate: p.endDate,
      handoverDate: p.handoverDate,
      dlpEndDate: p.dlpEndDate,
      retentionAmount: p.retentionAmount,
      retentionReleased: p.retentionReleased
    }));
    res.json(summary);
  } catch (e) { logError('route.get.projects', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Batch fetch full project records by id ---
// Replaces an N+1 fetch storm on Factory page (one /projects/:id call per active
// project on every page load). At 17 projects today that's already 17 file reads;
// at 500 projects it would be 500. This endpoint reads projects.json once and
// filters server-side. Declared BEFORE /api/projects/:id so Express doesn't
// route "/api/projects/batch" into the :id handler.
app.get('/api/projects/batch', (req, res) => {
  try {
    const idsParam = String(req.query.ids || '').trim();
    if (!idsParam) return res.json({});
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length > 1000) return res.status(400).json({ error: 'Too many ids (max 1000)' });
    const idSet = new Set(ids);
    const projects = readProjects();
    const result = {};
    for (const p of projects) {
      if (idSet.has(p.id)) result[p.id] = deriveFields(p);
    }
    res.json(result);
  } catch (e) { logError('route.get.projects.batch', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Get single project ---
app.get('/api/projects/:id', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    res.json(deriveFields(project));
  } catch (e) { logError('route.get.projects.id', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Create project ---
app.post('/api/projects', (req, res) => {
  try {
    const projects = readProjects();
    const data = req.body;
    if (!data.id || !data.jobCode) return res.status(400).json({ error: 'id and jobCode required' });
    if (projects.find(p => p.id === data.id)) return res.status(409).json({ error: 'ID already exists' });
    const newProject = buildDefaultProject(data);
    projects.push(newProject);
    writeProjects(projects);
    logActivity('project.created', { id: newProject.id, jobCode: newProject.jobCode });
    res.status(201).json(newProject);
  } catch (e) { logError('route.post.projects', e); res.status(500).json({ error: 'Internal server error' }); }
});

// Per-item stage lists — single source of truth for fab + install pipelines
const FAB_STAGES     = ['Not Started', 'In Progress', 'QC Check', 'Ready for Delivery', 'Delivered'];
const INSTALL_STAGES = ['Not Started', 'In Progress', 'Installed', 'Verified'];

// ── Auto-derive project stage statuses from operational data ─────────────────
// Each stage maps to data the team already enters on ops pages.
// Reads external files (PRs, POs, DOs) — cached per deriveFields batch.
let _stageCache = null;
function _getStageExternalData() {
  if (!_stageCache) {
    _stageCache = {
      prs: readPRs(),
      pos: readPOs(),
      dos: readDOs(),
    };
    // Auto-clear after current tick to avoid stale reads
    process.nextTick(() => { _stageCache = null; });
  }
  return _stageCache;
}

function deriveStages(p) {
  const stages = p.stages;
  if (!Array.isArray(stages) || stages.length === 0) return;

  const ext = _getStageExternalData();

  // ── Data signals from project sub-arrays ──
  const fab       = p.fabrication   || [];
  const inst      = p.installation  || [];
  const docs      = p.documents     || [];
  const drawings  = p.drawings      || [];
  const meetings  = p.meetingNotes  || [];
  const ms        = p.paymentMilestones || [];
  const prpo      = p.prpo          || [];

  // External data filtered to this project
  const projectPRs = ext.prs.filter(pr => pr.projectCode === p.jobCode);
  const projectPOs = ext.pos.filter(po => po.projectId === p.id || po.projectJobCode === p.jobCode);
  const projectDOs = ext.dos.filter(d => d.projectCode === p.jobCode);

  // ── Document signals ──
  const safetyDocs = docs.filter(d => (d.group || '').includes('Safety'));
  const hasSubmittedSafety = safetyDocs.some(d => d.status && d.status !== 'Not Submitted');
  const allSafetyDone = safetyDocs.length > 0 &&
    safetyDocs.every(d => d.status === 'Approved' || d.status === 'Submitted for Approval');

  const drawingDocs = docs.filter(d => /shop.?draw|drawing/i.test(d.name || ''));
  const hasDrawingSubmitted = drawingDocs.some(d => d.status && d.status !== 'Not Submitted') || drawings.length > 0;
  const hasDrawingApproved = drawingDocs.some(d => d.status === 'Approved');

  const sicDocs = docs.filter(d => /sic/i.test(d.name || ''));
  const hasSICSubmitted = sicDocs.some(d => d.status && d.status !== 'Not Submitted');

  // ── Fab signals ──
  const hasFabRows       = fab.length > 0;
  const anyFabStarted    = fab.some(r => r.status !== 'Not Started');
  const anyFabHasLogs    = fab.some(r => Array.isArray(r.logs) && r.logs.length > 0);
  const anyFabInProgress = fab.some(r => r.status === 'In Progress' || r.status === 'QC Check');
  const anyFabReady      = fab.some(r => r.status === 'Ready for Delivery');
  const anyFabDelivered  = fab.some(r => r.status === 'Delivered');
  const allFabDelivered  = hasFabRows && fab.every(r => r.status === 'Delivered');

  // ── Install signals ──
  const anyInstStarted   = inst.some(r => r.status !== 'Not Started');
  const anyInstHasLogs   = inst.some(r => Array.isArray(r.logs) && r.logs.length > 0);
  const allInstDone      = inst.length > 0 && inst.every(r => r.status === 'Installed' || r.status === 'Verified');
  const allInstVerified  = inst.length > 0 && inst.every(r => r.status === 'Verified');

  // ── PR/PO signals ──
  const hasPRs = projectPRs.length > 0 || prpo.some(r => r.prNo);
  const hasPOs = projectPOs.length > 0 || prpo.some(r => r.poNo);

  // ── Meeting signals ──
  const hasMeetings = meetings.some(m => m.date || m.notes || m.attendees);

  // ── Payment signals ──
  const allPaid = ms.length > 0 && ms.every(m => m.status === 'Paid' || m.paid === true);

  // ── Stage derivation map ──
  // Key = stage name (supports both 21-stage and 12-stage variants)
  // Value = { completed: bool, inProgress: bool }
  const rules = {
    // Bucket 1: project exists = done
    'Quotation':              { c: true },
    'LOI Received':           { c: true },
    'Awarded':                { c: !!p.contractValue },
    'LOA Received':           { c: !!p.contractValue },
    'Contract Review':        { c: !!p.contractValue },
    'QS Breakdown':           { c: !!p.qs },
    'Job Code Created':       { c: !!p.jobCode },

    // Bucket 2: auto-derived from ops data
    'Kick-off Meeting':              { c: hasMeetings },
    'Kickoff Meeting':               { c: hasMeetings },
    'Safety Document Submission':    { c: allSafetyDone, ip: hasSubmittedSafety },
    'Drawing Submission':            { c: hasDrawingApproved, ip: hasDrawingSubmitted },
    'Drawing Approved':              { c: hasDrawingApproved },
    'SIC Submission':                { c: hasSICSubmitted },
    'Assign to Factory':             { c: anyFabStarted, ip: hasFabRows },
    'Factory Take-off':              { c: anyFabStarted, ip: anyFabHasLogs || hasFabRows },
    'PR to Purchaser':               { c: hasPRs },
    'PO Issued':                     { c: hasPOs },
    'Production / Fabrication':      { c: anyFabReady || anyFabDelivered, ip: anyFabInProgress },
    'Fabrication':                   { c: anyFabReady || anyFabDelivered, ip: anyFabInProgress },
    'Shipping':                      { c: anyFabDelivered, ip: anyFabReady },
    'Delivered':                     { c: allFabDelivered, ip: anyFabDelivered },
    'Delivery':                      { c: allFabDelivered, ip: anyFabDelivered },
    'Site Ready':                    { c: false, ip: anyInstStarted },
    'Installation':                  { c: allInstDone, ip: anyInstStarted || anyInstHasLogs },
    'Handover':                      { c: allInstVerified && allPaid, ip: allInstDone },
    'Handover / Inspection':         { c: allInstVerified && allPaid, ip: allInstDone },
    'Final Claim & Closure':         { c: allPaid },
  };

  // Apply rules — always reflect current data (stages regress if items removed)
  for (const stage of stages) {
    const rule = rules[stage.name];
    if (!rule) continue; // stages not in rules map are untouched (manual)

    const derived = rule.c ? 'Completed' : rule.ip ? 'In Progress' : 'Not Started';

    if (derived !== stage.status) {
      stage.status = derived;
      stage.statusChangedAt = new Date().toISOString();

      // Set date fields on advance
      if (derived === 'In Progress' && !stage.started) {
        stage.started = todaySGT();
      }
      if (derived === 'Completed') {
        if (!stage.started) stage.started = todaySGT();
        if (!stage.done) stage.done = todaySGT();
      }
      // Clear done date on regress
      if (derived !== 'Completed') {
        stage.done = '';
      }
    }
  }
}

// ── Derive computed fields from live sub-arrays ──────────────────────────────
// Call this on every project before saving to keep derived fields accurate.
// Valid lifecycle states for projects
const VALID_LIFECYCLES = ['active', 'dlp', 'settled', 'archived'];

function deriveFields(p) {
  // Ensure lifecycle field exists (default to 'active')
  if (!p.lifecycle || !VALID_LIFECYCLES.includes(p.lifecycle)) p.lifecycle = 'active';
  // Ensure DLP/retention fields exist
  if (p.handoverDate === undefined)         p.handoverDate = null;
  if (p.dlpMonths === undefined)            p.dlpMonths = 12;
  if (p.dlpEndDate === undefined)           p.dlpEndDate = null;
  if (p.retentionPercent === undefined)     p.retentionPercent = 5;
  if (p.retentionAmount === undefined)      p.retentionAmount = null;
  if (p.retentionReleased === undefined)    p.retentionReleased = false;
  if (p.retentionReleasedDate === undefined) p.retentionReleasedDate = null;
  if (p.finalAccountDate === undefined)     p.finalAccountDate = null;
  if (p.archivedDate === undefined)         p.archivedDate = null;

  // Auto-derive retention amount from contract value
  const cv = parseFloat(p.contractValue) || 0;
  const vo = parseFloat(p.voValue) || 0;
  const rp = parseFloat(p.retentionPercent) || 5;
  p.retentionAmount = Math.round((cv + vo) * rp / 100 * 100) / 100;

  // Auto-derive DLP end date from handover date + months
  if (p.handoverDate && p.dlpMonths) {
    const hd = new Date(p.handoverDate);
    hd.setMonth(hd.getMonth() + (parseInt(p.dlpMonths, 10) || 12));
    p.dlpEndDate = hd.toISOString().slice(0, 10);
  }

  // fabPercent — from fabrication array (exclude parent container rows)
  const fabRows  = p.fabrication  || [];
  const fabRowsForPct = fabRows.filter(r => !r.isMechanicalParent);
  const fabTotal = fabRowsForPct.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const fabDone  = fabRowsForPct.reduce((s, r) => s + (parseFloat(r.qtyDone)  || 0), 0);
  p.fabPercent   = fabTotal > 0 ? Math.round(fabDone  / fabTotal  * 100) : 0;

  // Fab per-item stage: normalize + forward-only auto-advance from qty.
  // Only Not Started → In Progress is automatic; every other transition is manual.
  // Skip parent rows — their status is derived from children below.
  const PARENT_VALID = ['Not Started', 'Parts In Progress', 'Assembly', 'QC Check', 'Ready for Delivery', 'Delivered'];
  fabRows.forEach(r => {
    if (r.isMechanicalParent) return; // derived below
    if (!FAB_STAGES.includes(r.status)) r.status = 'Not Started';
    const done = parseFloat(r.qtyDone) || 0;
    if (done > 0 && r.status === 'Not Started') r.status = 'In Progress';
  });

  // Auto-derive parent status from child fab parts + order parts
  fabRows.forEach((r, idx) => {
    if (!r.isMechanicalParent) return;
    const children = fabRows.filter(c => c.parentIdx === idx && c.isPartRow);
    const orderParts = Array.isArray(r.orderParts) ? r.orderParts : [];
    const fabPartsDone = children.length === 0 || children.every(c =>
      c.status === 'QC Check' || c.status === 'Ready for Delivery' || c.status === 'Delivered'
    );
    const orderPartsDone = orderParts.length === 0 || orderParts.every(p => p.status === 'Done');
    const allPartsReady = fabPartsDone && orderPartsDone;
    const anyStarted = children.some(c => c.status !== 'Not Started') ||
      orderParts.some(p => p.status === 'Done');

    // Parent status ladder: Not Started → Parts In Progress → Assembly → QC Check → Ready → Delivered
    // If not all parts ready, force back to parts tracking (even if status was inherited).
    // Only preserve manual status if it was set via Assembly flow (has _assemblyStarted flag).
    if (!allPartsReady && (children.length > 0 || orderParts.length > 0)) {
      // Parts incomplete — force to parts tracking regardless of inherited status
      r.status = anyStarted ? 'Parts In Progress' : 'Not Started';
    } else if (r._assemblyStarted && ['Assembly', 'QC Check', 'Ready for Delivery', 'Delivered'].includes(r.status)) {
      // Manual control from Assembly onward — don't auto-regress
    } else if (allPartsReady && (children.length > 0 || orderParts.length > 0)) {
      r.status = 'Assembly';
      r._assemblyStarted = true;
    } else if (anyStarted) {
      r.status = 'Parts In Progress';
    } else {
      r.status = 'Not Started';
    }
    // Compute parts progress counts for display
    const totalParts = children.length + orderParts.length;
    const doneParts = children.filter(c =>
      c.status === 'QC Check' || c.status === 'Ready for Delivery' || c.status === 'Delivered'
    ).length + orderParts.filter(p => p.status === 'Done').length;
    r.partsProgress = { done: doneParts, total: totalParts };
  });

  // installPercent — from installation array
  const instRows  = p.installation || [];
  const instTotal = instRows.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const instDone  = instRows.reduce((s, r) => s + (parseFloat(r.doneQty) || parseFloat(r.qtyDone) || 0), 0);
  p.installPercent = instTotal > 0 ? Math.round(instDone / instTotal * 100) : 0;

  // Install per-item stage: backfill from qty if missing, then forward-only auto-advance.
  instRows.forEach(r => {
    // Sync field names: prefer qtyDone (from logs), fall back to doneQty (legacy)
    const done = parseFloat(r.qtyDone) || parseFloat(r.doneQty) || 0;
    r.doneQty = done;
    r.qtyDone = done;
    if (!INSTALL_STAGES.includes(r.status)) {
      const total = parseFloat(r.totalQty) || 0;
      if      (total > 0 && done >= total) r.status = 'Installed';
      else if (done > 0)                   r.status = 'In Progress';
      else                                 r.status = 'Not Started';
    } else {
      if (done > 0 && r.status === 'Not Started') r.status = 'In Progress';
    }
  });

  // paidAmount — sum of paid payment milestones
  const milestones = p.paymentMilestones || [];
  p.paidAmount = milestones
    .filter(m => m.status === 'Paid' || m.paid === true)
    .reduce((s, m) => s + (parseFloat(m.amount) || 0), 0);

  // Auto-derive stage statuses from operational data
  deriveStages(p);

  // currentStage — first In Progress, else first Not Started
  const stages = p.stages || [];
  const activeStage = stages.find(s => s.status === 'In Progress')
    || stages.find(s => s.status === 'Not Started');
  p.currentStage = activeStage ? activeStage.name
    : (stages.length ? 'All Complete' : '');

  // actionBy — owner of the current active stage
  p.actionBy = activeStage ? (activeStage.owner || '') : '';

  return p;
}

// --- API: Migrate — recalculate derived fields for all projects ---
app.post('/api/admin/recalc', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const projects = readProjects();
    projects.forEach(p => deriveFields(p));
    writeProjects(projects);
    res.json({ ok: true, updated: projects.length });
  } catch (e) { logError('route.post.admin.recalc', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Update project ---
app.put('/api/projects/:id', async (req, res) => {
  try {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const PROJECT_WRITABLE = [
    'projectName','jobCode','product','client','status','startDate','endDate',
    'contractValue','voValue','projectManager','qs','factoryManager','drafter',
    'purchaser','sales','siteEngineer','latestNotes','stages','fabrication',
    'installation','productScope','paymentMilestones','documents','drawings',
    'meetingNotes','fabLeadTimeDays','notes'
  ];
  const incoming = {};
  for (const k of PROJECT_WRITABLE) { if (req.body[k] !== undefined) incoming[k] = req.body[k]; }
  const oldProject = projects[idx];

  // Validate startDate/endDate consistency
  const effectiveStart = incoming.startDate !== undefined ? incoming.startDate : oldProject.startDate;
  const effectiveEnd = incoming.endDate !== undefined ? incoming.endDate : oldProject.endDate;
  if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
    return res.status(400).json({ error: 'endDate cannot be before startDate' });
  }

  // Track statusChangedAt for stages
  if (incoming.stages && oldProject.stages) {
    incoming.stages.forEach((newStage, i) => {
      const oldStage = oldProject.stages[i];
      if (oldStage && newStage.status !== oldStage.status) {
        newStage.statusChangedAt = new Date().toISOString();
      } else if (oldStage) {
        newStage.statusChangedAt = oldStage.statusChangedAt || null;
      }
    });
  }

  // Trigger: project status changed to Delayed → notify project manager
  if (incoming.status === 'Delayed' && oldProject.status !== 'Delayed') {
    const pmName = incoming.projectManager || oldProject.projectManager;
    const pmEmail = getStaffEmail(pmName);
    if (pmEmail) {
      sendEmail(pmEmail, pmName,
        `[Project Delayed] ${oldProject.jobCode} — ${oldProject.projectName}`,
        emailWrap(`Hi ${escHtml(pmName)},`,
          `<p style="margin:0 0 16px;">Project <strong>${escHtml(oldProject.jobCode)} — ${escHtml(oldProject.projectName)}</strong> has been marked as <strong>Delayed</strong>.</p>` +
          `<p style="margin:0;">Please update the latest notes and advise on the revised timeline.</p>`,
          'Open Project', `${APP_URL}/project.html?id=${oldProject.id}`)
      ).catch(() => {});
    } else {
      console.warn('[EMAIL SKIP] No email for:', pmName, '(project delayed notification)');
    }
  }

  // Preserve fab row logs[] + editHistory across the full-project PUT.
  // /project.html's buildFabRow only writes visible fields (item, qty, unit,
  // etc) and never round-trips logs[]. A naive `{...old, ...incoming}`
  // spread would wipe server-side logs on every save. Walk the incoming
  // fabrication array and copy logs (+ fab_started_at / fab_completed_at /
  // cycle_days, which are also server-managed) from the matching old row.
  // Match by item-name first (stable across reordering), fallback to index.
  if (Array.isArray(incoming.fabrication) && Array.isArray(oldProject.fabrication)) {
    const oldByName = new Map();
    oldProject.fabrication.forEach((r, i) => {
      const key = (r.item || '').toLowerCase().trim();
      if (key) oldByName.set(key, r);
    });
    incoming.fabrication.forEach((r, i) => {
      const key = (r.item || '').toLowerCase().trim();
      const matchByName = key ? oldByName.get(key) : null;
      const matchByIdx = oldProject.fabrication[i];
      const oldRow = matchByName || matchByIdx;
      if (oldRow) {
        // Only copy if the incoming row doesn't already have these fields.
        // The narrow fab endpoints DO include logs[]; only the full PUT
        // from /project.html's buildFabRow is the lossy caller.
        if (r.logs === undefined) r.logs = oldRow.logs || [];
        if (r.fab_started_at === undefined) r.fab_started_at = oldRow.fab_started_at || null;
        if (r.fab_completed_at === undefined) r.fab_completed_at = oldRow.fab_completed_at || null;
        if (r.cycle_days === undefined) r.cycle_days = oldRow.cycle_days;
      }
    });
  }

  projects[idx] = deriveFields({ ...oldProject, ...incoming });
  writeProjects(projects);
  logActivity('project.updated', { projectId: req.params.id, jobCode: projects[idx].jobCode });
  res.json(projects[idx]);
  } catch (e) { logError('route.put.projects', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Project lifecycle transition ---
// POST /api/projects/:id/lifecycle — change lifecycle state
// Valid transitions: active→dlp, dlp→settled, settled→archived, settled→dlp (reopen)
// Body: { lifecycle, handoverDate?, dlpMonths?, reason? }
app.post('/api/projects/:id/lifecycle', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const projects = readProjects();
    const idx = projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const p = projects[idx];
    deriveFields(p);

    const target = sanitizeStr(req.body.lifecycle, 20);
    if (!VALID_LIFECYCLES.includes(target)) return res.status(400).json({ error: 'Invalid lifecycle: ' + target });

    const current = p.lifecycle || 'active';
    const ALLOWED = {
      'active':   ['dlp'],
      'dlp':      ['settled'],
      'settled':  ['archived', 'dlp'],  // dlp = reopen
      'archived': ['dlp'],              // reopen from archive
    };
    if (!(ALLOWED[current] || []).includes(target)) {
      return res.status(400).json({ error: `Cannot transition from ${current} to ${target}` });
    }

    // active → dlp: require handover date
    if (target === 'dlp' && current === 'active') {
      const handoverDate = sanitizeStr(req.body.handoverDate, 20);
      if (!handoverDate) return res.status(400).json({ error: 'handoverDate is required for DLP transition' });
      p.handoverDate = handoverDate;
      if (req.body.dlpMonths !== undefined) p.dlpMonths = parseInt(req.body.dlpMonths, 10) || 12;
      if (req.body.retentionPercent !== undefined) p.retentionPercent = parseFloat(req.body.retentionPercent) || 5;
      p.status = 'Completed';
    }

    // dlp → settled: mark retention released + final account date
    if (target === 'settled') {
      p.retentionReleased = true;
      p.retentionReleasedDate = req.body.retentionReleasedDate || todaySGT();
      p.finalAccountDate = req.body.finalAccountDate || todaySGT();
    }

    // → archived
    if (target === 'archived') {
      p.archivedDate = todaySGT();
    }

    // settled/archived → dlp: reopen (defect callback)
    if (target === 'dlp' && (current === 'settled' || current === 'archived')) {
      p.retentionReleased = false;
      p.retentionReleasedDate = null;
      p.finalAccountDate = null;
      p.archivedDate = null;
    }

    const oldLifecycle = p.lifecycle;
    p.lifecycle = target;
    deriveFields(p); // recalculate DLP end date etc.
    writeProjects(projects);
    logActivity('project.lifecycle.changed', {
      projectId: p.id, jobCode: p.jobCode,
      from: oldLifecycle, to: target,
      reason: sanitizeStr(req.body.reason, 500) || undefined,
    });
    res.json({ ok: true, lifecycle: p.lifecycle, project: deriveFields(p) });

    // Email notifications
    const bossEmail = getBossEmail();
    const bossName = getBossName();
    if (target === 'dlp' && current === 'active' && bossEmail) {
      const qsEmail = p.qs ? getStaffEmail(p.qs) : null;
      const cc = qsEmail ? [qsEmail] : [];
      sendEmail(bossEmail, bossName,
        `[DLP Started] ${p.jobCode} — Handover complete`,
        emailWrap(null,
          `<p style="margin:0 0 16px;">Project has moved to Defects Liability Period:</p>` +
          emailTable([
            ['Project', escHtml(p.jobCode) + ' — ' + escHtml(p.projectName)],
            ['Handover Date', escHtml(p.handoverDate)],
            ['DLP Period', p.dlpMonths + ' months'],
            ['DLP Ends', escHtml(p.dlpEndDate)],
            ['Retention', '$' + (p.retentionAmount || 0).toLocaleString()],
          ]),
          'View Project', `${APP_URL}/project?id=${p.id}`),
        cc
      ).catch(() => {});
    }
  } catch (e) { logError('route.post.project.lifecycle', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Delete project ---
app.delete('/api/projects/:id', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const pid = req.params.id;
    const projects = readProjects();
    const idx = projects.findIndex(p => p.id === pid);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const deleted = projects.splice(idx, 1)[0];
    writeProjects(projects);

    // Cascade cleanup: remove orphaned records referencing this project
    try {
      // Site requests
      const srs = readSiteRequests();
      const filteredSRs = srs.filter(sr => sr.projectId !== pid);
      if (filteredSRs.length < srs.length) writeSiteRequests(filteredSRs);

      // Tasks
      const tasks = readTasks();
      const filteredTasks = tasks.filter(t => t.projectId !== pid);
      if (filteredTasks.length < tasks.length) writeTasks(filteredTasks);

      // Upload files on disk — project docs, fab-log photos, install-log photos
      const safePid = path.basename(pid);
      const dirsToWipe = [
        path.join(UPLOADS_DIR, 'projects', safePid),
        path.join(FAB_LOGS_DIR, safePid),
        path.join(INSTALL_LOGS_DIR, safePid)
      ];
      for (const dir of dirsToWipe) {
        if (fs.existsSync(dir) && path.resolve(dir).startsWith(path.resolve(UPLOADS_DIR))) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      logActivity('project.deleted.cascade', {
        projectId: pid,
        jobCode: deleted.jobCode || '',
        removedSRs: srs.length - filteredSRs.length,
        removedTasks: tasks.length - filteredTasks.length
      });
    } catch (cascadeErr) { logError('project.delete.cascade', cascadeErr); }

    res.json({ ok: true });
  } catch (e) { logError('route.delete.projects', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Factory Queue (cross-project) ---
app.get('/api/factory-queue', (req, res) => {
  try {
  const projects = readProjects();
  const allSRs = readSiteRequests();
  const today = Date.now();
  const queue = [];

  for (const p of projects) {
    deriveFields(p);
    if (p.lifecycle !== 'active') continue;
    const fabItemsRaw = (p.fabrication || []);
    // Merge productScope items so the factory queue auto-populates even when
    // Chris hasn't hit "Sync to FAB" yet. Only Local Fabrication items flow here;
    // Overseas Order / Purchase Item scope rows are skipped.
    const scopeItems = (p.productScope || []).filter(s => {
      if (!s || !s.item || !String(s.item).trim()) return false;
      const t = s.type || 'Local Fabrication';
      return t === 'Local Fabrication';
    });
    const fabKeys = new Set(fabItemsRaw.map(f => String(f.item || '').trim().toLowerCase()));
    const scopeOnly = scopeItems
      .filter(s => !fabKeys.has(String(s.item).trim().toLowerCase()))
      .map(s => ({
        item: String(s.item).trim(),
        totalQty: Number(s.qty) || 0,
        unit: s.unit || 'units',
        qtyDone: 0,
        qtySent: 0,
        status: 'Not Started',
        _fromScope: true,
      }));
    const fabItems = fabItemsRaw.concat(scopeOnly);
    if (!fabItems.length) continue;

    // Build site-request maps for this project.
    // Source: site-requests.json filtered by projectId. Retired
    // project.deliveryRequests[] 2026-04-15 — site-requests are the canonical
    // pull-from-site signal; project.deliveryRequests was a backwards
    // push-from-project model that violated one-role-one-page.
    //
    // Three maps computed here:
    //   deliveryMap  — OPEN (non-Delivered) SRs keyed by item name for
    //                  the existing needed-by / ticket-status metadata.
    //   shippedByIdx — total qty Delivered per fabIdx (authoritative).
    //   shippedByKey — total qty Delivered per item-name key (fallback for
    //                  legacy SRs with null fabIdx).
    const deliveryMap = {};
    const shippedByIdx = {};
    const shippedByKey = {};
    for (const sr of allSRs) {
      if (sr.projectId !== p.id) continue;
      const key = (sr.item || '').toLowerCase().trim();
      if (sr.status === 'Delivered') {
        const q = parseFloat(sr.quantity) || 0;
        if (sr.fabIdx !== null && sr.fabIdx !== undefined && !Number.isNaN(parseInt(sr.fabIdx, 10))) {
          const fIdx = parseInt(sr.fabIdx, 10);
          shippedByIdx[fIdx] = (shippedByIdx[fIdx] || 0) + q;
        } else if (key) {
          shippedByKey[key] = (shippedByKey[key] || 0) + q;
        }
        continue;
      }
      if (!key) continue;
      if (!deliveryMap[key] || (sr.neededByDate && sr.neededByDate < (deliveryMap[key].neededByDate || '9999'))) {
        // Normalize SR shape into what the downstream items.map() reads:
        // neededByDate, phase, requestedBy, acknowledgedAt, inProductionAt, id, ticketStatus.
        deliveryMap[key] = {
          id:              sr.id,
          item:            sr.item,
          neededByDate:    sr.neededByDate || '',
          phase:           '',
          requestedBy:     sr.requestedBy || '',
          acknowledgedAt:  sr.acknowledgedAt || null,
          acknowledgedBy:  sr.acknowledgedBy || '',
          inProductionAt:  null,
          ticketStatus:    sr.status || 'New',
        };
      }
    }

    const items = fabItems.map((f, idx) => {
      const key = (f.item || f.description || '').toLowerCase().trim();
      const req = deliveryMap[key] || null;
      const daysUntilNeeded = req && req.neededByDate
        ? Math.floor((new Date(req.neededByDate).getTime() - today) / 86400000)
        : null;
      // qtyShipped: sum of Delivered SRs linked to this fab row.
      // Prefer fabIdx match (authoritative); fall back to item name for
      // legacy SRs (pre-fabIdx) and free-text entries. Only real fabrication
      // rows (not scope-seeded) have a stable index — scope-only rows always
      // fall through to name match.
      const shippedByIdxVal = f._fromScope ? 0 : (shippedByIdx[idx] || 0);
      const shippedByKeyVal = shippedByKey[key] || 0;
      const qtyShipped = shippedByIdxVal + shippedByKeyVal;
      const qtyDone    = parseFloat(f.qtyDone) || 0;
      // On-floor = built but not yet shipped. Clamp at 0 for edge cases
      // where data drift (e.g. deletion of a fab row) would otherwise
      // produce negatives.
      const qtyOnFloor = Math.max(0, qtyDone - qtyShipped);
      // Integrity check: you can't ship more than you built. When this
      // happens it's usually bad SR quantity or a fab row qty that lags
      // behind reality. Don't block the UI, just surface a soft-warn so
      // Chris can fix the source data. Mirror of the planned
      // qtyInstalled > qtyShipped banner on the install side.
      const qtyOverShipped = qtyShipped > qtyDone;
      // Include logs[] in the queue response so the client can render
      // the today's-logs inline panel + timeline without a separate
      // full-project fetch. Scope-only rows never have logs (they're
      // synthetic, not yet persisted).
      const logs = Array.isArray(f.logs) ? f.logs : [];
      return {
        idx,
        description: f.item || f.description || '',
        totalQty: f.totalQty || 0,
        doneQty: qtyDone,
        qtyShipped,
        qtyOnFloor,
        qtyOverShipped,
        fabPct: f.totalQty > 0 ? Math.round(qtyDone / f.totalQty * 100) : 0,
        status: f.status || 'Not Started',
        fromScope: !!f._fromScope,
        readyForDelivery: f.readyForDelivery || false,
        targetDeliveryDate: f.targetDeliveryDate || '',
        readyAt: f.readyAt || null,
        logs,
        deliveryRequested: !!req,
        neededByDate: req ? (req.neededByDate || '') : '',
        phase: req ? (req.phase || '') : '',
        requestedBy: req ? (req.requestedBy || '') : '',
        daysUntilNeeded,
        isOverdue: req && req.neededByDate && daysUntilNeeded < 0 && !f.readyForDelivery,
        fabStatus: f.status || 'Not Started',
        ticketStatus: req ? (req.ticketStatus || 'New') : '',
        deliveryReqId: req ? (req.id || '') : '',
        acknowledgedBy: req ? (req.acknowledgedBy || '') : '',
        acknowledgedAt: req ? (req.acknowledgedAt || null) : null,
        inProductionAt: req ? (req.inProductionAt || null) : null,
        // Parts/BOM fields
        isMechanicalParent: !!f.isMechanicalParent,
        isPartRow: !!f.isPartRow,
        parentIdx: f.parentIdx != null ? f.parentIdx : null,
        partSource: f.partSource || null,
        orderParts: Array.isArray(f.orderParts) ? f.orderParts : [],
        partsProgress: f.partsProgress || null,
      };
    });

    queue.push({
      projectId: p.id,
      jobCode: p.jobCode,
      projectName: p.projectName,
      endDate: p.endDate || '',
      items,
    });
  }

  res.json(queue);
  } catch (e) { logError('route.get.factory-queue', e); res.status(500).json({ error: 'Internal server error' }); }
});

// Whitelist of client-writable fields on fabrication rows. Anything outside
// this set (fab_started_at, cycle_days, _fromScope, logs, etc.) is server-managed.
// NOTE: qtyDone remains writable via the narrow PUT for backward compat with
// /project.html's buildFabRow inputs (still shipping as of Phase A). Direct
// writes from /project will NOT create a log entry — that's a temporary dual
// path. When /project's fab edit UI is retired in Phase 4, qtyDone comes off
// this list and logs[] becomes the only write path.
const FAB_WRITABLE_FIELDS = ['item','unit','totalQty','qtyDone','status','readyForDelivery','targetDeliveryDate','readyAt','fabDeadline','isMechanicalParent','parentIdx','isPartRow','partSource','orderParts'];

// recomputeQtyDone — source of truth for qtyDone is sum(logs[].delta).
// We keep qtyDone on the fab row as a CACHE so readers don't have to sum on
// every request (factory-queue, deriveFields, autoDeriveFabStatus all read
// the field directly). Any code path that mutates logs[] must call this
// immediately after.
//
// Empty-logs semantics: if `logs` is explicitly an array (possibly empty),
// qtyDone is normalized to the sum — which is 0 for an empty array. This
// is what the user expects when they delete the last log: the row zeros
// out. If `logs` is absent entirely (row never touched by the daily-log
// model), we leave qtyDone alone so the legacy /project.html direct-edit
// path still works during the transition. Post-migration every fab row
// has a `logs` array, so in practice the "leave alone" branch only
// matters for brand-new rows created after migration.
function recomputeQtyDone(fabItem) {
  if (!Array.isArray(fabItem.logs)) return;
  const sum = fabItem.logs.reduce((acc, l) => acc + (parseFloat(l.delta) || 0), 0);
  fabItem.qtyDone = Math.round(sum * 100) / 100;
  // Keep doneQty in sync for install rows (legacy field name used by project.js + deriveFields)
  fabItem.doneQty = fabItem.qtyDone;
}

// Auto-derive status from qtyDone for batch items (totalQty > 1). Chris
// picks "In Progress" on day 1 and forgets — the chip goes stale while
// qtyDone keeps moving. For batch items, qtyDone is the only signal that
// actually tracks reality, so derive status from it. Qty=1 items (gates,
// one-off assemblies) keep manual stage control where the ladder is meaningful.
// Rules:
//   qtyDone == 0        → Not Started
//   0 < done < total    → In Progress
//   done >= total       → QC Check  (Chris manually advances past QC)
// Only auto-derive for items currently in the pre-QC half of the ladder —
// once Chris has advanced to QC/Ready/Delivered, we leave the status alone.
function autoDeriveFabStatus(fabItem) {
  if (fabItem.isMechanicalParent) return; // parent status derived from parts
  const total = parseFloat(fabItem.totalQty) || 0;
  const done  = parseFloat(fabItem.qtyDone)  || 0;
  if (total <= 1) return; // singletons: manual ladder only
  const current = fabItem.status || 'Not Started';
  if (current === 'QC Check' || current === 'Ready for Delivery' || current === 'Delivered') return;
  if (done <= 0) fabItem.status = 'Not Started';
  else if (done < total) fabItem.status = 'In Progress';
  else fabItem.status = 'QC Check';
}

// Cycle-time stamping + derived status, shared by POST-append and PUT-update
// so both paths stay consistent. Also recomputes qtyDone from logs[] first so
// downstream derivations (status chip, cycle time) run against the true value.
function applyFabDerivations(oldItem, fabItem, opts) {
  recomputeQtyDone(fabItem);
  const oldQtyDone = parseFloat((oldItem || {}).qtyDone) || 0;
  const newQtyDone = parseFloat(fabItem.qtyDone) || 0;
  const qtyTotal   = parseFloat(fabItem.totalQty) || 0;
  const nowISO     = new Date().toISOString();
  if (oldQtyDone === 0 && newQtyDone > 0 && !fabItem.fab_started_at) {
    fabItem.fab_started_at = nowISO;
  }
  if (qtyTotal > 0 && newQtyDone >= qtyTotal && !fabItem.fab_completed_at) {
    fabItem.fab_completed_at = nowISO;
  }
  if (fabItem.fab_started_at && fabItem.fab_completed_at && !fabItem.cycle_days) {
    const startMs = new Date(fabItem.fab_started_at).getTime();
    const endMs   = new Date(fabItem.fab_completed_at).getTime();
    fabItem.cycle_days = Math.round((endMs - startMs) / 86400000 * 10) / 10;
  }
  if (!(opts && opts.skipStatusDerive)) {
    autoDeriveFabStatus(fabItem);
  }
}

// --- API: Append a fabrication row (narrow, whitelisted). Dedupes by item
// name (case-insensitive) so seeded scope rows upsert cleanly on first save.
app.post('/api/projects/:id/fabrication', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!Array.isArray(project.fabrication)) project.fabrication = [];
    const clean = {};
    for (const k of FAB_WRITABLE_FIELDS) if (req.body[k] !== undefined) clean[k] = req.body[k];
    if (!clean.item || !String(clean.item).trim()) return res.status(400).json({ error: 'item required' });
    const nameKey = String(clean.item).toLowerCase().trim();
    const existingIdx = project.fabrication.findIndex(f => (f.item || '').toLowerCase().trim() === nameKey);
    let idx;
    let oldForDerive = null;
    if (existingIdx >= 0) {
      oldForDerive = { ...project.fabrication[existingIdx] };
      Object.assign(project.fabrication[existingIdx], clean);
      idx = existingIdx;
    } else {
      project.fabrication.push(clean);
      idx = project.fabrication.length - 1;
    }
    applyFabDerivations(oldForDerive, project.fabrication[idx]);
    deriveFields(project);
    writeProjects(projects);
    logActivity('fab.upserted', { projectId: req.params.id, jobCode: project.jobCode, itemIndex: idx, item: clean.item });
    res.json({ idx, item: project.fabrication[idx] });
  } catch (e) { logError('route.post.fabrication', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Update fabrication item fields ---
app.put('/api/projects/:id/fabrication/:idx', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const idx = parseInt(req.params.idx, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Invalid index' });
    if (!project.fabrication || !project.fabrication[idx]) return res.status(404).json({ error: 'Item not found' });
    const oldItem = { ...project.fabrication[idx] };
    // Whitelist — silently drop server-managed fields (fab_started_at, cycle_days, _fromScope).
    const clean = {};
    for (const k of FAB_WRITABLE_FIELDS) if (req.body[k] !== undefined) clean[k] = req.body[k];
    // Validate fabDeadline format (YYYY-MM-DD or null/empty to clear)
    if (clean.fabDeadline !== undefined) {
      if (clean.fabDeadline === null || clean.fabDeadline === '') { clean.fabDeadline = null; }
      else if (!isValidDate(String(clean.fabDeadline))) { return res.status(400).json({ error: 'fabDeadline must be YYYY-MM-DD' }); }
      else { clean.fabDeadline = String(clean.fabDeadline).trim().slice(0, 10); }
    }
    Object.assign(project.fabrication[idx], clean);
    // If the client sent an explicit status (stage chip tap), preserve it —
    // only run auto-derive when the status wasn't manually set.
    const manualStatus = clean.status !== undefined;
    applyFabDerivations(oldItem, project.fabrication[idx], { skipStatusDerive: manualStatus });

    deriveFields(project);
    writeProjects(projects);
    const changes = Object.keys(clean)
      .filter(k => String(clean[k]) !== String(oldItem[k]))
      .map(k => ({ field: k, from: oldItem[k], to: clean[k] }));
    logActivity('fab.updated', { projectId: req.params.id, jobCode: project.jobCode, itemIndex: idx, item: project.fabrication[idx].item || project.fabrication[idx].description || '', changes });
    res.json(project.fabrication[idx]);
  } catch (e) { logError('route.put.fabrication', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Fabrication log entries ─────────────────────────────────────────────────
// Phase A of the daily-log accountability model. Each build event is a log
// entry with a mandatory photo (photoPath) paired to a delta. qtyDone is
// derived (cached) from sum(logs[].delta). Edits preserve history. See
// memory/project_factory_daily_log_model.md for the full contract.
//
// NOTE: photoPath is enforced here as a non-empty string reference. Phase A
// ships the data model only — no UI, no multer route for log photos yet.
// Callers in this phase can pass any placeholder string; Phase B wires the
// real upload pipeline that produces a deterministic photoPath.

// Shared: find the project + fab row, returning standardized 404s. Returns
// { project, projects, row, idx } or sends the response and returns null.
function _loadFabRowOr404(req, res) {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  const idx = parseInt(req.params.idx, 10);
  if (isNaN(idx) || idx < 0) { res.status(400).json({ error: 'Invalid fab index' }); return null; }
  if (!Array.isArray(project.fabrication) || !project.fabrication[idx]) {
    res.status(404).json({ error: 'Fab row not found' }); return null;
  }
  return { projects, project, row: project.fabrication[idx], idx };
}

// Shared: compute shipped qty for a given (project, fabIdx) by summing
// Delivered site-requests. Matches the same shippedByIdx + shippedByKey
// logic the factory-queue endpoint uses so log-write validation is
// consistent with what the UI shows.
function _shippedForFabRow(projectId, fabIdx, fabItemName) {
  const srs = readSiteRequests();
  const nameKey = (fabItemName || '').toLowerCase().trim();
  let shipped = 0;
  for (const sr of srs) {
    if (sr.projectId !== projectId) continue;
    if (sr.status !== 'Delivered') continue;
    const q = parseFloat(sr.quantity) || 0;
    if (sr.fabIdx !== null && sr.fabIdx !== undefined && !Number.isNaN(parseInt(sr.fabIdx, 10))) {
      if (parseInt(sr.fabIdx, 10) === fabIdx) shipped += q;
    } else if (nameKey && (sr.item || '').toLowerCase().trim() === nameKey) {
      shipped += q;
    }
  }
  return shipped;
}

// Shared: validate a proposed new total qtyDone against the BOM ceiling and
// the shipped floor. Returns null if OK, or a { status, error } object to
// send back. Hard blocks — matches the over-sent guardrail strategy.
function _validateLogTotals(row, proposedQtyDone, projectId, fabIdx) {
  const totalQty = parseFloat(row.totalQty) || 0;
  if (totalQty > 0 && proposedQtyDone > totalQty) {
    return {
      status: 400,
      error: `Cannot log more than total quantity. Proposed ${proposedQtyDone} exceeds totalQty ${totalQty}. Edit the BOM or adjust the delta.`,
    };
  }
  const shipped = _shippedForFabRow(projectId, fabIdx, row.item);
  if (shipped > proposedQtyDone) {
    return {
      status: 400,
      error: `Cannot reduce built qty below already-shipped total. Proposed ${proposedQtyDone} is less than ${shipped} already shipped via delivered site-requests. Reconcile by editing shipment quantities first.`,
    };
  }
  return null;
}

// POST /api/projects/:id/fabrication/:idx/log-photo — upload a log photo.
// Accepts a single image file (multipart field name: `file`). Runs it
// through sharp to strip EXIF, normalize HEIC/WEBP/PNG/etc to JPEG, and
// cap long-edge at 1600px as a safety net (client compression also does
// this, but we don't trust the client on its own). Writes to
//   public/uploads/fab-logs/<projectId>/<logId>.jpg
// Returns { photoPath, logId } so the client can then POST a log entry
// with the same logId, producing a durable photo↔entry pairing.
//
// The photoPath returned is the public URL (e.g. `/uploads/fab-logs/xxx/log_abc.jpg`)
// so the client can display it immediately without rewriting the path.
// Internally `photoPath` on the log entry stores the same value.
app.post('/api/projects/:id/fabrication/:idx/log-photo',
  postRateLimit,
  uploadLogPhoto.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });
      const projects = readProjects();
      const project = projects.find(p => p.id === req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const fabIdx = parseInt(req.params.idx, 10);
      if (isNaN(fabIdx) || fabIdx < 0) return res.status(400).json({ error: 'Invalid fab index' });
      if (!Array.isArray(project.fabrication) || !project.fabrication[fabIdx]) {
        return res.status(404).json({ error: 'Fab row not found' });
      }

      // Caller may supply a logId (so the subsequent log-create call can
      // use the same id). Otherwise we mint one here and return it.
      const suppliedId = typeof req.body.logId === 'string' ? req.body.logId.trim() : '';
      const logId = suppliedId && /^log_[a-z0-9_]+$/i.test(suppliedId)
        ? suppliedId
        : ('log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));

      // Project subdir — sanitize the project id for filesystem safety even
      // though it's already normalized upstream.
      const projectDirName = String(project.id).replace(/[^a-zA-Z0-9._-]/g, '_');
      const projectDir = path.join(FAB_LOGS_DIR, projectDirName);
      if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
      const destPath = path.join(projectDir, `${logId}.jpg`);

      // Sharp pipeline: auto-rotate based on EXIF orientation (THEN strip
      // metadata so the rotation is baked in), resize cap at 1600px long
      // edge (inside — no upscale), re-encode as progressive JPEG at
      // quality 85. `.jpeg()` implicitly strips EXIF unless we explicitly
      // keep it. Sharp writes atomically; partial files aren't left on
      // disk if the encode errors.
      await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
        .toFile(destPath);

      const photoPath = `/uploads/fab-logs/${projectDirName}/${logId}.jpg`;
      logActivity('fab.log.photo.uploaded', {
        projectId: project.id, jobCode: project.jobCode, fabIdx, logId,
        originalSize: req.file.size, originalMime: req.file.mimetype,
      });
      res.json({ photoPath, logId });
    } catch (e) {
      logError('route.post.fab-log-photo', e, { projectId: req.params.id, fabIdx: req.params.idx });
      if (!res.headersSent) res.status(500).json({ error: 'Photo upload failed: ' + (e.message || 'unknown') });
    }
  }
);

// POST /api/projects/:id/fabrication/:idx/logs — create a log entry.
// Body: { delta, photoPath, note?, loggedBy?, id? }
// - delta must be a finite non-zero number (positive = built, negative = correction)
// - photoPath is required (non-empty string)
// - id is OPTIONAL — if the caller pre-uploaded a photo via the log-photo
//   route and got back a logId, they pass it here so the entry and the
//   photo file share the same identifier. Must match /^log_[a-z0-9_]+$/i.
// - loggedBy defaults to 'Chris' (TODO: pull from session when auth lands)
app.post('/api/projects/:id/fabrication/:idx/logs', postRateLimit, (req, res) => {
  try {
    const loaded = _loadFabRowOr404(req, res);
    if (!loaded) return;
    const { projects, project, row, idx } = loaded;

    const delta = parseFloat(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'delta must be a non-zero number' });
    }
    const photoPath = typeof req.body.photoPath === 'string' ? req.body.photoPath.trim() : '';
    if (!photoPath) return res.status(400).json({ error: 'photoPath is required — every log entry must carry photo evidence' });
    if (!photoPath.startsWith('/uploads/fab-logs/')) return res.status(400).json({ error: 'photoPath must start with /uploads/fab-logs/' });
    const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : '';
    const fmName = (readStaff()['Factory Manager'] || {}).name || 'Factory Manager';
    const loggedBy = (typeof req.body.loggedBy === 'string' && req.body.loggedBy.trim()) || fmName;

    if (!Array.isArray(row.logs)) row.logs = [];
    const currentSum = row.logs.reduce((a, l) => a + (parseFloat(l.delta) || 0), 0);
    const proposedSum = Math.round((currentSum + delta) * 100) / 100;

    const err = _validateLogTotals(row, proposedSum, project.id, idx);
    if (err) return res.status(err.status).json({ error: err.error });

    // Caller-supplied id: set when a photo was pre-uploaded via the
    // log-photo route and returned a logId the client now passes back
    // here. Must match the log_<...> pattern to prevent path injection
    // and must not collide with an existing entry on this row.
    const suppliedId = typeof req.body.id === 'string' ? req.body.id.trim() : '';
    let entryId;
    if (suppliedId) {
      if (!/^log_[a-z0-9_]+$/i.test(suppliedId)) {
        return res.status(400).json({ error: 'Invalid id format — must match /^log_[a-z0-9_]+$/i' });
      }
      if (row.logs.some(l => l.id === suppliedId)) {
        return res.status(409).json({ error: 'A log entry with this id already exists' });
      }
      entryId = suppliedId;
    } else {
      entryId = 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // extraPhotos: optional array of additional photo paths
    let extraPhotos = [];
    if (Array.isArray(req.body.extraPhotos)) {
      extraPhotos = req.body.extraPhotos
        .filter(p => typeof p === 'string' && p.startsWith('/uploads/fab-logs/'))
        .slice(0, 9); // max 9 extra (10 total with primary)
    }

    const entry = {
      id: entryId,
      loggedAt: new Date().toISOString(),
      loggedBy,
      delta: Math.round(delta * 100) / 100,
      photoPath,
      extraPhotos,
      note,
      editedAt: null,
      editedBy: null,
      editHistory: [],
    };
    row.logs.push(entry);

    applyFabDerivations(null, row); // recomputes qtyDone + status + cycle time
    deriveFields(project);
    writeProjects(projects);
    logActivity('fab.log.created', {
      projectId: project.id, jobCode: project.jobCode,
      fabIdx: idx, item: row.item,
      logId: entry.id, delta: entry.delta, newTotal: row.qtyDone,
    });
    res.json({ log: entry, qtyDone: row.qtyDone, status: row.status });
  } catch (e) {
    logError('route.post.fab-log', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:id/fabrication/:idx/logs/:logId — edit a log entry.
// Body: { delta?, photoPath?, note?, editedBy? }
// Prior version pushed to editHistory[]. Never rewrites silently.
app.put('/api/projects/:id/fabrication/:idx/logs/:logId', postRateLimit, (req, res) => {
  try {
    const loaded = _loadFabRowOr404(req, res);
    if (!loaded) return;
    const { projects, project, row, idx } = loaded;
    if (!Array.isArray(row.logs)) return res.status(404).json({ error: 'No logs on this row' });
    const logIdx = row.logs.findIndex(l => l.id === req.params.logId);
    if (logIdx < 0) return res.status(404).json({ error: 'Log entry not found' });
    const entry = row.logs[logIdx];

    // Snapshot the prior version before mutating.
    const priorSnapshot = {
      at: entry.editedAt || entry.loggedAt,
      by: entry.editedBy || entry.loggedBy,
      delta: entry.delta,
      note: entry.note || '',
      photoPath: entry.photoPath,
    };

    // Build the proposed delta before validation so we can check the total.
    const nextDelta = (req.body.delta !== undefined && req.body.delta !== null)
      ? parseFloat(req.body.delta)
      : entry.delta;
    if (!Number.isFinite(nextDelta) || nextDelta === 0) {
      return res.status(400).json({ error: 'delta must be a non-zero number' });
    }
    const otherSum = row.logs.reduce((a, l, i) => i === logIdx ? a : a + (parseFloat(l.delta) || 0), 0);
    const proposedSum = Math.round((otherSum + nextDelta) * 100) / 100;
    const err = _validateLogTotals(row, proposedSum, project.id, idx);
    if (err) return res.status(err.status).json({ error: err.error });

    // Apply the edit.
    if (!Array.isArray(entry.editHistory)) entry.editHistory = [];
    entry.editHistory.push(priorSnapshot);
    entry.delta = Math.round(nextDelta * 100) / 100;
    if (typeof req.body.photoPath === 'string' && req.body.photoPath.trim()) {
      const pp = req.body.photoPath.trim();
      if (pp.startsWith('/uploads/fab-logs/')) entry.photoPath = pp;
    }
    if (Array.isArray(req.body.extraPhotos)) {
      entry.extraPhotos = req.body.extraPhotos
        .filter(p => typeof p === 'string' && p.startsWith('/uploads/fab-logs/'))
        .slice(0, 9);
    }
    if (typeof req.body.note === 'string') entry.note = req.body.note.slice(0, 500);
    entry.editedAt = new Date().toISOString();
    const fmNameEdit = (readStaff()['Factory Manager'] || {}).name || 'Factory Manager';
    entry.editedBy = (typeof req.body.editedBy === 'string' && req.body.editedBy.trim()) || fmNameEdit;

    applyFabDerivations(null, row);
    deriveFields(project);
    writeProjects(projects);
    logActivity('fab.log.edited', {
      projectId: project.id, jobCode: project.jobCode,
      fabIdx: idx, item: row.item,
      logId: entry.id, newDelta: entry.delta, newTotal: row.qtyDone,
      editCount: entry.editHistory.length,
    });
    res.json({ log: entry, qtyDone: row.qtyDone, status: row.status });
  } catch (e) {
    logError('route.put.fab-log', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:id/fabrication/:idx/logs/:logId — remove a log entry.
// Re-validates the row after removal (a delete can't push us under the
// shipped floor). If the guard blocks it, the client can retry with
// { force: true, reason: '...' } in the JSON body — the delete proceeds
// but a force-override is logged in the activity log for audit.
app.delete('/api/projects/:id/fabrication/:idx/logs/:logId', postRateLimit, express.json(), (req, res) => {
  try {
    const loaded = _loadFabRowOr404(req, res);
    if (!loaded) return;
    const { projects, project, row, idx } = loaded;
    if (!Array.isArray(row.logs)) return res.status(404).json({ error: 'No logs on this row' });
    const logIdx = row.logs.findIndex(l => l.id === req.params.logId);
    if (logIdx < 0) return res.status(404).json({ error: 'Log entry not found' });
    const removed = row.logs[logIdx];

    const otherSum = row.logs.reduce((a, l, i) => i === logIdx ? a : a + (parseFloat(l.delta) || 0), 0);
    const proposedSum = Math.round(otherSum * 100) / 100;
    const err = _validateLogTotals(row, proposedSum, project.id, idx);
    let forceOverride = false;
    if (err) {
      const body = req.body || {};
      const reason = (body.reason || '').trim();
      if (body.force === true && reason.length > 0) {
        forceOverride = true;
      } else {
        return res.status(err.status).json({ error: err.error, canForce: true });
      }
    }

    row.logs.splice(logIdx, 1);
    applyFabDerivations(null, row);
    deriveFields(project);
    writeProjects(projects);

    // Unlink the photo file. Log photos are named <logId>.jpg — editing
    // overwrites the same file in place, so there's never more than one
    // physical file per logId. One unlink cleans up the whole entry
    // (including any prior versions referenced in editHistory[]).
    // Path-traversal guard: require the /uploads/ prefix and verify the
    // resolved path lives inside UPLOADS_DIR before unlinking.
    let photoUnlinked = false;
    // Collect all photo paths to unlink (primary + extras)
    const photosToUnlink = [];
    if (removed.photoPath && typeof removed.photoPath === 'string' && removed.photoPath.startsWith('/uploads/fab-logs/')) {
      photosToUnlink.push(removed.photoPath);
    }
    if (Array.isArray(removed.extraPhotos)) {
      removed.extraPhotos.forEach(p => {
        if (typeof p === 'string' && p.startsWith('/uploads/fab-logs/')) photosToUnlink.push(p);
      });
    }
    for (const photoPath of photosToUnlink) {
      try {
        const rel = photoPath.replace(/^\/uploads\//, '');
        const abs = path.resolve(path.join(UPLOADS_DIR, rel));
        if (abs.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          photoUnlinked = true;
        }
      } catch (unlinkErr) {
        logError('fab.log.delete.unlink', unlinkErr, { photoPath, logId: removed.id });
      }
    }

    const activityData = {
      projectId: project.id, jobCode: project.jobCode,
      fabIdx: idx, item: row.item,
      logId: removed.id, deletedDelta: removed.delta, newTotal: row.qtyDone,
      photoUnlinked,
    };
    if (forceOverride) {
      activityData.forceOverride = true;
      activityData.overrideReason = (req.body.reason || '').trim();
      activityData.shippedFloor = _shippedForFabRow(project.id, idx, row.item);
      logActivity('fab.log.force-deleted', activityData);
    } else {
      logActivity('fab.log.deleted', activityData);
    }
    res.json({ ok: true, qtyDone: row.qtyDone, status: row.status, forceOverride });
  } catch (e) {
    logError('route.delete.fab-log', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// --- API: Delete a fabrication row AND reindex any linked site-requests.
// This is the ONE place fab rows should be deleted. Doing it via the full
// project PUT (client-side splice → write-back) orphans site-requests that
// hold a fabIdx pointing at rows below the deleted one, silently
// mis-attributing shipments once Phase 2A landed. This narrow route keeps
// fabIdx integrity:
//   - SR with fabIdx === deletedIdx   → fabIdx set to null (falls back to
//     item-name match in derivations; caller decides whether to also
//     delete the SR)
//   - SR with fabIdx >  deletedIdx    → fabIdx decremented by 1
//   - SR with fabIdx <  deletedIdx    → untouched
app.delete('/api/projects/:id/fabrication/:idx', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const idx = parseInt(req.params.idx, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Invalid index' });
    if (!Array.isArray(project.fabrication) || !project.fabrication[idx]) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const removed = project.fabrication[idx];
    project.fabrication.splice(idx, 1);
    deriveFields(project);
    writeProjects(projects);

    // Walk site-requests and reindex fabIdx for this project only.
    const srs = readSiteRequests();
    let reindexed = 0, nulled = 0;
    for (const sr of srs) {
      if (sr.projectId !== project.id) continue;
      if (sr.fabIdx === undefined || sr.fabIdx === null) continue;
      const cur = parseInt(sr.fabIdx, 10);
      if (Number.isNaN(cur)) continue;
      if (cur === idx) { sr.fabIdx = null; nulled++; }
      else if (cur > idx) { sr.fabIdx = cur - 1; reindexed++; }
    }
    if (reindexed || nulled) writeSiteRequests(srs);

    logActivity('fab.deleted', {
      projectId: req.params.id,
      jobCode: project.jobCode,
      itemIndex: idx,
      item: removed.item || removed.description || '',
      srReindexed: reindexed,
      srNulled: nulled,
    });
    res.json({ ok: true, srReindexed: reindexed, srNulled: nulled });
  } catch (e) { logError('route.delete.fabrication', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Update installation item fields ---
app.put('/api/projects/:id/installation/:idx', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const idx = parseInt(req.params.idx, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Invalid index' });
    if (!project.installation || !project.installation[idx]) return res.status(404).json({ error: 'Item not found' });
    const oldItem = { ...project.installation[idx] };
    // Whitelist: only allow fields the installation page legitimately writes
    const INSTALL_WRITABLE = ['notes', 'status'];
    const clean = {};
    for (const k of INSTALL_WRITABLE) {
      if (req.body[k] !== undefined) clean[k] = req.body[k];
    }
    if (clean.notes !== undefined) clean.notes = String(clean.notes).slice(0, 1000);
    if (clean.status !== undefined) {
      const VALID = ['Not Started', 'In Progress', 'Installed', 'Verified'];
      if (!VALID.includes(clean.status)) return res.status(400).json({ error: 'Invalid status' });
    }
    Object.assign(project.installation[idx], clean);
    deriveFields(project);
    writeProjects(projects);
    const changes = Object.keys(clean)
      .filter(k => String(clean[k]) !== String(oldItem[k]))
      .map(k => ({ field: k, from: oldItem[k], to: clean[k] }));
    logActivity('install.updated', { projectId: req.params.id, jobCode: project.jobCode, itemIndex: idx, item: project.installation[idx].item || project.installation[idx].description || '', changes });
    res.json(project.installation[idx]);
  } catch (e) { logError('route.put.installation', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Installation log routes (mirrors fab-log model) ─────────────────────────
const INSTALL_LOGS_DIR = path.join(__dirname, 'public', 'uploads', 'install-logs');
if (!fs.existsSync(INSTALL_LOGS_DIR)) fs.mkdirSync(INSTALL_LOGS_DIR, { recursive: true });

function _loadInstallRowOr404(req, res) {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  const idx = parseInt(req.params.idx, 10);
  if (isNaN(idx) || idx < 0 || !project.installation || !project.installation[idx]) {
    res.status(404).json({ error: 'Installation item not found' }); return null;
  }
  return { projects, project, row: project.installation[idx], idx };
}

// POST /api/projects/:id/installation/:idx/log-photo — upload install photo
app.post('/api/projects/:id/installation/:idx/log-photo', postRateLimit, uploadLogPhoto.single('photo'),
  async (req, res) => {
    try {
      const projects = readProjects();
      const project = projects.find(p => p.id === req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!req.file) return res.status(400).json({ error: 'No photo' });
      const idx = parseInt(req.params.idx, 10);
      if (isNaN(idx) || idx < 0 || !project.installation || !project.installation[idx]) {
        return res.status(404).json({ error: 'Installation item not found' });
      }
      const suppliedId = typeof req.body.logId === 'string' ? req.body.logId.trim() : '';
      const logId = suppliedId && /^log_[a-z0-9_]+$/i.test(suppliedId)
        ? suppliedId
        : ('log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const projectDirName = String(project.id).replace(/[^a-zA-Z0-9._-]/g, '_');
      const projectDir = path.join(INSTALL_LOGS_DIR, projectDirName);
      if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
      const destPath = path.join(projectDir, `${logId}.jpg`);
      await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
        .toFile(destPath);
      const photoPath = `/uploads/install-logs/${projectDirName}/${logId}.jpg`;
      logActivity('install.log.photo.uploaded', { projectId: project.id, jobCode: project.jobCode, idx, logId });
      res.json({ photoPath, logId });
    } catch (e) {
      logError('route.post.install-log-photo', e);
      if (!res.headersSent) res.status(500).json({ error: 'Photo upload failed' });
    }
  }
);

// POST /api/projects/:id/installation/:idx/logs — create install log entry
app.post('/api/projects/:id/installation/:idx/logs', postRateLimit, (req, res) => {
  try {
    const loaded = _loadInstallRowOr404(req, res);
    if (!loaded) return;
    const { projects, project, row, idx } = loaded;

    const delta = parseFloat(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'delta must be a non-zero number' });
    }
    const photoPath = typeof req.body.photoPath === 'string' ? req.body.photoPath.trim() : '';
    if (!photoPath) return res.status(400).json({ error: 'photoPath is required' });
    if (!photoPath.startsWith('/uploads/install-logs/')) return res.status(400).json({ error: 'photoPath must start with /uploads/install-logs/' });
    const note     = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : '';
    const location = typeof req.body.location === 'string' ? req.body.location.slice(0, 200) : '';
    const step     = typeof req.body.step === 'string' ? req.body.step.trim().slice(0, 100) : '';
    const loggedBy = (typeof req.body.loggedBy === 'string' && req.body.loggedBy.trim()) || 'Site Engineer';

    if (!Array.isArray(row.logs)) row.logs = [];
    const currentSum = row.logs.reduce((a, l) => a + (parseFloat(l.delta) || 0), 0);
    const proposedSum = Math.round((currentSum + delta) * 100) / 100;
    const totalQty = parseFloat(row.totalQty) || 0;
    if (proposedSum > totalQty && totalQty > 0) {
      return res.status(400).json({ error: `Cannot exceed total qty (${totalQty}). Current: ${currentSum}, delta: ${delta}` });
    }
    if (proposedSum < 0) {
      return res.status(400).json({ error: `Cannot go below 0. Current: ${currentSum}, delta: ${delta}` });
    }

    const suppliedId = typeof req.body.id === 'string' ? req.body.id.trim() : '';
    const logId = suppliedId && /^log_[a-z0-9_]+$/i.test(suppliedId)
      ? suppliedId
      : ('log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    if (suppliedId && row.logs.some(l => l.id === suppliedId)) {
      return res.status(409).json({ error: 'Duplicate log id' });
    }

    // extraPhotos: optional array of additional photo paths
    let extraPhotos = [];
    if (Array.isArray(req.body.extraPhotos)) {
      extraPhotos = req.body.extraPhotos
        .filter(p => typeof p === 'string' && p.startsWith('/uploads/install-logs/'))
        .slice(0, 9);
    }

    const entry = { id: logId, delta: Math.round(delta * 100) / 100, photoPath, extraPhotos, note, location, step: step || undefined, loggedBy, loggedAt: new Date().toISOString() };
    row.logs.push(entry);
    recomputeQtyDone(row);
    // Auto-derive status
    const done = parseFloat(row.qtyDone) || 0;
    if (done > 0 && done < totalQty && row.status === 'Not Started') row.status = 'In Progress';
    if (done >= totalQty && totalQty > 0 && (row.status === 'Not Started' || row.status === 'In Progress')) row.status = 'Installed';

    deriveFields(project);
    writeProjects(projects);
    logActivity('install.log.created', {
      projectId: project.id, jobCode: project.jobCode, idx,
      item: row.item || row.description || '', logId, delta, newTotal: row.qtyDone, step: step || undefined
    });
    res.status(201).json({ entry, qtyDone: row.qtyDone, status: row.status, logs: row.logs });

    // Notify the project's QS about installation progress
    const qsName = project.qs;
    if (qsName) {
      const qsEmail = getStaffEmail(qsName);
      if (qsEmail) {
        const itemName = row.item || row.description || 'Item';
        const totalQty = parseFloat(row.totalQty) || 0;
        const pct = totalQty > 0 ? Math.round((row.qtyDone / totalQty) * 100) : 0;
        const stepLabel = step ? ` (${step})` : '';
        sendEmail(qsEmail, qsName,
          `[Install] ${escHtml(project.jobCode || '')} — ${escHtml(itemName)}${stepLabel}: +${delta} (${pct}%)`,
          emailWrap(`Hi ${escHtml(qsName)},`,
            `<p style="margin:0 0 16px;"><strong>${escHtml(loggedBy)}</strong> logged installation progress:</p>` +
            emailTable([
              ['Project', `${escHtml(project.jobCode || '')} — ${escHtml(project.projectName || '')}`],
              ['Item', escHtml(itemName)],
              step ? ['Step', escHtml(step)] : null,
              ['Qty installed', `+${delta}`],
              ['Progress', `${row.qtyDone} / ${totalQty} (${pct}%)`],
              location ? ['Location', escHtml(location)] : null,
              note ? ['Notes', escHtml(note)] : null
            ]) +
            (entry.photoPath ? `<p style="margin:0;"><a href="${APP_URL}${escHtml(entry.photoPath)}">View photo</a></p>` : ''),
            'Open Installation', `${APP_URL}/installation`)
        ).catch(err => console.error('[EMAIL] Install log notify failed:', err.message));
      }
    }
  } catch (e) { logError('route.post.install-log', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/projects/:id/installation/:idx/logs/:logId — edit install log entry
app.put('/api/projects/:id/installation/:idx/logs/:logId', postRateLimit, (req, res) => {
  try {
    const loaded = _loadInstallRowOr404(req, res);
    if (!loaded) return;
    const { projects, project, row, idx } = loaded;
    if (!Array.isArray(row.logs)) return res.status(404).json({ error: 'No logs' });
    const entry = row.logs.find(l => l.id === req.params.logId);
    if (!entry) return res.status(404).json({ error: 'Log entry not found' });

    // Preserve edit history
    if (!Array.isArray(entry.editHistory)) entry.editHistory = [];
    entry.editHistory.push({ delta: entry.delta, note: entry.note, location: entry.location, editedAt: new Date().toISOString() });

    const nextDelta = parseFloat(req.body.delta);
    if (!Number.isFinite(nextDelta) || nextDelta === 0) return res.status(400).json({ error: 'delta must be non-zero' });
    const currentSum = row.logs.reduce((a, l) => a + (parseFloat(l.delta) || 0), 0);
    const proposedSum = Math.round((currentSum - entry.delta + nextDelta) * 100) / 100;
    const totalQty = parseFloat(row.totalQty) || 0;
    if (proposedSum > totalQty && totalQty > 0) return res.status(400).json({ error: 'Would exceed total qty' });
    if (proposedSum < 0) return res.status(400).json({ error: 'Would go below 0' });

    entry.delta = Math.round(nextDelta * 100) / 100;
    if (typeof req.body.photoPath === 'string' && req.body.photoPath.trim()) {
      const pp = req.body.photoPath.trim();
      if (pp.startsWith('/uploads/install-logs/')) entry.photoPath = pp;
    }
    if (Array.isArray(req.body.extraPhotos)) {
      entry.extraPhotos = req.body.extraPhotos
        .filter(p => typeof p === 'string' && p.startsWith('/uploads/install-logs/'))
        .slice(0, 9);
    }
    if (typeof req.body.note === 'string') entry.note = req.body.note.slice(0, 500);
    if (typeof req.body.location === 'string') entry.location = req.body.location.slice(0, 200);
    entry.editedAt = new Date().toISOString();
    entry.editedBy = (typeof req.body.editedBy === 'string' && req.body.editedBy.trim()) || 'Site Engineer';

    recomputeQtyDone(row);
    deriveFields(project);
    writeProjects(projects);
    logActivity('install.log.edited', { projectId: project.id, jobCode: project.jobCode, idx, logId: entry.id, newDelta: entry.delta, newTotal: row.qtyDone });
    res.json({ entry, qtyDone: row.qtyDone, status: row.status, logs: row.logs });
  } catch (e) { logError('route.put.install-log', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/projects/:id/installation/:idx/logs/:logId — delete install log
app.delete('/api/projects/:id/installation/:idx/logs/:logId', postRateLimit, (req, res) => {
  try {
    const loaded = _loadInstallRowOr404(req, res);
    if (!loaded) return;
    const { projects, project, row, idx } = loaded;
    if (!Array.isArray(row.logs)) return res.status(404).json({ error: 'No logs' });
    const logIdx = row.logs.findIndex(l => l.id === req.params.logId);
    if (logIdx === -1) return res.status(404).json({ error: 'Log entry not found' });
    const entry = row.logs[logIdx];

    // Validate: don't allow delete if it would push qtyDone negative
    const otherSum = row.logs.reduce((a, l, i) => i === logIdx ? a : a + (parseFloat(l.delta) || 0), 0);
    const proposedSum = Math.round(otherSum * 100) / 100;
    if (proposedSum < 0) {
      return res.status(400).json({ error: `Cannot delete: would result in negative installed qty (${proposedSum}).` });
    }

    row.logs.splice(logIdx, 1);
    recomputeQtyDone(row);

    // Delete photo files (primary + extras)
    const installPhotos = [];
    if (entry.photoPath) installPhotos.push(entry.photoPath);
    if (Array.isArray(entry.extraPhotos)) entry.extraPhotos.forEach(p => { if (p) installPhotos.push(p); });
    for (const pp of installPhotos) {
      try {
        const filePath = path.resolve(__dirname, 'public', pp.replace(/^\//, ''));
        if (filePath.startsWith(path.resolve(INSTALL_LOGS_DIR)) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (unlinkErr) { console.warn('[install-log-delete] Failed to unlink photo:', pp, unlinkErr.message); }
    }

    deriveFields(project);
    writeProjects(projects);
    logActivity('install.log.deleted', { projectId: project.id, jobCode: project.jobCode, idx, logId: entry.id, deletedDelta: entry.delta, newTotal: row.qtyDone });
    res.json({ ok: true, qtyDone: row.qtyDone, status: row.status });
  } catch (e) { logError('route.delete.install-log', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Notification stubs (future email integration) ---
app.post('/api/notify/delivery-acknowledged', async (req, res) => {
  try {
    const { requestedBy, item, timeline, projectJobCode } = req.body;
    const requestorEmail = getStaffEmail(requestedBy);
    if (requestorEmail) {
      const fmName = getFactoryManagerName();
      sendEmail(requestorEmail, requestedBy,
        `[Delivery Acknowledged] ${item || 'Your delivery request'}${projectJobCode ? ' — ' + projectJobCode : ''}`,
        emailWrap(`Hi ${escHtml(requestedBy)},`,
          `<p style="margin:0 0 16px;">${escHtml(fmName)} has acknowledged your delivery request.</p>` +
          emailTable([
            ['Item', escHtml(item || '—')],
            ['Project', escHtml(projectJobCode || '—')],
            ['Expected Timeline', escHtml(timeline || 'To be confirmed')]
          ]) +
          `<p style="margin:0;">${escHtml(fmName)} will keep you updated on the delivery progress.</p>`,
          'Open Factory View', `${APP_URL}/factory`)
      ).catch(() => {});
    }
    logActivity('notify.delivery-acknowledged', { requestedBy, item, projectJobCode });
    res.json({ ok: true });
  } catch (e) { logError('route.post.notify.delivery-acknowledged', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/notify/delivery-ready', async (req, res) => {
  try {
    const { projectId, requestedBy, item, projectJobCode } = req.body;
    const requestorEmail = getStaffEmail(requestedBy);
    if (requestorEmail) {
      const fmName = getFactoryManagerName();
      await sendEmail(requestorEmail, requestedBy,
        `[Ready for Delivery] ${item || 'Your item'}${projectJobCode ? ' — ' + projectJobCode : ''}`,
        emailWrap(`Hi ${escHtml(requestedBy)},`,
          `<p style="margin:0 0 16px;">Your requested item is ready for delivery:</p>` +
          emailTable([
            ['Item', escHtml(item || '—')],
            ['Project', escHtml(projectJobCode || '—')]
          ]) +
          `<p style="margin:0;">Please coordinate delivery timing with ${escHtml(fmName)}.</p>`,
          'Open Factory View', `${APP_URL}/factory`)
      ).catch(() => {});
    }
    logActivity('notify.delivery-ready', { requestedBy, item, projectJobCode });
    res.json({ ok: true });
  } catch (e) { logError('route.post.notify.delivery-ready', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Delete document file ---
app.delete('/api/projects/:id/documents/:docIndex/file', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const docIdx = parseInt(req.params.docIndex, 10);
    const doc = (project.documents || [])[docIdx];
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Support both legacy single-file (doc.file) and new multi-file (doc.files[])
    const fileIdx = req.query.fi !== undefined ? parseInt(req.query.fi) : -1;
    let deletedFile = null;

    if (fileIdx >= 0 && Array.isArray(doc.files) && doc.files[fileIdx]) {
      // New multi-file: remove specific file from array
      deletedFile = doc.files[fileIdx].fileName;
      doc.files.splice(fileIdx, 1);
    } else if (doc.file) {
      // Legacy single-file
      deletedFile = doc.file;
      doc.file = '';
      doc.fileUrl = '';
    }

    // Delete from disk — handle both flat and per-project paths
    if (deletedFile) {
      let filePath = path.join(UPLOADS_DIR, deletedFile);
      if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).json({ error: 'Invalid file path' });
      if (!fs.existsSync(filePath)) filePath = path.join(UPLOADS_DIR, path.basename(deletedFile));
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      logActivity('document.file.deleted', { projectId: req.params.id, docIdx, fileName: deletedFile });
    }

    writeProjects(projects);
    res.json({ ok: true, deletedFile });
  } catch (e) { logError('route.delete.document-file', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Delete drawing file ---
app.delete('/api/projects/:id/drawings/:drawingIndex/file', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const drawing = (project.drawings || [])[parseInt(req.params.drawingIndex, 10)];
    if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
    if (drawing.file) {
      // Handle both flat and per-project paths
      let filePath = path.join(UPLOADS_DIR, drawing.file);
      if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).json({ error: 'Invalid file path' });
      if (!fs.existsSync(filePath)) filePath = path.join(UPLOADS_DIR, path.basename(drawing.file));
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      drawing.file = '';
    }
    writeProjects(projects);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.drawing-file', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Fabrication Status (live per-project fab status) ---
app.get('/api/fab-status', (req, res) => {
  try {
  const projects = readProjects();
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 86400000); // next 7 days
  const result = [];

  projects.filter(p => p.status !== 'Completed').forEach(p => {
    const fabItems = (p.fabrication || []).filter(f => f.totalQty > 0);
    if (!fabItems.length) return;

    const totalQty = fabItems.reduce((s, f) => s + (Number(f.totalQty) || 0), 0);
    const doneQty  = fabItems.reduce((s, f) => s + (Number(f.qtyDone)  || 0), 0);
    const fabPct   = totalQty > 0 ? Math.round(doneQty / totalQty * 100) : 0;

    const statusCounts = {};
    fabItems.forEach(f => {
      const s = f.status || 'Not Started';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });

    const hasReady   = fabItems.some(f => f.readyForDelivery && f.status !== 'Delivered');
    const hasOverdue = fabItems.some(f => f.targetDeliveryDate && new Date(f.targetDeliveryDate) < now && !f.readyForDelivery);

    // Items active this week: In Progress, QC Check, or target delivery within 7 days
    const activeItems = fabItems
      .filter(f => {
        const isActive = ['In Progress', 'QC Check', 'Ready for Delivery'].includes(f.status);
        const dueThisWeek = f.targetDeliveryDate && new Date(f.targetDeliveryDate) <= weekEnd;
        return isActive || dueThisWeek;
      })
      .map(f => {
        const daysUntil = f.targetDeliveryDate
          ? Math.round((new Date(f.targetDeliveryDate) - now) / 86400000)
          : null;
        return {
          description: f.item || f.description || '',
          status: f.status || 'Not Started',
          qtyDone: f.qtyDone || 0,
          totalQty: f.totalQty || 0,
          targetDeliveryDate: f.targetDeliveryDate || '',
          daysUntil,
          isOverdue: daysUntil !== null && daysUntil < 0 && !f.readyForDelivery,
          readyForDelivery: f.readyForDelivery || false,
        };
      });

    result.push({
      projectId: p.id,
      jobCode: p.jobCode,
      projectName: p.projectName,
      endDate: p.endDate || '',
      fabPct,
      doneQty,
      totalQty,
      statusCounts,
      hasReady,
      hasOverdue,
      itemCount: fabItems.length,
      activeItems,
    });
  });

  result.sort((a, b) => {
    if (a.hasOverdue !== b.hasOverdue) return a.hasOverdue ? -1 : 1;
    if (a.activeItems.length !== b.activeItems.length) return b.activeItems.length - a.activeItems.length;
    return a.fabPct - b.fabPct;
  });

  res.json(result);
  } catch (e) { logError('route.get.fab-status', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Delete stage file ---
app.delete('/api/projects/:id/stages/:stageIdx/file', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const stage = (project.stages || [])[parseInt(req.params.stageIdx, 10)];
    if (!stage) return res.status(404).json({ error: 'Stage not found' });
    if (stage.fileName) {
      const filePath = path.resolve(path.join(UPLOADS_DIR, path.basename(stage.fileName)));
      if (filePath.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      }
      stage.fileName = '';
    }
    writeProjects(projects);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.stage-file', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Send Outlook reminder ---
app.post('/api/remind', postRateLimit, async (req, res) => {
  const { projectId, stageNum, ownerName, ownerEmail, stageName, projectName, jobCode, daysInStatus } = req.body;
  if (!ownerEmail) return res.status(400).json({ error: 'ownerEmail required' });

  const senderEmail = process.env.SENDER_EMAIL;
  if (!senderEmail) {
    return res.status(503).json({ error: 'Outlook not configured. Set AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET, SENDER_EMAIL in .env' });
  }

  try {
    const subject = `[Action Required] ${stageName} – ${projectName}`;
    const htmlBody = emailWrap(`Hi ${escHtml(ownerName || ownerEmail)},`,
      `<p style="margin:0 0 16px;">This is a reminder that the following project stage requires your attention:</p>` +
      emailTable([
        ['Project', escHtml(projectName)],
        ['Job Code', escHtml(jobCode)],
        ['Stage', escHtml(stageName)],
        ['Days Pending', `${escHtml(String(daysInStatus))} day(s)`]
      ]),
      'Open Project', `${APP_URL}/project.html?id=${projectId}`);

    await sendEmail(ownerEmail, ownerName, subject, htmlBody);
    res.json({ ok: true, sentTo: ownerEmail });
  } catch (err) {
    logError('route.post.remind', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Default project structure ---
function buildDefaultProject(data) {
  // 20-stage template matching the real LYS project lifecycle.
  // deriveStages() auto-derives status for each from live data.
  const stages = [
    { num: 1,  name: 'Quotation',                    owner: 'Sales' },
    { num: 2,  name: 'Awarded',                      owner: 'Sales' },
    { num: 3,  name: 'Contract Review',              owner: 'GM' },
    { num: 4,  name: 'QS Breakdown',                 owner: 'QS' },
    { num: 5,  name: 'Job Code Created',             owner: 'Accounts' },
    { num: 6,  name: 'Kick-off Meeting',             owner: 'Project Manager' },
    { num: 7,  name: 'Safety Document Submission',   owner: 'Project Manager/Site Engineer' },
    { num: 8,  name: 'Drawing Submission',           owner: 'Drafter' },
    { num: 9,  name: 'Drawing Approved',             owner: 'Drafter' },
    { num: 10, name: 'SIC Submission',               owner: 'Project Manager' },
    { num: 11, name: 'Assign to Factory',            owner: 'Project Manager' },
    { num: 12, name: 'Factory Take-off',             owner: 'Factory Manager' },
    { num: 13, name: 'PR to Purchaser',              owner: 'Factory Manager' },
    { num: 14, name: 'PO Issued',                    owner: 'Purchaser' },
    { num: 15, name: 'Production / Fabrication',     owner: 'Factory Manager' },
    { num: 16, name: 'Shipping',                     owner: 'Purchaser' },
    { num: 17, name: 'Delivered',                    owner: 'Purchaser' },
    { num: 18, name: 'Site Ready',                   owner: 'Project Manager/Site Engineer' },
    { num: 19, name: 'Installation',                 owner: 'Site Engineer' },
    { num: 20, name: 'Handover',                     owner: 'Project Manager' },
  ].map(s => ({ ...s, status: 'Not Started', started: '', done: '', notes: '', statusChangedAt: null, fileName: '', refs: [] }));

  // No default documents — users create their own folder structure per project.
  const p = {
    id: data.id,
    jobCode: data.jobCode || '',
    projectName: data.projectName || '',
    product: data.product || '',
    contractValue: data.contractValue || 0,
    voValue: 0,
    client: data.client || '',
    contact: data.contact || '',
    mainCon: data.mainCon || '',
    consultant: data.consultant || '',
    startDate: data.startDate || '',
    endDate: data.endDate || '',
    projectManager: data.projectManager || '',
    qs: data.qs || '',
    factoryManager: data.factoryManager || '',
    drafter: data.drafter || '',
    purchaser: data.purchaser || '',
    sales: data.sales || '',
    siteEngineer: data.siteEngineer || '',
    status: data.status || 'On Track',
    currentStage: '',
    actionBy: '',
    fabPercent: 0,
    installPercent: 0,
    paidAmount: 0,
    latestNotes: '',
    stages,
    documents: [],
    fabrication: [],
    installation: [],
    productScope: [],
    prpo: [],
    paymentMilestones: [],
    variationOrders: [],
    defects: [],
    meetingNotes: [],
    drawings: [],
    drawingFolders: ['General'],
    scopeNotes: '',
    fabLeadTimeDays: 0,
  };

  // Run deriveFields so currentStage/actionBy are computed immediately
  deriveFields(p);
  return p;
}

module.exports = { buildDefaultProject };

function startupCheck() {
  const issues = [];

  // Check data directory exists
  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    issues.push('Created missing data/ directory');
  }

  // Check config directory exists
  if (!fs.existsSync(path.join(__dirname, 'config'))) {
    fs.mkdirSync(path.join(__dirname, 'config'), { recursive: true });
    issues.push('Created missing config/ directory');
  }

  // Check projects.json is valid
  if (fs.existsSync(DATA_FILE)) {
    try {
      safeReadJSON(DATA_FILE);
    } catch (e) {
      issues.push(`⚠️  CRITICAL: projects.json is invalid JSON — ${e.message}`);
    }
  }

  // Check admin.json exists, create if not
  if (!fs.existsSync(ADMIN_FILE)) {
    safeWriteJSON(ADMIN_FILE, { pin: '' });
    issues.push('Created missing admin.json');
  }

  // Check admin PIN is set
  try {
    const admin = safeReadJSON(ADMIN_FILE);
    if (!admin.pin) issues.push('⚠️  Admin password not set — anyone can access admin');
  } catch {}

  if (issues.length) {
    console.log('\n[LYS OPS] Startup checks:');
    issues.forEach(i => console.log(' -', i));
  } else {
    console.log('[LYS OPS] All startup checks passed ✅');
  }
}

// ── Task Routes ──────────────────────────────────────────────────────────────

// GET tasks/summary must come before /api/tasks/:id
// /api/tasks/summary removed — dead route, no frontend caller

app.get('/api/tasks', (req, res) => {
  try {
    let tasks = readTasks();
    if (req.query.assignee) tasks = tasks.filter(t => t.assignedTo === req.query.assignee);
    if (req.query.projectId) tasks = tasks.filter(t => t.projectId === req.query.projectId);
    if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
    res.json(tasks);
  } catch (e) { logError('route.get.tasks', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/tasks', postRateLimit, (req, res) => {
  try {
  const title = sanitizeStr(req.body.title, 300);
  if (!title) return res.status(400).json({ error: 'title is required' });
  const dueDate = req.body.dueDate ? sanitizeStr(req.body.dueDate, 10) : '';
  if (dueDate && !isValidDate(dueDate)) return res.status(400).json({ error: 'Invalid dueDate (YYYY-MM-DD expected)' });
  const tasks = readTasks();
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId:      sanitizeStr(req.body.projectId, 100),
    projectJobCode: sanitizeStr(req.body.projectJobCode, 50),
    projectName:    sanitizeStr(req.body.projectName, 300),
    title,
    description:    sanitizeStr(req.body.description, 2000),
    taskType:       sanitizeStr(req.body.taskType, 50) || 'Project Task',
    assignedTo:     sanitizeStr(req.body.assignedTo, 100),
    createdBy:      sanitizeStr(req.body.createdBy, 100),
    createdAt: new Date().toISOString(),
    dueDate,
    status: 'Pending',
    priority: sanitizeStr(req.body.priority, 20) || 'Normal',
    hoursLogged: [],
    completedAt: null,
    linkedMeetingNoteIdx: req.body.linkedMeetingNoteIdx || null,
    tags: req.body.tags || [],
    weekOf: getWeekStart(),
    archived: false,
    archivedAt: null
  };
  tasks.push(task);
  writeTasks(tasks);
  res.status(201).json(task);

  // Trigger 1: Send assignment email if task is assigned to someone other than the creator
  // (Self Tasks where creator === assignee don't need a "you've been assigned" notification)
  if (task.assignedTo && task.createdBy !== task.assignedTo) {
    const assignEmail = getStaffEmail(task.assignedTo);
    if (assignEmail) {
      const assignedBy   = task.createdBy && task.createdBy !== task.assignedTo ? task.createdBy : null;
      const projectLabel = task.projectJobCode || task.projectName || null;
      const dueDateLabel = task.dueDate || null;
      const priorityLabel = task.priority && task.priority !== 'Normal' ? task.priority : null;
      sendEmail(assignEmail, task.assignedTo,
        `[New Task] ${task.title}`,
        emailWrap(`Hi ${escHtml(task.assignedTo)},`,
          `<p style="margin:0 0 16px;">You have been assigned a new task:</p>` +
          emailTable([
            ['Task', escHtml(task.title)],
            projectLabel  ? ['Project', escHtml(projectLabel)] : null,
            dueDateLabel  ? ['Due Date', escHtml(dueDateLabel)] : null,
            priorityLabel ? ['Priority', escHtml(priorityLabel)] : null,
            assignedBy    ? ['Assigned By', escHtml(assignedBy)] : null
          ]),
          'View My Tasks', `${APP_URL}/my-tasks`)
      ).catch(() => {});
      logActivity('email.sent', { to: task.assignedTo, subject: 'New Task: ' + task.title });

      // Create calendar event on the assignee's Outlook calendar (if task has a due date)
      if (task.dueDate) {
        createTaskCalendarEvent(task, assignEmail, assignedBy)
          .then(result => {
            if (result && result.eventId) {
              // Atomic read-modify-write to avoid race with concurrent saves
              try {
                const latest = readTasks();
                const i = latest.findIndex(t => t.id === task.id);
                if (i !== -1) {
                  latest[i].calendarEventId = result.eventId;
                  latest[i].calendarEventOwner = result.ownerEmail;
                  writeTasks(latest);
                }
              } catch (e) { logError('calendar.task-create-update', e); }
            }
          }).catch(() => {});
      }
    } else {
      console.warn('[EMAIL SKIP] No email for:', task.assignedTo);
    }
  }
  } catch (e) { logError('route.post.tasks', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  const TASK_WRITABLE = ['title','description','taskType','category','assignedTo','requestedBy',
    'dueDate','status','priority','notes','tags','projectId','projectJobCode','projectName',
    'hoursLogged','completedAt','linkedMeetingNoteIdx','acknowledgedAt','acknowledgedBy'];
  const updates = {};
  for (const k of TASK_WRITABLE) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
  const oldAssignee = tasks[idx].assignedTo;
  const oldStatus   = tasks[idx].status;
  const oldDueDate  = tasks[idx].dueDate;
  const oldEventId  = tasks[idx].calendarEventId;
  const oldEventOwner = tasks[idx].calendarEventOwner;
  if (updates.status === 'Done' && tasks[idx].status !== 'Done') {
    updates.completedAt = new Date().toISOString();
  }
  // Reset overdueEmailSent if dueDate is updated to a future date
  if (updates.dueDate && updates.dueDate >= todaySGT()) {
    updates.overdueEmailSent = false;
  }
  tasks[idx] = { ...tasks[idx], ...updates };
  writeTasks(tasks);
  logActivity('task.updated', { id: req.params.id, title: tasks[idx].title, status: tasks[idx].status });
  res.json(tasks[idx]);

  // ── Calendar event lifecycle on update ──────────────────────────────────
  const newAssignee = tasks[idx].assignedTo;
  const newDueDate  = tasks[idx].dueDate;
  const newStatus   = tasks[idx].status;
  const assigneeChanged = updates.assignedTo && updates.assignedTo !== oldAssignee;
  const dueDateChanged  = updates.dueDate !== undefined && updates.dueDate !== oldDueDate;
  const markedDone      = updates.status === 'Done' && oldStatus !== 'Done';

  // If done → delete the event (no need for a future reminder)
  if (markedDone && oldEventId && oldEventOwner) {
    deleteTaskCalendarEvent(oldEventOwner, oldEventId).catch(() => {});
    // Clear event fields atomically
    try {
      const refresh = readTasks();
      const j = refresh.findIndex(t => t.id === req.params.id);
      if (j !== -1) {
        refresh[j].calendarEventId = null;
        refresh[j].calendarEventOwner = null;
        writeTasks(refresh);
      }
    } catch (e) { logError('calendar.task-done-clear', e); }
  } else if ((assigneeChanged || dueDateChanged) && !markedDone) {
    // Delete old event (if any) and create a new one for the (possibly new) assignee.
    if (oldEventId && oldEventOwner) {
      deleteTaskCalendarEvent(oldEventOwner, oldEventId).catch(() => {});
    }
    if (newDueDate && newAssignee) {
      const assigneeEmail = getStaffEmail(newAssignee);
      if (assigneeEmail) {
        const assignedByName = tasks[idx].createdBy && tasks[idx].createdBy !== newAssignee ? tasks[idx].createdBy : null;
        createTaskCalendarEvent(tasks[idx], assigneeEmail, assignedByName)
          .then(result => {
            if (result && result.eventId) {
              try {
                const refresh = readTasks();
                const j = refresh.findIndex(t => t.id === req.params.id);
                if (j !== -1) {
                  refresh[j].calendarEventId = result.eventId;
                  refresh[j].calendarEventOwner = result.ownerEmail;
                  writeTasks(refresh);
                }
              } catch (e) { logError('calendar.task-update-event', e); }
            }
          }).catch(() => {});
      }
    }
  }

  // Trigger 1: Send assignment email if assignee changed to a new person
  if (updates.assignedTo && updates.assignedTo !== oldAssignee) {
    const newTask = tasks[idx];
    const assignEmail = getStaffEmail(updates.assignedTo);
    if (assignEmail) {
      const assignedBy   = newTask.createdBy && newTask.createdBy !== updates.assignedTo ? newTask.createdBy : null;
      const projectLabel = newTask.projectJobCode || newTask.projectName || null;
      const dueDateLabel = newTask.dueDate || null;
      sendEmail(assignEmail, updates.assignedTo,
        `[New Task] ${newTask.title}`,
        emailWrap(`Hi ${escHtml(updates.assignedTo)},`,
          `<p style="margin:0 0 16px;">You have been assigned a task:</p>` +
          emailTable([
            ['Task', escHtml(newTask.title)],
            projectLabel ? ['Project', escHtml(projectLabel)] : null,
            dueDateLabel ? ['Due Date', escHtml(dueDateLabel)] : null,
            assignedBy   ? ['Assigned By', escHtml(assignedBy)] : null
          ]),
          'View My Tasks', `${APP_URL}/my-tasks`)
      ).catch(() => {});
    } else {
      console.warn('[EMAIL SKIP] No email for:', updates.assignedTo);
    }
  }
  // Trigger 3: email requestedBy when task status changes
  if (updates.status && updates.status !== oldStatus && tasks[idx].requestedBy) {
    const changedTask = tasks[idx];
    const rbEmail = getStaffEmail(changedTask.requestedBy);
    if (rbEmail) {
      sendEmail(rbEmail, changedTask.requestedBy,
        `[Task Update] ${changedTask.title} — ${updates.status}`,
        emailWrap(`Hi ${escHtml(changedTask.requestedBy)},`,
          `<p style="margin:0 0 16px;">A task you requested has been updated:</p>` +
          emailTable([
            ['Task', escHtml(changedTask.title)],
            ['New Status', escHtml(updates.status)],
            ['Assigned To', escHtml(changedTask.assignedTo || '—')]
          ]),
          'View Tasks', `${APP_URL}/my-tasks`)
      ).catch(() => {});
    } else {
      console.warn('[EMAIL SKIP] No email for:', changedTask.requestedBy);
    }
  }
  } catch (e) { logError('route.put.tasks', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/tasks/:id/acknowledge — mark task as acknowledged by assignee
app.post('/api/tasks/:id/acknowledge', (req, res) => {
  try {
    const tasks = readTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    const now = new Date().toISOString();
    tasks[idx].acknowledgedAt = now;
    tasks[idx].acknowledgedBy = req.body.name || tasks[idx].assignedTo || '';
    // Mark-as-seen does NOT change status — the task stays Pending until
    // the assignee explicitly marks it Done. The "In Progress" middle
    // state was removed so staff are forced through this seen step.
    writeTasks(tasks);
    logActivity('task.acknowledged', { id: req.params.id, title: tasks[idx].title, by: tasks[idx].acknowledgedBy });
    res.json(tasks[idx]);
    // Trigger 2: email requestedBy that task was acknowledged
    const task = tasks[idx];
    if (task.requestedBy) {
      const rbEmail = getStaffEmail(task.requestedBy);
      if (rbEmail) {
        sendEmail(rbEmail, task.requestedBy,
          `[Task Seen] ${task.title}`,
          emailWrap(`Hi ${escHtml(task.requestedBy)},`,
            `<p style="margin:0 0 16px;"><strong>${escHtml(task.acknowledgedBy)}</strong> has marked your request as seen.</p>` +
            emailTable([
              ['Task', escHtml(task.title)],
              ['Assigned To', escHtml(task.assignedTo || '—')]
            ]),
            'View Tasks', `${APP_URL}/my-tasks`)
        ).catch(() => {});
      } else {
        console.warn('[EMAIL SKIP] No email for:', task.requestedBy);
      }
    }
  } catch (e) { logError('route.post.tasks.acknowledge', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/remind-eod — send EOD reminder email to a staff member
app.post('/api/remind-eod', async (req, res) => {
  try {
    const { staffName } = req.body;
    if (!staffName) return res.status(400).json({ error: 'staffName required' });
    const email = getStaffEmail(staffName);
    if (!email) return res.status(404).json({ error: 'Staff email not found' });
    await sendEmail(email, staffName,
      '[Reminder] Please submit your EOD log',
      emailWrap(`Hi ${escHtml(staffName)},`,
        `<p style="margin:0;">This is a reminder to submit your end-of-day log.</p>`,
        'Submit EOD Log', APP_URL)
    );
    res.json({ ok: true });
  } catch (e) { logError('route.post.remind-eod', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/tasks/:id/hours', (req, res) => {
  try {
    const tasks = readTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    const entry = {
      date: req.body.date || todaySGT(),
      hours: parseFloat(req.body.hours) || 0,
      note: req.body.note || '',
      loggedBy: req.body.loggedBy || '',
      loggedAt: new Date().toISOString()
    };
    if (!Array.isArray(tasks[idx].hoursLogged)) tasks[idx].hoursLogged = [];
    tasks[idx].hoursLogged.push(entry);
    writeTasks(tasks);
    logActivity('task.hours.logged', { id: req.params.id, hours: entry.hours });
    res.json(tasks[idx]);
  } catch (e) { logError('route.post.tasks.hours', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    let tasks = readTasks();
    const gone = tasks.find(t => t.id === req.params.id);
    if (!gone) return res.status(404).json({ error: 'Task not found' });
    tasks = tasks.filter(t => t.id !== req.params.id);
    writeTasks(tasks);
    logActivity('task.deleted', { id: req.params.id, title: gone.title });
    res.json({ ok: true });
    // Clean up the matching calendar event if one was created.
    if (gone && gone.calendarEventId && gone.calendarEventOwner) {
      deleteTaskCalendarEvent(gone.calendarEventOwner, gone.calendarEventId).catch(() => {});
    }
  } catch (e) { logError('route.delete.tasks', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Kanban — tasks grouped by staff ──────────────────────────────────────────
app.get('/api/tasks/kanban', (req, res) => {
  try {
    const tasks = readTasks().filter(t => !t.archived);
    const allNames = getStaffNames();
    const result = {};
    allNames.forEach(name => {
      result[name] = {
        pending:    tasks.filter(t => t.assignedTo === name && t.status === 'Pending'),
        inProgress: tasks.filter(t => t.assignedTo === name && t.status === 'In Progress'),
        done:       tasks.filter(t => t.assignedTo === name && t.status === 'Done')
      };
    });
    res.json(result);
  } catch (e) { logError('route.get.tasks.kanban', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── EOD log ───────────────────────────────────────────────────────────────────
app.post('/api/eod-log', postRateLimit, (req, res) => {
  try {
  const staffName   = sanitizeStr(req.body.staffName, 100);
  if (!staffName) return res.status(400).json({ error: 'staffName required' });
  const date        = req.body.date ? sanitizeStr(req.body.date, 10) : '';
  const hours       = parseFloat(req.body.hours || req.body.totalHours) || 0;
  const summary     = sanitizeStr(req.body.summary || req.body.notes || '', 2000);
  const issues      = sanitizeStr(req.body.issues || '', 2000);
  const notes       = sanitizeStr(req.body.notes || req.body.summary || '', 2000);
  const taskEntries = Array.isArray(req.body.taskEntries) ? req.body.taskEntries : [];
  if (date && !isValidDate(date)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD expected)' });
  const logs = readEOD();
  const logDate = date || todaySGT();
  const log = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    staffName,
    date: logDate,
    submittedAt: new Date().toISOString(),
    totalHours: hours,
    hours,
    notes: notes || '',
    summary: summary || '',
    issues: issues || '',
    taskEntries: taskEntries || []
  };
  // Duplicate guard: replace existing entry for same staff + date
  const existingIdx = logs.findIndex(l => l.staffName === staffName && l.date === logDate);
  if (existingIdx !== -1) {
    logs[existingIdx] = log;
  } else {
    logs.push(log);
  }
  safeWriteJSON(EOD_FILE, logs);

  // Update tasks — log hours + mark done if flagged
  const tasks = readTasks();
  (taskEntries || []).forEach(entry => {
    const idx = tasks.findIndex(t => t.id === entry.taskId);
    if (idx === -1) return;
    if (entry.hours > 0) {
      if (!Array.isArray(tasks[idx].hoursLogged)) tasks[idx].hoursLogged = [];
      tasks[idx].hoursLogged.push({
        date: log.date,
        hours: parseFloat(entry.hours) || 0,
        note: sanitizeStr(entry.note || '', 500) || notes || '',
        loggedBy: staffName,
        loggedAt: log.submittedAt
      });
    }
    if (entry.markDone) {
      tasks[idx].status = 'Done';
      tasks[idx].completedAt = log.submittedAt;
    }
  });
  writeTasks(tasks);
  res.json({ ok: true, log });
  } catch (e) { logError('route.post.eod-log', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// ── Claims (SOP Act pipeline) ─────────────────────────────────────────────────
function readClaims() {
  if (!fs.existsSync(CLAIMS_FILE)) safeWriteJSON(CLAIMS_FILE, []);
  return safeReadJSON(CLAIMS_FILE);
}
function writeClaims(c) {
  safeWriteJSON(CLAIMS_FILE, c);
}

// GET summary (before /:id so it matches first)
app.get('/api/claims/summary', (req, res) => {
  try {
    const claims = readClaims();
    const today = todaySGT();
    const outstanding = claims
      .filter(c => c.status !== 'Paid')
      .reduce((s, c) => s + (c.certifiedAmount || c.claimAmount || 0), 0);
    const overdue = claims.filter(c =>
      c.status !== 'Paid' && c.status !== 'Disputed' &&
      ((c.status === 'Awaiting Certification' && c.certificationDue && c.certificationDue < today) ||
       (c.status === 'Invoiced' && c.paymentDue && c.paymentDue < today))
    );
    res.json({
      total: claims.length,
      outstanding,
      overdue: overdue.length,
      byStatus: {
        awaitingCert: claims.filter(c => c.status === 'Awaiting Certification').length,
        certified:    claims.filter(c => c.status === 'Certified').length,
        invoiced:     claims.filter(c => c.status === 'Invoiced').length,
        paid:         claims.filter(c => c.status === 'Paid').length,
        disputed:     claims.filter(c => c.status === 'Disputed').length,
      }
    });
  } catch (e) { logError('route.get.claims.summary', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET all / filter by projectId
app.get('/api/claims', (req, res) => {
  try {
    let claims = readClaims();
    if (req.query.projectId) claims = claims.filter(c => c.projectId === req.query.projectId);
    res.json(claims);
  } catch (e) { logError('route.get.claims', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/projects/:id/install-progress — install logs grouped by item for QS claim evidence
app.get('/api/projects/:id/install-progress', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const installation = project.installation || [];
    const claims = readClaims().filter(c => c.projectId === project.id);

    // Build per-item progress summary with all logs
    const items = installation.map((row, idx) => {
      const logs = Array.isArray(row.logs) ? row.logs : [];
      const totalQty = parseFloat(row.totalQty) || 0;
      const qtyDone  = parseFloat(row.qtyDone)  || 0;

      // Group logs by step (if steps defined)
      const stepProgress = {};
      if (Array.isArray(row.installSteps) && row.installSteps.length) {
        row.installSteps.forEach(s => { stepProgress[s] = 0; });
        logs.forEach(l => {
          const s = l.step || 'Install';
          stepProgress[s] = (stepProgress[s] || 0) + (parseFloat(l.delta) || 0);
        });
      }

      return {
        idx,
        item: row.item || row.description || '',
        totalQty,
        qtyDone,
        pct: totalQty > 0 ? Math.round(qtyDone / totalQty * 100) : 0,
        status: row.status || 'Not Started',
        installSteps: row.installSteps || [],
        stepProgress,
        logs: logs.map(l => ({
          id: l.id, delta: l.delta, step: l.step || '',
          photoPath: l.photoPath || '', location: l.location || '',
          note: l.note || '', loggedBy: l.loggedBy || '', loggedAt: l.loggedAt || ''
        }))
      };
    });

    // Summary: total claimed so far for this project
    const totalClaimed = claims.reduce((s, c) => s + (parseFloat(c.claimAmount) || 0), 0);

    res.json({
      projectId: project.id,
      jobCode: project.jobCode || '',
      projectName: project.projectName || '',
      contractValue: parseFloat(project.contractValue) || 0,
      totalClaimed,
      installPercent: project.installPercent || 0,
      items,
      claims: claims.map(c => ({
        id: c.id, claimNumber: c.claimNumber, claimAmount: c.claimAmount,
        status: c.status, submittedDate: c.submittedDate, installLogIds: c.installLogIds || []
      }))
    });
  } catch (e) { logError('route.get.install-progress', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST create
app.post('/api/claims', postRateLimit, (req, res) => {
  try {
    const claims = readClaims();
    const b = req.body;
    const submittedStr = b.submittedDate && isValidDate(b.submittedDate) ? b.submittedDate : todaySGT();
    const submitted = new Date(submittedStr + 'T00:00:00');
    const certDue = new Date(submitted); certDue.setDate(certDue.getDate() + 21);
    const certDueStr = certDue.getFullYear() + '-' + String(certDue.getMonth() + 1).padStart(2, '0') + '-' + String(certDue.getDate()).padStart(2, '0');
    const claim = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      projectId:            b.projectId || '',
      projectJobCode:       b.projectJobCode || '',
      projectName:          b.projectName || '',
      claimNumber:          b.claimNumber || 'PC#1',
      description:          b.description || '',
      claimAmount:          parseFloat(b.claimAmount) || 0,
      submittedDate:        b.submittedDate || todaySGT(),
      submittedBy:          b.submittedBy || '',
      certificationDue:     certDueStr,
      certifiedDate:        null,
      certifiedAmount:      null,
      invoiceNumber:        b.invoiceNumber || null,
      invoiceRaisedDate:    null,
      paymentDue:           null,
      paymentReceivedDate:  null,
      paymentReceivedAmount:null,
      status:               'Awaiting Certification',
      notes:                b.notes || '',
      installLogIds:        Array.isArray(b.installLogIds) ? b.installLogIds : [],
      claimItems:           Array.isArray(b.claimItems) ? b.claimItems.map(ci => ({
        item: String(ci.item || '').slice(0, 200),
        qty: parseFloat(ci.qty) || 0,
        step: String(ci.step || '').slice(0, 100),
      })) : [],
      createdAt:            new Date().toISOString()
    };
    claims.push(claim);
    writeClaims(claims);
    logActivity('claim.created', { id: claim.id, projectId: claim.projectId, claimNumber: claim.claimNumber, amount: claim.claimAmount });
    res.status(201).json(claim);
  } catch (e) { logError('route.post.claims', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT update
app.put('/api/claims/:id', postRateLimit, (req, res) => {
  try {
    const claims = readClaims();
    const idx = claims.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const CLAIM_WRITABLE = ['claimNumber','description','claimAmount','submittedDate','submittedBy',
      'certifiedDate','certifiedAmount','invoiceNumber','invoiceRaisedDate','paymentDue',
      'paymentReceivedDate','paymentReceivedAmount','status','notes','installLogIds','claimItems'];
    const b = {};
    for (const k of CLAIM_WRITABLE) { if (req.body[k] !== undefined) b[k] = req.body[k]; }
    if (b.certifiedDate && !claims[idx].certifiedDate) {
      const certDate = new Date(b.certifiedDate);
      const payDue = new Date(certDate); payDue.setDate(payDue.getDate() + 35);
      b.paymentDue = payDue.getFullYear() + '-' + String(payDue.getMonth() + 1).padStart(2, '0') + '-' + String(payDue.getDate()).padStart(2, '0');
      if (!b.status) b.status = 'Certified';
    }
    if (b.invoiceRaisedDate && !claims[idx].invoiceRaisedDate && !b.status) b.status = 'Invoiced';
    if (b.paymentReceivedDate && !claims[idx].paymentReceivedDate) b.status = 'Paid';
    claims[idx] = { ...claims[idx], ...b };
    writeClaims(claims);
    logActivity('claim.updated', { id: claims[idx].id, claimNumber: claims[idx].claimNumber, status: claims[idx].status });
    res.json(claims[idx]);
  } catch (e) { logError('route.put.claims', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE
app.delete('/api/claims/:id', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    let claims = readClaims();
    const removed = claims.find(c => c.id === req.params.id);
    if (!removed) return res.status(404).json({ error: 'Claim not found' });
    claims = claims.filter(c => c.id !== req.params.id);
    writeClaims(claims);
    logActivity('claim.deleted', { id: removed.id, claimNumber: removed.claimNumber, projectId: removed.projectId });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.claims', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/eod-log', (req, res) => {
  try {
  const logs = readEOD();
  const date = req.query.date || todaySGT();
  // When staffName is provided, return just that person's logs for that date as an array
  if (req.query.staffName) {
    const staffName = sanitizeStr(req.query.staffName, 100);
    return res.json(logs.filter(l => l.date === date && l.staffName === staffName));
  }
  const allStaff = getStaffNames().filter(n => n !== getBossName());
  const todayLogs = logs.filter(l => l.date === date);
  const submitted = todayLogs.map(l => l.staffName);
  const missing = allStaff.filter(s => !submitted.includes(s));
  res.json({ date, submitted, missing, logs: todayLogs });
  } catch (e) { logError('route.get.eod-log', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Archive ───────────────────────────────────────────────────────────────────
app.post('/api/tasks/archive-week', (req, res) => {
  try {
    const tasks = readTasks();
    const currentWeek = getWeekStart();
    let count = 0;
    tasks.forEach(t => {
      if (!t.archived && t.status === 'Done' && t.weekOf && t.weekOf < currentWeek) {
        t.archived = true;
        t.archivedAt = new Date().toISOString();
        count++;
      }
    });
    writeTasks(tasks);
    res.json({ ok: true, archived: count });
  } catch (e) { logError('route.post.tasks.archive-week', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Completion history ────────────────────────────────────────────────────────
app.get('/api/tasks/history', (req, res) => {
  try {
    const { staffName, period } = req.query;
    const tasks = readTasks().filter(t => t.status === 'Done');
    const now = new Date();
    const today = todaySGT();
    const weekStart  = getWeekStart();
    const sgtNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
    const monthStart = sgtNow.getFullYear() + '-' + String(sgtNow.getMonth() + 1).padStart(2, '0') + '-01';

    let filtered = staffName ? tasks.filter(t => t.assignedTo === staffName) : tasks;
    if (period === 'today')
      filtered = filtered.filter(t => t.completedAt && t.completedAt.startsWith(today));
    else if (period === 'week')
      filtered = filtered.filter(t => t.completedAt && t.completedAt.split('T')[0] >= weekStart);
    else if (period === 'month')
      filtered = filtered.filter(t => t.completedAt && t.completedAt.split('T')[0] >= monthStart);

    filtered.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
    res.json(filtered);
  } catch (e) { logError('route.get.tasks.history', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────

// Heartbeat: each cron writes its last-run timestamp so /health can flag stale ones
const HEARTBEAT_FILE = path.join(__dirname, 'data', 'cron-heartbeat.json');
function cronHeartbeat(name) {
  try {
    const hb = fs.existsSync(HEARTBEAT_FILE) ? safeReadJSON(HEARTBEAT_FILE) : {};
    hb[name] = new Date().toISOString();
    safeWriteJSON(HEARTBEAT_FILE, hb);
  } catch {}
}

// Monthly log rotation — 1st of each month at midnight
cron.schedule('0 0 1 * *', () => {
  try {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const suffix = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`; // previous month
    const ACTIVITY_LOG_FILE_PATH = path.join(__dirname, 'data', 'activity.log');
    const ERRORS_LOG_FILE_PATH   = path.join(__dirname, 'data', 'errors.log');
    [ACTIVITY_LOG_FILE_PATH, ERRORS_LOG_FILE_PATH].forEach(logFile => {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (stat.size < 50000) return; // don't bother rotating tiny files
      const archive = logFile.replace('.log', `-${suffix}.log`);
      fs.copyFileSync(logFile, archive);
      fs.writeFileSync(logFile, ''); // truncate
      console.log(`[CRON] Rotated ${path.basename(logFile)} → ${path.basename(archive)} (${Math.round(stat.size/1024)}KB)`);
    });
    cronHeartbeat('log-rotation');
  } catch (e) { logError('cron.log-rotation', e); }
}, { timezone: 'Asia/Singapore' });

// 9am weekdays — consolidated checks (sequential to prevent concurrent read/write to tasks.json)
cron.schedule('0 9 * * 1-5', async () => {
  cronHeartbeat('9am-checks');
  try {
  const today = todaySGT();
  const now = new Date();

  // ── Check 1: Overdue task emails ───────────────────────────────────────────
  console.log('[CRON] 9am overdue task check...');
  const tasks = readTasks();
  const overdue = tasks.filter(t =>
    t.status !== 'Done' && t.dueDate && t.dueDate < today && !t.overdueEmailSent
  );
  for (const task of overdue) {
    const assigneeEmail = getStaffEmail(task.assignedTo);
    if (assigneeEmail) {
      await sendEmail(assigneeEmail, task.assignedTo,
        `[Overdue] ${task.title} — ${task.projectJobCode || 'General Task'}`,
        emailWrap(`Hi ${escHtml(task.assignedTo)},`,
          `<p style="margin:0 0 16px;">You have an overdue task:</p>` +
          emailTable([
            ['Task', escHtml(task.title)],
            ['Due Date', escHtml(task.dueDate)],
            ['Project', escHtml(task.projectJobCode || 'N/A')]
          ]),
          'View My Tasks', `${APP_URL}/my-tasks`)
      );
      task.overdueEmailSent = true;
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.warn('[EMAIL SKIP] No email for:', task.assignedTo);
    }
  }
  writeTasks(tasks);
  console.log(`[CRON] Overdue task emails sent: ${overdue.length}`);

  // ── Check 2: SOP claims deadline alerts ───────────────────────────────────
  // Spec: fire 1 week and 3 days before certificationDue, plus on the day
  // the deadline passes. Primary recipient is the QS assigned to the project
  // (projects.qs — either Salve or Alex Mac). CC only the boss so leadership
  // has visibility — Alex Chew is finance/invoices, not certification, so
  // she is NOT on this CC list.
  console.log('[CRON] 9am SOP claims deadline check...');
  const claims = readClaims();
  const projectsForClaims = readProjects();
  const projById = {};
  projectsForClaims.forEach(p => { projById[p.id] = p; });
  const in7days = dateSGT(7);
  const in3days = dateSGT(3);
  const bossEmail = getBossEmail() || process.env.SENDER_EMAIL;
  let claimsChanged = false;
  for (const claim of claims) {
    if (claim.status !== 'Awaiting Certification' || !claim.certificationDue) continue;
    // Per-project QS — fall back to claim.submittedBy if project has no QS assigned.
    const project = projById[claim.projectId];
    const qsName  = (project && project.qs) || claim.submittedBy || '';
    const qsEmail = qsName ? getStaffEmail(qsName) : null;
    if (!qsEmail) { console.warn('[CLAIM CRON] No QS email for claim', claim.claimNumber, 'project', claim.projectJobCode); continue; }
    const qsCc = [bossEmail].filter(Boolean);
    const money = `$${Number(claim.claimAmount || 0).toLocaleString()}`;
    const projLabel = `${claim.projectJobCode || ''} ${claim.claimNumber}`.trim();

    // 1-week-before reminder (once)
    if (claim.certificationDue === in7days && !claim.cert7DayEmailSent) {
      await sendEmail(qsEmail, qsName,
        `[SOP Alert] Certification due in 1 week — ${projLabel}`,
        emailWrap(`Hi ${escHtml(qsName)},`,
          `<p style="margin:0 0 16px;">Progress claim <strong>${escHtml(claim.claimNumber)}</strong> for <strong>${escHtml(claim.projectJobCode || '')}</strong> is due for certification in 1 week (${escHtml(claim.certificationDue)}).</p>` +
          emailTable([['Amount', money]]) +
          emailWarnBox('Please check with the client and chase early if needed.'),
          'Open OPS Tracker', APP_URL),
        qsCc
      );
      claim.cert7DayEmailSent = true;
      claimsChanged = true;
    }

    // 3-days-before reminder (once)
    if (claim.certificationDue === in3days && !claim.cert3DayEmailSent) {
      await sendEmail(qsEmail, qsName,
        `[SOP Alert] Certification due in 3 days — ${projLabel}`,
        emailWrap(`Hi ${escHtml(qsName)},`,
          `<p style="margin:0 0 16px;">Progress claim <strong>${escHtml(claim.claimNumber)}</strong> for <strong>${escHtml(claim.projectJobCode || '')}</strong> certification is due in 3 days (${escHtml(claim.certificationDue)}).</p>` +
          emailTable([['Amount', money]]) +
          emailWarnBox('If client has not responded, please chase now.'),
          'Open OPS Tracker', APP_URL),
        qsCc
      );
      claim.cert3DayEmailSent = true;
      claimsChanged = true;
    }

    // Deadline passed (once)
    if (claim.certificationDue < today && !claim.certOverdueEmailSent) {
      await sendEmail(qsEmail, qsName,
        `[URGENT] SOP Deadline Passed — ${projLabel}`,
        emailWrap(`Hi ${escHtml(qsName)},`,
          `<p style="margin:0 0 16px;">The SOP Act certification deadline has passed for <strong>${escHtml(claim.claimNumber)}</strong> on ${escHtml(claim.projectJobCode || '')}.</p>` +
          emailTable([['Amount at risk', money]]) +
          emailUrgentBox('Consider issuing a Payment Response Notice under SOP Act.'),
          'Open OPS Tracker', APP_URL),
        qsCc
      );
      claim.certOverdueEmailSent = true;
      claimsChanged = true;
    }
  }
  if (claimsChanged) writeClaims(claims);
  console.log('[CRON] SOP claims check done');

  // ── Check 3: Unacknowledged task reminders ────────────────────────────────
  // Two-step escalation: Day 1 = gentle reminder to assignee (CC requester).
  // Day 3 = final flag to assignee + boss CC'd. After that we stop.
  console.log('[CRON] 9am unacknowledged task reminder check...');
  const ACK_REMINDER_DAYS = [1, 3]; // send reminders on day 1 and day 3
  const allTasks = readTasks();
  const dayMs = 24 * 60 * 60 * 1000;
  let tasksChanged = false;
  for (const task of allTasks) {
    if (!task.assignedTo || task.acknowledgedAt || task.status === 'Done') continue;
    if (!task.createdAt) continue;
    const ageMs = now - new Date(task.createdAt).getTime();
    const ageDays = ageMs / dayMs;
    const sentSoFar = task.ackReminderCount || 0;
    if (sentSoFar >= ACK_REMINDER_DAYS.length) continue; // ladder exhausted
    const nextDay = ACK_REMINDER_DAYS[sentSoFar];
    if (ageDays < nextDay) continue; // not time yet
    // Don't send more than once per 20h (prevents double-sends on restart)
    if (task.ackReminderSentAt && (now - new Date(task.ackReminderSentAt).getTime()) < 20 * 60 * 60 * 1000) continue;
    const assigneeEmail = getStaffEmail(task.assignedTo);
    if (!assigneeEmail) { console.warn('[EMAIL SKIP] No email for:', task.assignedTo); continue; }
    const reminderNum = sentSoFar + 1;
    const isFinal = reminderNum === ACK_REMINDER_DAYS.length;
    const ccEmails = [];
    if (task.requestedBy) {
      const rbEmail = getStaffEmail(task.requestedBy);
      if (rbEmail) ccEmails.push(rbEmail);
    }
    if (isFinal) {
      const bossEmail = getBossEmail() || process.env.SENDER_EMAIL;
      if (bossEmail) ccEmails.push(bossEmail);
    }
    try {
      const subject = isFinal
        ? `[FINAL FLAG] Still unacknowledged after 3 days: ${task.title}`
        : `[Reminder] Please acknowledge: ${task.title}`;
      const htmlBody = isFinal
        ? emailWrap(`Hi ${escHtml(task.assignedTo)},`,
          emailUrgentBox(`This task has been sitting unacknowledged for <strong>3 days</strong>. The boss has been CC'd — please acknowledge or raise any blockers now.`) +
          emailTable([['Task', escHtml(task.title)]]) +
          `<p style="margin:8px 0 0;font-size:12px;color:#888;">Final reminder — no further nags will be sent.</p>`,
          'View My Tasks', `${APP_URL}/my-tasks`)
        : emailWrap(`Hi ${escHtml(task.assignedTo)},`,
          `<p style="margin:0 0 16px;">You have an unacknowledged task assigned to you:</p>` +
          emailTable([['Task', escHtml(task.title)]]) +
          `<p style="margin:0;">Please acknowledge this task so the requester knows you have received it.</p>`,
          'View My Tasks', `${APP_URL}/my-tasks`);
      await sendEmail(assigneeEmail, task.assignedTo, subject, htmlBody, ccEmails);
      console.log(`[CRON] Ack reminder ${reminderNum}/${ACK_REMINDER_DAYS.length}${isFinal ? ' (BOSS FLAG)' : ''} → ${assigneeEmail} for task: ${task.title}`);
      task.ackReminderSentAt = now.toISOString();
      task.ackReminderCount = reminderNum;
      if (isFinal) task.ackBossFlaggedAt = now.toISOString();
      tasksChanged = true;
    } catch (e) {
      console.error(`[CRON] Ack reminder failed for task ${task.id}:`, e.message);
    }
  }
  if (tasksChanged) writeTasks(allTasks);
  console.log('[CRON] Unacknowledged task reminder check done');

  // ── Check 4: Yesterday's missing EOD — re-alert boss ─────────────────────
  // At 6:30pm yesterday we wrote a flag file listing anyone who hadn't
  // submitted. If that flag still has names AND those people still haven't
  // caught up overnight, ping the boss again at 9am.
  console.log('[CRON] 9am yesterday EOD re-check...');
  try {
    const yesterday = dateSGT(-1);
    const yDate = new Date(yesterday + 'T00:00:00');
    const yDay = yDate.getDay(); // 0=Sun, 6=Sat — skip weekends (no EOD expected)
    if (yDay !== 0 && yDay !== 6) {
      const history = readEODHistory();
      const histEntry = history.find(h => h.date === yesterday);
      if (histEntry && Array.isArray(histEntry.missing) && histEntry.missing.length) {
        // Recheck: did anyone submit overnight? Remove them from the list.
        const logs = readEOD();
        const submittedYesterday = logs.filter(l => l.date === yesterday).map(l => l.staffName);
        const stillMissing = histEntry.missing.filter(n => !submittedYesterday.includes(n));
        if (stillMissing.length) {
          const laiEmail = process.env.SENDER_EMAIL;
          if (laiEmail) {
            await sendEmail(laiEmail, getBossName(),
              `[EOD Alert] Still missing from yesterday (${yesterday}): ${stillMissing.length} staff`,
              emailWrap(null,
                `<p style="margin:0 0 16px;">The following staff have <strong>still not submitted</strong> their EOD log for yesterday (${yesterday}):</p>` +
                `<ul style="margin:0 0 16px;padding-left:20px;">${stillMissing.map(n => `<li><strong>${escHtml(n)}</strong></li>`).join('')}</ul>` +
                emailWarnBox('6:30pm flag was sent yesterday. They have not caught up overnight.'),
                'View Tasks Dashboard', `${APP_URL}/tasks`)
            );
            console.log(`[CRON] 9am next-day EOD re-alert sent to boss: ${stillMissing.join(', ')}`);
          }
          // Update history entry to reflect overnight submissions
          histEntry.stillMissingAt9am = stillMissing;
          safeWriteJSON(EOD_HISTORY_FILE, history);
        } else {
          console.log('[CRON] 9am next-day EOD re-check: everyone caught up overnight');
        }
      } else {
        console.log('[CRON] 9am next-day EOD re-check: no missing from yesterday');
      }
    }
  } catch (e) { logError('cron.9am-eod-recheck', e); }

  // ── Check 5: Installation just hit 100% — note for the project's QS ──────
  // NOT a claim-submission trigger — claims are time/phase-bound, not %-bound.
  // This is a heads-up task so the assigned QS is aware the install is done
  // and can factor it into the next monthly claim planning.
  console.log('[CRON] 9am install-complete QS notes...');
  try {
    const projectsForNotes = readProjects().map(p => deriveFields(p));
    let projectsChanged = false;
    const noteTasks = readTasks();
    let createdNotes = 0;
    for (const p of projectsForNotes) {
      if (p.status === 'Completed') continue;
      if ((p.installPercent || 0) < 100) continue;
      if (p.installCompleteTaskCreated) continue; // already flagged
      const qsName = p.qs;
      if (!qsName) {
        console.warn('[CRON install-note] No QS on project', p.jobCode || p.id);
        continue;
      }
      noteTasks.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
        projectId:      p.id,
        projectJobCode: p.jobCode || '',
        projectName:    p.projectName || '',
        title:          `Installation complete on ${p.jobCode || p.projectName} — note for claim planning`,
        description:    `Install just hit 100% for ${p.projectName}. This is a heads-up, not an immediate claim trigger — factor into your next monthly claim cycle.`,
        taskType:       'Recurring', // shows under Mandatory section on the team page
        category:       'Reporting',
        assignedTo:     qsName,
        requestedBy:    'System',
        createdBy:      'System',
        createdAt:      new Date().toISOString(),
        dueDate:        today,
        status:         'Pending',
        priority:       'Normal',
        hoursLogged:    [],
        completedAt:    null,
        tags:           ['install-complete-note'],
        weekOf:         getWeekStart(),
        archived:       false,
        archivedAt:     null,
      });
      createdNotes++;
    }
    if (createdNotes > 0) {
      writeTasks(noteTasks);
      // Flag projects in a single read-write pass (not inside the loop)
      const masterList = readProjects();
      for (const p of projectsForNotes) {
        if ((p.installPercent || 0) >= 100 && !p.installCompleteTaskCreated) {
          const mi = masterList.findIndex(x => x.id === p.id);
          if (mi !== -1) {
            masterList[mi].installCompleteTaskCreated = true;
            masterList[mi].installCompleteTaskAt = new Date().toISOString();
          }
        }
      }
      writeProjects(masterList);
      console.log(`[CRON] Created ${createdNotes} install-complete note task(s) for QS`);
      logActivity('install-complete-notes.created', { count: createdNotes });
    } else {
      console.log('[CRON] No new install-complete notes needed');
    }
  } catch (e) { logError('cron.9am-install-complete-notes', e); }

  // ── Check 6: DLP expiry reminders ─────────────────────────────────────────
  // Email boss + finance when a project's DLP is expiring within 30 days.
  // Also flags already-expired DLP with unreleased retention.
  try {
    console.log('[CRON] 9am DLP expiry check...');
    const allProjects = readProjects();
    const dlpProjects = allProjects.map(p => deriveFields(p)).filter(p => p.lifecycle === 'dlp');
    const today = todaySGT();
    const in30d = dateSGT(30);
    let dlpDirty = false;
    for (const p of dlpProjects) {
      if (!p.dlpEndDate) continue;
      // Only alert if DLP ends within 30 days or already expired
      if (p.dlpEndDate > in30d) continue;
      // Don't nag more than once per week
      if (p._dlpReminderSentAt && (Date.now() - new Date(p._dlpReminderSentAt).getTime()) < 7 * 86400000) continue;

      const expired = p.dlpEndDate <= today;
      const bossEmail = getBossEmail();
      const bossName = getBossName();
      if (!bossEmail) continue;

      const subject = expired
        ? `[DLP EXPIRED] ${p.jobCode} — Retention claimable`
        : `[DLP Expiring] ${p.jobCode} — ${p.dlpEndDate}`;
      const body = emailWrap(null,
        (expired
          ? emailUrgentBox(`DLP has <strong>expired</strong> for this project. Retention of <strong>$${(p.retentionAmount || 0).toLocaleString()}</strong> is now claimable.`)
          : emailWarnBox(`DLP is expiring on <strong>${escHtml(p.dlpEndDate)}</strong>. Retention of <strong>$${(p.retentionAmount || 0).toLocaleString()}</strong> will be claimable.`)) +
        emailTable([
          ['Project', escHtml(p.jobCode) + ' — ' + escHtml(p.projectName)],
          ['Handover', escHtml(p.handoverDate || '—')],
          ['DLP Ends', escHtml(p.dlpEndDate)],
          ['Retention', '$' + (p.retentionAmount || 0).toLocaleString()],
        ]),
        'View Project', `${APP_URL}/project?id=${p.id}`);

      try {
        await sendEmail(bossEmail, bossName, subject, body);
        // Mark on the source array so we write once after the loop
        const idx = allProjects.findIndex(pp => pp.id === p.id);
        if (idx >= 0) {
          allProjects[idx]._dlpReminderSentAt = new Date().toISOString();
          dlpDirty = true;
        }
        console.log(`[CRON] DLP ${expired ? 'expired' : 'expiring'} reminder sent for ${p.jobCode}`);
      } catch (e) { console.error(`[CRON] DLP reminder failed for ${p.id}:`, e.message); }
    }
    if (dlpDirty) writeProjects(allProjects);
    console.log('[CRON] DLP expiry check done');
  } catch (e) { logError('cron.9am-dlp-expiry', e); }

  // ── Check 7: Auto-archive settled projects past 3 years ───────────────────
  try {
    console.log('[CRON] 9am auto-archive check...');
    const projects = readProjects();
    const threeYearsAgo = dateSGT(-1095); // ~3 years
    let archived = 0;
    for (const p of projects) {
      deriveFields(p);
      if (p.lifecycle !== 'settled') continue;
      if (!p.finalAccountDate || p.finalAccountDate > threeYearsAgo) continue;
      p.lifecycle = 'archived';
      p.archivedDate = todaySGT();
      logActivity('project.auto-archived', { projectId: p.id, jobCode: p.jobCode, finalAccountDate: p.finalAccountDate });
      archived++;
    }
    if (archived > 0) {
      writeProjects(projects);
      console.log(`[CRON] Auto-archived ${archived} settled project(s)`);
    }
    console.log('[CRON] Auto-archive check done');
  } catch (e) { logError('cron.9am-auto-archive', e); }

  // ── Check 8: Sales follow-up reminders ────────────────────────────────────
  try {
    console.log('[CRON] 9am sales follow-up check...');
    const opps = readOpps();
    const today = todaySGT();
    const overdueOpps = opps.filter(o =>
      o.nextFollowUpDate && o.nextFollowUpDate <= today &&
      !['Won', 'Lost', 'No-Bid'].includes(o.stage)
    );
    if (overdueOpps.length > 0) {
      const salesEmail = getRoleEmail('Sales');
      if (salesEmail) {
        const salesName = (readStaff()['Sales'] || {}).name || 'Sales';
        const rows = overdueOpps.map(o =>
          `['${escHtml(o.clientName)}', '${escHtml(o.stage)}', '${escHtml(o.nextFollowUpDate)}', '${escHtml((o.fuSequence || 0) > 0 ? 'FU' + o.fuSequence : 'First call')}']`
        );
        await sendEmail(salesEmail, salesName,
          `[Follow-Up Due] ${overdueOpps.length} opportunity follow-up${overdueOpps.length > 1 ? 's' : ''} overdue`,
          emailWrap(`Hi ${escHtml(salesName)},`,
            `<p style="margin:0 0 16px;">You have <strong>${overdueOpps.length}</strong> overdue follow-up${overdueOpps.length > 1 ? 's' : ''}:</p>` +
            emailTable(overdueOpps.map(o => [
              escHtml(o.clientName),
              escHtml(o.stage),
              escHtml(o.nextFollowUpDate),
              (o.fuSequence || 0) > 0 ? 'FU' + o.fuSequence : 'First call'
            ])),
            'Open Sales Pipeline', `${APP_URL}/sales`)
        ).catch(e => console.error('[CRON] Sales FU email failed:', e.message));
        console.log(`[CRON] Sales FU reminder sent: ${overdueOpps.length} overdue`);
      }
    }
    console.log('[CRON] Sales follow-up check done');
  } catch (e) { logError('cron.9am-sales-followup', e); }

  // ── Check 9: 24hr nudge for New Lead without follow-up ─────────────────────
  try {
    console.log('[CRON] 9am new-lead nudge check...');
    const opps = readOpps();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let oppsChanged = false;
    for (const opp of opps) {
      if (opp.stage !== 'New Lead') continue;
      if (opp._nudgeSentAt) continue; // already nudged
      if (!opp.createdAt || opp.createdAt > oneDayAgo) continue; // less than 24hrs old
      if (!opp.email) continue;
      // Send nudge email to client
      try {
        const salesName = (readStaff()['Sales'] || {}).name || 'Sales Team';
        await sendEmail(opp.email, opp.contactPerson || opp.clientName,
          `Following up on your enquiry — ${opp.clientName || ''}`,
          emailWrap(null,
            `<p style="margin:0 0 16px;">We recently received your enquiry and would love to schedule a brief call to discuss your requirements.</p>` +
            `<p style="margin:0 0 16px;">Please let us know a convenient time, or reply to this email with any details about your project.</p>` +
            `<p style="margin:0;">Best regards,<br>${escHtml(salesName)}<br>Lai Yew Seng Engineering Pte Ltd</p>`)
        );
        opp._nudgeSentAt = new Date().toISOString();
        if (!Array.isArray(opp.activity)) opp.activity = [];
        opp.activity.push({ ts: new Date().toISOString(), type: 'auto-nudge', note: '24hr auto-nudge sent to ' + opp.email });
        oppsChanged = true;
        console.log(`[CRON] 24hr nudge sent to ${opp.email} for opp ${opp.id}`);
      } catch (e) { console.error(`[CRON] Nudge failed for ${opp.id}:`, e.message); }
    }
    if (oppsChanged) writeOpps(opps);
    console.log('[CRON] New-lead nudge check done');
  } catch (e) { logError('cron.9am-sales-nudge', e); }

  } catch (e) { logError('cron.9am-checks', e); }
}, { timezone: 'Asia/Singapore' });

// Trigger 2: Noon weekdays — remind Factory Manager about unacknowledged site requests > 24hrs
cron.schedule('0 12 * * 1-5', async () => {
  cronHeartbeat('noon-sr-reminder');
  try {
    console.log('[CRON] Noon site-request reminder check...');
    const srs = readSiteRequests();
    const yesterdayISO = new Date(dateSGT(-1) + 'T23:59:59+08:00').toISOString();
    const stale = srs.filter(r => r.status === 'New' && r.createdAt && r.createdAt < yesterdayISO);
    if (!stale.length) return;
    const byProject = {};
    stale.forEach(r => {
      const key = r.projectId || '__unlinked__';
      if (!byProject[key]) byProject[key] = { jobCode: r.projectJobCode, projectName: r.projectName, items: [] };
      byProject[key].items.push(r);
    });
    const factoryEmail = getRoleEmail('Factory Manager');
    const factoryName = (readStaff()['Factory Manager'] || {}).name || 'Factory Manager';
    if (!factoryEmail) return;
    for (const key of Object.keys(byProject)) {
      const group = byProject[key];
      const label = group.jobCode || group.projectName || '(no project)';
      await sendEmail(factoryEmail, factoryName,
        `[Reminder] Unacknowledged Site Request — ${label}`,
        emailWrap(`Hi ${escHtml(factoryName.split(' ')[0])},`,
          `<p style="margin:0 0 16px;">A site request for <strong>${escHtml(label)}</strong> has been waiting for your acknowledgement for over 24 hours.</p>` +
          emailTable([['Items', group.items.map(r => `${escHtml(r.item)} (${r.quantity || r.qtyRequested || ''} ${escHtml(r.unit || '')})`).join(', ')]]),
          'Open Factory Dashboard', `${APP_URL}/factory`)
      );
    }
  } catch (e) { logError('cron.noon-sr', e); }
}, { timezone: 'Asia/Singapore' });

// 6pm weekdays — EOD reminder to staff who haven't submitted yet (with task status)
cron.schedule('0 18 * * 1-5', async () => {
  cronHeartbeat('6pm-eod-reminder');
  try {
  console.log('[CRON] 6pm EOD reminder running...');
  const today = todaySGT();
  const logs = readEOD();
  const submitted = logs.filter(l => l.date === today).map(l => l.staffName);
  const staffToRemind = getStaffNames().filter(n => n !== getBossName() && !submitted.includes(n));

  if (!staffToRemind.length) {
    console.log('[CRON] 6pm EOD: all staff submitted — no reminders needed');
    return;
  }

  const tasks = readTasks();
  let sent = 0;
  for (const name of staffToRemind) {
    const email = getStaffEmail(name);
    if (!email) { console.warn('[EMAIL SKIP] No email for:', name); continue; }
    const firstName = name.split(' ')[0];

    // Today's tasks for this person
    const todayTasks = tasks.filter(t => t.assignedTo === name && t.dueDate === today && !t.archived);
    const taskRowsHtml = todayTasks.length > 0
      ? todayTasks.map(t => {
          const icon  = t.status === 'Done' ? '✅' : '⚠️';
          const color = t.status === 'Done' ? '#00c875' : '#fdab3d';
          const strike = t.status === 'Done' ? 'text-decoration:line-through;' : '';
          return `<li style="padding:5px 0;border-bottom:1px solid #eee;list-style:none;font-size:13px;">`+
            `${icon} <span style="color:${color};${strike}">${escHtml(t.title)}</span>` +
            (t.category ? ` <span style="color:#aaa;font-size:11px;">[${escHtml(t.category)}]</span>` : '') +
            `</li>`;
        }).join('')
      : `<li style="padding:5px 0;list-style:none;font-size:13px;color:#888;">No tasks assigned today.</li>`;

    const htmlBody = emailWrap(`Hi ${escHtml(firstName)},`,
      `<p style="margin:0 0 16px;">This is a reminder to submit your <strong>EOD report</strong> for today.</p>` +
      `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin-bottom:8px;">Today's Tasks</div>` +
      `<ul style="padding:0;margin:0 0 20px;">${taskRowsHtml}</ul>`,
      'Submit EOD Report', `${APP_URL}/my-tasks#${firstName.toLowerCase()}`);

    await sendEmail(email, name, 'EOD Reminder — Please submit your report for today', htmlBody);
    sent++;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[CRON] 6pm EOD reminders sent: ${sent}`);
  } catch (e) { logError('cron.6pm-eod-reminder', e); }
}, { timezone: 'Asia/Singapore' });

// Trigger 5: 6:30pm weekdays — flag + email Lai if EOD not submitted
cron.schedule('30 18 * * 1-5', async () => {
  try {
  console.log('[CRON] 6:30pm EOD check running...');
  const today = todaySGT();
  const logs = readEOD();
  const submitted = logs.filter(l => l.date === today).map(l => l.staffName);
  const staffNames = getStaffNames().filter(n => n !== getBossName());
  const missing = staffNames.filter(n => !submitted.includes(n));
  // Write current flags file (for live /api/eod-log endpoint)
  safeWriteJSON(FLAG_FILE, { date: today, missing });
  // Append to cumulative history (permanent record)
  const history = readEODHistory();
  const existingIdx = history.findIndex(h => h.date === today);
  const histEntry = { date: today, submitted, missing, recordedAt: new Date().toISOString() };
  if (existingIdx !== -1) { history[existingIdx] = histEntry; } else { history.push(histEntry); }
  safeWriteJSON(EOD_HISTORY_FILE, history);
  console.log(`[CRON] EOD missing: ${missing.join(', ') || 'none'}`);

  if (missing.length > 0) {
    const laiEmail = process.env.SENDER_EMAIL;
    if (laiEmail) {
      await sendEmail(laiEmail, getBossName(),
        `[EOD Alert] ${missing.length} staff haven't submitted end-of-day log`,
        emailWrap(null,
          `<p style="margin:0 0 16px;">The following staff have not submitted their EOD log today (${today}):</p>` +
          `<ul style="margin:0 0 16px;padding-left:20px;">${missing.map(n => `<li><strong>${escHtml(n)}</strong></li>`).join('')}</ul>`,
          'View Tasks Dashboard', `${APP_URL}/tasks`)
      );
    }
  }
  } catch (e) { logError('cron.eod-flag', e); }
}, { timezone: 'Asia/Singapore' });

// Note: the 7pm duplicate staff reminder was removed — 6pm covers staff,
// 6:30pm flags the boss. Next-day 9am re-alert to boss is handled inside
// the 9am cron below (see "Check 4: Yesterday's missing EOD").

// Every Monday 12:01am — archive last week's done tasks
cron.schedule('1 0 * * 1', () => {
  try {
  console.log('[CRON] Weekly archive running...');
  const tasks = readTasks();
  const currentWeek = getWeekStart();
  let count = 0;
  tasks.forEach(t => {
    if (!t.archived && t.status === 'Done' && t.weekOf && t.weekOf < currentWeek) {
      t.archived = true;
      t.archivedAt = new Date().toISOString();
      count++;
    }
  });
  writeTasks(tasks);
  console.log(`[CRON] Archived ${count} tasks`);
  } catch (e) { logError('cron.weekly-archive', e); }
}, { timezone: 'Asia/Singapore' });

// ── Manpower Planning ─────────────────────────────────────────────────────────

// GET /api/manpower-plan?weekStart=YYYY-MM-DD  (weekly plan)
// GET /api/manpower-plan?date=YYYY-MM-DD        (legacy daily plan)
app.get('/api/manpower-plan', (req, res) => {
  try {
    const plans = readManpowerPlans();
    if (req.query.weekStart) {
      const weekStart = req.query.weekStart;
      if (!isValidDate(weekStart)) return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
      const plan = plans.find(p => p.weekStart === weekStart);
      if (!plan) return res.status(404).json({ error: 'No plan for this week' });
      return res.json(plan);
    }
    // Legacy daily
    const date = req.query.date;
    if (!date || !isValidDate(date)) return res.status(400).json({ error: 'weekStart or date query param required (YYYY-MM-DD)' });
    const plan = plans.find(p => p.date === date);
    if (!plan) return res.status(404).json({ error: 'No plan for this date' });
    res.json(plan);
  } catch (e) { logError('route.get.manpower-plan', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/manpower-plan/ot-summary — monthly OT totals per worker
app.get('/api/manpower-plan/ot-summary', (req, res) => {
  try {
    const now = new Date();
    const yr = req.query.year  ? parseInt(req.query.year)  : now.getFullYear();
    const mo = req.query.month ? parseInt(req.query.month) - 1 : now.getMonth();

    // Find all weekly plans whose weekStart falls in this month
    const plans = readManpowerPlans();
    const monthPlans = plans.filter(p => {
      if (!p.weekStart) return false;
      const ws = new Date(p.weekStart + 'T00:00:00');
      // Include if the week overlaps with the target month
      const weekEnd = new Date(ws); weekEnd.setDate(weekEnd.getDate() + 5);
      return (ws.getFullYear() === yr && ws.getMonth() === mo) ||
             (weekEnd.getFullYear() === yr && weekEnd.getMonth() === mo);
    });

    // Sum OT per worker
    const otByWorker = {};
    let totalOT = 0;
    monthPlans.forEach(p => {
      Object.entries(p.assignments || {}).forEach(([wid, days]) => {
        Object.values(days).forEach(a => {
          const ot = parseFloat(a.otHours) || 0;
          if (ot > 0) {
            otByWorker[wid] = (otByWorker[wid] || 0) + ot;
            totalOT += ot;
          }
        });
      });
    });

    // Resolve worker names
    const workers = readWorkers();
    const workerMap = {};
    workers.forEach(w => { workerMap[w.id] = w.name; });

    const details = Object.entries(otByWorker)
      .map(([wid, hours]) => ({ id: wid, name: workerMap[wid] || wid, hours, overCap: hours >= 72 }))
      .sort((a, b) => b.hours - a.hours);

    const atRisk = details.filter(d => d.hours >= 60).length;

    res.json({ year: yr, month: mo + 1, totalOT, workerCount: details.length, atRisk, details });
  } catch (e) { logError('route.get.ot-summary', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/manpower-plan — upsert weekly or daily plan
app.post('/api/manpower-plan', (req, res) => {
  try {
    const plans = readManpowerPlans();
    if (req.body.weekStart) {
      // Weekly plan: { weekStart, assignments: { workerId: { mon, tue, ... } }, supplyWorkers }
      const { weekStart, assignments, supplyWorkers } = req.body;
      if (!isValidDate(weekStart)) return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
      const entry = {
        weekStart,
        assignments: assignments && typeof assignments === 'object' ? assignments : {},
        supplyWorkers: Array.isArray(supplyWorkers) ? supplyWorkers : [],
        savedAt: new Date().toISOString()
      };
      const idx = plans.findIndex(p => p.weekStart === weekStart);
      if (idx !== -1) plans[idx] = entry; else plans.push(entry);
      writeManpowerPlans(plans);
      logActivity('manpower-plan.saved', { weekStart, type: 'weekly' });
      return res.json(entry);
    }
    // Legacy daily plan
    const { date, assignments } = req.body;
    if (!date || !isValidDate(date)) return res.status(400).json({ error: 'weekStart or date required (YYYY-MM-DD)' });
    const entry = {
      date,
      assignments: Array.isArray(assignments) ? assignments : [],
      savedAt: new Date().toISOString()
    };
    const idx = plans.findIndex(p => p.date === date);
    if (idx !== -1) plans[idx] = entry; else plans.push(entry);
    writeManpowerPlans(plans);
    logActivity('manpower-plan.saved', { date, assignmentCount: entry.assignments.length });
    res.json(entry);
  } catch (e) { logError('route.post.manpower-plan', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Excel Export ──────────────────────────────────────────────────────────────

// GET /api/export/projects — download all projects as Excel
app.get('/api/export/projects', (req, res) => {
  try {
    const xlsx = require('xlsx');
    const projects = readProjects();

    const rows = projects.map(p => {
      const totalContract = (p.contractValue || 0) + (p.voValue || 0);
      const fabItems = p.fabrication || [];
      const instItems = p.installation || [];
      const totalFab  = fabItems.reduce((s, f) => s + (parseFloat(f.totalQty) || 0), 0);
      const doneFab   = fabItems.reduce((s, f) => s + (parseFloat(f.qtyDone)  || 0), 0);
      const totalInst = instItems.reduce((s, i) => s + (parseFloat(i.totalQty) || 0), 0);
      const doneInst  = instItems.reduce((s, i) => s + (parseFloat(i.doneQty)  || 0), 0);
      const fabPct    = totalFab  > 0 ? Math.round(doneFab  / totalFab  * 100) : 0;
      const instPct   = totalInst > 0 ? Math.round(doneInst / totalInst * 100) : 0;

      return {
        'Job Code':        p.jobCode || '',
        'Project Name':    p.projectName || '',
        'Client':          p.client || '',
        'Status':          p.status || '',
        'Contract ($)':    p.contractValue || 0,
        'VO ($)':          p.voValue || 0,
        'Total ($)':       totalContract,
        'Paid ($)':        p.paidAmount || 0,
        'Fab %':           fabPct,
        'Install %':       instPct,
        'Start Date':      p.startDate || '',
        'End Date':        p.endDate || '',
        'Project Manager': p.projectManager || '',
        'QS':              p.qs || '',
        'Factory Manager': p.factoryManager || '',
        'Site Engineer':   p.siteEngineer || '',
        'Latest Notes':    p.latestNotes || ''
      };
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows);
    // Auto-fit column widths
    const colWidths = Object.keys(rows[0] || {}).map(k => ({ wch: Math.max(k.length + 2, 14) }));
    ws['!cols'] = colWidths;
    xlsx.utils.book_append_sheet(wb, ws, 'Projects');

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `LYS-Projects-${todaySGT()}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
    logActivity('export.projects', { count: projects.length });
  } catch (e) {
    logError('export.projects', e);
    res.status(500).json({ error: 'Export failed: ' + e.message });
  }
});

// ── Workers API ───────────────────────────────────────────────────────────────

// GET /api/workers — return all workers, optionally filter by ?active=true
app.get('/api/workers', (req, res) => {
  try {
    let workers = readWorkers();
    if (req.query.active === 'true') workers = workers.filter(w => w.active);
    res.json(workers);
  } catch (e) { logError('route.get.workers', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/workers — add a new worker
app.post('/api/workers', async (req, res) => {
  try {
  if (!await requireAdminAuth(req, res)) return;
  const workers = readWorkers();
  const worker = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name:      sanitizeStr(req.body.name, 100),
    nationality: sanitizeStr(req.body.nationality, 50),
    code:      sanitizeStr(req.body.code, 50),
    role:      sanitizeStr(req.body.role, 100),
    active:    req.body.active !== false,
    startDate: req.body.startDate ? sanitizeStr(req.body.startDate, 10) : '',
    notes:     sanitizeStr(req.body.notes || '', 1000),
    createdAt: new Date().toISOString()
  };
  if (!worker.name) return res.status(400).json({ error: 'name is required' });
  workers.push(worker);
  writeWorkers(workers);
  logActivity('worker.created', { workerId: worker.id, name: worker.name });
  res.status(201).json(worker);
  } catch (e) { logError('route.post.workers', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/workers/:id — update worker fields
app.put('/api/workers/:id', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const workers = readWorkers();
    const idx = workers.findIndex(w => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Worker not found' });
    const WORKER_WRITABLE = ['name','role','company','phone','wpNumber','wpExpiry','code','active','notes','nationality','startDate'];
    const clean = {};
    for (const k of WORKER_WRITABLE) { if (req.body[k] !== undefined) clean[k] = req.body[k]; }
    workers[idx] = { ...workers[idx], ...clean };
    writeWorkers(workers);
    logActivity('worker.updated', { workerId: req.params.id, name: workers[idx].name });
    res.json(workers[idx]);
  } catch (e) { logError('route.put.workers', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/workers/:id — remove worker
app.delete('/api/workers/:id', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const workers = readWorkers();
    const idx = workers.findIndex(w => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Worker not found' });
    const deleted = workers[idx];
    workers.splice(idx, 1);
    writeWorkers(workers);
    logActivity('worker.deleted', { workerId: req.params.id, name: deleted.name });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.workers', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Attendance API ─────────────────────────────────────────────────────────────

function readAttendance() {
  if (!fs.existsSync(ATTENDANCE_FILE)) safeWriteJSON(ATTENDANCE_FILE, []);
  return safeReadJSON(ATTENDANCE_FILE);
}

function writeAttendance(records) {
  safeWriteJSON(ATTENDANCE_FILE, records);
}

// GET /api/attendance/week?weekStart=YYYY-MM-DD — returns MC/Off/Leave statuses for the week (Mon-Sat)
app.get('/api/attendance/week', (req, res) => {
  try {
    const ws = req.query.weekStart;
    if (!ws || !isValidDate(ws)) return res.status(400).json({ error: 'weekStart required (YYYY-MM-DD)' });
    const wsDate = new Date(ws + 'T00:00:00');
    // Build list of 6 dates (Mon-Sat)
    const dayKeys = ['mon','tue','wed','thu','fri','sat'];
    const dates = dayKeys.map((_, i) => {
      const d = new Date(wsDate);
      d.setDate(d.getDate() + i);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    });
    const all = readAttendance();
    // Build { workerId: { mon: status, tue: status, ... } } for non-working statuses only
    const result = {};
    const absenceStatuses = ['MC', 'Off', 'On Leave', 'Absent'];
    dates.forEach((dateStr, i) => {
      const rec = all.find(r => r.date === dateStr);
      if (!rec || !rec.records) return;
      rec.records.forEach(r => {
        if (absenceStatuses.includes(r.status)) {
          if (!result[r.workerId]) result[r.workerId] = {};
          result[r.workerId][dayKeys[i]] = { status: r.status, notes: r.notes || '' };
        }
      });
    });
    res.json(result);
  } catch (e) { logError('route.get.attendance.week', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/attendance/today — shortcut for today's date
app.get('/api/attendance/today', (req, res) => {
  try {
    const today = todaySGT();
    const all = readAttendance();
    const rec = all.find(r => r.date === today) || null;
    res.json(rec);
  } catch (e) { logError('route.get.attendance.today', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/attendance?date=YYYY-MM-DD — returns attendance for that date
app.get('/api/attendance', (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
    }
    const all = readAttendance();
    const rec = all.find(r => r.date === date) || null;
    res.json(rec);
  } catch (e) { logError('route.get.attendance', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/attendance — save attendance record for a date
app.post('/api/attendance', postRateLimit, (req, res) => {
  try {
    const { date, records } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    }
    if (!Array.isArray(records)) {
      return res.status(400).json({ error: 'records array is required' });
    }
    const validStatuses = ['Present', 'Absent', 'MC', 'Off', 'On Site', 'On Leave'];
    // Reject if any record has an invalid status
    const badStatus = records.find(r => r.status && !validStatuses.includes(r.status));
    if (badStatus) {
      return res.status(400).json({ error: `Invalid status: "${badStatus.status}". Valid: ${validStatuses.join(', ')}` });
    }
    const cleaned = records.map(r => ({
      workerId:   sanitizeStr(r.workerId, 100),
      workerName: sanitizeStr(r.workerName, 100),
      status:     validStatuses.includes(r.status) ? r.status : 'Absent',
      notes:      sanitizeStr(r.notes || '', 500)
    }));
    const all = readAttendance();
    const idx = all.findIndex(r => r.date === date);
    const entry = { date, records: cleaned, savedAt: new Date().toISOString() };
    if (idx >= 0) all[idx] = entry;
    else all.push(entry);
    writeAttendance(all);
    logActivity('attendance.saved', { date, count: cleaned.length });
    res.json(entry);
  } catch (e) { logError('route.post.attendance', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Site Requests — Factory Pipeline ─────────────────────────────────────────
function readSiteRequests() {
  try {
    if (!fs.existsSync(SITE_REQUESTS_FILE)) return [];
    return safeReadJSON(SITE_REQUESTS_FILE);
  } catch { return []; }
}

function writeSiteRequests(records) {
  safeWriteJSON(SITE_REQUESTS_FILE, records);
}

// /api/system-map removed — dead route, no frontend caller

const VALID_SR_STATUSES = ['New', 'Acknowledged', 'In Fabrication', 'Ready', 'Delivered', 'Received', 'Issue'];

// GET /api/site-requests — all requests, newest first
app.get('/api/site-requests', (req, res) => {
  try {
    const all = readSiteRequests();
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(all);
  } catch (e) { logError('route.get.site-requests', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/site-requests — create new request
app.post('/api/site-requests', postRateLimit, (req, res) => {
  try {
  const projectId    = sanitizeStr(req.body.projectId, 100);
  const projectJobCode = sanitizeStr(req.body.projectJobCode, 100);
  const projectName  = sanitizeStr(req.body.projectName, 200);
  const item         = sanitizeStr(req.body.item, 200);
  const quantity     = parseFloat(req.body.quantity) || 1;
  const unit         = sanitizeStr(req.body.unit, 50);
  const neededByDate = sanitizeStr(req.body.neededByDate, 20);
  const requestedBy  = sanitizeStr(req.body.requestedBy, 100);
  const notes        = sanitizeStr(req.body.notes || '', 1000);
  // fabIdx links the SR to a specific project.fabrication[] row.
  // Captured when Teo picks from the fab dropdown on /installation; null for
  // free-text / "Other" items. Derivations match by fabIdx first (authoritative),
  // fall back to item-name match for legacy SRs or free-text entries.
  const fabIdxRaw    = req.body.fabIdx;
  const fabIdx       = (fabIdxRaw === undefined || fabIdxRaw === null || fabIdxRaw === '') ? null : parseInt(fabIdxRaw, 10);

  if (!item || !requestedBy || !neededByDate) {
    return res.status(400).json({ error: 'item, requestedBy, and neededByDate are required' });
  }
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  if (req.body.urgency && !['Normal','Urgent'].includes(req.body.urgency)) {
    return res.status(400).json({ error: 'urgency must be Normal or Urgent' });
  }

  // Validate project exists. Orphan requests (typo'd projectId, deleted project)
  // would silently disappear from /factory and /project so block at creation.
  let linkedProject = null;
  if (projectId) {
    const allProjects = readProjects();
    linkedProject = allProjects.find(p => p.id === projectId);
    if (!linkedProject) {
      return res.status(400).json({ error: 'Unknown projectId — project no longer exists' });
    }
    // If fabIdx was supplied, validate it points to an actual fab row
    if (fabIdx !== null && !Number.isNaN(fabIdx)) {
      const fab = Array.isArray(linkedProject.fabrication) ? linkedProject.fabrication : [];
      if (fabIdx < 0 || fabIdx >= fab.length) {
        return res.status(400).json({ error: 'Invalid fabIdx — no matching fabrication row' });
      }
    }
  }

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId, projectJobCode, projectName,
    item, quantity, unit, neededByDate,
    fabIdx: (fabIdx !== null && !Number.isNaN(fabIdx)) ? fabIdx : null,
    requestedBy, notes,
    urgency: ['Normal','Urgent'].includes(req.body.urgency) ? req.body.urgency : 'Normal',
    status: 'New',
    createdAt: new Date().toISOString(),
    acknowledgedAt: null,
    estimatedReadyDate: null,
    factoryNotes: null,
    deliveredAt: null,
    issueReason: null
  };

  const all = readSiteRequests();
  all.push(record);
  writeSiteRequests(all);
  logActivity('site-request.created', { id: record.id, item, requestedBy, fabIdx: record.fabIdx });

  // Notify the Factory Manager role (resolves via staff.json; falls back to boss).
  const factoryEmail = getRoleEmail('Factory Manager');
  const factoryName  = (readStaff()['Factory Manager'] || {}).name || 'Factory Manager';
  if (factoryEmail) {
    sendEmail(factoryEmail, factoryName,
      `[New Site Request] ${item} — ${projectJobCode || projectName}`,
      emailWrap(`Hi ${escHtml(factoryName.split(' ')[0])},`,
        `<p style="margin:0 0 16px;">A new factory request has been submitted.</p>` +
        emailTable([
          ['Item', escHtml(item)],
          ['Qty', `${escHtml(String(quantity))} ${escHtml(unit)}`],
          ['Project', `${escHtml(projectJobCode || '')} ${escHtml(projectName || '')}`],
          ['Needed By', escHtml(neededByDate)],
          ['Requested By', escHtml(requestedBy)],
          notes ? ['Notes', escHtml(notes)] : null
        ]),
        'Open Factory Dashboard', `${APP_URL}/factory`)
    ).catch(() => {});
  }

  res.status(201).json(record);
  } catch (e) { logError('route.post.site-requests', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/site-requests/:id — update status, Chris response, OR core fields.
// Permissive model: any field can be edited at any status. Every change is logged
// with actor + diff + previousStatus so the audit trail is the accountability layer.
app.put('/api/site-requests/:id', postRateLimit, (req, res) => {
  try {
  const all = readSiteRequests();
  const idx = all.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Site request not found' });

  const record = all[idx];
  const oldStatus = record.status;
  const actor = sanitizeStr(req.body._actor || '', 80) || 'unknown';

  // Capture pre-edit snapshot of all editable fields so we can emit a clean diff.
  const snapshot = {
    status: record.status,
    item: record.item,
    quantity: record.quantity,
    unit: record.unit,
    neededByDate: record.neededByDate,
    notes: record.notes,
    projectId: record.projectId,
    projectJobCode: record.projectJobCode,
    projectName: record.projectName,
    estimatedReadyDate: record.estimatedReadyDate,
    factoryNotes: record.factoryNotes,
    issueReason: record.issueReason
  };

  if (req.body.status !== undefined) {
    const s = sanitizeStr(req.body.status, 30);
    if (!VALID_SR_STATUSES.includes(s)) return res.status(400).json({ error: 'Invalid status' });
    record.status = s;
  }
  if (req.body.estimatedReadyDate !== undefined) record.estimatedReadyDate = sanitizeStr(req.body.estimatedReadyDate, 20);
  if (req.body.factoryNotes !== undefined)         record.factoryNotes         = sanitizeStr(req.body.factoryNotes, 1000);
  if (req.body.issueReason !== undefined)        record.issueReason        = sanitizeStr(req.body.issueReason, 1000);

  if (req.body.item         !== undefined) record.item         = sanitizeStr(req.body.item, 200);
  if (req.body.quantity     !== undefined) record.quantity     = parseFloat(req.body.quantity) || 0;
  if (req.body.unit         !== undefined) record.unit         = sanitizeStr(req.body.unit, 20);
  if (req.body.neededByDate !== undefined) record.neededByDate = sanitizeStr(req.body.neededByDate, 20);
  if (req.body.notes        !== undefined) record.notes        = sanitizeStr(req.body.notes, 1000);
  if (req.body.urgency     !== undefined && ['Normal','Urgent'].includes(req.body.urgency)) record.urgency = req.body.urgency;
  if (req.body.projectId      !== undefined) record.projectId      = sanitizeStr(req.body.projectId, 80);
  if (req.body.projectJobCode !== undefined) record.projectJobCode = sanitizeStr(req.body.projectJobCode, 80);
  if (req.body.projectName    !== undefined) record.projectName    = sanitizeStr(req.body.projectName, 200);

  if (record.status === 'Acknowledged' && !record.acknowledgedAt) {
    record.acknowledgedAt = new Date().toISOString();
  }
  if (record.status === 'Delivered' && !record.deliveredAt) {
    record.deliveredAt = new Date().toISOString();
  }
  // Clear deliveredAt when reverting from Delivered (undo from factory)
  if (record.status !== 'Delivered' && record.status !== 'Received' && record.deliveredAt) {
    record.deliveredAt = null;
  }
  // Site confirmation: stamp received fields
  if (record.status === 'Received' && !record.receivedAt) {
    record.receivedAt = new Date().toISOString();
    if (req.body.receivedBy)    record.receivedBy    = sanitizeStr(req.body.receivedBy, 100);
    if (req.body.receivedQty !== undefined) record.receivedQty = parseFloat(req.body.receivedQty) || record.quantity;
    if (req.body.receivedNotes) record.receivedNotes = sanitizeStr(req.body.receivedNotes, 500);
  }

  // Build change diff vs pre-edit snapshot
  const changes = {};
  Object.keys(snapshot).forEach(k => {
    if (String(snapshot[k] ?? '') !== String(record[k] ?? '')) {
      changes[k] = { from: snapshot[k], to: record[k] };
    }
  });

  all[idx] = record;
  writeSiteRequests(all);
  logActivity('site-request.updated', {
    id: record.id,
    actor,
    previousStatus: oldStatus,
    newStatus: record.status,
    changes
  });

  // Notify site engineer when Ready
  if (record.status === 'Ready' && oldStatus !== 'Ready') {
    const engEmail = getStaffEmail(record.requestedBy);
    if (engEmail) {
      sendEmail(engEmail, record.requestedBy,
        `[Ready] ${record.item} is ready for delivery`,
        emailWrap(`Hi ${escHtml(record.requestedBy)},`,
          `<p style="margin:0 0 16px;">Your factory request for <strong>${escHtml(record.item)}</strong> (${escHtml(String(record.quantity))} ${escHtml(record.unit)}) is ready.</p>` +
          emailTable([
            record.estimatedReadyDate ? ['Estimated Delivery', escHtml(record.estimatedReadyDate)] : null,
            record.factoryNotes ? ['Factory Notes', escHtml(record.factoryNotes)] : null
          ]),
          'Open Installation', `${APP_URL}/installation`)
      ).catch(() => {});
    }
  }

  // Notify site engineer when Delivered
  if (record.status === 'Delivered' && oldStatus !== 'Delivered') {
    const engEmail = getStaffEmail(record.requestedBy);
    if (engEmail) {
      sendEmail(engEmail, record.requestedBy,
        `[Delivered] ${record.item} has been delivered`,
        emailWrap(`Hi ${escHtml(record.requestedBy)},`,
          `<p style="margin:0 0 16px;"><strong>${escHtml(record.item)}</strong> (${escHtml(String(record.quantity))} ${escHtml(record.unit)}) has been delivered to site.</p>` +
          emailTable([
            ['Project', `${escHtml(record.projectJobCode || '')} ${escHtml(record.projectName || '')}`]
          ]),
          null, null)
      ).catch(() => {});
    }
  }

  // Notify site engineer when Issue flagged
  if (record.status === 'Issue' && oldStatus !== 'Issue') {
    const engEmail = getStaffEmail(record.requestedBy);
    if (engEmail) {
      const fmName = getFactoryManagerName();
      sendEmail(engEmail, record.requestedBy,
        `[Issue] Factory cannot fulfil request: ${record.item}`,
        emailWrap(`Hi ${escHtml(record.requestedBy)},`,
          `<p style="margin:0 0 16px;">There is an issue with your request for <strong>${escHtml(record.item)}</strong>.</p>` +
          (record.issueReason ? emailUrgentBox(`Reason: ${escHtml(record.issueReason)}`) : '') +
          `<p style="margin:16px 0 0;">Please follow up with ${escHtml(fmName)} directly.</p>`,
          null, null)
      ).catch(() => {});
    }
  }

  res.json(record);
  } catch (e) { logError('route.put.site-requests', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/site-requests/:id — permissive, audit-logged.
// Actor is read from query string (?actor=Teo) since DELETE has no body in most clients.
// POST /api/site-requests/:id/split — partial shipment support.
// Business need: Teo raises an SR for 100 units. Chris has built 40 and the
// install team needs them now. Previously "Delivered" was all-or-nothing so
// Chris had to close the SR early (wrong) or wait until all 100 were built
// (bad). This route splits the SR into:
//   - parent:  quantity=readyQty, stays on its current status trajectory
//              so Chris can Mark Ready → Delivered on just the ready batch
//   - sibling: quantity=(parent.quantity - readyQty), status='Acknowledged',
//              parentId=parent.id, fresh createdAt, inherits fabIdx/project/
//              item/unit/neededByDate/requestedBy/notes
// The sibling goes straight to Acknowledged (not New) because (a) Chris
// already knows about it — he just split it — and (b) it avoids the noon
// cron re-nagging about a "new" request within 24h of the original.
// No email triggered — splits are a Chris-internal workflow, not a new
// request signal.
app.post('/api/site-requests/:id/split', postRateLimit, (req, res) => {
  try {
    const all = readSiteRequests();
    const idx = all.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Site request not found' });
    const parent = all[idx];
    if (parent.status === 'Delivered') {
      return res.status(400).json({ error: 'Cannot split a Delivered request' });
    }
    const readyQty = parseFloat(req.body.readyQty);
    const parentQty = parseFloat(parent.quantity) || 0;
    if (!Number.isFinite(readyQty) || readyQty <= 0) {
      return res.status(400).json({ error: 'readyQty must be a positive number' });
    }
    if (readyQty >= parentQty) {
      return res.status(400).json({ error: `readyQty (${readyQty}) must be less than parent quantity (${parentQty}) — use the normal Ready/Delivered flow for full shipments` });
    }

    const balance = Math.round((parentQty - readyQty) * 100) / 100;
    const sibling = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      projectId:       parent.projectId,
      projectJobCode:  parent.projectJobCode,
      projectName:     parent.projectName,
      item:            parent.item,
      quantity:        balance,
      unit:            parent.unit,
      neededByDate:    parent.neededByDate,
      fabIdx:          (parent.fabIdx !== undefined ? parent.fabIdx : null),
      requestedBy:     parent.requestedBy,
      notes:           parent.notes,
      status:          'Acknowledged',
      createdAt:       new Date().toISOString(),
      acknowledgedAt:  new Date().toISOString(),
      estimatedReadyDate: null,
      factoryNotes:      null,
      deliveredAt:     null,
      issueReason:     null,
      parentId:        parent.id,
    };

    parent.quantity = readyQty;
    all.push(sibling);
    writeSiteRequests(all);
    logActivity('site-request.split', {
      parentId: parent.id,
      siblingId: sibling.id,
      item: parent.item,
      readyQty,
      balance,
      projectId: parent.projectId,
    });

    res.json({ parent, sibling });
  } catch (e) {
    logError('route.post.site-requests.split', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/site-requests/:id', postRateLimit, (req, res) => {
  try {
    const all = readSiteRequests();
    const idx = all.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Site request not found' });
    const record = all[idx];
    const actor = sanitizeStr(req.query.actor || '', 80) || 'unknown';
    all.splice(idx, 1);
    writeSiteRequests(all);
    logActivity('site-request.deleted', {
      id: record.id,
      actor,
      previousStatus: record.status,
      projectId: record.projectId || '',
      projectJobCode: record.projectJobCode || '',
      item: record.item || '',
      quantity: record.quantity || 0,
      requestedBy: record.requestedBy || ''
    });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.site-requests', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Monday Flags API ─────────────────────────────────────────────────────────
function readMondayFlags() {
  try {
    if (!fs.existsSync(MONDAY_FLAGS_FILE)) return [];
    return safeReadJSON(MONDAY_FLAGS_FILE);
  } catch { return []; }
}

function writeMondayFlags(flags) {
  safeWriteJSON(MONDAY_FLAGS_FILE, flags);
}

// GET /api/monday-flags — all flags (client filters by weekStart)
app.get('/api/monday-flags', (req, res) => {
  try {
    res.json(readMondayFlags());
  } catch (e) { logError('route.get.monday-flags', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/monday-flags — add a flag for an engineer this week
app.post('/api/monday-flags', postRateLimit, (req, res) => {
  try {
    const engineer  = String(req.body.engineer  || '').trim().slice(0, 100);
    const text      = String(req.body.text      || '').trim().slice(0, 200);
    const weekStart = String(req.body.weekStart || '').trim().slice(0, 10);
    if (!engineer || !text || !weekStart) return res.status(400).json({ error: 'engineer, text and weekStart required' });
    const flags = readMondayFlags();
    const flag = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), engineer, text, weekStart, createdAt: new Date().toISOString() };
    flags.push(flag);
    writeMondayFlags(flags);
    res.status(201).json(flag);
  } catch (e) { logError('route.post.monday-flags', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/monday-flags/:id — remove a flag
app.delete('/api/monday-flags/:id', (req, res) => {
  try {
    const flags = readMondayFlags();
    const idx = flags.findIndex(f => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Flag not found' });
    flags.splice(idx, 1);
    writeMondayFlags(flags);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.monday-flags', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Transport Plan API ────────────────────────────────────────────────────────

// GET /api/transport?date=YYYY-MM-DD — returns transport plan for that date
app.get('/api/transport', (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    }
    const all = readTransport();
    const record = all.find(r => r.date === date);
    res.json(record || { date, trips: [] });
  } catch (e) { logError('route.get.transport', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/transport — save transport plan for a date
// Body: { date, trips: [{ id, departureTime, driver, vehicle, workers, destination, projectId, projectJobCode, notes }] }
app.post('/api/transport', postRateLimit, (req, res) => {
  try {
    const { date, trips } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    }
    if (!Array.isArray(trips)) {
      return res.status(400).json({ error: 'trips must be an array' });
    }
    // Basic sanitize each trip
    const clean = trips.map(t => ({
      id:             sanitizeStr(t.id || '', 50),
      departureTime:  sanitizeStr(t.departureTime || '', 10),
      driver:         sanitizeStr(t.driver || '', 100),
      vehicle:        sanitizeStr(t.vehicle || '', 100),
      workers:        Array.isArray(t.workers) ? t.workers.map(w => ({
        workerId:   sanitizeStr(w.workerId || '', 100),
        workerName: sanitizeStr(w.workerName || '', 100)
      })) : [],
      destination:    sanitizeStr(t.destination || '', 200),
      projectId:      sanitizeStr(t.projectId || '', 100),
      projectJobCode: sanitizeStr(t.projectJobCode || '', 100),
      notes:          sanitizeStr(t.notes || '', 500)
    }));
    const all = readTransport();
    const idx = all.findIndex(r => r.date === date);
    const record = { date, trips: clean, savedAt: new Date().toISOString() };
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    writeTransport(all);
    logActivity('transport.saved', { date, tripCount: clean.length });
    res.json(record);
  } catch (e) { logError('route.post.transport', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Logs API ──────────────────────────────────────────────────────────────────
// GET /api/logs?type=activity|errors&limit=50&projectId=X
app.get('/api/logs', (req, res) => {
  const type      = req.query.type === 'errors' ? 'errors' : 'activity';
  const limit     = Math.min(parseInt(req.query.limit) || 50, 500);
  const projectId = req.query.projectId || null;
  const logFile   = type === 'errors' ? ERRORS_LOG_FILE : ACTIVITY_LOG_FILE;

  try {
    if (!fs.existsSync(logFile)) return res.json([]);
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    // Parse each line as JSON, skip malformed
    let parsed = [];
    for (let i = lines.length - 1; i >= 0 && parsed.length < limit * 3; i--) {
      try { parsed.push(JSON.parse(lines[i])); } catch {}
    }
    // Optionally filter by projectId
    if (projectId) {
      parsed = parsed.filter(e => e.projectId === projectId || (e.details && e.details.projectId === projectId));
    }
    res.json(parsed.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: 'Failed to read log: ' + e.message });
  }
});

// ── Recurring Tasks ───────────────────────────────────────────────────────────
// Task templates keyed by staff.json role alias. At runtime, the role resolves
// to the person's name via readStaff(). If a role isn't in staff.json, those
// tasks are silently skipped — no code change needed when staff changes.
const RECURRING_ROLE_DEFS = {
  'GM': {
    daily: [
      { title: 'Review EOD flags — action any gaps from yesterday',                  category: 'People'     },
      { title: 'Review cash position — check what landed, what\'s overdue',          category: 'Finance'    },
      { title: 'Approve/reject pending decisions — POs, scope changes, OT',          category: 'Operations' },
    ],
    monday: [
      { title: 'Weekly P&L check — margin vs forecast on active projects',           category: 'Finance'    },
    ],
  },
  'Factory Manager': {
    daily: [
      { title: 'Take attendance — mark MC/absent workers',                           category: 'People'     },
      { title: 'Review today\'s fabrication priorities across all projects',          category: 'Operations' },
      { title: 'Check site requests inbox — acknowledge within 2 hours',             category: 'Operations' },
      { title: 'Assign workers to projects and plan transport',                      category: 'People'     },
      { title: 'Update FAB progress on all active items',                            category: 'Reporting'  },
      { title: 'Confirm next-day material and delivery readiness',                   category: 'Operations' },
    ],
    monday: [
      { title: 'Weekly fab planning — align with site engineer priorities',           category: 'Operations' },
      { title: 'Check stock levels — flag low materials to purchaser',               category: 'Operations' },
      { title: 'Safety walkthrough with photo evidence — machines, tools, fire exits', category: 'Safety'   },
    ],
  },
  'Purchaser': {
    daily: [
      { title: 'Review and action all new PRs raised since yesterday',               category: 'Operations'  },
      { title: 'Check all pending POs — confirm delivery dates with suppliers',      category: 'Operations'  },
      { title: 'Follow up on overdue supplier deliveries',                           category: 'Operations'  },
      { title: 'Update material ETA for all active projects',                        category: 'Reporting'   },
    ],
    monday: [
      { title: 'Weekly supplier review — compare prices, flag unreliable suppliers', category: 'Operations'  },
      { title: 'Get 1 competitive quote on top-3 spend items this month',            category: 'Development' },
    ],
  },
  'QS': {
    daily: [
      { title: 'Review SOP Act deadlines — flag anything due within 7 days',         category: 'Reporting'  },
      { title: 'Chase outstanding payment responses past SOP deadline — escalate if >3 days', category: 'Operations' },
      { title: 'Update claims status for all active projects',                       category: 'Reporting'  },
      { title: 'Prepare next progress claim for any project within 5 working days of claim date', category: 'Operations' },
    ],
    monday: [
      { title: 'Weekly claims review — total outstanding, overdue, upcoming',        category: 'Reporting'  },
    ],
  },
  'QS2': {
    daily: [
      { title: 'Review SOP Act deadlines — flag anything due within 7 days',         category: 'Reporting'  },
      { title: 'Chase outstanding payment responses past SOP deadline — escalate if >3 days', category: 'Operations' },
      { title: 'Update claims status for all active projects',                       category: 'Reporting'  },
      { title: 'Prepare next progress claim for any project within 5 working days of claim date', category: 'Operations' },
    ],
    monday: [
      { title: 'Weekly claims review — total outstanding, overdue, upcoming',        category: 'Reporting'  },
    ],
  },
  'Sales': {
    daily: [
      { title: 'Follow up on outstanding quotations with clients',                   category: 'Operations'  },
      { title: 'Check for new enquiries / tender invitations',                       category: 'Operations'  },
      { title: 'Update sales pipeline — Tendering / Quotation stage projects',       category: 'Reporting'   },
    ],
    monday: [
      { title: 'Weekly sales pipeline review — total quoted, pending decisions, lost jobs', category: 'Reporting' },
    ],
  },
  'Finance': {
    daily: [
      { title: 'Issue invoices for any certified claims within 24 hours of QS confirmation', category: 'Operations' },
      { title: 'Update payment received — match to bank statement',                  category: 'Reporting'  },
      { title: 'Flag any invoice unpaid past 30 days to QS + boss',                  category: 'Operations' },
    ],
    monday: [
      { title: 'Weekly AR aging report — outstanding by project and age bucket',     category: 'Reporting'  },
    ],
  },
  'Site Engineer': {
    daily: [
      { title: 'Set today\'s installation target — project, item, qty, location',    category: 'Operations' },
      { title: 'Check factory readiness for items needed this week',                 category: 'Operations' },
      { title: 'Update installation progress on active projects',                    category: 'Reporting'  },
      { title: 'Log result — qty done vs target, reason if short: Site Not Ready / Factory Delay / Manpower Shortage / Weather / Client Access / Other', category: 'Reporting' },
    ],
    monday: [
      { title: 'Weekly site planning — align with factory on delivery schedule',     category: 'Operations' },
    ],
  },
  'Site Engineer 2': {
    daily: [
      { title: 'Set today\'s installation target — project, item, qty, location',    category: 'Operations' },
      { title: 'Check factory readiness for items needed this week',                 category: 'Operations' },
      { title: 'Update installation progress on active projects',                    category: 'Reporting'  },
      { title: 'Log result — qty done vs target, reason if short: Site Not Ready / Factory Delay / Manpower Shortage / Weather / Client Access / Other', category: 'Reporting' },
    ],
    monday: [
      { title: 'Weekly site planning — align with factory on delivery schedule',     category: 'Operations' },
    ],
  },
};

// Get current date/day-of-week in Singapore time
function getSGTContext() {
  const nowSGT = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const yyyy = nowSGT.getFullYear();
  const mm   = String(nowSGT.getMonth() + 1).padStart(2, '0');
  const dd   = String(nowSGT.getDate()).padStart(2, '0');
  return { today: `${yyyy}-${mm}-${dd}`, dayOfWeek: nowSGT.getDay() }; // 0=Sun,1=Mon...
}

function cleanDuplicateRecurringTasks() {
  try {
    const todayStr = todaySGT();
    const tasks = readTasks();
    const seen = new Map(); // key: "assignedTo|title" -> index of first occurrence
    const toRemove = new Set();
    tasks.forEach((t, i) => {
      if (t.taskType !== 'Recurring') return;
      if ((t.dueDate || '').slice(0,10) !== todayStr) return;
      const key = `${t.assignedTo}|${t.title}`;
      if (seen.has(key)) {
        toRemove.add(i);
      } else {
        seen.set(key, i);
      }
    });
    if (toRemove.size > 0) {
      const cleaned = tasks.filter((_, i) => !toRemove.has(i));
      writeTasks(cleaned);
      console.log(`[STARTUP] Removed ${toRemove.size} duplicate recurring tasks`);
    } else {
      console.log(`[STARTUP] No duplicate recurring tasks found`);
    }
  } catch (e) {
    console.error('[STARTUP] cleanDuplicateRecurringTasks failed:', e.message);
  }
}

async function createDailyRecurringTasks() {
  try {
  const { today, dayOfWeek } = getSGTContext();
  const isMonday = dayOfWeek === 1;
  const tasks = readTasks();
  const newTasks = [];
  let _idSeq = 0; // ensure unique IDs even within same ms

  // Resolve roles to person names from staff.json
  const staff = readStaff();
  const rolePeople = [];
  for (const role of Object.keys(RECURRING_ROLE_DEFS)) {
    const entry = staff[role];
    if (entry && entry.name) rolePeople.push({ person: entry.name, role });
  }
  for (const { person, role } of rolePeople) {
    const defs = RECURRING_ROLE_DEFS[role] || {};
    const daily  = defs.daily || [];
    const monday = isMonday ? (defs.monday || []) : [];
    const allDefs = daily.concat(monday);

    for (const def of allDefs) {
      // Dedup: skip if same assignedTo + title already exists for today (use dueDate which is SGT-stamped)
      const todaySGTStr = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Singapore"})).toISOString().slice(0,10);
      const exists = tasks.some(t =>
        t.assignedTo === person &&
        t.title === def.title &&
        (t.dueDate || t.createdAt || "").slice(0,10) === todaySGTStr
      );
      if (exists) continue;

      _idSeq++;
      const task = {
        id:                  Date.now().toString(36) + _idSeq.toString(36) + Math.random().toString(36).slice(2, 4),
        projectId:           '',
        projectJobCode:      '',
        projectName:         '',
        title:               def.title,
        description:         '',
        taskType:            'Recurring',
        category:            def.category,
        assignedTo:          person,
        requestedBy:         'System',
        createdBy:           'System',
        createdAt:           new Date().toISOString(),
        dueDate:             today,
        status:              'Pending',
        priority:            'Normal',
        hoursLogged:         [],
        completedAt:         null,
        linkedMeetingNoteIdx: null,
        tags:                ['recurring'],
        weekOf:              getWeekStart(),
        archived:            false,
        archivedAt:          null
      };
      tasks.push(task);
      newTasks.push(task);
    }
  }

  if (newTasks.length > 0) {
    writeTasks(tasks);
    const roles = [...new Set(newTasks.map(t => t.assignedTo))];
    logActivity('recurring-tasks.created', { date: today, count: newTasks.length, roles });
    console.log(`[RECURRING] Created ${newTasks.length} tasks for ${today} (${roles.join(', ')})`);

    // ── Task 4: Send each person their task list by email ─────────────────
    const nowSGT = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
    const dayName = nowSGT.toLocaleDateString('en-SG', { weekday: 'long' });
    const dateFmt = nowSGT.toLocaleDateString('en-SG', { day: 'numeric', month: 'long', year: 'numeric' });
    // Serialize sends — Graph throttles per-mailbox concurrency aggressively
    // (especially under EMAIL_TEST_OVERRIDE where every email lands in one inbox).
    for (const person of roles) {
      const personEmail = getStaffEmail(person);
      if (!personEmail) {
        console.warn(`[RECURRING] No email for ${person} — skipping daily task email`);
        continue;
      }
      const personTasks = newTasks.filter(t => t.assignedTo === person);
      if (!personTasks.length) continue;
      const taskListHtml = personTasks.map((t, i) =>
        `<li style="padding:7px 0;border-bottom:1px solid #eee;list-style:none;display:flex;align-items:flex-start;gap:8px;">` +
        `<span style="color:#3366ff;font-size:13px;font-weight:700;flex-shrink:0;min-width:20px;">${i + 1}.</span>` +
        `<div><span style="font-size:13px;">${escHtml(t.title)}</span> ` +
        `<span style="display:inline-block;font-size:10px;font-weight:700;color:#fff;background:#3366ff;border-radius:4px;padding:1px 6px;margin-left:4px;vertical-align:middle;">${escHtml(t.category)}</span></div>` +
        `</li>`
      ).join('');
      const firstName = person.split(' ')[0];
      const htmlBody = emailWrap(null,
        `<p style="margin:0 0 4px;font-size:15px;font-weight:700;">Good morning ${escHtml(firstName)}</p>` +
        `<p style="margin:0 0 16px;font-size:12px;color:#888;">${dayName}, ${dateFmt}</p>` +
        `<p style="margin:0 0 10px;font-size:13px;">Here are your <strong>${personTasks.length} task${personTasks.length !== 1 ? 's' : ''}</strong> for today:</p>` +
        `<ul style="padding:0;margin:0 0 20px;">${taskListHtml}</ul>` +
        emailWarnBox('Remember to submit your EOD report by 6pm'),
        'Open My Tasks', `${APP_URL}/my-tasks#${firstName.toLowerCase()}`);
      try {
        await sendEmail(personEmail, person, `Good morning ${firstName} — Your tasks for ${dayName}, ${dateFmt}`, htmlBody);
      } catch (e) {
        console.error(`[RECURRING] Email failed for ${person}:`, e.message);
      }
      // 2s gap between sends to stay within Graph API MailboxConcurrency limits (30/min)
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`[RECURRING] Daily task emails sent for ${today}`);
  } else {
    console.log(`[RECURRING] ${today}: all recurring tasks already exist — skipped`);
  }
  } catch (e) { logError('cron.daily-recurring', e); }
}

// Schedule: 8:45am SGT, Mon–Fri
cron.schedule('45 8 * * 1-5', createDailyRecurringTasks, { timezone: 'Asia/Singapore' });
console.log('[RECURRING] Daily task cron scheduled: 8:45am SGT, Mon–Fri');

// Admin endpoint to run the recurring-task seeder on demand. Same function
// the 8:45am cron calls. Idempotent — dedups by assignedTo+title+today.
app.post('/api/admin/seed-recurring-tasks', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const before = readTasks().length;
    await createDailyRecurringTasks();
    const after  = readTasks().length;
    res.json({ ok: true, created: after - before, total: after });
  } catch (e) {
    logError('route.post.seed-recurring-tasks', e);
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

// ── Procurement Helpers ───────────────────────────────────────────────────────
function readSuppliers()    { try { if (!fs.existsSync(SUPPLIERS_FILE)) return []; return safeReadJSON(SUPPLIERS_FILE); } catch { return []; } }
function writeSuppliers(d)  { safeWriteJSON(SUPPLIERS_FILE, d); }
function readPrices()       { try { if (!fs.existsSync(PRICES_FILE)) return []; return safeReadJSON(PRICES_FILE); } catch { return []; } }
function writePrices(d)     { safeWriteJSON(PRICES_FILE, d); }
function readPOs()          { try { if (!fs.existsSync(PO_FILE)) return []; return safeReadJSON(PO_FILE); } catch { return []; } }
function writePOs(d)        { safeWriteJSON(PO_FILE, d); }
function readPRs()          { try { if (!fs.existsSync(PR_FILE)) return []; return safeReadJSON(PR_FILE); } catch { return []; } }
function writePRs(d)        { safeWriteJSON(PR_FILE, d); }
function readDOs()           { try { if (!fs.existsSync(DO_FILE)) return []; return safeReadJSON(DO_FILE); } catch { return []; } }
function writeDOs(d)         { safeWriteJSON(DO_FILE, d); }

// Auto-flag Overdue: promisedDate < today and status !== Delivered
function applyOverdueFlag(pos) {
  const today = todaySGT();
  return pos.map(po => {
    if (po.status !== 'Delivered' && po.promisedDate && po.promisedDate < today) {
      return Object.assign({}, po, { status: 'Overdue' });
    }
    return po;
  });
}

// ── Suppliers API ─────────────────────────────────────────────────────────────
app.get('/api/suppliers', (req, res) => {
  try { res.json(readSuppliers()); }
  catch (e) { logError('route.get.suppliers', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/suppliers', postRateLimit, (req, res) => {
  try {
    const b = req.body;
    const supplier = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name:            String(b.name            || '').trim().slice(0, 200),
      country:         String(b.country         || '').trim().slice(0, 100),
      materialTypes:   Array.isArray(b.materialTypes) ? b.materialTypes : [],
      contactPerson:   String(b.contactPerson   || '').trim().slice(0, 100),
      phone:           String(b.phone           || '').trim().slice(0, 50),
      email:           String(b.email           || '').trim().slice(0, 200),
      paymentTerms:    String(b.paymentTerms    || '').trim().slice(0, 100),
      leadTimeDays:    parseInt(b.leadTimeDays)  || 0,
      reliabilityScore: Math.min(5, Math.max(1, parseInt(b.reliabilityScore) || 3)),
      notes:           String(b.notes           || '').trim().slice(0, 1000),
      active:          b.active !== false,
      createdAt:       new Date().toISOString()
    };
    if (!supplier.name) return res.status(400).json({ error: 'name required' });
    const suppliers = readSuppliers();
    suppliers.push(supplier);
    writeSuppliers(suppliers);
    logActivity('supplier.created', { id: supplier.id, name: supplier.name });
    res.status(201).json(supplier);
  } catch (e) { logError('route.post.suppliers', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/suppliers/:id', (req, res) => {
  try {
    const suppliers = readSuppliers();
    const idx = suppliers.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Supplier not found' });
    const b = req.body;
    const s = suppliers[idx];
    suppliers[idx] = Object.assign({}, s, {
      name:            String(b.name            !== undefined ? b.name            : s.name).trim().slice(0, 200),
      country:         String(b.country         !== undefined ? b.country         : s.country).trim().slice(0, 100),
      materialTypes:   Array.isArray(b.materialTypes) ? b.materialTypes : s.materialTypes,
      contactPerson:   String(b.contactPerson   !== undefined ? b.contactPerson   : s.contactPerson).trim().slice(0, 100),
      phone:           String(b.phone           !== undefined ? b.phone           : s.phone).trim().slice(0, 50),
      email:           String(b.email           !== undefined ? b.email           : s.email).trim().slice(0, 200),
      paymentTerms:    String(b.paymentTerms    !== undefined ? b.paymentTerms    : s.paymentTerms).trim().slice(0, 100),
      leadTimeDays:    b.leadTimeDays    !== undefined ? (parseInt(b.leadTimeDays) || 0)                                : s.leadTimeDays,
      reliabilityScore: b.reliabilityScore !== undefined ? Math.min(5, Math.max(1, parseInt(b.reliabilityScore) || 3)) : s.reliabilityScore,
      notes:           b.notes           !== undefined ? String(b.notes).trim().slice(0, 1000)                         : s.notes,
      active:          b.active          !== undefined ? !!b.active                                                    : s.active,
      updatedAt:       new Date().toISOString()
    });
    writeSuppliers(suppliers);
    logActivity('supplier.updated', { id: suppliers[idx].id, name: suppliers[idx].name });
    res.json(suppliers[idx]);
  } catch (e) { logError('route.put.suppliers', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/suppliers/:id', (req, res) => {
  try {
    const suppliers = readSuppliers();
    const idx = suppliers.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Supplier not found' });
    const removed = suppliers.splice(idx, 1)[0];
    writeSuppliers(suppliers);
    logActivity('supplier.deleted', { id: removed.id, name: removed.name });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.suppliers', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Price Tracking API ────────────────────────────────────────────────────────
app.get('/api/prices', (req, res) => {
  try { res.json(readPrices()); }
  catch (e) { logError('route.get.prices', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/prices/:id', (req, res) => {
  try {
    const prices = readPrices();
    const idx = prices.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Price entry not found' });
    const b = req.body;
    prices[idx] = Object.assign({}, prices[idx], {
      material:     b.material     !== undefined ? String(b.material).trim().slice(0, 100)     : prices[idx].material,
      grade:        b.grade        !== undefined ? String(b.grade).trim().slice(0, 100)         : prices[idx].grade,
      unitPrice:    b.unitPrice    !== undefined ? (parseFloat(b.unitPrice) || 0)              : prices[idx].unitPrice,
      unit:         b.unit         !== undefined ? String(b.unit).trim().slice(0, 30)          : prices[idx].unit,
      supplierId:   b.supplierId   !== undefined ? String(b.supplierId).trim()                 : prices[idx].supplierId,
      supplierName: b.supplierName !== undefined ? String(b.supplierName).trim().slice(0, 200) : prices[idx].supplierName,
      date:         b.date         !== undefined ? String(b.date).trim().slice(0, 10)          : prices[idx].date,
      notes:        b.notes        !== undefined ? String(b.notes).trim().slice(0, 500)        : prices[idx].notes,
      leadTimeDays: b.leadTimeDays !== undefined ? (parseInt(b.leadTimeDays) || null)          : prices[idx].leadTimeDays,
      updatedAt:    new Date().toISOString()
    });
    writePrices(prices);
    logActivity('price.updated', { id: prices[idx].id, material: prices[idx].material });
    res.json(prices[idx]);
  } catch (e) { logError('route.put.prices', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/prices/:id', (req, res) => {
  try {
    const prices = readPrices();
    const idx = prices.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Price entry not found' });
    const removed = prices.splice(idx, 1)[0];
    writePrices(prices);
    logActivity('price.deleted', { id: removed.id, material: removed.material });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.prices', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/prices', postRateLimit, (req, res) => {
  try {
    const b = req.body;
    const price = {
      id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      material:     String(b.material     || '').trim().slice(0, 100),
      grade:        String(b.grade        || '').trim().slice(0, 100),
      unitPrice:    parseFloat(b.unitPrice) || 0,
      unit:         String(b.unit         || '').trim().slice(0, 30),
      supplierId:   String(b.supplierId   || '').trim(),
      supplierName: String(b.supplierName || '').trim().slice(0, 200),
      date:         String(b.date || todaySGT()).trim().slice(0, 10),
      notes:        String(b.notes        || '').trim().slice(0, 500),
      createdAt:    new Date().toISOString()
    };
    if (!price.material || !price.unitPrice) return res.status(400).json({ error: 'material and unitPrice required' });
    const prices = readPrices();
    prices.push(price);
    writePrices(prices);
    logActivity('price.logged', { id: price.id, material: price.material, unitPrice: price.unitPrice });
    res.status(201).json(price);
  } catch (e) { logError('route.post.prices', e); res.status(500).json({ error: 'Internal server error' }); }
});

// /api/purchase-orders CRUD removed — dead routes, no frontend caller, no data file

// ── Sales Pipeline API ────────────────────────────────────────────────────────
const OPPS_FILE = path.join(__dirname, 'data', 'opportunities.json');
function readOpps() { if (!fs.existsSync(OPPS_FILE)) return []; return safeReadJSON(OPPS_FILE); }
function writeOpps(d) { safeWriteJSON(OPPS_FILE, d); }

const SALES_ACCESS = new Set((() => {
  const staff = readStaff();
  const names = new Set();
  // GM (boss) + Sales always have write access
  for (const key of ['GM', 'Boss', 'Sales']) {
    if (staff[key] && staff[key].name) names.add(staff[key].name);
  }
  if (!names.size) { names.add('Lai Wei Xiang'); names.add('Janessa'); }
  return [...names];
})());
const SALES_READ = new Set([...SALES_ACCESS, ...((() => {
  const staff = readStaff();
  const names = [];
  if (staff['Finance'] && staff['Finance'].name) names.push(staff['Finance'].name);
  return names;
})())]);
const VALID_OPP_STAGES = ['New Lead', 'Discovery', 'Tender Review', 'Quotation', 'Presentation', 'Pending Tender', 'Tender Awarded', 'Won', 'Lost', 'No-Bid'];

function requireSalesAccess(req, res, readOnly) {
  const user = req.authUser || (req.session && req.session.user);
  const allowed = readOnly ? SALES_READ : SALES_ACCESS;
  if (!user || !allowed.has(user)) {
    res.status(403).json({ error: 'Sales access restricted' });
    return false;
  }
  return true;
}

// GET /api/sales/opportunities
app.get('/api/sales/opportunities', (req, res) => {
  if (!requireSalesAccess(req, res, true)) return;
  try {
    const opps = readOpps();
    opps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (req.query.stage) return res.json(opps.filter(o => o.stage === req.query.stage));
    res.json(opps);
  } catch (e) { logError('route.get.sales.opportunities', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/sales/stats
app.get('/api/sales/stats', (req, res) => {
  if (!requireSalesAccess(req, res, true)) return;
  try {
    const opps = readOpps();
    const active = opps.filter(o => !['Won', 'Lost', 'No-Bid'].includes(o.stage));
    const won = opps.filter(o => o.stage === 'Won');
    const lost = opps.filter(o => o.stage === 'Lost');
    const closed = won.length + lost.length;
    const today = todaySGT();
    const expiring = opps.filter(o => o.quoteExpiryDate && o.quoteExpiryDate <= today && o.stage === 'Quotation');
    const overdueFU = active.filter(o => o.nextFollowUpDate && o.nextFollowUpDate <= today).length;
    const pipeline = active.reduce((s, o) => s + (o.estimatedValue || 0), 0);
    // Avg days per stage (for active opps)
    const stageAvg = {};
    const now = Date.now();
    for (const s of VALID_OPP_STAGES) {
      const inStage = opps.filter(o => o.stage === s && o.stageChangedAt);
      if (inStage.length) {
        const avg = Math.round(inStage.reduce((sum, o) => sum + (now - new Date(o.stageChangedAt).getTime()) / 86400000, 0) / inStage.length);
        stageAvg[s] = avg;
      }
    }
    // Pipeline value by stage
    const pipelineByStage = {};
    for (const o of active) {
      pipelineByStage[o.stage] = (pipelineByStage[o.stage] || 0) + (o.estimatedValue || 0);
    }
    // Sales access list for frontend (derived from roles, not hardcoded)
    const salesUsers = [...SALES_ACCESS];
    res.json({
      pipelineValue: pipeline,
      openCount: active.length,
      winRate: closed > 0 ? Math.round((won.length / closed) * 100) : 0,
      expiringQuotes: expiring.length,
      overdueFU,
      wonCount: won.length,
      lostCount: lost.length,
      totalValue: won.reduce((s, o) => s + (o.estimatedValue || 0), 0),
      stageAvg,
      pipelineByStage,
      salesUsers
    });
  } catch (e) { logError('route.get.sales.stats', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/sales/opportunities
app.post('/api/sales/opportunities', postRateLimit, (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const b = req.body;
    const clientName = sanitizeStr(b.clientName, 200);
    if (!clientName) return res.status(400).json({ error: 'clientName required' });
    const stage = VALID_OPP_STAGES.includes(b.stage) ? b.stage : 'New Lead';
    const opp = {
      id: 'opp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      clientName,
      contactPerson:  sanitizeStr(b.contactPerson, 200),
      phone:          sanitizeStr(b.phone, 50),
      email:          sanitizeStr(b.email, 200),
      siteAddress:    sanitizeStr(b.siteAddress, 500),
      productType:    sanitizeStr(b.productType, 100),
      estimatedValue: parseFloat(b.estimatedValue) || 0,
      quotationNo:    sanitizeStr(b.quotationNo, 50),
      quoteDate:      b.quoteDate && isValidDate(b.quoteDate) ? b.quoteDate : null,
      quoteExpiryDate: b.quoteExpiryDate && isValidDate(b.quoteExpiryDate) ? b.quoteExpiryDate : null,
      source:         sanitizeStr(b.source, 100),
      stage,
      stageChangedAt: new Date().toISOString(),
      followUpDate:   b.followUpDate && isValidDate(b.followUpDate) ? b.followUpDate : null,
      assignedTo:     sanitizeStr(b.assignedTo, 100),
      notes:          sanitizeStr(b.notes, 2000),
      winLossReason:  '',
      competitorInfo: sanitizeStr(b.competitorInfo, 500),
      convertedProjectId: null,
      // Follow-up engine
      followUps: [],
      nextFollowUpDate: null,
      fuSequence: 0,
      afuSequence: 0,
      qsAssigned: sanitizeStr(b.qsAssigned, 100) || '',
      tenderDocUrls: [],
      quotationFileUrl: null,
      activity: [{ ts: new Date().toISOString(), type: 'created', note: `Opportunity created by ${getAuthUser()}` }],
      createdBy:      getAuthUser(),
      createdAt:      new Date().toISOString()
    };
    const opps = readOpps();
    opps.push(opp);
    writeOpps(opps);
    logActivity('sales.opportunity.created', { id: opp.id, client: clientName, value: opp.estimatedValue });
    res.status(201).json(opp);
  } catch (e) { logError('route.post.sales.opportunity', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/sales/opportunities/:id
app.put('/api/sales/opportunities/:id', (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Opportunity not found' });
    const b = req.body;
    const OPP_WRITABLE = ['clientName','contactPerson','phone','email','siteAddress','productType',
      'estimatedValue','quotationNo','quoteDate','quoteExpiryDate','source','stage',
      'followUpDate','assignedTo','notes','winLossReason','competitorInfo',
      'nextFollowUpDate','qsAssigned','quotationFileUrl'];
    const oldStage = opps[idx].stage;
    for (const k of OPP_WRITABLE) {
      if (b[k] !== undefined) {
        if (k === 'estimatedValue') opps[idx][k] = parseFloat(b[k]) || 0;
        else if (k === 'stage' && !VALID_OPP_STAGES.includes(b[k])) continue;
        else opps[idx][k] = typeof b[k] === 'string' ? sanitizeStr(b[k], k === 'notes' ? 2000 : 500) : b[k];
      }
    }
    // Track stage changes
    if (b.stage && b.stage !== oldStage) {
      opps[idx].stageChangedAt = new Date().toISOString();
      if (!opps[idx].activity) opps[idx].activity = [];
      opps[idx].activity.push({
        ts: new Date().toISOString(),
        type: 'stage-change',
        note: `${oldStage} → ${b.stage} by ${getAuthUser()}`
      });

      // ── Auto-task: create QS task when entering Tender Review ──
      if (b.stage === 'Tender Review') {
        try {
          const opp = opps[idx];
          const qsName = opp.qsAssigned || (readStaff()['QS'] || {}).name || '';
          if (qsName) {
            const tasks = readTasks();
            // Avoid duplicate: check if a sales-review task already exists for this opp
            const exists = tasks.some(t => t.projectId === opp.id && t.category === 'sales-review' && t.status !== 'Done');
            if (!exists) {
              const deadline = dateSGT(5);
              const task = {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                title: `Prepare quotation for ${opp.clientName}`,
                description: `Client: ${opp.clientName}\nProduct: ${opp.productType || '—'}\nEstimated value: $${(opp.estimatedValue || 0).toLocaleString()}\nEmail: ${opp.email || '—'}\nSite: ${opp.siteAddress || '—'}`,
                taskType: 'Request',
                category: 'sales-review',
                assignedTo: qsName,
                requestedBy: opp.assignedTo || getAuthUser(),
                dueDate: deadline,
                status: 'Pending',
                priority: 'High',
                notes: '',
                projectId: opp.id,
                projectJobCode: opp.quotationNo || '',
                projectName: opp.clientName,
                createdAt: new Date().toISOString(),
                weekOf: null
              };
              tasks.push(task);
              writeTasks(tasks);
              opp.activity.push({ ts: new Date().toISOString(), type: 'auto-task', note: `Auto-created QS task for ${qsName} (due ${deadline})` });
              logActivity('sales.qs-task.auto-created', { oppId: opp.id, qsName, taskId: task.id });

              // Email QS
              const qsEmail = getStaffEmail(qsName);
              if (qsEmail) {
                sendEmail(qsEmail, qsName,
                  `[Quotation Request] ${opp.clientName} — ${opp.productType || 'New tender'}`,
                  emailWrap(`Hi ${escHtml(qsName)},`,
                    `<p style="margin:0 0 16px;">A new quotation has been requested:</p>` +
                    emailTable([
                      ['Client', escHtml(opp.clientName)],
                      ['Product', escHtml(opp.productType || '—')],
                      ['Estimated Value', '$' + (opp.estimatedValue || 0).toLocaleString()],
                      ['Deadline', deadline],
                      ['Requested By', escHtml(opp.assignedTo || '—')]
                    ]),
                    'View My Tasks', `${APP_URL}/my-tasks`)
                ).catch(() => {});
              }
            }
          }
        } catch (taskErr) { logError('sales.qs-task.auto-create', taskErr); }
      }

      // ── Auto-schedule first FU when entering Pending Tender ──
      if (b.stage === 'Pending Tender' && !opps[idx].nextFollowUpDate) {
        const fuDate = dateSGT(25);
        opps[idx].nextFollowUpDate = fuDate;
        opps[idx].fuSequence = 0;
        opps[idx].activity.push({ ts: new Date().toISOString(), type: 'auto-fu', note: `FU1 auto-scheduled for ${fuDate}` });
      }

      // ── Auto-schedule first AFU when entering Tender Awarded ──
      if (b.stage === 'Tender Awarded' && !opps[idx].nextFollowUpDate) {
        const afuDate = dateSGT(25);
        opps[idx].nextFollowUpDate = afuDate;
        opps[idx].afuSequence = 0;
        opps[idx].activity.push({ ts: new Date().toISOString(), type: 'auto-fu', note: `AFU1 auto-scheduled for ${afuDate}` });
      }
    }

    // ── Auto-advance: Tender Review → Quotation when quote uploaded ──
    if (b.quotationFileUrl && opps[idx].stage === 'Tender Review') {
      opps[idx].stage = 'Quotation';
      opps[idx].stageChangedAt = new Date().toISOString();
      if (!opps[idx].activity) opps[idx].activity = [];
      opps[idx].activity.push({
        ts: new Date().toISOString(),
        type: 'stage-change',
        note: `Tender Review → Quotation (auto-advanced on quotation upload)`
      });
    }

    // Track notes/follow-up as activity
    if (b.activityNote) {
      if (!opps[idx].activity) opps[idx].activity = [];
      opps[idx].activity.push({
        ts: new Date().toISOString(),
        type: 'note',
        note: sanitizeStr(b.activityNote, 1000)
      });
    }
    opps[idx].updatedAt = new Date().toISOString();
    writeOpps(opps);
    logActivity('sales.opportunity.updated', { id: opps[idx].id, stage: opps[idx].stage });
    res.json(opps[idx]);
  } catch (e) { logError('route.put.sales.opportunity', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/sales/opportunities/:id/follow-up — log a follow-up call
app.post('/api/sales/opportunities/:id/follow-up', postRateLimit, (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Opportunity not found' });
    const opp = opps[idx];
    const outcome = sanitizeStr(req.body.outcome, 30);
    const notes = sanitizeStr(req.body.notes, 2000);
    if (!notes) return res.status(400).json({ error: 'Call notes are mandatory' });
    if (!['Connected', 'NPU', 'Voicemail', 'No Answer'].includes(outcome)) {
      return res.status(400).json({ error: 'Invalid outcome. Must be Connected, NPU, Voicemail, or No Answer' });
    }

    // Determine FU type based on stage
    const isAFU = opp.stage === 'Tender Awarded';
    const seqKey = isAFU ? 'afuSequence' : 'fuSequence';
    const currentSeq = (opp[seqKey] || 0) + 1;
    opp[seqKey] = currentSeq;
    const fuType = (isAFU ? 'AFU' : 'FU') + currentSeq;

    // Calculate next follow-up date
    let nextDate = null;
    const intervalDays = parseInt(req.body.intervalDays, 10) || 25; // default ~3.5 weeks
    if (outcome === 'Connected') {
      // Connected → schedule next FU in 3-4 weeks
      nextDate = dateSGT(intervalDays);
    } else {
      // NPU / Voicemail / No Answer → retry in 2 days, same FU number
      nextDate = dateSGT(2);
      opp[seqKey] = currentSeq - 1; // don't increment — same FU retry
    }

    const fuEntry = {
      id: 'fu-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      scheduledDate: opp.nextFollowUpDate || todaySGT(),
      completedAt: new Date().toISOString(),
      type: fuType,
      outcome,
      notes,
      nextAction: outcome === 'Connected' ? (isAFU ? 'AFU' : 'FU') + (opp[seqKey] + 1) : fuType + ' retry',
      nextDate,
      loggedBy: getAuthUser()
    };

    if (!Array.isArray(opp.followUps)) opp.followUps = [];
    opp.followUps.push(fuEntry);
    opp.nextFollowUpDate = nextDate;

    // Also log to activity timeline
    if (!Array.isArray(opp.activity)) opp.activity = [];
    opp.activity.push({
      ts: new Date().toISOString(),
      type: 'follow-up-call',
      note: `${fuType}: ${outcome} — ${notes}${nextDate ? ' → Next: ' + nextDate : ''}`
    });

    opp.updatedAt = new Date().toISOString();
    writeOpps(opps);
    logActivity('sales.follow-up.logged', { oppId: opp.id, client: opp.clientName, fuType, outcome });
    res.json({ followUp: fuEntry, opp });
  } catch (e) { logError('route.post.sales.follow-up', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/sales/opportunities/:id
app.delete('/api/sales/opportunities/:id', (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const removed = opps.splice(idx, 1)[0];
    writeOpps(opps);

    // Clean up the opportunity's upload folder if it exists
    let filesUnlinked = 0;
    try {
      const safeId = path.basename(removed.id);
      const oppDir = path.join(SALES_UPLOADS_DIR, safeId);
      if (path.resolve(oppDir).startsWith(path.resolve(SALES_UPLOADS_DIR) + path.sep) && fs.existsSync(oppDir)) {
        filesUnlinked = fs.readdirSync(oppDir).length;
        fs.rmSync(oppDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) { logError('sales.opportunity.delete.cleanup', cleanupErr); }

    logActivity('sales.opportunity.deleted', { id: removed.id, client: removed.clientName, reason: sanitizeStr(req.query?.reason, 500), filesUnlinked });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.sales.opportunity', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/sales/convert-to-project/:id — convert Won opportunity to project
app.post('/api/sales/convert-to-project/:id', (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Opportunity not found' });
    if (opps[idx].stage !== 'Won') return res.status(400).json({ error: 'Only Won opportunities can be converted' });
    if (opps[idx].convertedProjectId) return res.status(400).json({ error: 'Already converted to project ' + opps[idx].convertedProjectId });

    const opp = opps[idx];
    const projects = readProjects();
    const projectId = 'proj-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const project = {
      id: projectId,
      jobCode: opp.quotationNo || '',
      projectName: opp.clientName + (opp.productType ? ' — ' + opp.productType : ''),
      name: opp.clientName,
      client: opp.clientName,
      contactPerson: opp.contactPerson || '',
      contactEmail: opp.email || '',
      contactPhone: opp.phone || '',
      siteAddress: opp.siteAddress || '',
      contractValue: opp.estimatedValue || 0,
      status: 'Active',
      startDate: todaySGT(),
      stages: [], fabrication: [], installation: [], documents: [], drawings: [],
      productScope: [],
      createdBy: getAuthUser(),
      createdAt: new Date().toISOString(),
      convertedFromOpportunity: opp.id
    };
    projects.push(deriveFields(project));
    writeProjects(projects);

    // Mark opportunity as converted
    opps[idx].convertedProjectId = projectId;
    opps[idx].stage = 'Won';
    if (!opps[idx].activity) opps[idx].activity = [];
    opps[idx].activity.push({
      ts: new Date().toISOString(),
      type: 'converted',
      note: `Converted to project ${projectId} by ${getAuthUser()}`
    });
    writeOpps(opps);

    logActivity('sales.converted-to-project', { oppId: opp.id, projectId, client: opp.clientName });
    res.status(201).json({ ok: true, projectId, project });
  } catch (e) { logError('route.post.sales.convert', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Sales: Email compose (send from CRM) ─────────────────────────────────────
app.post('/api/sales/opportunities/:id/send-email', postRateLimit, async (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Opportunity not found' });
    const opp = opps[idx];

    const to = sanitizeStr(req.body.to, 200);
    const subject = sanitizeStr(req.body.subject, 300);
    const body = sanitizeStr(req.body.body, 5000);
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, and body are required' });

    // Send via Graph API
    await sendEmail(to, opp.contactPerson || opp.clientName, subject,
      emailWrap(null, `<div style="white-space:pre-wrap;">${escHtml(body)}</div>`));

    // Log to activity timeline
    if (!Array.isArray(opp.activity)) opp.activity = [];
    opp.activity.push({
      ts: new Date().toISOString(),
      type: 'email',
      note: `📧 Sent to ${to}: "${subject}"`
    });
    opp.updatedAt = new Date().toISOString();
    writeOpps(opps);
    logActivity('sales.email.sent', { oppId: opp.id, to, subject });
    res.json({ ok: true });
  } catch (e) { logError('route.post.sales.send-email', e); res.status(500).json({ error: 'Send failed: ' + (e.message || 'unknown') }); }
});

// ── Sales: Email templates ───────────────────────────────────────────────────
app.get('/api/sales/email-templates', (req, res) => {
  if (!requireSalesAccess(req, res, true)) return;
  const salesName = (readStaff()['Sales'] || {}).name || 'Sales Team';
  const companyName = 'Lai Yew Seng Engineering Pte Ltd';
  res.json([
    {
      id: 'discovery-intro',
      name: 'Discovery Call Intro',
      subject: 'Re: Your Enquiry — Schedule a Call',
      body: `Dear {{clientName}},\n\nThank you for your enquiry. We would like to schedule a brief call to understand your requirements better.\n\nPlease select a convenient time slot using the link below:\n[Insert Calendly/Booking Link]\n\nLooking forward to speaking with you.\n\nBest regards,\n${salesName}\n${companyName}`
    },
    {
      id: 'post-call-recap',
      name: 'Post-Call Recap',
      subject: 'Meeting Recap — {{clientName}}',
      body: `Dear {{clientName}},\n\nThank you for your time today. Here is a summary of what we discussed:\n\n- [Key points from call]\n- [Next steps]\n\nWe will prepare a quotation and get back to you by [date].\n\nBest regards,\n${salesName}\n${companyName}`
    },
    {
      id: 'quotation-cover',
      name: 'Quotation Cover Letter',
      subject: 'Quotation — {{clientName}}',
      body: `Dear {{clientName}},\n\nPlease find attached our quotation for your review.\n\nQuotation No: {{quotationNo}}\nValidity: 30 days from date of issue\n\nShould you have any queries, please do not hesitate to contact us.\n\nBest regards,\n${salesName}\n${companyName}`
    },
    {
      id: 'follow-up-nudge',
      name: 'Follow-Up Nudge',
      subject: 'Following Up — {{clientName}}',
      body: `Dear {{clientName}},\n\nI hope this email finds you well. I wanted to follow up on our previous conversation regarding your project.\n\nWould you be available for a quick call this week to discuss the next steps?\n\nBest regards,\n${salesName}\n${companyName}`
    }
  ]);
});

// ── Sales: Inbox scanning (read enquiry emails) ─────────────────────────────
// GET /api/sales/inbox — fetch recent emails from configured inboxes matching keywords
app.get('/api/sales/inbox', async (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(503).json({ error: 'Email not configured' });

    const admin = readAdmin();
    const keywords = admin.salesKeywords || ['RFQ', 'Enquiry', 'Tender', 'Quotation', 'Quote', 'Price'];
    const inboxes = admin.salesInboxes || ['enquiry@laiyewseng.com.sg'];

    // Read last 7 days of emails from each inbox
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const allEmails = [];

    for (const mailbox of inboxes) {
      try {
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages` +
          `?$filter=receivedDateTime ge ${since}&$select=id,subject,bodyPreview,from,receivedDateTime,hasAttachments` +
          `&$orderby=receivedDateTime desc&$top=50`;
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
        if (!r.ok) {
          console.warn(`[INBOX] Failed to read ${mailbox}: ${r.status}`);
          continue;
        }
        const data = await r.json();
        const messages = data.value || [];

        // Filter by keywords (case-insensitive match on subject + body preview)
        const keywordRegex = new RegExp(keywords.join('|'), 'i');
        for (const msg of messages) {
          const text = (msg.subject || '') + ' ' + (msg.bodyPreview || '');
          if (!keywordRegex.test(text)) continue;

          // Skip internal emails
          const fromEmail = msg.from?.emailAddress?.address || '';
          if (fromEmail.toLowerCase().endsWith('@laiyewseng.com.sg')) continue;

          allEmails.push({
            id: msg.id,
            mailbox,
            subject: msg.subject || '(No subject)',
            from: msg.from?.emailAddress?.name || fromEmail,
            fromEmail,
            preview: (msg.bodyPreview || '').slice(0, 500),
            receivedAt: msg.receivedDateTime,
            hasAttachments: msg.hasAttachments || false,
            hasLinks: /drive\.google|docs\.google|1drv\.ms|onedrive|sharepoint|dropbox\.com|\.pdf/i.test(msg.bodyPreview || ''),
          });
        }
      } catch (e) {
        console.error(`[INBOX] Error reading ${mailbox}:`, e.message);
      }
    }

    // Deduplicate by fromEmail + subject (within same day)
    const seen = new Set();
    const deduped = allEmails.filter(e => {
      const key = e.fromEmail.toLowerCase() + '|' + (e.subject || '').toLowerCase().slice(0, 50) + '|' + (e.receivedAt || '').slice(0, 10);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Mark which emails already have an opportunity (by sender email)
    const opps = readOpps();
    const oppEmails = new Set(opps.map(o => (o.email || '').toLowerCase()).filter(Boolean));
    deduped.forEach(e => {
      e.existingOpp = oppEmails.has(e.fromEmail.toLowerCase());
    });

    res.json(deduped);
  } catch (e) { logError('route.get.sales.inbox', e); res.status(500).json({ error: 'Failed to scan inbox' }); }
});

// POST /api/sales/inbox/promote — create opportunity from an inbox email
app.post('/api/sales/inbox/promote', postRateLimit, async (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const emailId = sanitizeStr(req.body.emailId, 200);
    const mailbox = sanitizeStr(req.body.mailbox, 200);
    const fromEmail = sanitizeStr(req.body.fromEmail, 200);
    const fromName = sanitizeStr(req.body.fromName, 200);
    const subject = sanitizeStr(req.body.subject, 300);
    if (!fromEmail) return res.status(400).json({ error: 'fromEmail required' });

    // Check if already exists
    const opps = readOpps();
    const recentDupe = opps.find(o =>
      (o.email || '').toLowerCase() === fromEmail.toLowerCase() &&
      new Date(o.createdAt) > new Date(Date.now() - 7 * 86400000)
    );
    if (recentDupe) return res.status(409).json({ error: 'Lead from this email already exists (created ' + recentDupe.createdAt.slice(0, 10) + ')', existingId: recentDupe.id });

    const opp = {
      id: 'opp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      clientName: fromName || fromEmail.split('@')[0],
      contactPerson: fromName || '',
      phone: '',
      email: fromEmail,
      siteAddress: '',
      productType: '',
      estimatedValue: 0,
      quotationNo: '',
      quoteDate: null,
      quoteExpiryDate: null,
      source: 'Email — ' + (mailbox || 'inbox'),
      stage: 'New Lead',
      stageChangedAt: new Date().toISOString(),
      followUpDate: null,
      assignedTo: (readStaff()['Sales'] || {}).name || '',
      notes: subject || '',
      winLossReason: '',
      competitorInfo: '',
      convertedProjectId: null,
      followUps: [],
      nextFollowUpDate: null,
      fuSequence: 0,
      afuSequence: 0,
      qsAssigned: '',
      tenderDocUrls: [],
      quotationFileUrl: null,
      activity: [{
        ts: new Date().toISOString(),
        type: 'created',
        note: `Lead created from email: "${subject}" from ${fromEmail} (${mailbox})`
      }],
      createdBy: getAuthUser(),
      createdAt: new Date().toISOString(),
      _sourceEmailId: emailId,
      _sourceMailbox: mailbox
    };
    opps.push(opp);
    writeOpps(opps);
    logActivity('sales.lead.from-email', { oppId: opp.id, from: fromEmail, subject, mailbox });
    res.status(201).json(opp);
  } catch (e) { logError('route.post.sales.inbox.promote', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/sales/opportunities/:id/calendar-event — create Outlook calendar event
app.post('/api/sales/opportunities/:id/calendar-event', postRateLimit, async (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Opportunity not found' });
    const opp = opps[idx];

    const eventDate = sanitizeStr(req.body.date, 20);
    const eventTime = sanitizeStr(req.body.time, 10) || '10:00';
    const eventType = sanitizeStr(req.body.type, 30); // 'discovery' or 'presentation'
    const duration = parseInt(req.body.duration, 10) || 30; // minutes
    if (!eventDate || !eventType) return res.status(400).json({ error: 'date and type are required' });

    const assigneeEmail = getStaffEmail(opp.assignedTo) || getRoleEmail('Sales');
    if (!assigneeEmail) return res.status(400).json({ error: 'No email for assignee' });

    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(503).json({ error: 'Calendar not configured' });

    const startDT = `${eventDate}T${eventTime}:00`;
    const endMinutes = parseInt(eventTime.split(':')[1] || '0', 10) + duration;
    const endHour = parseInt(eventTime.split(':')[0], 10) + Math.floor(endMinutes / 60);
    const endMin = endMinutes % 60;
    const endDT = `${eventDate}T${String(endHour).padStart(2,'0')}:${String(endMin).padStart(2,'0')}:00`;

    const label = eventType === 'discovery' ? 'Discovery Call' : eventType === 'presentation' ? 'Presentation' : 'Meeting';
    const subject = `[${label}] ${opp.clientName}${opp.productType ? ' — ' + opp.productType : ''}`;
    const bodyHtml = `<p><strong>${escHtml(label)}</strong> with <strong>${escHtml(opp.clientName)}</strong></p>` +
      (opp.contactPerson ? `<p>Contact: ${escHtml(opp.contactPerson)}</p>` : '') +
      (opp.phone ? `<p>Phone: ${escHtml(opp.phone)}</p>` : '') +
      (opp.email ? `<p>Email: ${escHtml(opp.email)}</p>` : '') +
      `<p><a href="${APP_URL}/sales">Open in LYS Sales Pipeline →</a></p>`;

    // Also invite the client if they have an email
    const attendees = [];
    if (opp.email) attendees.push({ emailAddress: { address: opp.email, name: opp.contactPerson || opp.clientName }, type: 'required' });

    const targetEmail = process.env.CALENDAR_TEST_OVERRIDE || assigneeEmail;
    const eventBody = {
      subject,
      body: { contentType: 'HTML', content: bodyHtml },
      start: { dateTime: startDT, timeZone: 'Asia/Singapore' },
      end: { dateTime: endDT, timeZone: 'Asia/Singapore' },
      isReminderOn: true,
      reminderMinutesBeforeStart: 60,
      attendees,
      categories: ['LYS Sales'],
      showAs: 'busy',
    };

    const calRes = await fetch(`https://graph.microsoft.com/v1.0/users/${targetEmail}/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody)
    });
    if (!calRes.ok) {
      const err = await calRes.text();
      logError('sales.calendar.create', new Error(err.slice(0, 200)));
      return res.status(502).json({ error: 'Calendar event creation failed' });
    }
    const calData = await calRes.json();

    // Store event reference on opp
    if (eventType === 'discovery') {
      opp.discoveryCallDate = eventDate;
      opp.discoveryCalEventId = calData.id;
    } else if (eventType === 'presentation') {
      opp.presentationDate = eventDate;
      opp.presentationCalEventId = calData.id;
    }
    if (!Array.isArray(opp.activity)) opp.activity = [];
    opp.activity.push({
      ts: new Date().toISOString(),
      type: 'calendar',
      note: `📅 ${label} scheduled for ${eventDate} at ${eventTime} — calendar invite sent to ${opp.email || 'assignee'}`
    });
    opp.updatedAt = new Date().toISOString();
    writeOpps(opps);
    logActivity('sales.calendar.created', { oppId: opp.id, type: eventType, date: eventDate, eventId: calData.id });
    res.json({ ok: true, eventId: calData.id });
  } catch (e) { logError('route.post.sales.calendar', e); res.status(500).json({ error: 'Failed: ' + (e.message || 'unknown') }); }
});

// POST /api/sales/opportunities/:id/upload — upload file to opportunity
app.post('/api/sales/opportunities/:id/upload', uploadImageOrPdf.single('file'), (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Opportunity not found' });

    const opp = opps[idx];
    const oppDir = path.join(SALES_UPLOADS_DIR, opp.id);
    if (!fs.existsSync(oppDir)) fs.mkdirSync(oppDir, { recursive: true });

    const safeBase = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Prefix timestamp+random so re-uploads of the same filename don't clobber
    const safeName = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safeBase}`;
    const destPath = path.join(oppDir, safeName);
    if (!path.resolve(destPath).startsWith(path.resolve(SALES_UPLOADS_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    fs.renameSync(req.file.path, destPath);

    const publicPath = `/uploads/sales/${opp.id}/${safeName}`;
    if (!Array.isArray(opp.tenderDocUrls)) opp.tenderDocUrls = [];
    if (!opp.tenderDocUrls.includes(publicPath)) opp.tenderDocUrls.push(publicPath);

    // If this is a quotation upload (field hint from frontend)
    const isQuotation = req.body.isQuotation === 'true';
    if (isQuotation) opp.quotationFileUrl = publicPath;

    if (!Array.isArray(opp.activity)) opp.activity = [];
    opp.activity.push({
      ts: new Date().toISOString(),
      type: 'upload',
      note: `📄 Uploaded ${isQuotation ? 'quotation' : 'document'}: ${req.file.originalname}`
    });
    opp.updatedAt = new Date().toISOString();
    writeOpps(opps);
    logActivity('sales.file.uploaded', { oppId: opp.id, file: safeName, isQuotation });
    res.json({ filePath: publicPath, fileName: safeName });
  } catch (e) { logError('route.post.sales.upload', e); res.status(500).json({ error: 'Upload failed' }); }
});

// POST /api/sales/opportunities/:id/fetch-attachments — pull email attachments into the opportunity
app.post('/api/sales/opportunities/:id/fetch-attachments', postRateLimit, async (req, res) => {
  if (!requireSalesAccess(req, res, false)) return;
  try {
    const opps = readOpps();
    const idx = opps.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Opportunity not found' });
    const opp = opps[idx];

    const emailId = req.body.emailId || opp._sourceEmailId;
    const mailbox = req.body.mailbox || opp._sourceMailbox;
    if (!emailId || !mailbox) return res.status(400).json({ error: 'No source email linked to this opportunity' });

    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(503).json({ error: 'Email not configured' });

    // Fetch attachments from the source email
    const attUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${emailId}/attachments`;
    const attRes = await fetch(attUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!attRes.ok) return res.status(502).json({ error: 'Failed to fetch attachments from email' });
    const attData = await attRes.json();
    const attachments = (attData.value || []).filter(a =>
      a.contentBytes && a.name &&
      (a.contentType === 'application/pdf' || /\.(pdf|doc|docx|xls|xlsx|jpg|jpeg|png)$/i.test(a.name))
    );

    if (!attachments.length) return res.json({ fetched: 0, message: 'No downloadable attachments found' });

    // Save to uploads/sales/<oppId>/
    const oppDir = path.join(SALES_UPLOADS_DIR, opp.id);
    if (!fs.existsSync(oppDir)) fs.mkdirSync(oppDir, { recursive: true });

    const saved = [];
    if (!Array.isArray(opp.tenderDocUrls)) opp.tenderDocUrls = [];

    for (const att of attachments) {
      const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(oppDir, safeName);
      // Verify path stays inside uploads dir
      if (!path.resolve(filePath).startsWith(path.resolve(SALES_UPLOADS_DIR))) continue;
      fs.writeFileSync(filePath, Buffer.from(att.contentBytes, 'base64'));
      const publicPath = `/uploads/sales/${opp.id}/${safeName}`;
      if (!opp.tenderDocUrls.includes(publicPath)) opp.tenderDocUrls.push(publicPath);
      saved.push({ name: att.name, path: publicPath, size: att.size });
    }

    if (saved.length) {
      if (!Array.isArray(opp.activity)) opp.activity = [];
      opp.activity.push({
        ts: new Date().toISOString(),
        type: 'attachment',
        note: `📎 Fetched ${saved.length} file(s) from email: ${saved.map(s => s.name).join(', ')}`
      });
      opp.updatedAt = new Date().toISOString();
      writeOpps(opps);
      logActivity('sales.attachments.fetched', { oppId: opp.id, count: saved.length, files: saved.map(s => s.name) });
    }

    res.json({ fetched: saved.length, files: saved });
  } catch (e) { logError('route.post.sales.fetch-attachments', e); res.status(500).json({ error: 'Failed: ' + (e.message || 'unknown') }); }
});

// ── Historical PR Import ──────────────────────────────────────────────────────
function importPRHistory() {
  if (fs.existsSync(PR_FILE)) return; // already imported
  const xlsxFile = path.join(__dirname, 'data', 'pr-control-list.xlsx');
  if (!fs.existsSync(xlsxFile)) { console.log('[PROCUREMENT] No pr-control-list.xlsx — skipping import'); return; }
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(xlsxFile);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    function excelDateToISO(serial) {
      if (!serial || typeof serial !== 'number') return null;
      return new Date(Math.round((serial - 25569) * 86400000)).toISOString().split('T')[0];
    }
    const grouped = {}, order = [];
    for (const row of rows.slice(1)) {
      const prNum = row[0] ? String(row[0]).trim() : null;
      if (!prNum) continue;
      if (!grouped[prNum]) { grouped[prNum] = []; order.push(prNum); }
      grouped[prNum].push(row);
    }
    const prs = [];
    for (const prNum of order) {
      const rowSet = grouped[prNum], first = rowSet[0];
      const poNumber    = first[1] ? String(first[1]).trim() : null;
      const requestDate = excelDateToISO(first[2]);
      const projectCode = first[3] ? String(first[3]).trim() : null;
      const site        = first[4] ? String(first[4]).trim() : null;
      const items = rowSet.map(r => ({
        description: r[5] ? String(r[5]).trim() : null,
        qty:         r[6] != null ? (parseFloat(r[6]) || null) : null,
        unit: null, unitPrice: null, requiredDate: null,
        qtyArrived:  r[7] != null ? (parseFloat(r[7]) || 0) : 0,
        arriveDate:  excelDateToISO(r[8]),
        outstanding: r[9] != null ? (parseFloat(r[9]) || 0) : 0
      })).filter(i => i.description || i.qty != null);
      const totalArrived     = items.reduce((s, i) => s + (i.qtyArrived || 0), 0);
      const totalOutstanding = items.reduce((s, i) => s + (i.outstanding || 0), 0);
      let status;
      if      (totalArrived > 0 && totalOutstanding === 0) status = 'Delivered';
      else if (totalArrived > 0)                           status = 'Partial';
      else if (poNumber)                                   status = 'Ordered';
      else                                                 status = 'Pending';
      prs.push({ id: prNum, prNumber: prNum, poNumber, requestDate, projectCode, site, items, status,
        supplier: null, eta: null, urgency: 'Normal', notes: null,
        submittedBy: 'Import', createdBy: 'Import', importedAt: new Date().toISOString() });
    }
    writePRs(prs);
    console.log(`[PROCUREMENT] Imported ${prs.length} PRs from historical data`);
  } catch (e) { console.error('[PROCUREMENT] Import failed:', e.message); }
}

// ── Purchase Requisitions API ─────────────────────────────────────────────────
app.get('/api/purchase-requisitions', (req, res) => {
  try {
    let prs = readPRs();
    const today = todaySGT();
    prs = prs.map(pr => {
      if (pr.status !== 'Delivered' && pr.eta && pr.eta < today) {
        const hasOutstanding = (pr.items || []).some(i => (i.outstanding || 0) > 0);
        if (hasOutstanding || pr.status === 'Ordered') return { ...pr, status: 'Overdue' };
      }
      return pr;
    });
    prs.sort((a, b) => {
      const numA = parseInt(((a.prNumber || '').match(/(\d+)$/) || [])[1] || '0');
      const numB = parseInt(((b.prNumber || '').match(/(\d+)$/) || [])[1] || '0');
      return numB !== numA ? numB - numA : (b.prNumber || '').localeCompare(a.prNumber || '');
    });
    res.json(prs);
  } catch (e) { logError('route.get.purchase-requisitions', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/purchase-requisitions', postRateLimit, async (req, res) => {
  try {
    const prs = readPRs();
    const b   = req.body;
    const yr  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' })).getFullYear().toString().slice(2);
    const allSeqs = prs.map(p => parseInt(((p.prNumber || '').match(/(\d+)$/) || [])[1] || '0'));
    const nextSeq = (allSeqs.length ? Math.max(...allSeqs) : 0) + 1;
    const prNumber = `PR${yr}-${String(nextSeq).padStart(3, '0')}`;
    const items = Array.isArray(b.items) ? b.items.map(it => ({
      description:  String(it.description || '').trim().slice(0, 500),
      qty:          parseFloat(it.qty) || 0,
      unit:         String(it.unit || '').trim().slice(0, 50),
      unitPrice:    null, requiredDate: it.requiredDate ? String(it.requiredDate).trim().slice(0, 10) : null,
      qtyArrived:   0, arriveDate: null, outstanding: parseFloat(it.qty) || 0
    })) : [];
    const pr = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), prNumber, poNumber: null,
      requestDate:  todaySGT(),
      projectCode:  String(b.projectCode || '').trim().slice(0, 100),
      site:         String(b.site || '').trim().slice(0, 200),
      items, status: 'Pending', supplier: null, eta: null,
      urgency:      ['Normal','Urgent'].includes(b.urgency) ? b.urgency : 'Normal',
      notes:        String(b.notes || '').trim().slice(0, 1000),
      submittedBy:  String(b.submittedBy || '').trim().slice(0, 100),
      createdBy:    String(b.submittedBy || '').trim().slice(0, 100),
      createdAt:    new Date().toISOString()
    };
    prs.push(pr);
    writePRs(prs);
    logActivity('pr.created', { id: pr.id, prNumber, projectCode: pr.projectCode });
    res.status(201).json(pr);
    // Email Purchaser + CC boss
    const purchaserStaff = readStaff()['Purchaser'] || {};
    const purchaserName  = purchaserStaff.name || 'Purchaser';
    const purchaserEmail = getRoleEmail('Purchaser');
    const bossEmail      = getRoleEmail('Project Manager');
    const bossName       = getBossName();
    const itemsSummary = pr.items.map(i => `${i.description || '—'} (${i.qty} ${i.unit})`).join('; ') || '—';
    sendEmail(purchaserEmail, purchaserName,
      `New PR: ${prNumber} — ${pr.projectCode || 'General'}`,
      emailWrap(`Hi ${escHtml(purchaserName.split(' ')[0])},`,
        `<p style="margin:0 0 16px;">A new Purchase Requisition has been submitted.</p>` +
        emailTable([
          ['PR Number', escHtml(prNumber)],
          ['Project', escHtml(pr.projectCode || '—')],
          ['Site', escHtml(pr.site || '—')],
          ['Urgency', escHtml(pr.urgency)],
          ['Items', escHtml(itemsSummary)],
          ['Submitted By', escHtml(pr.submittedBy || '—')],
          pr.notes ? ['Notes', escHtml(pr.notes)] : null
        ].filter(Boolean)),
        'Open Procurement', `${APP_URL}/procurement`),
      bossEmail
    ).catch(mailErr => console.error('[EMAIL] PR notify failed:', mailErr.message));
  } catch (e) { logError('route.post.purchase-requisitions', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/purchase-requisitions/:id', postRateLimit, async (req, res) => {
  try {
    const prs = readPRs();
    const idx = prs.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'PR not found' });
    const b = req.body, pr = { ...prs[idx], items: prs[idx].items ? prs[idx].items.map(i => ({ ...i })) : [] };
    const oldStatus = pr.status, hadPO = !!pr.poNumber;
    if (b.prNumber    !== undefined) pr.prNumber    = String(b.prNumber    || '').trim().slice(0, 30);
    if (b.urgency     !== undefined && ['Normal','Urgent'].includes(b.urgency)) pr.urgency = b.urgency;
    if (b.poNumber    !== undefined) pr.poNumber    = String(b.poNumber    || '').trim().slice(0, 100) || null;
    if (b.supplier    !== undefined) pr.supplier    = String(b.supplier    || '').trim().slice(0, 200) || null;
    if (b.eta         !== undefined) pr.eta         = String(b.eta         || '').trim().slice(0, 10)  || null;
    if (b.notes       !== undefined) pr.notes       = String(b.notes       || '').trim().slice(0, 1000);
    if (b.poDocPath   !== undefined) pr.poDocPath   = String(b.poDocPath   || '').trim().slice(0, 300) || null;
    if (b.site        !== undefined) pr.site        = String(b.site        || '').trim().slice(0, 200);
    if (b.projectCode !== undefined) pr.projectCode = String(b.projectCode || '').trim().slice(0, 100);
    // Full item replacement when PR is still Pending (factory-side edit)
    if (Array.isArray(b.replaceItems) && pr.status === 'Pending') {
      pr.items = b.replaceItems.map(it => ({
        description: String(it.description || '').trim().slice(0, 500),
        qty: parseFloat(it.qty) || 0,
        unit: String(it.unit || '').trim().slice(0, 50),
        unitPrice: null, requiredDate: it.requiredDate ? String(it.requiredDate).trim().slice(0, 10) : null,
        qtyArrived: 0, arriveDate: null, outstanding: parseFloat(it.qty) || 0
      }));
    }
    if (Array.isArray(b.items)) {
      b.items.forEach((upd, i) => {
        if (!pr.items[i]) return;
        if (upd.unitPrice  !== undefined) pr.items[i].unitPrice  = parseFloat(upd.unitPrice) || null;
        if (upd.qtyArrived !== undefined) {
          pr.items[i].qtyArrived = parseFloat(upd.qtyArrived) || 0;
          pr.items[i].arriveDate = upd.arriveDate ? String(upd.arriveDate).trim().slice(0, 10) : (pr.items[i].arriveDate || todaySGT());
          pr.items[i].outstanding = Math.max(0, (pr.items[i].qty || 0) - pr.items[i].qtyArrived);
        }
      });
    }
    const today2 = todaySGT();
    const totalArrived     = pr.items.reduce((s, i) => s + (i.qtyArrived || 0), 0);
    const totalOutstanding = pr.items.reduce((s, i) => s + (i.outstanding != null ? i.outstanding : (i.qty || 0)), 0);
    if      (totalArrived > 0 && totalOutstanding === 0) pr.status = 'Delivered';
    else if (totalArrived > 0)                           pr.status = 'Partial';
    else if (pr.poNumber && pr.eta && pr.eta < today2)   pr.status = 'Overdue';
    else if (pr.poNumber)                                pr.status = 'Ordered';
    else                                                 pr.status = 'Pending';
    if (b.status && ['Pending','Ordered','Partial','Delivered','Overdue'].includes(b.status)) pr.status = b.status;
    pr.updatedAt = new Date().toISOString();
    prs[idx] = pr;
    writePRs(prs);
    logActivity('pr.updated', { id: pr.id, status: pr.status });
    res.json(pr);
    // Email: PO created → Factory Manager (whoever requested)
    if (pr.poNumber && !hadPO) {
      const fmStaff = readStaff()['Factory Manager'] || {};
      const fmName  = fmStaff.name || 'Factory Manager';
      const fmEmail = getRoleEmail('Factory Manager');
      if (fmEmail) {
        sendEmail(fmEmail, fmName,
          `PO Created for ${pr.prNumber}: ${pr.supplier || 'Supplier TBC'}, ETA: ${pr.eta || 'TBC'}, PO#: ${pr.poNumber}`,
          emailWrap(`Hi ${escHtml(fmName)},`,
            `<p style="margin:0 0 16px;">A Purchase Order has been created for <strong>${escHtml(pr.prNumber)}</strong>.</p>` +
            emailTable([
              ['Project', escHtml(pr.projectCode || '—')],
              ['PO Number', escHtml(pr.poNumber)],
              ['Supplier', escHtml(pr.supplier || '—')],
              ['ETA', escHtml(pr.eta || 'TBC')]
            ]) +
            (pr.poDocPath ? `<p style="margin:0;"><a href="${APP_URL}${escHtml(pr.poDocPath)}">View PO Document</a></p>` : ''),
            'Open Procurement', `${APP_URL}/procurement`)
        ).catch(() => {});
      }
      // Auto-update price book when Rena enters unit prices at processing time
      if (pr.supplier) {
        const prices = readPrices();
        let pricesChanged = false;
        for (const item of pr.items) {
          if (!item.description || !item.unitPrice) continue;
          const existing = prices.find(p =>
            p.material.toLowerCase() === item.description.toLowerCase() &&
            p.supplierName.toLowerCase() === pr.supplier.toLowerCase()
          );
          if (existing) {
            existing.unitPrice  = item.unitPrice;
            existing.date       = today2;
            existing.updatedAt  = new Date().toISOString();
          } else {
            prices.push({
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              material: item.description, grade: '', unitPrice: item.unitPrice, unit: item.unit || '',
              supplierId: '', supplierName: pr.supplier, date: today2,
              notes: `Auto-added from ${pr.prNumber}`, createdAt: new Date().toISOString()
            });
          }
          pricesChanged = true;
        }
        if (pricesChanged) writePrices(prices);
      }
    }
    // Email: fully delivered → Purchaser + CC Finance (Chris receives, Rena tracks, Alex Chew reconciles)
    if (pr.status === 'Delivered' && oldStatus !== 'Delivered') {
      const purchStaff2 = readStaff()['Purchaser'] || {};
      const purchName2  = purchStaff2.name || 'Purchaser';
      const purchEmail2 = getRoleEmail('Purchaser');
      const finEmail2   = getRoleEmail('Finance');
      if (purchEmail2) {
        const itemsList = pr.items.map(i => `${escHtml(i.description || '—')} (${i.qtyArrived || 0} ${escHtml(i.unit || '')})`).join(', ');
        sendEmail(purchEmail2, purchName2,
          `Materials Delivered: ${pr.prNumber} — ${pr.projectCode || ''}`,
          emailWrap(`Hi ${escHtml(purchName2)},`,
            `<p style="margin:0 0 16px;">Materials for <strong>${escHtml(pr.prNumber)}</strong> have been fully delivered.</p>` +
            emailTable([
              ['Project', escHtml(pr.projectCode || '—')],
              ['Supplier', escHtml(pr.supplier || '—')],
              ['Items', itemsList]
            ]) +
            `<p style="margin:0;">Materials have been received at factory.</p>`,
            'Open Procurement', `${APP_URL}/procurement`),
          finEmail2 ? [finEmail2] : []
        ).catch(() => {});
      }
      // Auto-update price book for items that have unitPrice + supplier set
      const prices = readPrices();
      let pricesChanged = false;
      for (const item of pr.items) {
        if (!item.description || !item.unitPrice || !pr.supplier) continue;
        const existing = prices.find(p =>
          p.material.toLowerCase() === item.description.toLowerCase() &&
          p.supplierName.toLowerCase() === pr.supplier.toLowerCase()
        );
        if (existing) {
          existing.unitPrice = item.unitPrice; existing.date = today2; existing.updatedAt = new Date().toISOString();
        } else {
          prices.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            material: item.description, grade: '', unitPrice: item.unitPrice, unit: item.unit || '',
            supplierId: '', supplierName: pr.supplier, date: today2,
            notes: `Auto-added from ${pr.prNumber}`, createdAt: new Date().toISOString() });
        }
        pricesChanged = true;
      }
      if (pricesChanged) writePrices(prices);
    }
  } catch (e) { logError('route.put.purchase-requisitions', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/purchase-requisitions/:id', async (req, res) => {
  try {
    if (!await requireAdminAuth(req, res)) return;
    const prs = readPRs();
    const idx = prs.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'PR not found' });
    const removed = prs.splice(idx, 1)[0];
    writePRs(prs);

    // Unlink any uploaded PDFs attached to this PR
    const candidates = [];
    if (removed.poDocPath) candidates.push(removed.poDocPath);
    if (removed.quotationFileUrl) candidates.push(removed.quotationFileUrl);
    if (Array.isArray(removed.documents)) {
      for (const d of removed.documents) {
        if (d && typeof d.filename === 'string') candidates.push('/uploads/' + d.filename);
      }
    }
    let filesUnlinked = 0;
    for (const publicPath of candidates) {
      if (typeof publicPath !== 'string' || !publicPath.startsWith('/uploads/')) continue;
      const abs = path.resolve(path.join(__dirname, 'public', publicPath));
      if (!abs.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) continue;
      if (fs.existsSync(abs)) {
        try { fs.unlinkSync(abs); filesUnlinked++; } catch (_) { /* tolerate */ }
      }
    }
    logActivity('pr.deleted', { id: removed.id, prNumber: removed.prNumber, filesUnlinked });
    res.json({ ok: true });
  } catch (e) { logError('route.delete.purchase-requisitions', e); res.status(500).json({ error: 'Internal server error' }); }
});

startupCheck();
importPRHistory();
cleanDuplicateRecurringTasks();
// Recalculate stale derived fields for all projects on startup
try {
  const _recalcProjects = readProjects();
  _recalcProjects.forEach(p => deriveFields(p));
  writeProjects(_recalcProjects);
  console.log(`[STARTUP] Recalculated derived fields for ${_recalcProjects.length} projects`);
} catch (e) {
  console.error('[STARTUP] Recalc failed:', e.message);
}
// Log record counts so you can see data state on startup
try {
  const _projects  = readProjects();
  const _tasks     = readTasks();
  const _workers   = readWorkers();
  const _eod       = readEOD();
  const _claims    = readClaims();
  const _tickets   = readTickets();
  console.log(`[LYS OPS] Records — Projects: ${_projects.length}, Tasks: ${_tasks.length}, Workers: ${_workers.length}, EOD logs: ${_eod.length}, Claims: ${_claims.length}, Tickets: ${_tickets.length}`);
} catch (e) {
  console.error('[LYS OPS] Could not read data counts on startup:', e.message);
}
// ── Graceful shutdown — systemctl stop/restart sends SIGTERM ───────────────────
// SIGTERM handler already registered at startup (line 135)

// ── Crash handlers — log + alert, then let process manager restart ────────────
const _serverStartTime = Date.now();
const CRASH_EMAIL_COOLDOWN = 5 * 60 * 1000; // 5 minutes between crash emails
const CRASH_TS_FILE = path.join(__dirname, 'data', '.last-crash-email-ts');

function _lastCrashEmailTs() {
  try { return parseInt(fs.readFileSync(CRASH_TS_FILE, 'utf8'), 10) || 0; } catch { return 0; }
}

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  logError('uncaughtException', err);
  // Rate-limited crash email — max one per 5 minutes, persisted to disk to survive restarts
  const now = Date.now();
  if (now - _lastCrashEmailTs() >= CRASH_EMAIL_COOLDOWN) {
    try { fs.writeFileSync(CRASH_TS_FILE, String(now)); } catch {}
    try {
      const bossEmail = process.env.SENDER_EMAIL;
      if (bossEmail) {
        sendEmail(bossEmail, 'System', '[LYS OPS] Server Crashed — Restarting',
          emailWrap(null,
            emailUrgentBox('<strong>Uncaught Exception</strong>') +
            `<pre style="margin:12px 0;padding:10px;background:#f5f5f5;border-radius:4px;font-size:12px;overflow-x:auto;">${escHtml(String(err.stack || err.message).slice(0, 500))}</pre>` +
            `<p style="margin:0;font-size:13px;">Server will auto-restart if running under systemd.</p>`,
            null, null)
        ).catch(() => {});
      }
    } catch {}
  }
  // Give the email a moment to send, then exit so systemd restarts us
  setTimeout(() => process.exit(1), 2000);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// ── Health endpoint — uptime, data counts, last cron times ───────────────────
app.get('/health', (req, res) => {
  const uptimeSec = Math.floor((Date.now() - _serverStartTime) / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  try {
    const heartbeat = fs.existsSync(path.join(__dirname, 'data', 'cron-heartbeat.json'))
      ? safeReadJSON(path.join(__dirname, 'data', 'cron-heartbeat.json'))
      : {};
    res.json({
      status: 'ok',
      uptime: `${h}h ${m}m`,
      uptimeSec,
      startedAt: new Date(_serverStartTime).toISOString(),
      cronHeartbeat: heartbeat,
      dataFiles: {
        projects: fs.existsSync(DATA_FILE),
        staff: fs.existsSync(STAFF_FILE),
        workers: fs.existsSync(WORKERS_FILE),
        tasks: fs.existsSync(TASKS_FILE)
      }
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ── Express error-handling middleware (catch-all for route errors) ────────────
app.use((err, req, res, _next) => {
  logError('express.unhandled', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const _server = app.listen(PORT, () => {
  console.log(`LYS OPS Tracker running at http://localhost:${PORT}`);
});
_server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} is already in use. Is another instance running?`);
    console.error('[HINT] Use: sudo systemctl restart ops-tracker');
    process.exit(1); // Clean exit — no crash email
  }
});
