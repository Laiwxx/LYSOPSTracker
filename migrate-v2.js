#!/usr/bin/env node
/**
 * migrate-v2.js — LYS OPS Tracker data migration
 * Adds new fields to existing projects without overwriting existing data
 * Run: node migrate-v2.js
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'projects.json');

function migrate() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('No projects.json found. Nothing to migrate.');
    return;
  }

  let projects;
  try {
    projects = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('ERROR: projects.json is invalid JSON:', e.message);
    process.exit(1);
  }

  // Backup before migrating
  const backupPath = DATA_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(projects, null, 2));
  console.log(`✅ Backup created: ${path.basename(backupPath)}`);

  let changed = 0;

  projects.forEach((p, i) => {
    let modified = false;
    const log = [];

    // 1. Add deliveryRequests if missing
    if (!Array.isArray(p.deliveryRequests)) {
      p.deliveryRequests = [];
      log.push('added deliveryRequests[]');
      modified = true;
    }

    // 2. Add drawings if missing
    if (!Array.isArray(p.drawings)) {
      p.drawings = [];
      log.push('added drawings[]');
      modified = true;
    }

    // 3. Add productScope if missing
    if (!Array.isArray(p.productScope)) {
      p.productScope = [];
      if (p.product && typeof p.product === 'string' && p.product.trim()) {
        p.productScope = [{ item: p.product.trim(), qty: 1, unit: 'units', zoneLabel: '' }];
        log.push(`migrated product string to productScope: "${p.product}"`);
      } else {
        log.push('added empty productScope[]');
      }
      modified = true;
    }

    // 4. Add scopeNotes if missing
    if (typeof p.scopeNotes !== 'string') {
      p.scopeNotes = '';
      log.push('added scopeNotes');
      modified = true;
    }

    // 5. Add fileName to stages that don't have it
    if (Array.isArray(p.stages)) {
      let stageChanged = false;
      p.stages.forEach(s => {
        if (typeof s.fileName === 'undefined') {
          s.fileName = '';
          stageChanged = true;
        }
      });
      if (stageChanged) {
        log.push('added fileName to stage objects');
        modified = true;
      }
    }

    // 6. Add files[] to documents that don't have it
    if (Array.isArray(p.documents)) {
      let docChanged = false;
      p.documents.forEach(d => {
        if (!Array.isArray(d.files)) {
          d.files = d.file ? [{ fileName: d.file, uploadedAt: '' }] : [];
          docChanged = true;
        }
        if (typeof d.group === 'undefined') {
          d.group = 'Safety Documents';
          docChanged = true;
        }
        if (typeof d.allowMultiple === 'undefined') {
          d.allowMultiple = false;
          docChanged = true;
        }
      });
      if (docChanged) {
        log.push('updated document objects (files[], group, allowMultiple)');
        modified = true;
      }
    }

    // 7. Add ticketStatus to existing deliveryRequests
    if (Array.isArray(p.deliveryRequests)) {
      let drChanged = false;
      p.deliveryRequests.forEach(r => {
        if (!r.ticketStatus) {
          r.ticketStatus = r.status === 'Delivered' ? 'Delivered' : 'New';
          drChanged = true;
        }
        if (!r.id) {
          r.id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          drChanged = true;
        }
      });
      if (drChanged) {
        log.push('added ticketStatus/id to delivery requests');
        modified = true;
      }
    }

    // 8. Add readyForDelivery fields to fab items
    if (Array.isArray(p.fabrication)) {
      let fabChanged = false;
      p.fabrication.forEach(f => {
        if (typeof f.readyForDelivery === 'undefined') { f.readyForDelivery = false; fabChanged = true; }
        if (typeof f.targetDeliveryDate === 'undefined') { f.targetDeliveryDate = ''; fabChanged = true; }
        if (typeof f.readyAt === 'undefined') { f.readyAt = null; fabChanged = true; }
      });
      if (fabChanged) {
        log.push('added delivery fields to fab items');
        modified = true;
      }
    }

    const stageCount = Array.isArray(p.stages) ? p.stages.length : 0;

    if (modified) {
      changed++;
      console.log(`[${i + 1}] ${p.jobCode} — UPDATED: ${log.join(', ')} | stages: ${stageCount}`);
    } else {
      console.log(`[${i + 1}] ${p.jobCode} — OK | stages: ${stageCount}`);
    }
  });

  fs.writeFileSync(DATA_FILE, JSON.stringify(projects, null, 2));
  console.log(`\n✅ Migration complete. ${changed}/${projects.length} projects updated.`);
  console.log(`ℹ️  Note: Stage structure NOT auto-migrated. Use "Reset to 12 stages" button per project as needed.`);
}

migrate();
