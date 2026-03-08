const { query, withTransaction } = require('./config/database');
const logger = require('./utils/logger');

/**
 * DiffService
 * Compares source and destination snapshots and writes diff_results
 */
class DiffService {
  constructor(jobId) {
    this.jobId = jobId;
  }

  // ── Main diff entry point ─────────────────────────────────────────────────

  async computeDiff(sourceEnvId, destEnvId) {
    logger.info(`Computing diff for job ${this.jobId}`);

    await query(
      `UPDATE migration_jobs SET status = 'diffing', updated_at = NOW() WHERE id = $1`,
      [this.jobId]
    );

    // Clear previous diff results for this job
    await query('DELETE FROM diff_results WHERE job_id = $1', [this.jobId]);

    const results = {
      orgs:         await this._diffOrgGroups(sourceEnvId, destEnvId),
      profiles:     await this._diffProfiles(sourceEnvId, destEnvId),
      apps:         await this._diffApplications(sourceEnvId, destEnvId),
      products:     await this._diffProducts(sourceEnvId, destEnvId),
      smart_groups: await this._diffSmartGroups(sourceEnvId, destEnvId),
      sensors:      await this._diffSensors(sourceEnvId, destEnvId),
      scripts:      await this._diffScripts(sourceEnvId, destEnvId),
    };

    const totals = Object.values(results).reduce((acc, r) => {
      acc.total += r.total;
      acc.only_in_source += r.only_in_source;
      acc.modified += r.modified;
      acc.identical += r.identical;
      acc.only_in_dest += r.only_in_dest;
      return acc;
    }, { total: 0, only_in_source: 0, modified: 0, identical: 0, only_in_dest: 0 });

    await query(
      `UPDATE migration_jobs 
       SET status = 'ready', diff_completed_at = NOW(), total_entities = $2, updated_at = NOW()
       WHERE id = $1`,
      [this.jobId, totals.total]
    );

    logger.info(`Diff complete for job ${this.jobId}:`, totals);
    return { results, totals };
  }

  // ── Generic diff helper ───────────────────────────────────────────────────

  async _diffEntities({ entityType, sourceItems, destItems, matchKey, compareFields }) {
    const stats = { total: 0, only_in_source: 0, modified: 0, identical: 0, only_in_dest: 0 };

    // Index dest items by match key
    const destIndex = new Map();
    for (const item of destItems) {
      const key = this._getMatchKey(item, matchKey);
      if (key) destIndex.set(key.toLowerCase().trim(), item);
    }

    const matchedDestKeys = new Set();

    for (const srcItem of sourceItems) {
      stats.total++;
      const matchValue = this._getMatchKey(srcItem, matchKey);
      const destItem = matchValue ? destIndex.get(matchValue.toLowerCase().trim()) : null;

      let diffStatus, diffDetails, migrationAction;

      if (!destItem) {
        diffStatus = 'only_in_source';
        migrationAction = 'create';
        diffDetails = null;
      } else {
        matchedDestKeys.add(matchValue.toLowerCase().trim());
        const fieldDiffs = this._compareFields(srcItem, destItem, compareFields);
        if (fieldDiffs.length === 0) {
          diffStatus = 'identical';
          migrationAction = 'skip';
        } else {
          diffStatus = 'modified';
          migrationAction = 'update';
          diffDetails = fieldDiffs;
        }
      }

      await query(
        `INSERT INTO diff_results (
          job_id, entity_type,
          source_entity_id, source_uem_id, source_name,
          dest_entity_id, dest_uem_id, dest_name,
          diff_status, match_key, diff_details, migration_action
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          this.jobId, entityType,
          srcItem._db_id || null, srcItem.uem_id, srcItem.name,
          destItem?._db_id || null, destItem?.uem_id || null, destItem?.name || null,
          diffStatus, matchValue, diffDetails ? JSON.stringify(diffDetails) : null,
          migrationAction,
        ]
      );

      if (diffStatus === 'only_in_source') stats.only_in_source++;
      else if (diffStatus === 'modified') stats.modified++;
      else stats.identical++;
    }

    // Items only in destination
    for (const destItem of destItems) {
      const key = this._getMatchKey(destItem, matchKey);
      if (key && !matchedDestKeys.has(key.toLowerCase().trim())) {
        stats.only_in_dest++;
        stats.total++;
        await query(
          `INSERT INTO diff_results (
            job_id, entity_type,
            dest_entity_id, dest_uem_id, dest_name,
            diff_status, match_key, migration_action
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            this.jobId, entityType,
            destItem._db_id || null, destItem.uem_id, destItem.name,
            'only_in_dest', key, 'skip',
          ]
        );
      }
    }

