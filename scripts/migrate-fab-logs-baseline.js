#!/usr/bin/env node
/**
 * One-time migration: seed the Factory daily-log model with a baseline entry
 * per fab row that already has qtyDone > 0.
 *
 * Run from repo root:   node scripts/migrate-fab-logs-baseline.js
 * Or dry-run first:     node scripts/migrate-fab-logs-baseline.js --dry-run
 *
 * What it does:
 *   - Reads data/projects.json
 *   - For each project.fabrication[i] with qtyDone > 0 and no logs[] yet,
 *     prepends one synthetic baseline log entry:
 *       { id, loggedAt, loggedBy: 'system', delta: <current qtyDone>,
 *         photoPath: null, note: 'Pre-launch baseline — no photo available',
 *         editedAt: null, editedBy: null, editHistory: [] }
 *   - Leaves rows with qtyDone === 0 untouched (empty logs[] is implicit)
 *   - Idempotent: if a row already has a non-empty logs[], it's skipped
 *   - Writes a timestamped backup to data/projects.backup-fab-logs-<ts>.json
 *     before touching the file
 *
 * After running, the sum of logs[].delta on every touched row equals the
 * original qtyDone, so the derived qtyDone (= sum) reconciles exactly.
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECTS_FILE = path.join(__dirname, '..', 'data', 'projects.json');

function main() {
  const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
  const projects = JSON.parse(raw);

  let touchedProjects = 0;
  let touchedRows = 0;
  let skippedExisting = 0;
  let skippedEmpty = 0;
  const nowIso = new Date().toISOString();

  for (const p of projects) {
    if (!Array.isArray(p.fabrication)) continue;
    let projectTouched = false;
    p.fabrication.forEach((row, idx) => {
      if (Array.isArray(row.logs) && row.logs.length > 0) {
        skippedExisting++;
        return;
      }
      const qty = parseFloat(row.qtyDone) || 0;
      if (qty <= 0) {
        // Initialize an empty logs[] for schema consistency, but no baseline entry.
        if (!Array.isArray(row.logs)) row.logs = [];
        skippedEmpty++;
        return;
      }
      const baselineId = 'log_baseline_' + p.id.slice(0, 8) + '_' + idx;
      row.logs = [{
        id: baselineId,
        loggedAt: nowIso,
        loggedBy: 'system',
        delta: qty,
        photoPath: null,
        note: 'Pre-launch baseline — no photo available',
        editedAt: null,
        editedBy: null,
        editHistory: [],
      }];
      touchedRows++;
      projectTouched = true;
    });
    if (projectTouched) touchedProjects++;
  }

  console.log('Migration summary:');
  console.log('  Projects touched:        ', touchedProjects);
  console.log('  Fab rows seeded:         ', touchedRows);
  console.log('  Rows already had logs:   ', skippedExisting);
  console.log('  Rows with qtyDone=0:     ', skippedEmpty);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes written. Rerun without --dry-run to commit.');
    return;
  }

  // Backup before writing.
  const backupPath = PROJECTS_FILE.replace('.json', `.backup-fab-logs-${Date.now()}.json`);
  fs.writeFileSync(backupPath, raw);
  console.log(`\nBackup written:  ${backupPath}`);

  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  console.log(`Migration committed to: ${PROJECTS_FILE}`);
}

try {
  main();
} catch (e) {
  console.error('Migration failed:', e);
  process.exit(1);
}
