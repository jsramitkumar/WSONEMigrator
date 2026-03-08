const pLimit = require('p-limit');
const { query, withTransaction } = require('./config/database');
const { getClientForEnv, UEMClient } = require('./uemClient');
const logger = require('./utils/logger');

const BATCH_SIZE = parseInt(process.env.MIGRATION_BATCH_SIZE) || 50;
const MAX_CONCURRENT = parseInt(process.env.MIGRATION_MAX_CONCURRENT) || 5;

/**
 * MigrationExecutor
 * Applies approved diff_results to the destination environment
 * Order: Org Groups → Profiles → Applications → Products
 */
class MigrationExecutor {
  constructor(jobId) {
    this.jobId = jobId;
    this.limit = pLimit(MAX_CONCURRENT);
  }

  // ── Main execute entry point ──────────────────────────────────────────────

  async execute() {
    const jobRow = await query('SELECT * FROM migration_jobs WHERE id = $1', [this.jobId]);
    const job = jobRow.rows[0];
    if (!job) throw new Error(`Job not found: ${this.jobId}`);

    await query(
      `UPDATE migration_jobs SET status = 'migrating', migration_started_at = NOW() WHERE id = $1`,
      [this.jobId]
    );

    const destClient = await getClientForEnv(job.dest_env_id);
    const stats = { added: 0, updated: 0, skipped: 0, failed: 0 };

    // IMPORTANT: Order matters — OGs must exist before profiles/apps/products/smart groups
    // Smart groups before sensors/scripts (sensors/scripts may ref smart groups)
    if (job.migrate_orgs)         await this._executeEntityType('org_group',    destClient, stats, job);
    if (job.migrate_smart_groups) await this._executeEntityType('smart_group',  destClient, stats, job);
    if (job.migrate_profiles)     await this._executeEntityType('profile',      destClient, stats, job);
    if (job.migrate_apps)         await this._executeEntityType('application',  destClient, stats, job);
    if (job.migrate_products)     await this._executeEntityType('product',      destClient, stats, job);
    if (job.migrate_sensors)      await this._executeEntityType('sensor',       destClient, stats, job);
    if (job.migrate_scripts)      await this._executeEntityType('script',       destClient, stats, job);

    const finalStatus = stats.failed > 0 ? 'completed_with_errors' : 'completed';
    await query(
      `UPDATE migration_jobs
       SET status = $2, completed_at = NOW(),
           entities_added = $3, entities_updated = $4,
           entities_skipped = $5, entities_failed = $6,
           updated_at = NOW()
       WHERE id = $1`,
      [this.jobId, finalStatus, stats.added, stats.updated, stats.skipped, stats.failed]
    );

    logger.info(`Migration ${this.jobId} complete:`, stats);
    return stats;
  }

  // ── Per entity type execution ─────────────────────────────────────────────

  async _executeEntityType(entityType, destClient, stats, job) {
    const { rows: pendingItems } = await query(
      `SELECT * FROM diff_results
       WHERE job_id = $1 AND entity_type = $2
         AND migration_action IN ('create', 'update')
         AND (migration_status IS NULL OR migration_status = 'not_started')
       ORDER BY created_at ASC`,
      [this.jobId, entityType]
    );

    logger.info(`Migrating ${pendingItems.length} ${entityType}(s)...`);

    const tasks = pendingItems.map(item =>
      this.limit(() => this._migrateEntity(item, destClient, job, stats))
    );
    await Promise.all(tasks);
  }

  // ── Single entity migration ───────────────────────────────────────────────

