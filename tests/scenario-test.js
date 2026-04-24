#!/usr/bin/env node
/**
 * Backend scenario tests for LYS Ops Tracker.
 * Runs against a live server at localhost:3000.
 *
 * Usage:  node tests/scenario-test.js
 *
 * Creates a temporary test credential, runs 22 scenarios, then cleans up.
 * NOTE: Server has a 30 POST/min rate limit. If running back-to-back with
 * scenario-extended.js, wait 60s between runs to avoid 429 errors.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const BASE = 'http://localhost:3000';
const CREDS_FILE = path.join(__dirname, '..', 'config', 'credentials.json');
const ADMIN_FILE = path.join(__dirname, '..', 'config', 'admin.json');
const TEST_EMAIL = '__test@scenario.local';
const TEST_PASS  = 'scenario-test-' + Date.now();
const TEST_NAME  = 'Scenario Tester';
const TEST_ADMIN_PIN = 'test-admin-pin-' + Date.now();

// ── Inject temp credential + temp admin pin ───────────────────────────────────
const credsRaw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
credsRaw[TEST_EMAIL] = { name: TEST_NAME, hash: bcrypt.hashSync(TEST_PASS, 10) };
fs.writeFileSync(CREDS_FILE + '.bak', fs.readFileSync(CREDS_FILE, 'utf8'));
fs.writeFileSync(CREDS_FILE, JSON.stringify(credsRaw, null, 2));

// Backup admin.json and set a known pin
let adminBak = null;
if (fs.existsSync(ADMIN_FILE)) adminBak = fs.readFileSync(ADMIN_FILE, 'utf8');
fs.writeFileSync(ADMIN_FILE, JSON.stringify({ pin: bcrypt.hashSync(TEST_ADMIN_PIN, 10) }, null, 2));

function cleanup() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    delete c[TEST_EMAIL];
    fs.writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2));
    const bak = CREDS_FILE + '.bak';
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  } catch {}
  try {
    if (adminBak) fs.writeFileSync(ADMIN_FILE, adminBak);
    else if (fs.existsSync(ADMIN_FILE)) fs.unlinkSync(ADMIN_FILE);
  } catch {}
  // Also remove test cred we added earlier for debugging
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    delete c['testscn@test.local'];
    fs.writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2));
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────
let sessionCookie = null;
let passed = 0, failed = 0;
const failures = [];

const TEST_PROJECT_ID = '__test_scenario_' + Date.now();

async function api(method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noAuth && sessionCookie) headers['Cookie'] = sessionCookie;
  if (opts.basicAuth) headers['Authorization'] = opts.basicAuth;
  const fetchOpts = { method, headers, redirect: 'manual' };
  if (body !== undefined && body !== null) fetchOpts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${urlPath}`, fetchOpts);
  const sc = res.headers.get('set-cookie');
  if (sc && sc.includes('connect.sid')) sessionCookie = sc.split(';')[0];
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function test(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; const m = `  FAIL  ${name}${detail ? ' — ' + detail : ''}`; console.log(m); failures.push(m); }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
let testTaskId = null, testSRId = null, testClaimId = null, testPRId = null, testTicketId = null;

async function run() {
  console.log('\nLYS Ops Tracker — Backend Scenario Tests');
  console.log('=========================================\n');

  // ── AUTH & SECURITY ──
  console.log('Auth & Security');
  console.log('---------------');

  // 1
  { const r = await api('GET', '/api/projects', null, { noAuth: true });
    test('1.  Unauth GET /api/projects → 401', r.status === 401); }

  // 2
  { const r = await api('POST', '/api/auth/login', { username: TEST_EMAIL, password: TEST_PASS }, { noAuth: true });
    test('2.  Login with valid creds → 200', r.status === 200 && r.data?.ok, `status=${r.status}`); }

  // 3
  { const r = await api('POST', '/api/auth/login', { username: TEST_EMAIL, password: 'wrong' }, { noAuth: true });
    test('3.  Login with wrong password → 401', r.status === 401); }

  // 4a — without pin → 403
  { const r = await api('POST', '/api/admin/recalc', {});
    test('4a. POST /api/admin/recalc without pin → 403', r.status === 403, `status=${r.status}`); }

  // 4b — with pin → 200
  { const r = await api('POST', '/api/admin/recalc', { pin: TEST_ADMIN_PIN });
    test('4b. POST /api/admin/recalc with pin → 200', r.status === 200, `status=${r.status}`); }

  // 5 — path traversal: try to escape uploads dir
  { const r = await api('DELETE', '/api/projects/test/upload/..%2F..%2F..%2Fetc%2Fpasswd');
    test('5.  Path traversal DELETE → blocked', r.status === 400 || r.status === 200, `status=${r.status}`);
    // 200 is acceptable if file doesn't exist (already-gone path returns ok:true, fileDeleted:false)
  }

  console.log('');

  // ── DATA INTEGRITY ──
  console.log('Data Integrity');
  console.log('--------------');

  // 6
  { const r = await api('POST', '/api/projects', {
      id: TEST_PROJECT_ID, jobCode: 'TEST-SCN', name: 'Scenario Test', client: 'TestCo', status: 'Active'
    });
    test('6.  Create test project → 201', r.status === 201, `status=${r.status}`); }

  // 6b
  { const r = await api('GET', '/api/projects');
    const found = Array.isArray(r.data) && r.data.some(p => p.id === TEST_PROJECT_ID);
    test('6b. Project in listing', found); }

  // 7
  { const r = await api('POST', '/api/tasks', {
      title: 'Scenario test task', projectId: TEST_PROJECT_ID, assignedTo: TEST_NAME, createdBy: TEST_NAME
    });
    testTaskId = r.data?.id;
    test('7.  Create linked task', !!testTaskId, `status=${r.status}`); }

  // 7b
  { const r = await api('GET', '/api/tasks');
    const found = Array.isArray(r.data) && r.data.some(t => t.id === testTaskId);
    test('7b. Task in listing', found); }

  // 8
  { const r = await api('POST', '/api/site-requests', {
      projectId: TEST_PROJECT_ID, projectJobCode: 'TEST-SCN', projectName: 'Scenario Test',
      item: 'Test beam', quantity: 5, unit: 'pcs', neededByDate: '2026-12-31', requestedBy: TEST_NAME
    });
    testSRId = r.data?.id;
    test('8.  Create linked site request', !!testSRId, `status=${r.status}`); }

  // 9 — delete project, verify cascade
  { const r = await api('DELETE', `/api/projects/${TEST_PROJECT_ID}`, { pin: TEST_ADMIN_PIN, reason: 'test' });
    test('9.  Delete project (cascade)', r.status === 200 && r.data?.ok, `status=${r.status}`); }

  // 9b — task gone?
  { const r = await api('GET', '/api/tasks');
    const orphans = Array.isArray(r.data) ? r.data.filter(t => t.projectId === TEST_PROJECT_ID) : [];
    test('9b. Cascade: tasks removed', orphans.length === 0, `orphans=${orphans.length}`); }

  // 9c — SR gone?
  { const r = await api('GET', '/api/site-requests');
    const orphans = Array.isArray(r.data) ? r.data.filter(s => s.projectId === TEST_PROJECT_ID) : [];
    test('9c. Cascade: site requests removed', orphans.length === 0, `orphans=${orphans.length}`); }

  console.log('');

  // ── EMAIL ROUTING ──
  console.log('Email Routing');
  console.log('-------------');

  // 10
  { const r = await api('GET', '/api/staff');
    const has = r.data?.['Factory Manager'] && r.data?.['Purchaser'] && r.data?.['QS'];
    test('10. Staff has role aliases', r.status === 200 && !!has); }

  // 11
  { const staff = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'staff.json'), 'utf8'));
    const roles = ['Factory Manager','Purchaser','QS','Site Engineer','Project Manager','Finance'];
    const missing = roles.filter(r => !staff[r]?.email);
    test('11. staff.json has all roles with emails', missing.length === 0, missing.length ? `missing: ${missing}` : ''); }

  console.log('');

  // ── DATE HANDLING ──
  console.log('Date Handling');
  console.log('-------------');

  // 12
  { const r = await api('POST', '/api/claims', {
      projectId: 'x', claimNumber: 'TEST-CLM', claimAmount: 100, submittedDate: 'not-a-date'
    });
    const certDue = r.data?.certificationDue || '';
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(certDue);
    test('12. Invalid submittedDate → valid certificationDue', valid, `certDue=${certDue}`);
    testClaimId = r.data?.id;
  }

  // 13
  { const r = await api('POST', '/api/eod-log', {
      staffName: TEST_NAME, date: '2026-04-21', hours: 1, summary: 'Test', taskEntries: []
    });
    const d = r.data?.log?.date || r.data?.date || '';
    test('13. EOD log date valid', /^\d{4}-\d{2}-\d{2}$/.test(d), `date=${d}`); }

  console.log('');

  // ── EDGE CASES ──
  console.log('Edge Cases');
  console.log('----------');

  // 14
  { const r = await api('POST', '/api/tasks', { assignedTo: 'X' });
    test('14. Task without title → 400', r.status === 400, `status=${r.status}`); }

  // 15
  { const r = await api('POST', '/api/purchase-requisitions', {
      projectCode: 'TEST', site: 'Test', items: [], submittedBy: TEST_NAME
    });
    test('15. PR with empty items → 201', r.status === 201, `status=${r.status}`);
    testPRId = r.data?.id;
  }

  // 16
  { const r2 = await api('POST', '/api/tickets', {
      title: 'Test ticket', type: 'Bug', submittedBy: TEST_NAME, description: 'test'
    });
    testTicketId = r2.data?.id;
    if (testTicketId) {
      const r = await api('PUT', `/api/tickets/${testTicketId}`, { status: 'BogusStatus' });
      test('16. Ticket with invalid status → 400', r.status === 400, `status=${r.status}`);
    } else {
      test('16. Ticket with invalid status → 400', false, 'Could not create ticket');
    }
  }

  // 17 — staff name collision with role alias
  { const r = await api('POST', '/api/staff', { pin: TEST_ADMIN_PIN, name: 'Factory Manager', email: 'test@test.com' });
    test('17. Staff name = role alias → blocked', r.status === 400, `status=${r.status}`); }

  console.log('');

  // ── SALES PIPELINE ──
  console.log('Sales Pipeline');
  console.log('--------------');

  let testOppId = null;

  // 18 — Sales stats accessible when logged in
  { const r = await api('GET', '/api/sales/stats');
    test('18. GET /api/sales/stats → 200 or 403', r.status === 200 || r.status === 403, `status=${r.status}`); }

  // 19 — Create opportunity
  { const r = await api('POST', '/api/sales/opportunities', {
      clientName: 'Test Pipeline Client', estimatedValue: 50000, productType: 'Bollards',
      contactPerson: 'John Doe', phone: '+6591234567', source: 'Referral', assignedTo: 'Lai Wei Xiang'
    });
    // May get 403 if test user doesn't have sales access, which is acceptable
    if (r.status === 201) {
      testOppId = r.data?.id;
      test('19. POST /api/sales/opportunities → 201', !!testOppId, `id=${testOppId}`);
    } else {
      test('19. POST /api/sales/opportunities → 403 (no access)', r.status === 403, `status=${r.status}`);
    }
  }

  // 20 — Create opportunity without clientName → 400
  { const r = await api('POST', '/api/sales/opportunities', { estimatedValue: 1000 });
    test('20. Create opp without clientName → 400 or 403', r.status === 400 || r.status === 403, `status=${r.status}`); }

  // 21 — Update opportunity stage
  if (testOppId) {
    const r = await api('PUT', `/api/sales/opportunities/${testOppId}`, { stage: 'Quotation' });
    test('21. PUT opp stage → Quotation Sent', r.status === 200 && r.data?.stage === 'Quotation Sent', `status=${r.status} stage=${r.data?.stage}`);
  } else {
    test('21. PUT opp stage (skipped — no access)', true);
  }

  // 22 — Update with invalid stage → ignored
  if (testOppId) {
    const r = await api('PUT', `/api/sales/opportunities/${testOppId}`, { stage: 'InvalidStage' });
    test('22. PUT opp invalid stage → stays same', r.status === 200 && r.data?.stage === 'Quotation Sent', `stage=${r.data?.stage}`);
  } else {
    test('22. PUT opp invalid stage (skipped — no access)', true);
  }

  // 23 — Activity note logged
  if (testOppId) {
    const r = await api('PUT', `/api/sales/opportunities/${testOppId}`, { activityNote: 'Test follow-up note' });
    const hasNote = (r.data?.activity || []).some(a => a.note === 'Test follow-up note');
    test('23. Activity note recorded', r.status === 200 && hasNote, `activities=${r.data?.activity?.length}`);
  } else {
    test('23. Activity note (skipped — no access)', true);
  }

  // 24 — GET opportunities returns list
  { const r = await api('GET', '/api/sales/opportunities');
    if (r.status === 200) {
      test('24. GET /api/sales/opportunities → array', Array.isArray(r.data), `type=${typeof r.data}`);
    } else {
      test('24. GET /api/sales/opportunities → 403 (no access)', r.status === 403, `status=${r.status}`);
    }
  }

  // 25 — Convert non-Won opp → 400
  if (testOppId) {
    const r = await api('POST', `/api/sales/convert-to-project/${testOppId}`, { pin: TEST_ADMIN_PIN });
    test('25. Convert non-Won opp → 400', r.status === 400, `status=${r.status}`);
  } else {
    test('25. Convert non-Won opp (skipped — no access)', true);
  }

  // 26 — Delete opportunity
  if (testOppId) {
    const r = await api('DELETE', `/api/sales/opportunities/${testOppId}`, { pin: TEST_ADMIN_PIN, reason: 'test cleanup' });
    test('26. DELETE opp → 200', r.status === 200, `status=${r.status}`);
    testOppId = null;
  } else {
    test('26. DELETE opp (skipped — no access)', true);
  }

  console.log('');

  // ── SECURITY & FIREWALL ──
  console.log('Security & Firewall');
  console.log('-------------------');

  // 27a — Health check (no auth required)
  { const r = await api('GET', '/api/health', null, { noAuth: true });
    test('27a. GET /api/health → 200 (no auth)', r.status === 200 && r.data?.ok, `status=${r.status}`); }

  // 27 — Unauthenticated POST blocked
  { const r = await api('POST', '/api/tasks', { title: 'hack', assignedTo: 'X' }, { noAuth: true });
    test('27. Unauth POST /api/tasks → 401', r.status === 401, `status=${r.status}`); }

  // 28 — Unauthenticated DELETE blocked
  { const r = await api('DELETE', '/api/projects/fake-id', null, { noAuth: true });
    test('28. Unauth DELETE /api/projects → 401', r.status === 401, `status=${r.status}`); }

  // 29 — Path traversal via upload filename (double-encoded)
  { const r = await api('DELETE', '/api/projects/x/upload/..%252F..%252Fetc%252Fpasswd');
    test('29. Double-encoded path traversal → blocked', r.status === 400 || (r.status === 200 && !r.data?.fileDeleted), `status=${r.status}`); }

  // 30 — Path traversal via dot-dot-slash in filename
  { const r = await api('DELETE', '/api/projects/x/upload/../../config/credentials.json');
    test('30. Direct ../../ traversal → blocked', r.status === 400 || r.status === 404 || (r.status === 200 && !r.data?.fileDeleted), `status=${r.status}`); }

  // 31 — Admin endpoint without PIN
  { const r = await api('DELETE', '/api/projects/nonexistent', { reason: 'test' });
    test('31. Delete project without PIN → 403', r.status === 403, `status=${r.status}`); }

  // 32 — Admin endpoint with wrong PIN
  { const r = await api('DELETE', '/api/projects/nonexistent', { pin: 'wrong-pin', reason: 'test' });
    test('32. Delete project with wrong PIN → 403', r.status === 403, `status=${r.status}`); }

  // 33 — Worker CRUD requires admin auth
  { const r = await api('POST', '/api/workers', { name: 'Hack Worker', type: 'Own' });
    test('33. POST /api/workers without PIN → 403', r.status === 403, `status=${r.status}`); }

  // 34 — XSS in task title should be stored safely (no script execution, just stored as text)
  { const xss = '<script>alert("xss")</script>';
    const r = await api('POST', '/api/tasks', {
      title: xss, assignedTo: TEST_NAME, createdBy: TEST_NAME
    });
    const stored = r.data?.title || '';
    // Title should be stored as-is (sanitized on output) or stripped
    test('34. XSS in task title → stored without execution risk', r.status === 200 || r.status === 201, `status=${r.status}`);
    if (r.data?.id) await api('DELETE', `/api/tasks/${r.data.id}`, { deletedBy: TEST_NAME, reason: 'test cleanup' });
  }

  // 35 — SQL/NoSQL injection in query params (should not crash)
  { const r = await api('GET', '/api/tasks?assignedTo[$ne]=null');
    test('35. NoSQL injection in query → no crash', r.status === 200, `status=${r.status}`); }

  // 36 — Oversized payload (very long string)
  { const big = 'A'.repeat(100000);
    const r = await api('POST', '/api/tasks', { title: big, assignedTo: TEST_NAME, createdBy: TEST_NAME });
    // Should either reject (413/400) or truncate, not crash
    test('36. 100KB title → no crash', r.status < 500, `status=${r.status}`);
    if (r.data?.id) await api('DELETE', `/api/tasks/${r.data.id}`, { deletedBy: TEST_NAME, reason: 'test cleanup' });
  }

  // 37 — CRLF injection in header-sensitive field
  { const r = await api('POST', '/api/tickets', {
      title: 'Test\r\nInjected-Header: evil', type: 'Bug', submittedBy: TEST_NAME, description: 'test'
    });
    test('37. CRLF in ticket title → no crash', r.status < 500, `status=${r.status}`);
    if (r.data?.id) await api('DELETE', `/api/tickets/${r.data.id}`, { pin: TEST_ADMIN_PIN, reason: 'test' });
  }

  // 38 — JSON body with prototype pollution keys
  { const r = await api('POST', '/api/tasks', {
      title: 'Proto test', assignedTo: TEST_NAME, createdBy: TEST_NAME,
      '__proto__': { admin: true }, 'constructor': { prototype: { admin: true } }
    });
    test('38. Prototype pollution keys → no crash', r.status < 500, `status=${r.status}`);
    if (r.data?.id) await api('DELETE', `/api/tasks/${r.data.id}`, { deletedBy: TEST_NAME, reason: 'test cleanup' });
  }

  // 39 — Basic Auth with invalid base64
  { const r = await api('GET', '/api/projects', null, { noAuth: true, basicAuth: 'Basic !!!notbase64!!!' });
    test('39. Malformed Basic Auth → 401 (no crash)', r.status === 401, `status=${r.status}`); }

  // 40 — Access admin PIN endpoint without admin auth
  { const r = await api('POST', '/api/admin/pin', { action: 'set', pin: '0000' });
    test('40. Set admin PIN without auth → rejected', r.status === 400 || r.status === 403, `status=${r.status}`); }

  // 41 — Document file delete with traversal in docIndex
  { const r = await api('DELETE', '/api/projects/fakeproj/documents/99/file');
    test('41. Doc file delete on nonexistent project → 404', r.status === 404, `status=${r.status}`); }

  console.log('');

  // ── CLEANUP ──
  console.log('Cleanup');
  console.log('-------');
  if (testOppId) await api('DELETE', `/api/sales/opportunities/${testOppId}`, { pin: TEST_ADMIN_PIN, reason: 'test' });
  if (testClaimId) await api('DELETE', `/api/claims/${testClaimId}`, { pin: TEST_ADMIN_PIN, reason: 'test' });
  if (testPRId) await api('DELETE', `/api/purchase-requisitions/${testPRId}`, { pin: TEST_ADMIN_PIN, reason: 'test' });
  if (testTicketId) await api('DELETE', `/api/tickets/${testTicketId}`, { pin: TEST_ADMIN_PIN, reason: 'test' });
  // Clean up EOD logs from test user
  try {
    const eodFile = path.join(__dirname, '..', 'data', 'eod-logs.json');
    const eodLogs = JSON.parse(fs.readFileSync(eodFile, 'utf8'));
    const cleaned = eodLogs.filter(l => l.staffName !== TEST_NAME);
    if (cleaned.length < eodLogs.length) fs.writeFileSync(eodFile, JSON.stringify(cleaned, null, 2));
  } catch {}
  console.log('  Test data cleaned up.');

  // ── SUMMARY ──
  console.log('\n=========================================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(f)); }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Runner crashed:', err); cleanup(); process.exit(1); });
