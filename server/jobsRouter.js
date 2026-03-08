const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query } = require('./config/database');
const SnapshotService = require('./snapshotService');
const DiffService = require('./diffService');
const MigrationExecutor = require('./migrationExecutor');
const logger = require('./utils/logger');

const router = express.Router();

// ── GET /jobs ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM v_job_summary ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /jobs/:id ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT j.*, s.name AS source_env_name, d.name AS dest_env_name
       FROM migration_jobs j
       JOIN environments s ON j.source_env_id = s.id
       JOIN environments d ON j.dest_env_id = d.id
       WHERE j.id = $1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /jobs ────────────────────────────────────────────────────────────
router.post('/',
  body('name').notEmpty(),
  body('source_env_id').isUUID(),
  body('dest_env_id').isUUID(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, description, source_env_id, dest_env_id,
            migrate_orgs = true, migrate_profiles = true,
            migrate_apps = true, migrate_products = true,
            migrate_smart_groups = false, migrate_sensors = false,
            migrate_scripts = false } = req.body;

    try {
      const { rows } = await query(
        `INSERT INTO migration_jobs
           (name, description, source_env_id, dest_env_id,
            migrate_orgs, migrate_profiles, migrate_apps, migrate_products,
            migrate_smart_groups, migrate_sensors, migrate_scripts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [name, description, source_env_id, dest_env_id,
         migrate_orgs, migrate_profiles, migrate_apps, migrate_products,
         migrate_smart_groups, migrate_sensors, migrate_scripts]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /jobs/:id/snapshot ───────────────────────────────────────────────
// Pull data from both source and destination environments
router.post('/:id/snapshot', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await query('SELECT * FROM migration_jobs WHERE id = $1', [id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['pending', 'ready'].includes(job.status)) {
      return res.status(400).json({ error: `Cannot snapshot a job in status: ${job.status}` });
    }

    await query(
      `UPDATE migration_jobs SET status = 'snapshotting', started_at = NOW() WHERE id = $1`, [id]
    );
    res.json({ message: 'Snapshot started', jobId: id });

    // Run async
    setImmediate(async () => {
      try {
        const svc = new SnapshotService(id);
        await svc.snapshotEnvironment(job.source_env_id);
        await svc.snapshotEnvironment(job.dest_env_id);
        await query(
          `UPDATE migration_jobs SET snapshot_at = NOW() WHERE id = $1`, [id]
        );

        // Auto-run diff after snapshot
        const diffSvc = new DiffService(id);
        await diffSvc.computeDiff(job.source_env_id, job.dest_env_id);
      } catch (err) {
        logger.error(`Snapshot/diff failed for job ${id}:`, err);
        await query(
          `UPDATE migration_jobs SET status = 'failed' WHERE id = $1`, [id]
        );
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /jobs/:id/diff ────────────────────────────────────────────────────
// Get diff results, optionally filtered by entity_type or diff_status
router.get('/:id/diff', async (req, res) => {
  const { entity_type, diff_status, migration_action, page = 0, pagesize = 100 } = req.query;
  try {
    const conditions = ['job_id = $1'];
    const params = [req.params.id];
    let i = 2;
    if (entity_type) { conditions.push(`entity_type = $${i++}`); params.push(entity_type); }
    if (diff_status) { conditions.push(`diff_status = $${i++}`); params.push(diff_status); }
    if (migration_action) { conditions.push(`migration_action = $${i++}`); params.push(migration_action); }

    const where = conditions.join(' AND ');
    const offset = parseInt(page) * parseInt(pagesize);

    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM diff_results WHERE ${where}`, params),
      query(
        `SELECT * FROM diff_results WHERE ${where}
         ORDER BY entity_type, diff_status, source_name
         LIMIT $${i} OFFSET $${i+1}`,
        [...params, parseInt(pagesize), offset]
      ),
    ]);

    res.json({
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      pagesize: parseInt(pagesize),
      results: dataRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /jobs/:id/diff/:diffId ──────────────────────────────────────────
// Override migration_action for a specific diff item (user review)
router.patch('/:id/diff/:diffId',
  body('migration_action').isIn(['create', 'update', 'skip', 'manual_review']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const { rows } = await query(
        `UPDATE diff_results
         SET migration_action = $1, action_override = TRUE, notes = $2, updated_at = NOW()
         WHERE id = $3 AND job_id = $4 RETURNING *`,
        [req.body.migration_action, req.body.notes || null, req.params.diffId, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Diff result not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /jobs/:id/migrate ────────────────────────────────────────────────
// Execute approved migration
router.post('/:id/migrate', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await query('SELECT * FROM migration_jobs WHERE id = $1', [id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'ready') {
      return res.status(400).json({ error: `Job must be in "ready" status to migrate. Current: ${job.status}` });
    }

    res.json({ message: 'Migration started', jobId: id });

    setImmediate(async () => {
      try {
        const executor = new MigrationExecutor(id);
        await executor.execute();
      } catch (err) {
        logger.error(`Migration failed for job ${id}:`, err);
        await query(`UPDATE migration_jobs SET status = 'failed' WHERE id = $1`, [id]);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /jobs/:id/audit ───────────────────────────────────────────────────
router.get('/:id/audit', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM migration_audit_log WHERE job_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [req.params.id]
    );
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /jobs/:id/mappings ────────────────────────────────────────────────
router.get('/:id/mappings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM id_mappings WHERE job_id = $1 ORDER BY entity_type, source_uem_id`,
      [req.params.id]
    );
    res.json({ mappings: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