  async _migrateEntity(diffResult, destClient, job, stats) {
    const start = Date.now();
    await query(
      `UPDATE diff_results SET migration_status = 'in_progress' WHERE id = $1`,
      [diffResult.id]
    );

    try {
      let destId = null;

      switch (diffResult.entity_type) {
        case 'org_group':    destId = await this._migrateOrgGroup(diffResult, destClient, job);   break;
        case 'profile':      destId = await this._migrateProfile(diffResult, destClient, job);    break;
        case 'application':  destId = await this._migrateApplication(diffResult, destClient, job); break;
        case 'product':      destId = await this._migrateProduct(diffResult, destClient, job);    break;
        case 'smart_group':  destId = await this._migrateSmartGroup(diffResult, destClient, job); break;
        case 'sensor':       destId = await this._migrateSensor(diffResult, destClient, job);     break;
        case 'script':       destId = await this._migrateScript(diffResult, destClient, job);     break;
      }

      await query(
        `UPDATE diff_results
         SET migration_status = 'success', migrated_at = NOW(),
             dest_created_uem_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [diffResult.id, destId]
      );

      if (diffResult.migration_action === 'create') stats.added++;
      else stats.updated++;

      await this._logAudit({
        action: diffResult.migration_action === 'create' ? 'CREATE_SUCCESS' : 'UPDATE_SUCCESS',
        entityType: diffResult.entity_type, entityName: diffResult.source_name,
        sourceId: diffResult.source_uem_id, destId,
        status: 'success', durationMs: Date.now() - start,
      });

    } catch (err) {
      stats.failed++;
      logger.error(`Failed to migrate ${diffResult.entity_type} "${diffResult.source_name}": ${err.message}`);

      await query(
        `UPDATE diff_results
         SET migration_status = 'failed', error_message = $2, updated_at = NOW()
         WHERE id = $1`,
        [diffResult.id, err.message]
      );

      await this._logAudit({
        action: diffResult.migration_action === 'create' ? 'CREATE_FAILED' : 'UPDATE_FAILED',
        entityType: diffResult.entity_type, entityName: diffResult.source_name,
        sourceId: diffResult.source_uem_id, status: 'failed',
        error: err.message, durationMs: Date.now() - start,
      });
    }
  }

  // ── Org Group migration ───────────────────────────────────────────────────

  async _migrateOrgGroup(diffResult, destClient, job) {
    const srcRow = await query(
      `SELECT * FROM org_groups WHERE environment_id = $1 AND uem_id = $2`,
      [job.source_env_id, diffResult.source_uem_id]
    );
    const src = srcRow.rows[0];
    if (!src) throw new Error(`Source org group not found: ${diffResult.source_uem_id}`);

    // Resolve parent in destination using id_mappings
    let destParentId = null;
    if (src.parent_uem_id) {
      const mapping = await this._getMapping('org_group', src.parent_uem_id);
      destParentId = mapping?.dest_uem_id;
      if (!destParentId) throw new Error(`Parent OG ${src.parent_uem_id} not yet migrated. Retry later.`);
    }

    const payload = {
      Name: src.name,
      GroupId: src.group_id,
      OrganizationGroupType: src.type,
      Country: src.raw_payload?.Country,
      Locale: src.raw_payload?.Locale,
    };

    let destId;
    if (diffResult.migration_action === 'create') {
      const resp = await destClient.createOrgGroup(destParentId, payload);
      destId = resp?.Value || resp?.id;
    } else {
      await destClient.request({
        method: 'PUT', path: `/system/groups/${diffResult.dest_uem_id}`, data: payload
      });
      destId = diffResult.dest_uem_id;
    }

    await this._saveMapping('org_group', diffResult.source_uem_id, destId);
    return destId;
  }

  // ── Profile migration ─────────────────────────────────────────────────────

  async _migrateProfile(diffResult, destClient, job) {
    const srcRow = await query(
      `SELECT * FROM profiles WHERE environment_id = $1 AND uem_id = $2`,
      [job.source_env_id, diffResult.source_uem_id]
    );
    const src = srcRow.rows[0];
    if (!src) throw new Error(`Source profile not found: ${diffResult.source_uem_id}`);

    // Resolve OG mapping
    const ogMapping = src.og_uem_id ? await this._getMapping('org_group', src.og_uem_id) : null;
    const payload = {
      ...src.raw_payload,
      OrganizationGroupUuid: ogMapping?.dest_uuid || src.raw_payload?.OrganizationGroupUuid,
    };
    // Strip source-specific IDs
    delete payload.ProfileId;
    delete payload.Uuid;

    let destId;
    if (diffResult.migration_action === 'create') {
      const resp = await destClient.createProfile(payload);
      destId = resp?.Value || resp?.ProfileId?.Value;
    } else {
      await destClient.updateProfile(diffResult.dest_uem_id, payload);
      destId = diffResult.dest_uem_id;
    }

    await this._saveMapping('profile', diffResult.source_uem_id, destId);
    return destId;
  }

  // ── Application migration ─────────────────────────────────────────────────

  async _migrateApplication(diffResult, destClient, job) {
    const srcRow = await query(
      `SELECT * FROM applications WHERE environment_id = $1 AND uem_id = $2`,
      [job.source_env_id, diffResult.source_uem_id]
    );
    const src = srcRow.rows[0];
    if (!src) throw new Error(`Source app not found: ${diffResult.source_uem_id}`);

    const ogMapping = src.og_uem_id ? await this._getMapping('org_group', src.og_uem_id) : null;
    const payload = {
      ...src.raw_payload,
      OrganizationGroupUuid: ogMapping?.dest_uuid,
    };
    delete payload.Id;
    delete payload.Uuid;

    let destId;
    const appType = (src.app_type || 'Internal').toLowerCase();
    if (diffResult.migration_action === 'create') {
      const resp = await destClient.createPublicApp(payload);
      destId = resp?.Value || resp?.Id?.Value;
    } else {
      await destClient.updateApp(diffResult.dest_uem_id, appType, payload);
      destId = diffResult.dest_uem_id;
    }

    await this._saveMapping('application', diffResult.source_uem_id, destId);
    return destId;
  }

  // ── Product migration ─────────────────────────────────────────────────────

  async _migrateProduct(diffResult, destClient, job) {
    const srcRow = await query(
      `SELECT * FROM products WHERE environment_id = $1 AND uem_id = $2`,
      [job.source_env_id, diffResult.source_uem_id]
    );
    const src = srcRow.rows[0];
    if (!src) throw new Error(`Source product not found: ${diffResult.source_uem_id}`);

    const ogMapping = src.og_uem_id ? await this._getMapping('org_group', src.og_uem_id) : null;
    const payload = {
      ...src.raw_payload,
      OrganizationGroupUuid: ogMapping?.dest_uuid,
    };
    delete payload.ID;
    delete payload.Uuid;

    let destId;
    if (diffResult.migration_action === 'create') {
      const resp = await destClient.createProduct(payload);
      destId = resp?.Value || resp?.ID?.Value;
      // Activate if source was active
      if (src.status === 'Active' && destId) {
        await destClient.activateProduct(destId).catch(() => {});
      }
    } else {
      await destClient.updateProduct(diffResult.dest_uem_id, payload);
      destId = diffResult.dest_uem_id;
    }

    await this._saveMapping('product', diffResult.source_uem_id, destId);
    return destId;
  }

  // ── ID Mapping helpers ────────────────────────────────────────────────────

  async _getMapping(entityType, sourceUemId) {
    const { rows } = await query(
      `SELECT * FROM id_mappings WHERE job_id = $1 AND entity_type = $2 AND source_uem_id = $3`,
      [this.jobId, entityType, sourceUemId]
    );
    return rows[0] || null;
  }

  async _saveMapping(entityType, sourceUemId, destUemId) {
    await query(
      `INSERT INTO id_mappings (job_id, entity_type, source_uem_id, dest_uem_id, status)
       VALUES ($1, $2, $3, $4, 'mapped')
       ON CONFLICT (job_id, entity_type, source_uem_id)
       DO UPDATE SET dest_uem_id = $4, status = 'mapped', updated_at = NOW()`,
      [this.jobId, entityType, sourceUemId, destUemId]
    );
  }

  // ── Smart Group migration ─────────────────────────────────────────────────

  async _migrateSmartGroup(diffResult, destClient, job) {
    const srcRow = await query(
      `SELECT * FROM smart_groups WHERE environment_id = $1 AND uem_id = $2`,
      [job.source_env_id, diffResult.source_uem_id]
    );
    const src = srcRow.rows[0];
    if (!src) throw new Error(`Source smart group not found: ${diffResult.source_uem_id}`);

    const ogMapping = src.og_uem_id ? await this._getMapping('org_group', src.og_uem_id) : null;
    const payload = {
      Name: src.name,
      ManagedByOrganizationGroupId: ogMapping?.dest_uem_id || src.og_uem_id,
      CriteriaType: src.criteria_type,
      GroupType: src.group_type,
      Criterias: src.criterias || [],
      UserAdditions: src.user_additions || [],
      UserExclusions: src.user_exclusions || [],
      DeviceAdditions: src.device_additions || [],
      DeviceExclusions: src.device_exclusions || [],
      OrganizationGroupAdditions: src.ogs_additions || [],
    };

    let destId;
    if (diffResult.migration_action === 'create') {
      const resp = await destClient.createSmartGroup(payload);
      destId = resp?.Value || resp?.SmartGroupID?.Value || resp?.Id;
    } else {
      await destClient.updateSmartGroup(diffResult.dest_uem_id, payload);
      destId = diffResult.dest_uem_id;
    }
    await this._saveMapping('smart_group', diffResult.source_uem_id, destId);
    return destId;
  }

  // ── Sensor migration ──────────────────────────────────────────────────────

  async _migrateSensor(diffResult, destClient, job) {
    // source_uem_id is an integer (uem_id); fall back to uem_uuid text match
    const srcRow = await query(
      `SELECT * FROM sensors WHERE environment_id = $1 AND uem_id = $2`,
      [job.source_env_id, diffResult.source_uem_id]
    );
    const src = srcRow.rows[0] || (await query(
      `SELECT * FROM sensors WHERE environment_id = $1 AND uem_uuid = $2`,
      [job.source_env_id, String(diffResult.source_uem_id)]
    )).rows[0];
    if (!src) throw new Error(`Source sensor not found: ${diffResult.source_uem_id}`);

    const ogMapping = src.og_uem_id ? await this._getMapping('org_group', src.og_uem_id) : null;
    const payload = {
      Name: src.name,
      Description: src.description,
      Platform: src.platform,
      ExecutionContext: src.execution_context,
      ExecutionArchitecture: src.execution_architecture,
      ScriptType: src.script_type,
      ScriptBody: UEMClient.encodeScriptBody(src.script_body),
      ReturnType: src.return_type,
      OrganizationGroupUuid: ogMapping?.dest_uuid || src.og_uuid,
    };

    let destId;
    if (diffResult.migration_action === 'create') {
      const resp = await destClient.createSensor(payload);
      destId = resp?.Uuid || resp?.Value;
    } else {
      await destClient.updateSensor(diffResult.dest_uem_id, payload);
      destId = diffResult.dest_uem_id;
    }
    await this._saveMapping('sensor', diffResult.source_uem_id, destId);
    return destId;
  }

  // ── Script migration ──────────────────────────────────────────────────────

  async _migrateScript(diffResult, destClient, job) {
    const srcRow = await query(
      `SELECT * FROM scripts WHERE environment_id = $1 AND (uem_uuid = $2 OR uem_id::text = $2::text)`,
      [job.source_env_id, diffResult.source_uem_id]
    );
    const src = srcRow.rows[0];
    if (!src) throw new Error(`Source script not found: ${diffResult.source_uem_id}`);

    const ogMapping = src.og_uem_id ? await this._getMapping('org_group', src.og_uem_id) : null;
    const payload = {
      Name: src.name,
      Description: src.description,
      Platform: src.platform,
      ScriptType: src.script_type,
      ExecutionContext: src.execution_context,
      ExecutionArchitecture: src.execution_architecture,
      TimeoutInSeconds: src.timeout_seconds,
      ScriptBody: UEMClient.encodeScriptBody(src.script_body),
      TriggerType: src.trigger_type,
      Schedule: src.schedule || {},
      ScriptVariables: src.script_variables || [],
      OrganizationGroupUuid: ogMapping?.dest_uuid || src.og_uuid,
    };

    let destId;
    if (diffResult.migration_action === 'create') {
      const resp = await destClient.createScript(payload);
      destId = resp?.Uuid || resp?.Value;
    } else {
      await destClient.updateScript(diffResult.dest_uem_id, payload);
      destId = diffResult.dest_uem_id;
    }
    await this._saveMapping('script', diffResult.source_uem_id, destId);
    return destId;
  }

  // ── Audit log helper ──────────────────────────────────────────────────────

  async _logAudit({ action, entityType, entityName, sourceId, destId, status, error, durationMs }) {
    await query(
      `INSERT INTO migration_audit_log
         (job_id, action, entity_type, entity_name, source_uem_id, dest_uem_id, status, error_message, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [this.jobId, action, entityType, entityName, sourceId, destId, status, error || null, durationMs]
    );
  }
}

module.exports = MigrationExecutor;