    return stats;
  }

  _getMatchKey(item, matchKey) {
    if (typeof matchKey === 'function') return matchKey(item);
    return item[matchKey] || item.raw_payload?.[matchKey] || null;
  }

  _compareFields(src, dest, fields) {
    const diffs = [];
    for (const field of fields) {
      const srcVal = src.raw_payload?.[field];
      const destVal = dest.raw_payload?.[field];
      if (JSON.stringify(srcVal) !== JSON.stringify(destVal)) {
        diffs.push({ field, source: srcVal, destination: destVal });
      }
    }
    return diffs;
  }

  // ── Org Groups Diff ───────────────────────────────────────────────────────

  async _diffOrgGroups(sourceEnvId, destEnvId) {
    const srcRows = await query(
      `SELECT id AS _db_id, uem_id, name, group_id, type, hierarchy_path, raw_payload
       FROM org_groups WHERE environment_id = $1 AND job_id = $2`,
      [sourceEnvId, this.jobId]
    );
    const destRows = await query(
      `SELECT id AS _db_id, uem_id, name, group_id, type, hierarchy_path, raw_payload
       FROM org_groups WHERE environment_id = $1 AND job_id = $2`,
      [destEnvId, this.jobId]
    );

    const srcItems = srcRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));
    const destItems = destRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));

    return this._diffEntities({
      entityType: 'org_group',
      sourceItems: srcItems,
      destItems: destItems,
      matchKey: 'name', // Match OGs by name (hierarchy-aware matching could be added)
      compareFields: ['GroupId', 'OrganizationGroupType', 'Country', 'Locale'],
    });
  }

  // ── Profiles Diff ─────────────────────────────────────────────────────────

  async _diffProfiles(sourceEnvId, destEnvId) {
    const srcRows = await query(
      `SELECT id AS _db_id, uem_id, name, platform, profile_type, raw_payload
       FROM profiles WHERE environment_id = $1 AND job_id = $2`,
      [sourceEnvId, this.jobId]
    );
    const destRows = await query(
      `SELECT id AS _db_id, uem_id, name, platform, profile_type, raw_payload
       FROM profiles WHERE environment_id = $1 AND job_id = $2`,
      [destEnvId, this.jobId]
    );

    const srcItems = srcRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));
    const destItems = destRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));

    return this._diffEntities({
      entityType: 'profile',
      sourceItems: srcItems,
      destItems: destItems,
      matchKey: item => `${item.platform}::${item.name}`,
      compareFields: ['AssignmentType', 'ManagedBy', 'Status', 'ProfileVersion'],
    });
  }

  // ── Applications Diff ─────────────────────────────────────────────────────

  async _diffApplications(sourceEnvId, destEnvId) {
    const srcRows = await query(
      `SELECT id AS _db_id, uem_id, name, bundle_id, platform, app_type, raw_payload
       FROM applications WHERE environment_id = $1 AND job_id = $2`,
      [sourceEnvId, this.jobId]
    );
    const destRows = await query(
      `SELECT id AS _db_id, uem_id, name, bundle_id, platform, app_type, raw_payload
       FROM applications WHERE environment_id = $1 AND job_id = $2`,
      [destEnvId, this.jobId]
    );

    const srcItems = srcRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));
    const destItems = destRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));

    return this._diffEntities({
      entityType: 'application',
      sourceItems: srcItems,
      destItems: destItems,
      // Bundle ID is the canonical match key for apps
      matchKey: item => item.bundle_id || `${item.platform}::${item.name}`,
      compareFields: ['AppVersion', 'AssignmentType', 'Status', 'SupportedModels'],
    });
  }

  // ── Products Diff ─────────────────────────────────────────────────────────

  async _diffProducts(sourceEnvId, destEnvId) {
    const srcRows = await query(
      `SELECT id AS _db_id, uem_id, name, platform, product_type, raw_payload
       FROM products WHERE environment_id = $1 AND job_id = $2`,
      [sourceEnvId, this.jobId]
    );
    const destRows = await query(
      `SELECT id AS _db_id, uem_id, name, platform, product_type, raw_payload
       FROM products WHERE environment_id = $1 AND job_id = $2`,
      [destEnvId, this.jobId]
    );

    const srcItems = srcRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));
    const destItems = destRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} }));

    return this._diffEntities({
      entityType: 'product',
      sourceItems: srcItems,
      destItems: destItems,
      matchKey: item => `${item.platform || 'any'}::${item.name}`,
      compareFields: ['Active', 'ProductType', 'ActivationType'],
    });
  }
  // ── Smart Groups Diff ─────────────────────────────────────────────────────

  async _diffSmartGroups(sourceEnvId, destEnvId) {
    const srcRows = await query(
      `SELECT id AS _db_id, uem_id, name, criteria_type, group_type, raw_payload
       FROM smart_groups WHERE environment_id = $1 AND job_id = $2`,
      [sourceEnvId, this.jobId]
    );
    const destRows = await query(
      `SELECT id AS _db_id, uem_id, name, criteria_type, group_type, raw_payload
       FROM smart_groups WHERE environment_id = $1 AND job_id = $2`,
      [destEnvId, this.jobId]
    );
    return this._diffEntities({
      entityType: 'smart_group',
      sourceItems: srcRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} })),
      destItems:   destRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} })),
      matchKey: 'name',
      compareFields: ['CriteriaType', 'GroupType', 'Criterias'],
    });
  }

  // ── Sensors Diff ──────────────────────────────────────────────────────────

  async _diffSensors(sourceEnvId, destEnvId) {
    const srcRows = await query(
      `SELECT id AS _db_id, uem_id, uem_uuid, name, platform, script_type, script_body, return_type, raw_payload
       FROM sensors WHERE environment_id = $1 AND job_id = $2`,
      [sourceEnvId, this.jobId]
    );
    const destRows = await query(
      `SELECT id AS _db_id, uem_id, uem_uuid, name, platform, script_type, script_body, return_type, raw_payload
       FROM sensors WHERE environment_id = $1 AND job_id = $2`,
      [destEnvId, this.jobId]
    );
    return this._diffEntities({
      entityType: 'sensor',
      sourceItems: srcRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} })),
      destItems:   destRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} })),
      // Match by platform + name — script body changes count as modifications
      matchKey: item => `${item.platform || 'any'}::${item.name}`,
      compareFields: ['ExecutionContext', 'ScriptType', 'ReturnType', 'ScriptBody'],
    });
  }

  // ── Scripts Diff ──────────────────────────────────────────────────────────

  async _diffScripts(sourceEnvId, destEnvId) {
    const srcRows = await query(
      `SELECT id AS _db_id, uem_id, uem_uuid, name, platform, script_type,
              script_body, execution_context, timeout_seconds, raw_payload
       FROM scripts WHERE environment_id = $1 AND job_id = $2`,
      [sourceEnvId, this.jobId]
    );
    const destRows = await query(
      `SELECT id AS _db_id, uem_id, uem_uuid, name, platform, script_type,
              script_body, execution_context, timeout_seconds, raw_payload
       FROM scripts WHERE environment_id = $1 AND job_id = $2`,
      [destEnvId, this.jobId]
    );
    return this._diffEntities({
      entityType: 'script',
      sourceItems: srcRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} })),
      destItems:   destRows.rows.map(r => ({ ...r, raw_payload: r.raw_payload || {} })),
      matchKey: item => `${item.platform || 'any'}::${item.name}`,
      compareFields: ['ScriptType', 'ExecutionContext', 'TimeoutInSeconds', 'ScriptBody', 'TriggerType'],
    });
  }
}

module.exports = DiffService;
