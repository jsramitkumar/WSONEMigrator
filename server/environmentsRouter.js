const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('./config/database');
const { getClientForEnv } = require('./uemClient');

const router = express.Router();

// GET /environments
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, console_url, api_url, tenant_code,
              auth_type, environment_type, is_active, created_at, updated_at
       FROM environments ORDER BY created_at DESC`
    );
    res.json({ environments: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /environments/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, console_url, api_url, tenant_code,
              auth_type, environment_type, is_active, created_at, updated_at
       FROM environments WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Environment not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /environments
router.post('/',
  body('name').notEmpty(),
  body('console_url').isURL(),
  body('api_url').isURL(),
  body('auth_type').isIn(['oauth2', 'basic']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      name, description, console_url, api_url, tenant_code,
      auth_type, environment_type = 'source',
      oauth_token_url, client_id, client_secret,
      api_username, api_password, api_key,
    } = req.body;

    try {
      const { rows } = await query(
        `INSERT INTO environments
           (name, description, console_url, api_url, tenant_code, auth_type, environment_type,
            oauth_token_url, client_id, client_secret, api_username, api_password, api_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, name, console_url, api_url, auth_type, environment_type, created_at`,
        [name, description, console_url, api_url, tenant_code, auth_type, environment_type,
         oauth_token_url, client_id, client_secret, api_username, api_password, api_key]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PUT /environments/:id
router.put('/:id', async (req, res) => {
  const allowed = ['name', 'description', 'console_url', 'api_url', 'tenant_code',
                   'auth_type', 'environment_type', 'oauth_token_url', 'client_id',
                   'client_secret', 'api_username', 'api_password', 'api_key', 'is_active'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  const sets = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = updates.map(([, v]) => v);

  try {
    const { rows } = await query(
      `UPDATE environments SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING id, name, updated_at`,
      [req.params.id, ...values]
    );
    if (!rows.length) return res.status(404).json({ error: 'Environment not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /environments/:id/test - Test connectivity to UEM
router.post('/:id/test', async (req, res) => {
  try {
    const client = await getClientForEnv(req.params.id);
    const root = await client.getRootOrgGroup();
    res.json({
      success: true,
      message: 'Connection successful',
      root_og: root?.Name || root?.GroupName,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// DELETE /environments/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `DELETE FROM environments WHERE id = $1 RETURNING id`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Environment not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
