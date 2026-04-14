require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const msal = require('@azure/msal-node');
const multer = require('multer');
const cron = require('node-cron');

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
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    }
  }),
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Clean URL routes for SPA-style pages
app.get('/tasks',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'tasks.html')));
app.get('/my-tasks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-tasks.html')));
app.get('/factory',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'factory.html')));
app.get('/feedback',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'feedback.html')));
app.get('/installation', (req, res) => res.sendFile(path.join(__dirname, 'public', 'installation.html')));
app.get('/planning',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'planning.html')));
app.get('/attendance',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'attendance.html')));

// DO (Delivery Order) photo upload
app.post('/api/upload-do', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ filename: req.file.filename, ok: true });
  } catch (e) { logError('route.post.upload-do', e); res.status(500).json({ error: 'Internal server error' }); }
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

// ── Email helper ──────────────────────────────────────────────────────────────
async function sendEmail(toEmail, toName, subject, htmlBody) {
  const senderEmail = process.env.SENDER_EMAIL;
  if (!senderEmail) return;

  // TEST MODE: override recipient so all emails go to Lai during testing
  const recipient = process.env.EMAIL_TEST_OVERRIDE || toEmail;

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      console.warn(`[EMAIL SKIP] No access token — skipping email to ${recipient} ("${subject}")`);
      return;
    }
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${senderEmail}/sendMail`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: htmlBody },
          toRecipients: [{ emailAddress: { address: recipient, name: toName || recipient } }]
        }
      })
    });
    if (!res.ok) {
      // Log the full Graph API error response so we can diagnose failures
      let errBody = '';
      try { errBody = await res.text(); } catch {}
      const msg = `Graph API ${res.status} ${res.statusText} — ${errBody}`;
      console.error(`[EMAIL] Failed to send "${subject}" → ${recipient}: ${msg}`);
      logError('email.send.graphapi', new Error(msg), { to: recipient, subject, status: res.status });
      return;
    }
    console.log(`[EMAIL] Sent "${subject}" → ${recipient}`);
  } catch (e) {
    console.error('[EMAIL] Exception sending to', recipient, ':', e.message);
    logError('email.send.exception', e, { to: recipient, subject });
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
function logActivity(event, details = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details }) + '\n';
    fs.appendFileSync(ACTIVITY_LOG_FILE, line);
  } catch {}
}
function logError(event, err, details = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, error: err && err.message ? err.message : String(err), ...details }) + '\n';
    fs.appendFileSync(ERRORS_LOG_FILE, line);
  } catch {}
}
// Strip BOM and parse JSON — use for all file reads
function safeReadJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readTasks() {
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]');
  return safeReadJSON(TASKS_FILE);
}
function writeTasks(tasks) {
  const tmp = TASKS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, TASKS_FILE);
}
function readEOD() {
  if (!fs.existsSync(EOD_FILE)) fs.writeFileSync(EOD_FILE, '[]');
  return safeReadJSON(EOD_FILE);
}

function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function readProjects() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return safeReadJSON(DATA_FILE);
}
function writeProjects(projects) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(projects, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function readStaff() {
  if (!fs.existsSync(STAFF_FILE)) return {};
  return safeReadJSON(STAFF_FILE);
}
function writeStaff(staff) {
  fs.writeFileSync(STAFF_FILE, JSON.stringify(staff, null, 2));
}
function readAdmin() {
  if (!fs.existsSync(ADMIN_FILE)) return { pin: '' };
  return safeReadJSON(ADMIN_FILE);
}
function writeAdmin(data) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2));
}

function readTickets() {
  if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, '[]');
  return safeReadJSON(TICKETS_FILE);
}
function writeTickets(tickets) {
  const tmp = TICKETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tickets, null, 2));
  fs.renameSync(tmp, TICKETS_FILE);
}
function readWorkers() {
  if (!fs.existsSync(WORKERS_FILE)) fs.writeFileSync(WORKERS_FILE, '[]');
  return safeReadJSON(WORKERS_FILE);
}
function writeWorkers(workers) {
  const tmp = WORKERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(workers, null, 2));
  fs.renameSync(tmp, WORKERS_FILE);
}
function readManpowerPlans() {
  if (!fs.existsSync(MANPOWER_FILE)) fs.writeFileSync(MANPOWER_FILE, '[]');
  return safeReadJSON(MANPOWER_FILE);
}
function writeManpowerPlans(plans) {
  const tmp = MANPOWER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plans, null, 2));
  fs.renameSync(tmp, MANPOWER_FILE);
}
function readTransport() {
  if (!fs.existsSync(TRANSPORT_FILE)) fs.writeFileSync(TRANSPORT_FILE, '[]');
  return safeReadJSON(TRANSPORT_FILE);
}
function writeTransport(plans) {
  const tmp = TRANSPORT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plans, null, 2));
  fs.renameSync(tmp, TRANSPORT_FILE);
}
function readEODHistory() {
  if (!fs.existsSync(EOD_HISTORY_FILE)) fs.writeFileSync(EOD_HISTORY_FILE, '[]');
  return safeReadJSON(EOD_HISTORY_FILE);
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
  const entry = _rlMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
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

// POST /api/tickets — create a new ticket
app.post('/api/tickets', postRateLimit, (req, res) => {
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
      notes: ''
    };
    tickets.push(ticket);
    writeTickets(tickets);
    res.json(ticket);
    // Trigger 6: email Lai Wei Xiang on every new feedback ticket
    const laiEmail = getStaffEmail('Lai Wei Xiang') || getStaffEmail('Lai Weixiang') || process.env.ADMIN_EMAIL || '';
    if (laiEmail) {
      sendEmail(laiEmail, 'Lai Wei Xiang',
        `[New Feedback] ${ticket.title} — ${ticket.type}`,
        `<p>A new feedback ticket has been submitted:</p>
        <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Title</td><td>${ticket.title}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Type</td><td>${ticket.type}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Submitted By</td><td>${ticket.submittedBy}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Priority</td><td>${ticket.priority}</td></tr>
          ${ticket.description ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Description</td><td>${ticket.description}</td></tr>` : ''}
        </table>
        <p><a href="${APP_URL}/feedback">View Feedback →</a></p>`
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
  } catch (e) { logError('route.put.tickets', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/tickets/:id — remove a ticket
app.delete('/api/tickets/:id', (req, res) => {
  try {
    const tickets = readTickets();
    const idx = tickets.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Ticket not found' });
    tickets.splice(idx, 1);
    writeTickets(tickets);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.tickets', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Staff ---
app.get('/api/staff', (req, res) => {
  try {
    res.json(readStaff());
  } catch (e) { logError('route.get.staff', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/staff — add or update a staff member { name, email }
app.post('/api/staff', (req, res) => {
  try {
    const name  = sanitizeStr(req.body.name, 100);
    const email = sanitizeStr(req.body.email, 200);
    if (!name) return res.status(400).json({ error: 'name required' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    const staff = readStaff();
    staff[name] = { name, email };
    writeStaff(staff);
    res.json(staff[name]);
  } catch (e) { logError('route.post.staff', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/staff/:name — remove staff member and any role aliases pointing to them
app.delete('/api/staff/:name', (req, res) => {
  try {
    const pin = req.body?.pin || req.headers["x-admin-pin"];
    const adminData = readAdmin();
    if (adminData.pin && pin !== adminData.pin) {
      return res.status(403).json({ error: "Invalid PIN" });
    }
    const staff = readStaff();
    const name = decodeURIComponent(req.params.name);
    if (!staff[name]) return res.status(404).json({ error: 'Not found' });
    const targetName = staff[name].name;
    // Remove name key and any role-alias keys that resolve to the same person
    Object.keys(staff).forEach(k => {
      if (staff[k].name === targetName) delete staff[k];
    });
    writeStaff(staff);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.staff', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/admin/pin — returns whether a PIN has been set
app.get('/api/admin/pin', (req, res) => {
  try {
    const admin = readAdmin();
    res.json({ pinSet: !!admin.pin });
  } catch (e) { logError('route.get.admin.pin', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/admin/pin — action: 'set' or 'verify'
app.post('/api/admin/pin', (req, res) => {
  try {
    const { action, pin } = req.body;
    const admin = readAdmin();
    if (action === 'set') {
      if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });
      admin.pin = pin;
      writeAdmin(admin);
      return res.json({ ok: true });
    }
    if (action === 'verify') {
      if (!admin.pin) return res.json({ ok: false, noPinSet: true });
      return res.json({ ok: pin === admin.pin });
    }
    res.status(400).json({ error: 'action must be set or verify' });
  } catch (e) { logError('route.post.admin.pin', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/projects/:id/upload — upload a PDF for a document
app.post('/api/projects/:id/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded or wrong file type' });
    res.json({ filename: req.file.filename, originalName: req.file.originalname });
  } catch (e) { logError('route.post.upload', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Summary KPIs ---
app.get('/api/summary', (req, res) => {
  try {
  const projects = readProjects().map(p => deriveFields(p));
  const summary = {
    total: projects.length,
    completed: projects.filter(p => p.status === 'Completed').length,
    onTrack: projects.filter(p => p.status === 'On Track').length,
    delayed: projects.filter(p => p.status === 'Delayed').length,
    onHold: projects.filter(p => p.status === 'On Hold').length,
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
  const active = projects.filter(p => p.status !== 'Completed');
  summary.avgFabPct = active.length
    ? Math.round(active.reduce((s, p) => s + (parseFloat(p.fabPercent) || 0), 0) / active.length)
    : 0;
  summary.avgInstallPct = active.length
    ? Math.round(active.reduce((s, p) => s + (parseFloat(p.installPercent) || 0), 0) / active.length)
    : 0;
  res.json(summary);
  } catch (e) { logError('route.get.summary', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Action Required (Pending/In Progress stages across all projects) ---
app.get('/api/actions', (req, res) => {
  try {
    const projects = readProjects();
    const now = Date.now();
    const actions = [];
    for (const p of projects) {
      if (p.status === 'Completed') continue;
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
    const projects = readProjects();
    const summary = projects.map(p => ({
      id: p.id,
      jobCode: p.jobCode,
      projectName: p.projectName,
      product: p.product,
      contractValue: p.contractValue,
      voValue: p.voValue,
      status: p.status,
      fabPercent: p.fabPercent,
      installPercent: p.installPercent,
      latestNotes: p.latestNotes,
      paidAmount: p.paidAmount,
      client: p.client,
      currentStage: p.currentStage,
      actionBy: p.actionBy,
      endDate: p.endDate
    }));
    res.json(summary);
  } catch (e) { logError('route.get.projects', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Get single project ---
app.get('/api/projects/:id', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    res.json(project);
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
    res.status(201).json(newProject);
  } catch (e) { logError('route.post.projects', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Derive computed fields from live sub-arrays ──────────────────────────────
// Call this on every project before saving to keep derived fields accurate.
function deriveFields(p) {
  // fabPercent — from fabrication array
  const fabRows  = p.fabrication  || [];
  const fabTotal = fabRows.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const fabDone  = fabRows.reduce((s, r) => s + (parseFloat(r.qtyDone)  || 0), 0);
  p.fabPercent   = fabTotal > 0 ? Math.round(fabDone  / fabTotal  * 100) : 0;

  // installPercent — from installation array
  const instRows  = p.installation || [];
  const instTotal = instRows.reduce((s, r) => s + (parseFloat(r.totalQty) || 0), 0);
  const instDone  = instRows.reduce((s, r) => s + (parseFloat(r.doneQty)  || 0), 0);
  p.installPercent = instTotal > 0 ? Math.round(instDone / instTotal * 100) : 0;

  // paidAmount — sum of paid payment milestones
  const milestones = p.paymentMilestones || [];
  p.paidAmount = milestones
    .filter(m => m.status === 'Paid' || m.paid === true)
    .reduce((s, m) => s + (parseFloat(m.amount) || 0), 0);

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
app.post('/api/admin/recalc', (req, res) => {
  try {
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
  const incoming = req.body;
  const oldProject = projects[idx];

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

  // Trigger 1: New delivery request → notify Chris
  const oldDRIds = new Set((oldProject.deliveryRequests || []).map(r => r.id));
  const newDRs = (incoming.deliveryRequests || []).filter(r => r.id && !oldDRIds.has(r.id));
  for (const dr of newDRs) {
    const chrisEmail = getStaffEmail('Chris');
    if (chrisEmail) {
      sendEmail(chrisEmail, 'Chris',
        `[Action Required] New Delivery Request — ${oldProject.jobCode}`,
        `<p>Hi Chris,</p>
        <p>A new delivery request has been submitted for <strong>${oldProject.jobCode} — ${oldProject.projectName || ''}</strong>.</p>
        <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Item</td><td>${dr.item || 'See tracker'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Qty</td><td>${dr.qtyRequested || '—'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Needed By</td><td>${dr.neededByDate || 'ASAP'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Requested By</td><td>${dr.requestedBy || '—'}</td></tr>
        </table>
        <p><a href="${APP_URL}/project.html?id=${oldProject.id}">Open OPS Tracker →</a></p>`
      ).catch(() => {});
    } else {
      console.warn('[EMAIL SKIP] No email for: Chris (new delivery request)');
    }
  }

  // Trigger: project status changed to Delayed → notify project manager
  if (incoming.status === 'Delayed' && oldProject.status !== 'Delayed') {
    const pmName = incoming.projectManager || oldProject.projectManager;
    const pmEmail = getStaffEmail(pmName);
    if (pmEmail) {
      sendEmail(pmEmail, pmName,
        `[Project Delayed] ${oldProject.jobCode} — ${oldProject.projectName}`,
        `<p>Hi ${pmName},</p>
        <p>Project <strong>${oldProject.jobCode} — ${oldProject.projectName}</strong> has been marked as <strong>Delayed</strong>.</p>
        <p>Please update the latest notes and advise on the revised timeline.</p>
        <p><a href="${APP_URL}/project.html?id=${oldProject.id}">Open Project →</a></p>`
      ).catch(() => {});
    } else {
      console.warn('[EMAIL SKIP] No email for:', pmName, '(project delayed notification)');
    }
  }

  projects[idx] = deriveFields({ ...oldProject, ...incoming });
  writeProjects(projects);
  res.json(projects[idx]);
  } catch (e) { logError('route.put.projects', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Delete project ---
app.delete('/api/projects/:id', (req, res) => {
  try {
    const pin = req.body?.pin || req.headers["x-admin-pin"];
    const adminData = readAdmin();
    if (adminData.pin && pin !== adminData.pin) {
      return res.status(403).json({ error: "Invalid PIN" });
    }
    const projects = readProjects();
    const idx = projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    projects.splice(idx, 1);
    writeProjects(projects);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.projects', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Factory Queue (cross-project) ---
app.get('/api/factory-queue', (req, res) => {
  try {
  const projects = readProjects();
  const today = Date.now();
  const queue = [];

  for (const p of projects) {
    if (p.status === 'Completed') continue;
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

    // Build delivery request map keyed by item name (lowercase)
    // Source: project.deliveryRequests[] — dedicated delivery tab
    const deliveryMap = {};
    for (const req of (p.deliveryRequests || [])) {
      const key = (req.item || '').toLowerCase().trim();
      const isDelivered = (req.ticketStatus || req.status) === 'Delivered';
      if (key && !isDelivered) {
        // Multiple requests for same item: keep earliest neededByDate
        if (!deliveryMap[key] || (req.neededByDate && req.neededByDate < deliveryMap[key].neededByDate)) {
          deliveryMap[key] = req;
        }
      }
    }

    const items = fabItems.map((f, idx) => {
      const key = (f.item || f.description || '').toLowerCase().trim();
      const req = deliveryMap[key] || null;
      const daysUntilNeeded = req && req.neededByDate
        ? Math.floor((new Date(req.neededByDate).getTime() - today) / 86400000)
        : null;
      return {
        idx,
        description: f.item || f.description || '',
        totalQty: f.totalQty || 0,
        doneQty: f.qtyDone || 0,
        fabPct: f.totalQty > 0 ? Math.round((f.qtyDone || 0) / f.totalQty * 100) : 0,
        status: f.status || 'Not Started',
        fromScope: !!f._fromScope,
        readyForDelivery: f.readyForDelivery || false,
        targetDeliveryDate: f.targetDeliveryDate || '',
        readyAt: f.readyAt || null,
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
    Object.assign(project.fabrication[idx], req.body);

    // ── Task 5: FAB cycle time tracking (silent) ──────────────────────────
    const fabItem    = project.fabrication[idx];
    const oldQtyDone = parseFloat(oldItem.qtyDone) || 0;
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

    writeProjects(projects);
    const changes = Object.keys(req.body)
      .filter(k => String(req.body[k]) !== String(oldItem[k]))
      .map(k => ({ field: k, from: oldItem[k], to: req.body[k] }));
    logActivity('fab.updated', { projectId: req.params.id, jobCode: project.jobCode, itemIndex: idx, item: project.fabrication[idx].item || project.fabrication[idx].description || '', changes });
    res.json(project.fabrication[idx]);
  } catch (e) { logError('route.put.fabrication', e); res.status(500).json({ error: 'Internal server error' }); }
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
    Object.assign(project.installation[idx], req.body);
    writeProjects(projects);
    const changes = Object.keys(req.body)
      .filter(k => String(req.body[k]) !== String(oldItem[k]))
      .map(k => ({ field: k, from: oldItem[k], to: req.body[k] }));
    logActivity('install.updated', { projectId: req.params.id, jobCode: project.jobCode, itemIndex: idx, item: project.installation[idx].item || project.installation[idx].description || '', changes });
    res.json(project.installation[idx]);
  } catch (e) { logError('route.put.installation', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Update delivery request ticket status ---
app.put('/api/projects/:id/delivery-requests/:reqId', async (req, res) => {
  try {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const dr = project.deliveryRequests || [];
  const rIdx = dr.findIndex(r => r.id === req.params.reqId);
  if (rIdx === -1) return res.status(404).json({ error: 'Request not found' });
  const existing = dr[rIdx];
  Object.assign(dr[rIdx], req.body);
  project.deliveryRequests = dr;
  writeProjects(projects);

  // Trigger 3: Status changed to Ready → notify site engineer
  if (req.body.ticketStatus === 'Ready' && existing.ticketStatus !== 'Ready') {
    const siteEngineerName = project.siteEngineer;
    const siteEmail = getStaffEmail(siteEngineerName);
    if (siteEmail) {
      sendEmail(siteEmail, siteEngineerName,
        `[Ready for Delivery] ${project.jobCode} — ${dr[rIdx].item}`,
        `<p>Hi ${siteEngineerName},</p>
        <p>Items are ready for delivery on project <strong>${project.jobCode}</strong>.</p>
        <p><strong>${dr[rIdx].item}</strong> — Qty: ${dr[rIdx].qtyRequested || '—'}</p>
        <p>Please coordinate delivery with Chris.</p>
        <p><a href="${APP_URL}/project.html?id=${project.id}">Open Project →</a></p>`
      ).catch(() => {});
    }
  }

  res.json(dr[rIdx]);
  } catch (e) { logError('route.put.delivery-requests', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Notification stubs (future email integration) ---
app.post('/api/notify/delivery-acknowledged', async (req, res) => {
  try {
    const { requestedBy, item, timeline, projectJobCode } = req.body;
    const requestorEmail = getStaffEmail(requestedBy);
    if (requestorEmail) {
      sendEmail(requestorEmail, requestedBy,
        `[Delivery Acknowledged] ${item || 'Your delivery request'}${projectJobCode ? ' — ' + projectJobCode : ''}`,
        `<p>Hi ${requestedBy},</p>
        <p>Chris has acknowledged your delivery request.</p>
        <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Item</td><td>${item || '—'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Project</td><td>${projectJobCode || '—'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Expected Timeline</td><td>${timeline || 'To be confirmed'}</td></tr>
        </table>
        <p>Chris will keep you updated on the delivery progress.</p>
        <p><a href="${APP_URL}/factory">Open Factory View →</a></p>`
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { logError('route.post.notify.delivery-acknowledged', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/notify/delivery-ready', async (req, res) => {
  try {
    const { projectId, requestedBy, item, projectJobCode } = req.body;
    const requestorEmail = getStaffEmail(requestedBy);
    if (requestorEmail) {
      await sendEmail(requestorEmail, requestedBy,
        `[Ready for Delivery] ${item || 'Your item'}${projectJobCode ? ' — ' + projectJobCode : ''}`,
        `<p>Hi ${requestedBy},</p>
        <p>Your requested item is ready for delivery:</p>
        <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Item</td><td>${item || '—'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Project</td><td>${projectJobCode || '—'}</td></tr>
        </table>
        <p>Please coordinate delivery timing with Chris.</p>
        <p><a href="${APP_URL}/factory">Open Factory View →</a></p>`
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { logError('route.post.notify.delivery-ready', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Delete document file ---
app.delete('/api/projects/:id/documents/:docIndex/file', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const doc = (project.documents || [])[parseInt(req.params.docIndex)];
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.file) {
      const filePath = path.join(UPLOADS_DIR, path.basename(doc.file));
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      doc.file = '';
      doc.fileUrl = '';
    }
    writeProjects(projects);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.document-file', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Delete drawing file ---
app.delete('/api/projects/:id/drawings/:drawingIndex/file', (req, res) => {
  try {
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const drawing = (project.drawings || [])[parseInt(req.params.drawingIndex)];
    if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
    if (drawing.file) {
      const filePath = path.join(UPLOADS_DIR, path.basename(drawing.file));
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
    const stage = (project.stages || [])[parseInt(req.params.stageIdx)];
    if (!stage) return res.status(404).json({ error: 'Stage not found' });
    if (stage.fileName) {
      const filePath = path.join(UPLOADS_DIR, path.basename(stage.fileName));
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      stage.fileName = '';
    }
    writeProjects(projects);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.stage-file', e); res.status(500).json({ error: 'Internal server error' }); }
});

// --- API: Send Outlook reminder ---
app.post('/api/remind', async (req, res) => {
  const { projectId, stageNum, ownerName, ownerEmail, stageName, projectName, jobCode, daysInStatus } = req.body;
  if (!ownerEmail) return res.status(400).json({ error: 'ownerEmail required' });

  const senderEmail = process.env.SENDER_EMAIL;
  if (!senderEmail) {
    return res.status(503).json({ error: 'Outlook not configured. Set AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET, SENDER_EMAIL in .env' });
  }

  try {
    const subject = `[Action Required] ${stageName} – ${projectName}`;
    const htmlBody = `
<p>Hi ${ownerName || ownerEmail},</p>
<p>This is a reminder that the following project stage requires your attention:</p>
<table style="border-collapse:collapse;font-family:Arial,sans-serif;">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Project</td><td>${projectName}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Job Code</td><td>${jobCode}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Stage</td><td>${stageName}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Days Pending</td><td>${daysInStatus} day(s)</td></tr>
</table>
<p>Please update the status at: <a href="${APP_URL}/project.html?id=${projectId}">LYS OPS Tracker</a></p>
<p style="color:#888;font-size:12px;">Sent from LYS Operations Tracker</p>
`.trim();

    await sendEmail(ownerEmail, ownerName, subject, htmlBody);
    res.json({ ok: true, sentTo: ownerEmail });
  } catch (err) {
    logError('route.post.remind', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Default project structure ---
function buildDefaultProject(data) {
  const stages = [
    { num: 1,  name: 'LOI Received',               owner: 'Project Manager' },
    { num: 2,  name: 'LOA Received',               owner: 'Project Manager' },
    { num: 3,  name: 'Kickoff Meeting',             owner: 'Project Manager' },
    { num: 4,  name: 'Safety Document Submission',  owner: 'Project Manager' },
    { num: 5,  name: 'Drawing Submission',          owner: 'Drafter' },
    { num: 6,  name: 'SIC Submission',              owner: 'Project Manager' },
    { num: 7,  name: 'Conduit Installation',        owner: 'Site Engineer' },
    { num: 8,  name: 'Fabrication',                 owner: 'Factory Manager' },
    { num: 9,  name: 'Delivery',                    owner: 'Purchaser' },
    { num: 10, name: 'Installation',                owner: 'Site Engineer' },
    { num: 11, name: 'Handover / Inspection',       owner: 'Project Manager' },
    { num: 12, name: 'Final Claim & Closure',       owner: 'QS' },
  ].map(s => ({ ...s, status: 'Not Started', started: '', done: '', notes: '', statusChangedAt: null, refs: [] }));

  const documents = [
    { name: 'Risk Assessment',       group: 'Safety Documents', allowMultiple: false },
    { name: 'Method Statement',      group: 'Safety Documents', allowMultiple: true  },
    { name: 'Safe Work Procedure',   group: 'Safety Documents', allowMultiple: false },
    { name: 'Name List',             group: 'Safety Documents', allowMultiple: false },
    { name: 'Permit to Work (PTW)',  group: 'Safety Documents', allowMultiple: true  },
    { name: 'Letter of Appointment', group: 'Safety Documents', allowMultiple: true  },
    { name: 'Lifting Plan',          group: 'Safety Documents', allowMultiple: false },
    { name: 'Fall Prevention Plan',  group: 'Safety Documents', allowMultiple: false },
    { name: 'Schedule Submission',   group: 'Submissions',      allowMultiple: false },
    { name: 'SIC Submission',        group: 'Submissions',      allowMultiple: false },
  ].map(d => ({ ...d, status: 'Not Submitted', submitted: '', approved: '', notes: '', files: [] }));

  return {
    id: data.id,
    jobCode: data.jobCode || '',
    projectName: data.projectName || '',
    product: data.product || '',
    contractValue: data.contractValue || 0,
    voValue: data.voValue || 0,
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
    currentStage: data.currentStage || '',
    actionBy: data.actionBy || '',
    fabPercent: data.fabPercent || 0,
    installPercent: data.installPercent || 0,
    paidAmount: data.paidAmount || 0,
    latestNotes: data.latestNotes || '',
    stages: data.stages || stages,
    documents: data.documents || documents,
    fabrication: data.fabrication || [],
    installation: data.installation || [],
    prpo: data.prpo || [],
    paymentMilestones: data.paymentMilestones || [],
    variationOrders: data.variationOrders || [],
    defects: data.defects || [],
    meetingNotes: data.meetingNotes || [],
    drawings: data.drawings || [],
    deliveryRequests: data.deliveryRequests || []
  };
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
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ pin: '' }, null, 2));
    issues.push('Created missing admin.json');
  }

  // Check admin PIN is set
  try {
    const admin = safeReadJSON(ADMIN_FILE);
    if (!admin.pin) issues.push('⚠️  Admin PIN not set — anyone can delete projects');
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
app.get('/api/tasks/summary', (req, res) => {
  try {
    const tasks = readTasks();
    const today = new Date().toISOString().split('T')[0];
    res.json({
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'Pending').length,
      inProgress: tasks.filter(t => t.status === 'In Progress').length,
      done: tasks.filter(t => t.status === 'Done').length,
      blocked: tasks.filter(t => t.status === 'Blocked').length,
      overdue: tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== 'Done').length
    });
  } catch (e) { logError('route.get.tasks.summary', e); res.status(500).json({ error: 'Internal server error' }); }
});

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
    id: Date.now().toString(36),
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
  res.json(task);

  // Trigger 1: Send assignment email if task is assigned to someone
  if (task.assignedTo) {
    const assignEmail = getStaffEmail(task.assignedTo);
    if (assignEmail) {
      const assignedBy   = task.createdBy && task.createdBy !== task.assignedTo ? task.createdBy : null;
      const projectLabel = task.projectJobCode || task.projectName || null;
      const dueDateLabel = task.dueDate || null;
      const priorityLabel = task.priority && task.priority !== 'Normal' ? task.priority : null;
      const rows = [
        `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Task</td><td style="padding:6px 0;">${task.title}</td></tr>`,
        projectLabel  ? `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Project</td><td style="padding:6px 0;">${projectLabel}</td></tr>` : '',
        dueDateLabel  ? `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Due Date</td><td style="padding:6px 0;">${dueDateLabel}</td></tr>` : '',
        priorityLabel ? `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Priority</td><td style="padding:6px 0;">${priorityLabel}</td></tr>` : '',
        assignedBy    ? `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Assigned By</td><td style="padding:6px 0;">${assignedBy}</td></tr>` : '',
      ].filter(Boolean).join('');
      sendEmail(assignEmail, task.assignedTo,
        `[New Task] ${task.title}`,
        `<div style="font-family:Arial,sans-serif;max-width:520px;">
        <p style="margin:0 0 16px;">Hi ${task.assignedTo},</p>
        <p style="margin:0 0 16px;">You have been assigned a new task:</p>
        <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">${rows}</table>
        <p style="margin:0;"><a href="${APP_URL}/my-tasks" style="background:#3366ff;color:#fff;padding:9px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">View My Tasks →</a></p>
        <p style="margin:20px 0 0;font-size:11px;color:#aaa;">LYS Operations Tracker</p>
        </div>`
      ).catch(() => {});
      logActivity('email.sent', { to: task.assignedTo, subject: 'New Task: ' + task.title });
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
  const updates = req.body;
  const oldAssignee = tasks[idx].assignedTo;
  const oldStatus   = tasks[idx].status;
  if (updates.status === 'Done' && tasks[idx].status !== 'Done') {
    updates.completedAt = new Date().toISOString();
  }
  // Reset overdueEmailSent if dueDate is updated to a future date
  if (updates.dueDate && updates.dueDate >= new Date().toISOString().split('T')[0]) {
    updates.overdueEmailSent = false;
  }
  tasks[idx] = { ...tasks[idx], ...updates };
  writeTasks(tasks);
  res.json(tasks[idx]);

  // Trigger 1: Send assignment email if assignee changed to a new person
  if (updates.assignedTo && updates.assignedTo !== oldAssignee) {
    const newTask = tasks[idx];
    const assignEmail = getStaffEmail(updates.assignedTo);
    if (assignEmail) {
      const assignedBy   = newTask.createdBy && newTask.createdBy !== updates.assignedTo ? newTask.createdBy : null;
      const projectLabel = newTask.projectJobCode || newTask.projectName || null;
      const dueDateLabel = newTask.dueDate || null;
      const rows = [
        `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Task</td><td style="padding:6px 0;">${newTask.title}</td></tr>`,
        projectLabel ? `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Project</td><td style="padding:6px 0;">${projectLabel}</td></tr>` : '',
        dueDateLabel ? `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Due Date</td><td style="padding:6px 0;">${dueDateLabel}</td></tr>` : '',
        assignedBy   ? `<tr><td style="padding:6px 16px 6px 0;font-weight:600;color:#555;white-space:nowrap;">Assigned By</td><td style="padding:6px 0;">${assignedBy}</td></tr>` : '',
      ].filter(Boolean).join('');
      sendEmail(assignEmail, updates.assignedTo,
        `[New Task] ${newTask.title}`,
        `<div style="font-family:Arial,sans-serif;max-width:520px;">
        <p style="margin:0 0 16px;">Hi ${updates.assignedTo},</p>
        <p style="margin:0 0 16px;">You have been assigned a task:</p>
        <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">${rows}</table>
        <p style="margin:0;"><a href="${APP_URL}/my-tasks" style="background:#3366ff;color:#fff;padding:9px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">View My Tasks →</a></p>
        <p style="margin:20px 0 0;font-size:11px;color:#aaa;">LYS Operations Tracker</p>
        </div>`
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
        `<p>Hi ${changedTask.requestedBy},</p>
        <p>A task you requested has been updated:</p>
        <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Task</td><td>${changedTask.title}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">New Status</td><td>${updates.status}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Assigned To</td><td>${changedTask.assignedTo || '—'}</td></tr>
        </table>
        <p><a href="${APP_URL}/my-tasks">View Tasks →</a></p>`
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
    // Fix 1: auto-advance Pending → In Progress on acknowledgement
    if (tasks[idx].status === 'Pending') {
      tasks[idx].status = 'In Progress';
      tasks[idx].statusChangedAt = now;
    }
    writeTasks(tasks);
    res.json(tasks[idx]);
    // Trigger 2: email requestedBy that task was acknowledged
    const task = tasks[idx];
    if (task.requestedBy) {
      const rbEmail = getStaffEmail(task.requestedBy);
      if (rbEmail) {
        sendEmail(rbEmail, task.requestedBy,
          `[Task Acknowledged] ${task.title}`,
          `<p>Hi ${task.requestedBy},</p>
          <p><strong>${task.acknowledgedBy}</strong> has acknowledged your task and is now working on it.</p>
          <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
            <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Task</td><td>${task.title}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Assigned To</td><td>${task.assignedTo || '—'}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Status</td><td>In Progress</td></tr>
          </table>
          <p><a href="${APP_URL}/my-tasks">View Tasks →</a></p>`
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
      `<p>Hi ${staffName},</p>
      <p>This is a reminder to submit your end-of-day log.</p>
      <p><a href="${APP_URL}">Submit EOD Log →</a></p>
      <p style="color:#888;font-size:12px;">Sent from LYS Operations Tracker</p>`
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
      date: req.body.date || new Date().toISOString().split('T')[0],
      hours: parseFloat(req.body.hours) || 0,
      note: req.body.note || '',
      loggedBy: req.body.loggedBy || '',
      loggedAt: new Date().toISOString()
    };
    tasks[idx].hoursLogged.push(entry);
    writeTasks(tasks);
    res.json(tasks[idx]);
  } catch (e) { logError('route.post.tasks.hours', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    let tasks = readTasks();
    tasks = tasks.filter(t => t.id !== req.params.id);
    writeTasks(tasks);
    res.json({ ok: true });
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
  const logDate = date || new Date().toISOString().split('T')[0];
  const log = {
    id: Date.now().toString(36),
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
  fs.writeFileSync(EOD_FILE, JSON.stringify(logs, null, 2));

  // Update tasks — log hours + mark done if flagged
  const tasks = readTasks();
  (taskEntries || []).forEach(entry => {
    const idx = tasks.findIndex(t => t.id === entry.taskId);
    if (idx === -1) return;
    if (entry.hours > 0) {
      tasks[idx].hoursLogged.push({
        date: log.date,
        hours: parseFloat(entry.hours) || 0,
        note: notes || '',
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
  if (!fs.existsSync(CLAIMS_FILE)) fs.writeFileSync(CLAIMS_FILE, '[]');
  return safeReadJSON(CLAIMS_FILE);
}
function writeClaims(c) {
  const tmp = CLAIMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CLAIMS_FILE);
}

// GET summary (before /:id so it matches first)
app.get('/api/claims/summary', (req, res) => {
  try {
    const claims = readClaims();
    const today = new Date().toISOString().split('T')[0];
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

// POST create
app.post('/api/claims', (req, res) => {
  try {
    const claims = readClaims();
    const b = req.body;
    const submitted = new Date(b.submittedDate || new Date());
    const certDue = new Date(submitted); certDue.setDate(certDue.getDate() + 21);
    const claim = {
      id: Date.now().toString(36),
      projectId:            b.projectId || '',
      projectJobCode:       b.projectJobCode || '',
      projectName:          b.projectName || '',
      claimNumber:          b.claimNumber || 'PC#1',
      description:          b.description || '',
      claimAmount:          parseFloat(b.claimAmount) || 0,
      submittedDate:        b.submittedDate || new Date().toISOString().split('T')[0],
      submittedBy:          b.submittedBy || '',
      certificationDue:     certDue.toISOString().split('T')[0],
      certifiedDate:        null,
      certifiedAmount:      null,
      invoiceNumber:        b.invoiceNumber || null,
      invoiceRaisedDate:    null,
      paymentDue:           null,
      paymentReceivedDate:  null,
      paymentReceivedAmount:null,
      status:               'Awaiting Certification',
      notes:                b.notes || '',
      createdAt:            new Date().toISOString()
    };
    claims.push(claim);
    writeClaims(claims);
    res.json(claim);
  } catch (e) { logError('route.post.claims', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT update
app.put('/api/claims/:id', (req, res) => {
  try {
    const claims = readClaims();
    const idx = claims.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    if (b.certifiedDate && !claims[idx].certifiedDate) {
      const certDate = new Date(b.certifiedDate);
      const payDue = new Date(certDate); payDue.setDate(payDue.getDate() + 35);
      b.paymentDue = payDue.toISOString().split('T')[0];
      if (!b.status) b.status = 'Certified';
    }
    if (b.invoiceRaisedDate && !claims[idx].invoiceRaisedDate && !b.status) b.status = 'Invoiced';
    if (b.paymentReceivedDate && !claims[idx].paymentReceivedDate) b.status = 'Paid';
    claims[idx] = { ...claims[idx], ...b };
    writeClaims(claims);
    res.json(claims[idx]);
  } catch (e) { logError('route.put.claims', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE
app.delete('/api/claims/:id', (req, res) => {
  try {
    const pin = req.body?.pin || req.headers["x-admin-pin"];
    const adminData = readAdmin();
    if (adminData.pin && pin !== adminData.pin) {
      return res.status(403).json({ error: "Invalid PIN" });
    }
    let claims = readClaims();
    claims = claims.filter(c => c.id !== req.params.id);
    writeClaims(claims);
    res.json({ ok: true });
  } catch (e) { logError('route.delete.claims', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/eod-log', (req, res) => {
  try {
  const logs = readEOD();
  const date = req.query.date || new Date().toISOString().split('T')[0];
  // When staffName is provided, return just that person's logs for that date as an array
  if (req.query.staffName) {
    const staffName = sanitizeStr(req.query.staffName, 100);
    return res.json(logs.filter(l => l.date === date && l.staffName === staffName));
  }
  const allStaff = getStaffNames().filter(n => n !== 'Lai Wei Xiang');
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
    const today = now.toISOString().split('T')[0];
    const weekStart  = getWeekStart();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

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

// 9am weekdays — consolidated checks (sequential to prevent concurrent read/write to tasks.json)
cron.schedule('0 9 * * 1-5', async () => {
  try {
  const today = new Date().toISOString().split('T')[0];
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
        `<p>Hi ${task.assignedTo},</p>
        <p>You have an overdue task:</p>
        <p><strong>${task.title}</strong><br>Due: ${task.dueDate}<br>Project: ${task.projectJobCode || 'N/A'}</p>
        <p><a href="${APP_URL}/my-tasks">View My Tasks →</a></p>`
      );
      task.overdueEmailSent = true;
    } else {
      console.warn('[EMAIL SKIP] No email for:', task.assignedTo);
    }
  }
  writeTasks(tasks);
  console.log(`[CRON] Overdue task emails sent: ${overdue.length}`);

  // ── Check 2: SOP claims deadline alerts ───────────────────────────────────
  console.log('[CRON] 9am SOP claims deadline check...');
  const claims = readClaims();
  const in3days = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
  let claimsChanged = false;
  for (const claim of claims) {
    if (claim.status === 'Awaiting Certification' && claim.certificationDue) {
      if (claim.certificationDue === in3days) {
        const alexEmail = getStaffEmail('Alex Mac');
        if (alexEmail) {
          await sendEmail(alexEmail, 'Alex Mac',
            `[SOP Alert] Certification due in 3 days — ${claim.projectJobCode || ''} ${claim.claimNumber}`,
            `<p>Hi Alex,</p>
            <p>Progress claim <strong>${claim.claimNumber}</strong> for <strong>${claim.projectJobCode || ''}</strong> certification is due in 3 days (${claim.certificationDue}).</p>
            <p>If client has not responded, please chase now.</p>
            <p>Amount: $${Number(claim.claimAmount || 0).toLocaleString()}</p>
            <p><a href="${APP_URL}">Open OPS Tracker →</a></p>`
          );
        }
      }
      if (claim.certificationDue < today && !claim.certOverdueEmailSent) {
        const alexEmail = getStaffEmail('Alex Mac');
        if (alexEmail) {
          await sendEmail(alexEmail, 'Alex Mac',
            `[URGENT] SOP Deadline Passed — ${claim.projectJobCode || ''} ${claim.claimNumber}`,
            `<p>Hi Alex,</p>
            <p>The SOP Act certification deadline has passed for <strong>${claim.claimNumber}</strong> on ${claim.projectJobCode || ''}.</p>
            <p>Amount at risk: $${Number(claim.claimAmount || 0).toLocaleString()}</p>
            <p>Consider issuing a Payment Response Notice under SOP Act.</p>
            <p><a href="${APP_URL}">Open OPS Tracker →</a></p>`
          );
          claim.certOverdueEmailSent = true;
          claimsChanged = true;
        }
      }
    }
  }
  if (claimsChanged) writeClaims(claims);
  console.log('[CRON] SOP claims check done');

  // ── Check 3: Unacknowledged task reminders ────────────────────────────────
  console.log('[CRON] 9am unacknowledged task reminder check...');
  const allTasks = readTasks();
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  let tasksChanged = false;
  for (const task of allTasks) {
    if (!task.assignedTo || task.acknowledgedAt || task.status === 'Done') continue;
    if (!task.createdAt || task.createdAt > cutoff) continue;
    if (task.ackReminderSentAt && task.ackReminderSentAt > cutoff) continue;
    const assigneeEmail = getStaffEmail(task.assignedTo);
    if (!assigneeEmail) { console.warn('[EMAIL SKIP] No email for:', task.assignedTo); continue; }
    const ccEmails = [];
    if (task.requestedBy) {
      const rbEmail = getStaffEmail(task.requestedBy);
      if (rbEmail) ccEmails.push(rbEmail);
    }
    try {
      if (ccEmails.length > 0) {
        const senderEmail = process.env.SENDER_EMAIL;
        const accessToken = await getAccessToken();
        if (accessToken && senderEmail) {
          const recipient = process.env.EMAIL_TEST_OVERRIDE || assigneeEmail;
          const ccRecipients = ccEmails.map(e => ({ emailAddress: { address: e } }));
          await fetch(`https://graph.microsoft.com/v1.0/users/${senderEmail}/sendMail`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: {
                subject: `[Reminder] Please acknowledge: ${task.title}`,
                body: {
                  contentType: 'HTML',
                  content: `<p>Hi ${task.assignedTo},</p>
                  <p>You have an unacknowledged task assigned to you:</p>
                  <p><strong>${task.title}</strong></p>
                  <p>Please acknowledge this task so the requester knows you have received it.</p>
                  <p><a href="${APP_URL}/my-tasks">View My Tasks →</a></p>
                  <p style="color:#888;font-size:12px;">Sent from LYS Operations Tracker</p>`
                },
                toRecipients: [{ emailAddress: { address: recipient, name: task.assignedTo } }],
                ccRecipients
              }
            })
          });
          console.log(`[CRON] Ack reminder sent to ${assigneeEmail} (CC: ${ccEmails.join(', ')}) for task: ${task.title}`);
        }
      } else {
        await sendEmail(assigneeEmail, task.assignedTo,
          `[Reminder] Please acknowledge: ${task.title}`,
          `<p>Hi ${task.assignedTo},</p>
          <p>You have an unacknowledged task assigned to you:</p>
          <p><strong>${task.title}</strong></p>
          <p>Please acknowledge this task so the requester knows you have received it.</p>
          <p><a href="${APP_URL}/my-tasks">View My Tasks →</a></p>
          <p style="color:#888;font-size:12px;">Sent from LYS Operations Tracker</p>`
        );
        console.log(`[CRON] Ack reminder sent to ${assigneeEmail} for task: ${task.title}`);
      }
      task.ackReminderSentAt = now.toISOString();
      tasksChanged = true;
    } catch (e) {
      console.error(`[CRON] Ack reminder failed for task ${task.id}:`, e.message);
    }
  }
  if (tasksChanged) writeTasks(allTasks);
  console.log('[CRON] Unacknowledged task reminder check done');
  } catch (e) { logError('cron.9am-checks', e); }
}, { timezone: 'Asia/Singapore' });

// Trigger 2: Noon weekdays — remind Chris about unacknowledged DRs > 24hrs
cron.schedule('0 12 * * 1-5', async () => {
  try {
  console.log('[CRON] Noon delivery request reminder check...');
  const projects = readProjects();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  for (const p of projects) {
    const stale = (p.deliveryRequests || []).filter(r =>
      r.ticketStatus === 'New' && r.requestedAt && r.requestedAt < yesterday
    );
    if (stale.length > 0) {
      const chrisEmail = getStaffEmail('Chris');
      if (chrisEmail) {
        await sendEmail(chrisEmail, 'Chris',
          `[Reminder] Unacknowledged Delivery Request — ${p.jobCode}`,
          `<p>Hi Chris,</p>
          <p>A delivery request for <strong>${p.jobCode}</strong> has been waiting for your acknowledgement for over 24 hours.</p>
          <p>Items: ${stale.map(r => r.item).join(', ')}</p>
          <p><a href="${APP_URL}/project.html?id=${p.id}">Open OPS Tracker →</a></p>`
        );
      }
    }
  }
  } catch (e) { logError('cron.noon-dr', e); }
}, { timezone: 'Asia/Singapore' });

// 6pm weekdays — EOD reminder to staff who haven't submitted yet (with task status)
cron.schedule('0 18 * * 1-5', async () => {
  try {
  console.log('[CRON] 6pm EOD reminder running...');
  const today = new Date().toISOString().split('T')[0];
  const logs = readEOD();
  const submitted = logs.filter(l => l.date === today).map(l => l.staffName);
  const staffToRemind = ['Chris', 'Rena', 'Alex Mac', 'Salve', 'Teo Meei Haw', 'Jun Jie']
    .filter(n => !submitted.includes(n));

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
            `${icon} <span style="color:${color};${strike}">${t.title}</span>` +
            (t.category ? ` <span style="color:#aaa;font-size:11px;">[${t.category}]</span>` : '') +
            `</li>`;
        }).join('')
      : `<li style="padding:5px 0;list-style:none;font-size:13px;color:#888;">No tasks assigned today.</li>`;

    const htmlBody =
      `<div style="font-family:Arial,sans-serif;max-width:520px;color:#222;">` +
      `<p style="margin:0 0 12px;">Hi ${firstName},</p>` +
      `<p style="margin:0 0 16px;">This is a reminder to submit your <strong>EOD report</strong> for today.</p>` +
      `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin-bottom:8px;">Today's Tasks</div>` +
      `<ul style="padding:0;margin:0 0 20px;">${taskRowsHtml}</ul>` +
      `<p style="margin:0 0 20px;">` +
        `<a href="${APP_URL}/my-tasks#${firstName.toLowerCase()}" ` +
        `style="background:#3366ff;color:#fff;padding:9px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">` +
        `Submit EOD Report →</a></p>` +
      `<p style="margin:0;font-size:11px;color:#aaa;">LYS Ops Tracker</p>` +
      `</div>`;

    await sendEmail(email, name, 'EOD Reminder — Please submit your report for today', htmlBody);
    sent++;
  }
  console.log(`[CRON] 6pm EOD reminders sent: ${sent}`);
  } catch (e) { logError('cron.6pm-eod-reminder', e); }
}, { timezone: 'Asia/Singapore' });

// Trigger 5: 6:15pm weekdays — flag + email Lai if EOD not submitted
cron.schedule('15 18 * * 1-5', async () => {
  try {
  console.log('[CRON] 6:15pm EOD check running...');
  const today = new Date().toISOString().split('T')[0];
  const logs = readEOD();
  const submitted = logs.filter(l => l.date === today).map(l => l.staffName);
  const staffNames = getStaffNames().filter(n => n !== 'Lai Wei Xiang');
  const missing = staffNames.filter(n => !submitted.includes(n));
  // Write current flags file (for live /api/eod-log endpoint)
  fs.writeFileSync(FLAG_FILE, JSON.stringify({ date: today, missing }, null, 2));
  // Append to cumulative history (permanent record)
  const history = readEODHistory();
  const existingIdx = history.findIndex(h => h.date === today);
  const histEntry = { date: today, submitted, missing, recordedAt: new Date().toISOString() };
  if (existingIdx !== -1) { history[existingIdx] = histEntry; } else { history.push(histEntry); }
  fs.writeFileSync(EOD_HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`[CRON] EOD missing: ${missing.join(', ') || 'none'}`);

  if (missing.length > 0) {
    const laiEmail = process.env.SENDER_EMAIL;
    if (laiEmail) {
      await sendEmail(laiEmail, 'Lai Wei Xiang',
        `[EOD Alert] ${missing.length} staff haven't submitted end-of-day log`,
        `<p>The following staff have not submitted their EOD log today (${today}):</p>
        <ul>${missing.map(n => `<li><strong>${n}</strong></li>`).join('')}</ul>
        <p><a href="${APP_URL}/tasks">View Tasks Dashboard →</a></p>`
      );
    }
  }
  } catch (e) { logError('cron.eod-flag', e); }
}, { timezone: 'Asia/Singapore' });

// 7pm weekdays — remind staff who haven't submitted EOD log
cron.schedule('0 19 * * 1-5', async () => {
  try {
  console.log('[CRON] 7pm EOD staff reminder running...');
  const today = new Date().toISOString().split('T')[0];
  const logs = readEOD();
  const submitted = logs.filter(l => l.date === today).map(l => l.staffName);
  const missing = getStaffNames()
    .filter(n => n !== 'Lai Wei Xiang')
    .filter(n => !submitted.includes(n));

  let sent = 0;
  for (const name of missing) {
    const email = getStaffEmail(name);
    if (!email) continue;
    await sendEmail(email, name,
      '[Reminder] Please submit your EOD log',
      `<p>Hi ${name}, please submit your end-of-day log before 8pm today.</p>
      <p><a href="${APP_URL}">Submit EOD Log →</a></p>`
    );
    sent++;
  }
  console.log(`[CRON] EOD staff reminders sent: ${sent}`);
  } catch (e) { logError('cron.eod-staff-reminder', e); }
}, { timezone: 'Asia/Singapore' });

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
    const filename = `LYS-Projects-${new Date().toISOString().split('T')[0]}.xlsx`;
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
app.post('/api/workers', (req, res) => {
  try {
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
app.put('/api/workers/:id', (req, res) => {
  try {
    const workers = readWorkers();
    const idx = workers.findIndex(w => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Worker not found' });
    workers[idx] = { ...workers[idx], ...req.body, id: workers[idx].id };
    writeWorkers(workers);
    logActivity('worker.updated', { workerId: req.params.id, name: workers[idx].name });
    res.json(workers[idx]);
  } catch (e) { logError('route.put.workers', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/workers/:id — remove worker
app.delete('/api/workers/:id', (req, res) => {
  try {
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
  if (!fs.existsSync(ATTENDANCE_FILE)) fs.writeFileSync(ATTENDANCE_FILE, '[]');
  return safeReadJSON(ATTENDANCE_FILE);
}

function writeAttendance(records) {
  const tmp = ATTENDANCE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, ATTENDANCE_FILE);
}

// GET /api/attendance/today — shortcut for today's date
app.get('/api/attendance/today', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
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
  const tmp = SITE_REQUESTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, SITE_REQUESTS_FILE);
}

const VALID_SR_STATUSES = ['New', 'Acknowledged', 'In Fabrication', 'Ready', 'Delivered', 'Issue'];

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

  if (!item || !requestedBy || !neededByDate) {
    return res.status(400).json({ error: 'item, requestedBy, and neededByDate are required' });
  }

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId, projectJobCode, projectName,
    item, quantity, unit, neededByDate,
    requestedBy, notes,
    status: 'New',
    createdAt: new Date().toISOString(),
    acknowledgedAt: null,
    estimatedReadyDate: null,
    chrisNotes: null,
    deliveredAt: null,
    issueReason: null
  };

  const all = readSiteRequests();
  all.push(record);
  writeSiteRequests(all);
  logActivity('site-request.created', { id: record.id, item, requestedBy });

  // Notify Chris of new request
  const chrisEmail = getStaffEmail('Chris');
  if (chrisEmail) {
    sendEmail(chrisEmail, 'Chris',
      `[New Site Request] ${item} — ${projectJobCode || projectName}`,
      `<p>Hi Chris,</p>
      <p>A new factory request has been submitted.</p>
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;margin:10px 0;">
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Item</td><td>${item}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Qty</td><td>${quantity} ${unit}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Project</td><td>${projectJobCode || ''} ${projectName || ''}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Needed By</td><td>${neededByDate}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Requested By</td><td>${requestedBy}</td></tr>
        ${notes ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Notes</td><td>${notes}</td></tr>` : ''}
      </table>
      <p>View in the <a href="${APP_URL}/factory">Factory dashboard</a> → Site Requests tab.</p>`
    );
  }

  res.json(record);
  } catch (e) { logError('route.post.site-requests', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/site-requests/:id — update status / Chris response
app.put('/api/site-requests/:id', (req, res) => {
  try {
  const all = readSiteRequests();
  const idx = all.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Site request not found' });

  const record = all[idx];
  const oldStatus = record.status;

  if (req.body.status !== undefined) {
    const s = sanitizeStr(req.body.status, 30);
    if (!VALID_SR_STATUSES.includes(s)) return res.status(400).json({ error: 'Invalid status' });
    record.status = s;
  }
  if (req.body.estimatedReadyDate !== undefined) record.estimatedReadyDate = sanitizeStr(req.body.estimatedReadyDate, 20);
  if (req.body.chrisNotes !== undefined)         record.chrisNotes         = sanitizeStr(req.body.chrisNotes, 1000);
  if (req.body.issueReason !== undefined)        record.issueReason        = sanitizeStr(req.body.issueReason, 1000);

  if (record.status === 'Acknowledged' && !record.acknowledgedAt) {
    record.acknowledgedAt = new Date().toISOString();
  }
  if (record.status === 'Delivered' && !record.deliveredAt) {
    record.deliveredAt = new Date().toISOString();
  }

  all[idx] = record;
  writeSiteRequests(all);
  logActivity('site-request.updated', { id: record.id, status: record.status, from: oldStatus });

  // Notify site engineer when Ready
  if (record.status === 'Ready' && oldStatus !== 'Ready') {
    const engEmail = getStaffEmail(record.requestedBy);
    if (engEmail) {
      sendEmail(engEmail, record.requestedBy,
        `[Ready] ${record.item} is ready for delivery`,
        `<p>Hi ${record.requestedBy},</p>
        <p>Your factory request for <strong>${record.item}</strong> (${record.quantity} ${record.unit}) is ready.</p>
        ${record.estimatedReadyDate ? `<p>Estimated delivery: ${record.estimatedReadyDate}</p>` : ''}
        ${record.chrisNotes ? `<p>Notes from Chris: ${record.chrisNotes}</p>` : ''}
        <p>View status in <a href="${APP_URL}/installation">Installation tracker</a> → My Requests.</p>`
      );
    }
  }

  // Notify site engineer when Delivered
  if (record.status === 'Delivered' && oldStatus !== 'Delivered') {
    const engEmail = getStaffEmail(record.requestedBy);
    if (engEmail) {
      sendEmail(engEmail, record.requestedBy,
        `[Delivered] ${record.item} has been delivered`,
        `<p>Hi ${record.requestedBy},</p>
        <p><strong>${record.item}</strong> (${record.quantity} ${record.unit}) has been delivered to site.</p>
        <p>Project: ${record.projectJobCode || ''} ${record.projectName || ''}</p>`
      );
    }
  }

  // Notify site engineer when Issue flagged
  if (record.status === 'Issue' && oldStatus !== 'Issue') {
    const engEmail = getStaffEmail(record.requestedBy);
    if (engEmail) {
      sendEmail(engEmail, record.requestedBy,
        `[Issue] Factory cannot fulfil request: ${record.item}`,
        `<p>Hi ${record.requestedBy},</p>
        <p>There is an issue with your request for <strong>${record.item}</strong>.</p>
        ${record.issueReason ? `<p>Reason: ${record.issueReason}</p>` : ''}
        <p>Please follow up with Chris directly.</p>`
      );
    }
  }

  res.json(record);
  } catch (e) { logError('route.put.site-requests', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

// ── Monday Flags API ─────────────────────────────────────────────────────────
function readMondayFlags() {
  try {
    if (!fs.existsSync(MONDAY_FLAGS_FILE)) return [];
    return safeReadJSON(MONDAY_FLAGS_FILE);
  } catch { return []; }
}

function writeMondayFlags(flags) {
  const tmp = MONDAY_FLAGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(flags, null, 2));
  fs.renameSync(tmp, MONDAY_FLAGS_FILE);
}

// GET /api/monday-flags — all flags (client filters by weekStart)
app.get('/api/monday-flags', (req, res) => {
  try {
    res.json(readMondayFlags());
  } catch (e) { logError('route.get.monday-flags', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/monday-flags — add a flag for an engineer this week
app.post('/api/monday-flags', (req, res) => {
  try {
    const engineer  = String(req.body.engineer  || '').trim().slice(0, 100);
    const text      = String(req.body.text      || '').trim().slice(0, 200);
    const weekStart = String(req.body.weekStart || '').trim().slice(0, 10);
    if (!engineer || !text || !weekStart) return res.status(400).json({ error: 'engineer, text and weekStart required' });
    const flags = readMondayFlags();
    const flag = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), engineer, text, weekStart, createdAt: new Date().toISOString() };
    flags.push(flag);
    writeMondayFlags(flags);
    res.json(flag);
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
// Daily definitions: { title, category }
const RECURRING_DEFS = {
  Chris: [
    { title: 'Take attendance — mark MC/absent workers',                           category: 'People'     },
    { title: 'Review today\'s fabrication priorities across all projects',          category: 'Operations' },
    { title: 'Safety walkthrough — check machines, tools, fire exits',             category: 'Safety'     },
    { title: 'Check site requests inbox — acknowledge within 2 hours',             category: 'Operations' },
    { title: 'Assign workers to projects and plan transport',                      category: 'People'     },
    { title: 'Update FAB progress on all active items',                            category: 'Reporting'  },
    { title: 'Confirm next-day material and delivery readiness',                   category: 'Operations' },
    { title: 'Submit EOD log',                                                     category: 'Reporting'  },
  ],
  Chris_monday: [
    { title: 'Weekly fab planning — align with site engineer priorities',           category: 'Operations' },
    { title: 'Check stock levels — flag low materials to Rena',                    category: 'Operations' },
  ],
  Rena: [
    { title: 'Check all pending POs — confirm delivery dates with suppliers',      category: 'Operations'  },
    { title: 'Follow up on overdue supplier deliveries',                           category: 'Operations'  },
    { title: 'Source 1 new supplier contact today — log in Procurement',           category: 'Development' },
    { title: 'Update material ETA for all active projects',                        category: 'Reporting'   },
    { title: 'Submit EOD log',                                                     category: 'Reporting'   },
  ],
  Rena_monday: [
    { title: 'Weekly supplier review — compare prices, flag unreliable suppliers', category: 'Operations' },
  ],
  'Alex Mac': [
    { title: 'Check completed installations — trigger claim submissions',          category: 'Operations' },
    { title: 'Review SOP Act deadlines — flag anything due within 7 days',         category: 'Reporting'  },
    { title: 'Chase outstanding payment responses from clients',                   category: 'Operations' },
    { title: 'Update claims status for all active projects',                       category: 'Reporting'  },
    { title: 'Submit EOD log',                                                     category: 'Reporting'  },
  ],
  'Alex Mac_monday': [
    { title: 'Weekly claims review — total outstanding, overdue, upcoming',        category: 'Reporting'  },
  ],
  'Salve': [
    { title: 'Check completed installations — trigger claim submissions',          category: 'Operations' },
    { title: 'Review SOP Act deadlines — flag anything due within 7 days',         category: 'Reporting'  },
    { title: 'Chase outstanding payment responses from clients',                   category: 'Operations' },
    { title: 'Update claims status for all active projects',                       category: 'Reporting'  },
    { title: 'Submit EOD log',                                                     category: 'Reporting'  },
  ],
  'Salve_monday': [
    { title: 'Weekly claims review — total outstanding, overdue, upcoming',        category: 'Reporting'  },
  ],
  'Teo Meei Haw': [
    { title: 'Set today\'s installation target — project, item, qty, location',    category: 'Operations' },
    { title: 'Check factory readiness for items needed this week',                 category: 'Operations' },
    { title: 'Update installation progress on active projects',                    category: 'Reporting'  },
    { title: 'Log result — qty done vs target, reason if short: Site Not Ready / Factory Delay / Manpower Shortage / Weather / Client Access / Other', category: 'Reporting' },
    { title: 'Submit EOD log',                                                     category: 'Reporting'  },
  ],
  'Teo Meei Haw_monday': [
    { title: 'Weekly site planning — align with factory on delivery schedule',     category: 'Operations' },
  ],
  'Jun Jie': [
    { title: 'Set today\'s installation target — project, item, qty, location',    category: 'Operations' },
    { title: 'Check factory readiness for items needed this week',                 category: 'Operations' },
    { title: 'Update installation progress on active projects',                    category: 'Reporting'  },
    { title: 'Log result — qty done vs target, reason if short: Site Not Ready / Factory Delay / Manpower Shortage / Weather / Client Access / Other', category: 'Reporting' },
    { title: 'Submit EOD log',                                                     category: 'Reporting'  },
  ],
  'Jun Jie_monday': [
    { title: 'Weekly site planning — align with factory on delivery schedule',     category: 'Operations' },
  ],
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
    const todaySGT = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Singapore"})).toISOString().slice(0,10);
    const tasks = readTasks();
    const seen = new Map(); // key: "assignedTo|title" -> index of first occurrence
    const toRemove = new Set();
    tasks.forEach((t, i) => {
      if (t.taskType !== 'Recurring') return;
      if ((t.dueDate || '').slice(0,10) !== todaySGT) return;
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

  const people = ['Chris', 'Rena', 'Alex Mac', 'Salve', 'Teo Meei Haw', 'Jun Jie'];
  for (const person of people) {
    const daily   = RECURRING_DEFS[person]             || [];
    const monday  = isMonday ? (RECURRING_DEFS[`${person}_monday`] || []) : [];
    const allDefs = daily.concat(monday);

    for (const def of allDefs) {
      // Dedup: skip if same assignedTo + title already created today
      const todaySGT = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Singapore"})).toISOString().slice(0,10);
      const exists = tasks.some(t =>
        t.assignedTo === person &&
        t.title === def.title &&
        (t.createdAt || t.dueDate || "").slice(0,10) === todaySGT
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
    const emailPromises = [];
    for (const person of people) {
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
        `<div><span style="font-size:13px;">${t.title}</span> ` +
        `<span style="display:inline-block;font-size:10px;font-weight:700;color:#fff;background:#3366ff;border-radius:4px;padding:1px 6px;margin-left:4px;vertical-align:middle;">${t.category}</span></div>` +
        `</li>`
      ).join('');
      const firstName = person.split(' ')[0];
      const htmlBody =
        `<div style="font-family:Arial,sans-serif;max-width:520px;color:#222;">` +
        `<p style="margin:0 0 4px;font-size:15px;font-weight:700;">Good morning ${firstName} 👋</p>` +
        `<p style="margin:0 0 16px;font-size:12px;color:#888;">${dayName}, ${dateFmt}</p>` +
        `<p style="margin:0 0 10px;font-size:13px;">Here are your <strong>${personTasks.length} task${personTasks.length !== 1 ? 's' : ''}</strong> for today:</p>` +
        `<ul style="padding:0;margin:0 0 20px;">${taskListHtml}</ul>` +
        `<p style="margin:0 0 20px;">` +
        `<a href="${APP_URL}/my-tasks#${firstName.toLowerCase()}" ` +
        `style="background:#3366ff;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;display:inline-block;">` +
        `Open My Tasks →</a></p>` +
        `<p style="margin:0 0 0;padding:12px 16px;background:#fff8e6;border-left:3px solid #fdab3d;border-radius:4px;font-size:12px;color:#b45309;">` +
        `📋 Remember to submit your EOD report by 6pm</p>` +
        `<p style="margin:12px 0 0;font-size:11px;color:#aaa;">LYS Ops Tracker</p>` +
        `</div>`;
      emailPromises.push(
        sendEmail(personEmail, person, `Good morning ${firstName} — Your tasks for ${dayName}, ${dateFmt}`, htmlBody)
          .catch(e => console.error(`[RECURRING] Email failed for ${person}:`, e.message))
      );
    }
    await Promise.all(emailPromises);
    console.log(`[RECURRING] Daily task emails sent for ${today}`);
  } else {
    console.log(`[RECURRING] ${today}: all recurring tasks already exist — skipped`);
  }
  } catch (e) { logError('cron.daily-recurring', e); }
}

// Schedule: 8:45am SGT, Mon–Fri
cron.schedule('45 8 * * 1-5', createDailyRecurringTasks, { timezone: 'Asia/Singapore' });
console.log('[RECURRING] Daily task cron scheduled: 8:45am SGT, Mon–Fri');

// ── Procurement Route ─────────────────────────────────────────────────────────
app.get('/procurement', (req, res) => res.sendFile(path.join(__dirname, 'public', 'procurement.html')));

// ── Procurement Helpers ───────────────────────────────────────────────────────
function readSuppliers()    { try { if (!fs.existsSync(SUPPLIERS_FILE)) return []; return safeReadJSON(SUPPLIERS_FILE); } catch { return []; } }
function writeSuppliers(d)  { const tmp = SUPPLIERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, SUPPLIERS_FILE); }
function readPrices()       { try { if (!fs.existsSync(PRICES_FILE)) return []; return safeReadJSON(PRICES_FILE); } catch { return []; } }
function writePrices(d)     { const tmp = PRICES_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PRICES_FILE); }
function readPOs()          { try { if (!fs.existsSync(PO_FILE)) return []; return safeReadJSON(PO_FILE); } catch { return []; } }
function writePOs(d)        { const tmp = PO_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PO_FILE); }
function readPRs()          { try { if (!fs.existsSync(PR_FILE)) return []; return safeReadJSON(PR_FILE); } catch { return []; } }
function writePRs(d)        { const tmp = PR_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PR_FILE); }

// Auto-flag Overdue: promisedDate < today and status !== Delivered
function applyOverdueFlag(pos) {
  const today = new Date().toISOString().split('T')[0];
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
      date:         String(b.date || new Date().toISOString().split('T')[0]).trim().slice(0, 10),
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

// ── Purchase Orders API ───────────────────────────────────────────────────────
app.get('/api/purchase-orders', (req, res) => {
  try {
    const pos = applyOverdueFlag(readPOs());
    if (req.query.projectId) return res.json(pos.filter(po => po.projectId === req.query.projectId));
    res.json(pos);
  } catch (e) { logError('route.get.purchase-orders', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/purchase-orders', postRateLimit, (req, res) => {
  try {
    const b = req.body;
    const qty = parseFloat(b.quantity) || 0;
    const up  = parseFloat(b.unitPrice) || 0;
    const po = {
      id:             'PO-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
      projectId:      String(b.projectId      || '').trim(),
      projectJobCode: String(b.projectJobCode || '').trim().slice(0, 50),
      material:       String(b.material       || '').trim().slice(0, 200),
      quantity:       qty,
      unit:           String(b.unit           || '').trim().slice(0, 30),
      supplierId:     String(b.supplierId     || '').trim(),
      supplierName:   String(b.supplierName   || '').trim().slice(0, 200),
      unitPrice:      up,
      totalAmount:    parseFloat(b.totalAmount) || (qty * up),
      orderedDate:    String(b.orderedDate  || new Date().toISOString().split('T')[0]).trim().slice(0, 10),
      promisedDate:   String(b.promisedDate || '').trim().slice(0, 10),
      actualDate:     String(b.actualDate   || '').trim().slice(0, 10),
      status:         ['Ordered', 'In Transit', 'Delivered', 'Overdue'].includes(b.status) ? b.status : 'Ordered',
      notes:          String(b.notes        || '').trim().slice(0, 500),
      createdAt:      new Date().toISOString()
    };
    if (!po.material) return res.status(400).json({ error: 'material required' });
    const pos = readPOs();
    pos.push(po);
    writePOs(pos);
    logActivity('po.created', { id: po.id, material: po.material, supplierName: po.supplierName });
    res.status(201).json(po);
  } catch (e) { logError('route.post.purchase-orders', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/purchase-orders/:id', (req, res) => {
  try {
    const pos = readPOs();
    const idx = pos.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Purchase order not found' });
    const b = req.body;
    pos[idx] = Object.assign({}, pos[idx], b, {
      id:        pos[idx].id,
      createdAt: pos[idx].createdAt,
      updatedAt: new Date().toISOString()
    });
    if (!['Ordered', 'In Transit', 'Delivered', 'Overdue'].includes(pos[idx].status)) pos[idx].status = 'Ordered';
    writePOs(pos);
    logActivity('po.updated', { id: pos[idx].id, status: pos[idx].status });
    res.json(applyOverdueFlag([pos[idx]])[0]);
  } catch (e) { logError('route.put.purchase-orders', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete("/api/purchase-orders/:id", (req, res) => {
  const pin = req.body?.pin || req.headers["x-admin-pin"];
  const adminData = readAdmin();
  if (adminData.pin && pin !== adminData.pin) return res.status(403).json({ error: "Invalid PIN" });
  const orders = readPOs();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  orders.splice(idx, 1);
  writePOs(orders);
  logActivity("purchase-order.deleted", { id: req.params.id });
  res.json({ ok: true });
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
    const today = new Date().toISOString().split('T')[0];
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
    const yr  = new Date().getFullYear().toString().slice(2);
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
      id: prNumber, prNumber, poNumber: null,
      requestDate:  new Date().toISOString().split('T')[0],
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
    // Email Rena + CC Lai
    const renaEmail = getStaffEmail('Rena') || 'enquiry@laiyewseng.com.sg';
    const laiEmail  = getStaffEmail('Lai Wei Xiang') || 'laiwx@laiyewseng.com.sg';
    const itemsSummary = pr.items.map(i => `${i.description || '—'} (${i.qty} ${i.unit})`).join('; ') || '—';
    try {
      const accessToken = await getAccessToken();
      if (accessToken && process.env.SENDER_EMAIL) {
        const toAddr = process.env.EMAIL_TEST_OVERRIDE || renaEmail;
        const ccAddr = process.env.EMAIL_TEST_OVERRIDE || laiEmail;
        await fetch(`https://graph.microsoft.com/v1.0/users/${process.env.SENDER_EMAIL}/sendMail`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: {
            subject: `New PR: ${prNumber} — ${pr.projectCode || 'General'}`,
            body: { contentType: 'HTML', content:
              `<p>Hi Rena,</p><p>A new Purchase Requisition has been submitted.</p>
              <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
                <tr><td style="padding:4px 14px 4px 0;font-weight:600;">PR Number</td><td>${prNumber}</td></tr>
                <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Project</td><td>${pr.projectCode || '—'}</td></tr>
                <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Site</td><td>${pr.site || '—'}</td></tr>
                <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Urgency</td><td>${pr.urgency}</td></tr>
                <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Items</td><td>${itemsSummary}</td></tr>
                <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Submitted By</td><td>${pr.submittedBy || '—'}</td></tr>
                ${pr.notes ? `<tr><td style="padding:4px 14px 4px 0;font-weight:600;">Notes</td><td>${pr.notes}</td></tr>` : ''}
              </table>
              <p><a href="${APP_URL}/procurement">Open Procurement →</a></p>` },
            toRecipients: [{ emailAddress: { address: toAddr, name: 'Rena' } }],
            ccRecipients: [{ emailAddress: { address: ccAddr, name: 'Lai Wei Xiang' } }]
          }})
        });
        console.log(`[EMAIL] New PR notification → Rena (CC: Lai)`);
      }
    } catch (mailErr) { console.error('[EMAIL] PR notify failed:', mailErr.message); }
  } catch (e) { logError('route.post.purchase-requisitions', e); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/purchase-requisitions/:id', async (req, res) => {
  try {
    const prs = readPRs();
    const idx = prs.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'PR not found' });
    const b = req.body, pr = { ...prs[idx], items: prs[idx].items ? prs[idx].items.map(i => ({ ...i })) : [] };
    const oldStatus = pr.status, hadPO = !!pr.poNumber;
    if (b.poNumber    !== undefined) pr.poNumber    = String(b.poNumber    || '').trim().slice(0, 100) || null;
    if (b.supplier    !== undefined) pr.supplier    = String(b.supplier    || '').trim().slice(0, 200) || null;
    if (b.eta         !== undefined) pr.eta         = String(b.eta         || '').trim().slice(0, 10)  || null;
    if (b.notes       !== undefined) pr.notes       = String(b.notes       || '').trim().slice(0, 1000);
    if (b.site        !== undefined) pr.site        = String(b.site        || '').trim().slice(0, 200);
    if (b.projectCode !== undefined) pr.projectCode = String(b.projectCode || '').trim().slice(0, 100);
    if (Array.isArray(b.items)) {
      b.items.forEach((upd, i) => {
        if (!pr.items[i]) return;
        if (upd.unitPrice  !== undefined) pr.items[i].unitPrice  = parseFloat(upd.unitPrice) || null;
        if (upd.qtyArrived !== undefined) {
          pr.items[i].qtyArrived = parseFloat(upd.qtyArrived) || 0;
          pr.items[i].arriveDate = upd.arriveDate ? String(upd.arriveDate).trim().slice(0, 10) : (pr.items[i].arriveDate || new Date().toISOString().split('T')[0]);
          pr.items[i].outstanding = Math.max(0, (pr.items[i].qty || 0) - pr.items[i].qtyArrived);
        }
      });
    }
    const today2 = new Date().toISOString().split('T')[0];
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
    // Email: PO created → Chris
    if (pr.poNumber && !hadPO) {
      const chrisEmail = getStaffEmail('Chris');
      if (chrisEmail) {
        sendEmail(chrisEmail, 'Chris',
          `PO Created for ${pr.prNumber}: ${pr.supplier || 'Supplier TBC'}, ETA: ${pr.eta || 'TBC'}, PO#: ${pr.poNumber}`,
          `<p>Hi Chris,</p><p>A Purchase Order has been created for <strong>${pr.prNumber}</strong>.</p>
          <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
            <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Project</td><td>${pr.projectCode || '—'}</td></tr>
            <tr><td style="padding:4px 14px 4px 0;font-weight:600;">PO Number</td><td>${pr.poNumber}</td></tr>
            <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Supplier</td><td>${pr.supplier || '—'}</td></tr>
            <tr><td style="padding:4px 14px 4px 0;font-weight:600;">ETA</td><td>${pr.eta || 'TBC'}</td></tr>
          </table>
          <p><a href="${APP_URL}/procurement">Open Procurement →</a></p>`
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
    // Email: fully delivered → Chris
    if (pr.status === 'Delivered' && oldStatus !== 'Delivered') {
      const chrisEmail = getStaffEmail('Chris');
      if (chrisEmail) {
        const itemsList = pr.items.map(i => `${i.description || '—'} (${i.qtyArrived || 0} ${i.unit || ''})`).join(', ');
        sendEmail(chrisEmail, 'Chris',
          `Materials Delivered: ${pr.prNumber} — ${pr.projectCode || ''} ✅`,
          `<p>Hi Chris,</p><p>Materials for <strong>${pr.prNumber}</strong> have been fully delivered.</p>
          <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
            <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Project</td><td>${pr.projectCode || '—'}</td></tr>
            <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Supplier</td><td>${pr.supplier || '—'}</td></tr>
            <tr><td style="padding:4px 14px 4px 0;font-weight:600;">Items</td><td>${itemsList}</td></tr>
          </table>
          <p>Materials are ready to use ✅</p><p><a href="${APP_URL}/procurement">Open Procurement →</a></p>`
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

app.delete('/api/purchase-requisitions/:id', (req, res) => {
  try {
    const { pin } = req.body;
    const admin = readAdmin();
    if (admin.pin && pin !== admin.pin) return res.status(403).json({ error: 'Invalid PIN' });
    const prs = readPRs();
    const idx = prs.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'PR not found' });
    const removed = prs.splice(idx, 1)[0];
    writePRs(prs);
    logActivity('pr.deleted', { id: removed.id, prNumber: removed.prNumber });
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
app.listen(PORT, () => {
  console.log(`LYS OPS Tracker running at http://localhost:${PORT}`);
});
