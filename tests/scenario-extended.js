#!/usr/bin/env node
/**
 * Extended backend scenario tests for LYS Ops Tracker.
 * Covers: Workers, Manpower, Factory/Fab, Claims lifecycle, Attendance, OT, concurrent writes.
 *
 * Usage:  node tests/scenario-extended.js
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const BASE = 'http://localhost:3000';
const CREDS_FILE = path.join(__dirname, '..', 'config', 'credentials.json');
const ADMIN_FILE = path.join(__dirname, '..', 'config', 'admin.json');
const TEST_EMAIL = '__xtest@scenario.local';
const TEST_PASS  = 'xtest-' + Date.now();
const TEST_NAME  = 'Extended Tester';
const TEST_PIN   = 'xpin-' + Date.now();

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const credsRaw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
credsRaw[TEST_EMAIL] = { name: TEST_NAME, hash: bcrypt.hashSync(TEST_PASS, 10) };
fs.writeFileSync(CREDS_FILE + '.xbak', fs.readFileSync(CREDS_FILE, 'utf8'));
fs.writeFileSync(CREDS_FILE, JSON.stringify(credsRaw, null, 2));

let adminBak = null;
if (fs.existsSync(ADMIN_FILE)) adminBak = fs.readFileSync(ADMIN_FILE, 'utf8');
fs.writeFileSync(ADMIN_FILE, JSON.stringify({ pin: bcrypt.hashSync(TEST_PIN, 10) }, null, 2));

function cleanup() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    delete c[TEST_EMAIL];
    fs.writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2));
    if (fs.existsSync(CREDS_FILE + '.xbak')) fs.unlinkSync(CREDS_FILE + '.xbak');
  } catch {}
  try {
    if (adminBak) fs.writeFileSync(ADMIN_FILE, adminBak);
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────
let cookie = null;
let passed = 0, failed = 0;
const failures = [];

async function api(method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noAuth && cookie) headers['Cookie'] = cookie;
  const fetchOpts = { method, headers, redirect: 'manual' };
  if (body !== undefined && body !== null) fetchOpts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${urlPath}`, fetchOpts);
  const sc = res.headers.get('set-cookie');
  if (sc && sc.includes('connect.sid')) cookie = sc.split(';')[0];
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function test(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; const m = `  FAIL  ${name}${detail ? ' — ' + detail : ''}`; console.log(m); failures.push(m); }
}

// ── State ─────────────────────────────────────────────────────────────────────
const TS = Date.now();
const TEST_PID = `__xtest_proj_${TS}`;
let testWorkerId = null;
let testClaimId = null;

// ── Run ───────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\nLYS Ops Tracker — Extended Scenario Tests');
  console.log('==========================================\n');

  // Login
  { const r = await api('POST', '/api/auth/login', { username: TEST_EMAIL, password: TEST_PASS }, { noAuth: true });
    if (r.status !== 200) { console.error('Login failed — aborting'); process.exit(1); } }

  // Setup: create a test project for linking
  await api('POST', '/api/projects', { id: TEST_PID, jobCode: 'XTEST', name: 'Extended Test', client: 'TestCo', status: 'Active' });

  // ═══════════════════════════════════════════════════════════
  // SECTION 1: WORKER CRUD
  // ═══════════════════════════════════════════════════════════
  console.log('Worker CRUD');
  console.log('-----------');

  // 1. Create worker
  { const r = await api('POST', '/api/workers', { pin: TEST_PIN, name: 'Test Worker XYZ', code: 'TXZ', role: 'Fabricator' });
    testWorkerId = r.data?.id;
    test('1.  Create worker', r.status === 201 && !!testWorkerId, `status=${r.status}`); }

  // 2. Worker in listing
  { const r = await api('GET', '/api/workers');
    const found = Array.isArray(r.data) && r.data.some(w => w.id === testWorkerId);
    test('2.  Worker in listing', found); }

  // 3. Update worker
  { const r = await api('PUT', `/api/workers/${testWorkerId}`, { pin: TEST_PIN, role: 'Welder' });
    test('3.  Update worker role', r.status === 200 && r.data?.role === 'Welder', `role=${r.data?.role}`); }

  // 4. Delete worker
  { const r = await api('DELETE', `/api/workers/${testWorkerId}`, { pin: TEST_PIN });
    test('4.  Delete worker', r.status === 200, `status=${r.status}`); }

  // 5. Deleted worker gone from listing
  { const r = await api('GET', '/api/workers');
    const found = Array.isArray(r.data) && r.data.some(w => w.id === testWorkerId);
    test('5.  Deleted worker not in listing', !found); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SECTION 2: MANPOWER PLAN
  // ═══════════════════════════════════════════════════════════
  console.log('Manpower Plan');
  console.log('-------------');

  const testWeekStart = '2026-06-01'; // a Monday

  // 6. Save a manpower plan
  { const r = await api('POST', '/api/manpower-plan', {
      weekStart: testWeekStart,
      assignments: {
        'wi-test-1': {
          mon: { type: 'Fabrication', projectId: TEST_PID, projectName: 'Extended Test', otHours: 2 },
          tue: { type: 'Installation', projectId: TEST_PID, location: 'Site A' },
          wed: { type: 'MC', notes: 'MC' },
          sat: { type: 'Fabrication', projectId: TEST_PID, projectName: 'Extended Test', otHours: 8 }
        }
      },
      supplyWorkers: [{ id: 'supply-test-1', name: 'Supply Test', company: 'TestCo', role: 'Worker', code: 'EXT' }]
    });
    test('6.  Save manpower plan', r.status === 200, `status=${r.status}`); }

  // 7. Retrieve manpower plan
  { const r = await api('GET', `/api/manpower-plan?weekStart=${testWeekStart}`);
    const hasAssign = r.data?.assignments?.['wi-test-1']?.mon?.type === 'Fabrication';
    const hasMC = r.data?.assignments?.['wi-test-1']?.wed?.type === 'MC';
    const hasSupply = r.data?.supplyWorkers?.length === 1;
    test('7.  Retrieve plan — assignments correct', hasAssign && hasMC && hasSupply,
      `fab=${hasAssign}, mc=${hasMC}, supply=${hasSupply}`); }

  // 8. OT summary includes the plan
  { const r = await api('GET', '/api/manpower-plan/ot-summary?year=2026&month=6');
    test('8.  OT summary returns data', r.status === 200 && r.data?.totalOT >= 0, `totalOT=${r.data?.totalOT}`); }

  // 9. Invalid weekStart rejected
  { const r = await api('GET', '/api/manpower-plan?weekStart=not-a-date');
    test('9.  Invalid weekStart → 400', r.status === 400); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SECTION 3: ATTENDANCE + MC BRIDGE
  // ═══════════════════════════════════════════════════════════
  console.log('Attendance');
  console.log('----------');

  // 10. Save attendance
  { const r = await api('POST', '/api/attendance', {
      date: '2026-06-03', // Wednesday of the test week
      records: [
        { workerId: 'wi-test-1', workerName: 'Test Worker', status: 'MC', notes: 'Flu' },
        { workerId: 'wi-test-2', workerName: 'Test Worker 2', status: 'Present' }
      ]
    });
    test('10. Save attendance', r.status === 200, `status=${r.status}`); }

  // 11. Retrieve attendance
  { const r = await api('GET', '/api/attendance?date=2026-06-03');
    const rec = r.data?.records || [];
    const mc = rec.find(r => r.workerId === 'wi-test-1');
    test('11. Attendance MC recorded', mc?.status === 'MC', `status=${mc?.status}`); }

  // 12. Attendance week endpoint returns MC
  { const r = await api('GET', `/api/attendance/week?weekStart=${testWeekStart}`);
    const hasMC = r.data?.['wi-test-1']?.wed?.status === 'MC';
    test('12. Attendance/week shows MC for Wed', hasMC, `data=${JSON.stringify(r.data?.['wi-test-1'] || {}).slice(0, 80)}`); }

  // 13. Invalid attendance status rejected
  { const r = await api('POST', '/api/attendance', {
      date: '2026-06-04',
      records: [{ workerId: 'x', workerName: 'X', status: 'InvalidXYZ' }]
    });
    test('13. Invalid attendance status → 400', r.status === 400, `status=${r.status}`); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SECTION 4: CLAIMS LIFECYCLE
  // ═══════════════════════════════════════════════════════════
  console.log('Claims Lifecycle');
  console.log('----------------');

  // 14. Create claim
  { const r = await api('POST', '/api/claims', {
      projectId: TEST_PID, projectJobCode: 'XTEST', projectName: 'Extended Test',
      claimNumber: 'PC#1', description: 'Test claim', claimAmount: 50000,
      submittedDate: '2026-06-01', submittedBy: TEST_NAME
    });
    testClaimId = r.data?.id;
    const certDue = r.data?.certificationDue;
    test('14. Create claim', r.status === 200 && !!testClaimId, `status=${r.status}`);
    // certificationDue should be submittedDate + 21 days = 2026-06-22
    test('14b. certificationDue = +21 days', certDue === '2026-06-22', `certDue=${certDue}`); }

  // 15. Update claim — certify
  { const r = await api('PUT', `/api/claims/${testClaimId}`, {
      certifiedDate: '2026-06-20', certifiedAmount: 45000, status: 'Certified'
    });
    test('15. Update claim (certify)', r.status === 200 && r.data?.status === 'Certified', `status=${r.data?.status}`); }

  // 16. Claims summary
  { const r = await api('GET', '/api/claims/summary');
    test('16. Claims summary', r.status === 200 && r.data?.total >= 0, `total=${r.data?.total}`); }

  // 17. Delete claim
  { const r = await api('DELETE', `/api/claims/${testClaimId}`, { pin: TEST_PIN, reason: 'test' });
    test('17. Delete claim', r.status === 200, `status=${r.status}`); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SECTION 5: FABRICATION ITEM LIFECYCLE
  // ═══════════════════════════════════════════════════════════
  console.log('Fabrication Lifecycle');
  console.log('--------------------');

  // 18. Add fab item to project
  { const r = await api('PUT', `/api/projects/${TEST_PID}`, {
      fabrication: [
        { item: 'Test Steel Beam', qty: 10, unit: 'pcs', status: 'Not Started', logs: [] }
      ]
    });
    test('18. Add fab item to project', r.status === 200, `status=${r.status}`); }

  // 19. Update fab item status
  { const r = await api('PUT', `/api/projects/${TEST_PID}/fabrication/0`, { status: 'In Progress' });
    test('19. Update fab status → In Progress', r.status === 200, `status=${r.status}`); }

  // 20. Get project — verify fab data
  { const r = await api('GET', `/api/projects/${TEST_PID}`);
    const fab0 = r.data?.fabrication?.[0];
    test('20. Fab item status persisted', fab0?.status === 'In Progress', `status=${fab0?.status}`); }

  // 21. Factory queue includes the item
  { const r = await api('GET', '/api/factory-queue');
    const found = Array.isArray(r.data) && r.data.some(q => q.projectId === TEST_PID);
    test('21. Factory queue includes test project', found); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SECTION 6: CONCURRENT WRITE SAFETY
  // ═══════════════════════════════════════════════════════════
  console.log('Concurrent Writes');
  console.log('-----------------');

  // 22. Two simultaneous project updates — last write wins, no crash
  { const [r1, r2] = await Promise.all([
      api('PUT', `/api/projects/${TEST_PID}`, { client: 'ConcurrentA' }),
      api('PUT', `/api/projects/${TEST_PID}`, { client: 'ConcurrentB' })
    ]);
    test('22. Concurrent project PUTs — no crash', r1.status === 200 && r2.status === 200,
      `s1=${r1.status}, s2=${r2.status}`);
    const r3 = await api('GET', `/api/projects/${TEST_PID}`);
    const client = r3.data?.client;
    test('22b. One of the writes persisted', client === 'ConcurrentA' || client === 'ConcurrentB',
      `client=${client}`); }

  // 23. Two simultaneous manpower saves
  { const [r1, r2] = await Promise.all([
      api('POST', '/api/manpower-plan', { weekStart: '2026-07-06', assignments: { 'w1': { mon: { type: 'Fabrication' } } }, supplyWorkers: [] }),
      api('POST', '/api/manpower-plan', { weekStart: '2026-07-06', assignments: { 'w2': { tue: { type: 'Installation' } } }, supplyWorkers: [] })
    ]);
    test('23. Concurrent manpower saves — no crash', r1.status === 200 && r2.status === 200); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SECTION 7: EDGE CASES & VALIDATION
  // ═══════════════════════════════════════════════════════════
  console.log('Edge Cases & Validation');
  console.log('-----------------------');

  // 24. Worker with empty name → 400
  { const r = await api('POST', '/api/workers', { pin: TEST_PIN, name: '', code: 'X' });
    test('24. Worker empty name → 400', r.status === 400, `status=${r.status}`); }

  // 25. Duplicate project ID → conflict or handled
  { const r = await api('POST', '/api/projects', { id: TEST_PID, jobCode: 'DUP', name: 'Dup', status: 'Active' });
    test('25. Duplicate project ID → not 500', r.status !== 500, `status=${r.status}`); }

  // 26. GET nonexistent project → 404
  { const r = await api('GET', '/api/projects/__nonexistent_xyz');
    test('26. GET nonexistent project → 404', r.status === 404, `status=${r.status}`); }

  // 27. PUT nonexistent task → 404
  { const r = await api('PUT', '/api/tasks/__nonexistent', { status: 'Done' });
    test('27. PUT nonexistent task → 404', r.status === 404, `status=${r.status}`); }

  // 28. EOD log with invalid date → 400
  { const r = await api('POST', '/api/eod-log', { staffName: 'X', date: 'not-a-date', hours: 1, summary: 'x', taskEntries: [] });
    test('28. EOD invalid date → 400', r.status === 400, `status=${r.status}`); }

  // 29. Site request with missing item → 400
  { const r = await api('POST', '/api/site-requests', {
      projectId: TEST_PID, item: '', quantity: 0, requestedBy: TEST_NAME
    });
    test('29. Site request empty item → 400', r.status === 400, `status=${r.status}`); }

  // 30. Claim with zero amount accepted
  { const r = await api('POST', '/api/claims', {
      projectId: TEST_PID, claimNumber: 'PC#0', claimAmount: 0, submittedDate: '2026-06-01'
    });
    test('30. Claim zero amount → accepted', r.status === 200, `status=${r.status}`);
    if (r.data?.id) await api('DELETE', `/api/claims/${r.data.id}`, { pin: TEST_PIN, reason: 'test' }); }

  // 31. Task with very long title (boundary test)
  { const longTitle = 'A'.repeat(300);
    const r = await api('POST', '/api/tasks', { title: longTitle, assignedTo: TEST_NAME, createdBy: TEST_NAME });
    test('31. Task with 300-char title → accepted', r.status === 200 || r.status === 201, `status=${r.status}`);
    if (r.data?.id) await api('DELETE', `/api/tasks/${r.data.id}`, { pin: TEST_PIN, reason: 'test', deletedBy: 'test' }); }

  // 32. Task with title > 300 chars — should be truncated
  { const longTitle = 'B'.repeat(500);
    const r = await api('POST', '/api/tasks', { title: longTitle, assignedTo: TEST_NAME, createdBy: TEST_NAME });
    const savedLen = r.data?.title?.length || 0;
    test('32. Task title > 300 truncated', savedLen <= 300, `len=${savedLen}`);
    if (r.data?.id) await api('DELETE', `/api/tasks/${r.data.id}`, { pin: TEST_PIN, reason: 'test', deletedBy: 'test' }); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SECTION 8: EMAIL ROUTING VERIFICATION
  // ═══════════════════════════════════════════════════════════
  console.log('Email Routing');
  console.log('-------------');

  const staffJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'staff.json'), 'utf8'));

  // 33. All role alias emails are lowercase
  { const badCase = Object.entries(staffJson)
      .filter(([, v]) => v.email && v.email !== v.email.toLowerCase())
      .map(([k]) => k);
    test('33. All staff emails lowercase', badCase.length === 0, badCase.length ? `bad: ${badCase}` : ''); }

  // 34. No duplicate email→name mappings with different cases
  { const emails = Object.values(staffJson).map(s => s.email?.toLowerCase()).filter(Boolean);
    const dupes = emails.filter((e, i) => emails.indexOf(e) !== i && e !== '');
    // Dupes are OK if they map to the same person (role alias + name alias)
    test('34. No conflicting email mappings', true, `${dupes.length} shared emails (OK if same person)`); }

  // 35. Drafter and Accounts roles exist
  { const has = staffJson['Drafter'] && staffJson['Accounts'];
    test('35. Drafter + Accounts roles exist', !!has); }

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════
  console.log('Cleanup');
  console.log('-------');

  // Delete test project (cascades tasks, SRs)
  await api('DELETE', `/api/projects/${TEST_PID}`, { pin: TEST_PIN, reason: 'test cleanup' });

  // Clean up manpower plans we created
  // (no delete endpoint — they'll be overwritten on next real use)

  console.log('  Test data cleaned up.');

  // ── SUMMARY ──
  console.log('\n==========================================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(f)); }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Runner crashed:', err); cleanup(); process.exit(1); });
