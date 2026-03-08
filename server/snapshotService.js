const { query, withTransaction } = require('./config/database');
const { getClientForEnv, UEMClient } = require('./uemClient');
const logger = require('./utils/logger');

/**
 * SnapshotService
 * Pulls all entities from a UEM environment and saves to DB
 */
class SnapshotService {
  constructor(jobId) {
    this.jobId = jobId;
  }

  async log(action, details = {}) {
    await query(
      `INSERT INTO migration_audit_log (job_id, action, status, error_message, request_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [this.jobId, action, details.status || 'success', details.error || null, details.url || null]
    );
  }

  // ── Main snapshot entry point ─────────────────────────────────────────────

  async snapshotEnvironment(environmentId) {
    const { rows } = await query('SELECT * FROM environments WHERE id = $1', [environmentId]);
    const env = rows[0];
    if (!env) throw new Error(`Environment not found: ${environmentId}`);

    const client = await getClientForEnv(environmentId);
    logger.info(`Starting snapshot for environment: ${env.name}`);
    await this.log('SNAPSHOT_STARTED', { url: env.api_url });

    // Get root OG first
    const root = await client.getRootOrgGroup();
    const rootOgId = root.Id?.Value || root.Id;

    const results = {
      orgs: 0, profiles: 0, apps: 0, products: 0,
      smart_groups: 0, sensors: 0, scripts: 0,
    };

    // 1. Snapshot Org Groups (tree traversal)
    const allOrgs = await this._snapshotOrgTree(client, environmentId, rootOgId);
    results.orgs = allOrgs.length;

    // 2. Snapshot per-OG entities
    for (const org of allOrgs) {
      const ogId    = org.uem_id;
      const ogUuid  = org.uem_uuid;
      results.profiles     += await this._snapshotProfiles(client, environmentId, ogId);
      results.apps         += await this._snapshotApplications(client, environmentId, ogId);
      results.products     += await this._snapshotProducts(client, environmentId, ogId);
      results.smart_groups += await this._snapshotSmartGroups(client, environmentId, ogId);
      // Sensors and Scripts use org UUID, not int ID
      if (ogUuid) {
        results.sensors += await this._snapshotSensors(client, environmentId, ogUuid, ogId);
        results.scripts += await this._snapshotScripts(client, environmentId, ogUuid, ogId);
      }
    }

    await this.log('SNAPSHOT_COMPLETED', { url: env.api_url });
    logger.info(`Snapshot complete for ${env.name}:`, results);
    return results;
  }

  // ── Org Groups ────────────────────────────────────────────────────────────

  async _snapshotOrgTree(client, environmentId, rootOgId, depth = 0, parentId = null, path = 'Root') {
    const saved = [];

    // Clear existing snapshot for this env
    if (depth === 0) {
      await query('DELETE FROM org_groups WHERE environment_id = $1 AND job_id = $2', [environmentId, this.jobId]);
    }

    let children = [];
    try {
      children = await client.getOrgGroups(rootOgId);
    } catch (e) {
      logger.warn(`Could not fetch children of OG ${rootOgId}: ${e.message}`);
      return saved;
    }

    for (const og of children) {
      const ogId = og.Id?.Value || og.Id;
      const ogName = og.Name;
      const hierarchyPath = `${path}/${ogName}`;

      await query(
        `INSERT INTO org_groups (environment_id, job_id, uem_id, uem_uuid, parent_uem_id, name, group_id, type,
           depth, hierarchy_path, raw_payload, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT DO NOTHING`,
        [
          environmentId, this.jobId, ogId, og.Uuid || null, parentId,
          ogName, og.GroupId, og.OrganizationGroupType,
          depth, hierarchyPath, JSON.stringify(og)
        ]
      );

      const savedOg = { uem_id: ogId, uem_uuid: og.Uuid || null, name: ogName };
      saved.push(savedOg);

      // Recurse
      const children2 = await this._snapshotOrgTree(client, environmentId, ogId, depth + 1, ogId, hierarchyPath);
      saved.push(...children2);
    }
    return saved;
  }

  // ── Profiles ──────────────────────────────────────────────────────────────

  async _snapshotProfiles(client, environmentId, ogId) {
    let profiles;
    try {
      profiles = await client.getProfiles(ogId);
    } catch (e) {
      logger.warn(`Profiles fetch failed for OG ${ogId}: ${e.message}`);
      return 0;
    }

    for (const p of profiles) {
      const profileId = p.ProfileId?.Value || p.Id;
      await query(
        `INSERT INTO profiles (environment_id, job_id, uem_id, uem_uuid, og_uem_id, name, description,
           platform, profile_type, assignment_type, status, version, raw_payload, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT DO NOTHING`,
        [
          environmentId, this.jobId,
          profileId, p.Uuid || null, ogId,
          p.ProfileName || p.Name,
          p.Description || null,
          p.Platform, p.ManagedBy, p.AssignmentType,
          p.Status, p.CurrentVersion || 1,
          JSON.stringify(p)
        ]
      );
    }
    return profiles.length;
  }

  // ── Applications ──────────────────────────────────────────────────────────

  async _snapshotApplications(client, environmentId, ogId) {
    let apps;
    try {
      apps = await client.getApplications(ogId);
    } catch (e) {
      logger.warn(`Apps fetch failed for OG ${ogId}: ${e.message}`);
      return 0;
    }

    for (const app of apps) {
      const appId = app.Id?.Value || app.ApplicationId;
      await query(
        `INSERT INTO applications (environment_id, job_id, uem_id, uem_uuid, og_uem_id, name, bundle_id,
           version, platform, app_type, status, raw_payload, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT DO NOTHING`,
        [
          environmentId, this.jobId,
          appId, app.Uuid || null, ogId,
          app.ApplicationName || app.AppName,
          app.BundleId || app.Identifier,
          app.AppVersion || app.ApplicationVersion,
          app.Platform, app._appType || app.AppType,
          app.Status,
          JSON.stringify(app)
        ]
      );
    }
    return apps.length;
  }

  // ── Products ──────────────────────────────────────────────────────────────

  async _snapshotProducts(client, environmentId, ogId) {
    let products;
    try {
      products = await client.getProducts(ogId);
    } catch (e) {
      logger.warn(`Products fetch failed for OG ${ogId}: ${e.message}`);
      return 0;
    }

    for (const prod of products) {
      const prodId = prod.ID?.Value || prod.Id;
      await query(
        `INSERT INTO products (environment_id, job_id, uem_id, uem_uuid, og_uem_id, name, description,
           platform, product_type, status, raw_payload, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT DO NOTHING`,
        [
          environmentId, this.jobId,
          prodId, prod.Uuid || null, ogId,
          prod.Name, prod.Description || null,
          prod.Platform, prod.ProductType || 'Standard',
          prod.Active ? 'Active' : 'Inactive',
          JSON.stringify(prod)
        ]
      );
    }
    return products.length;
  }
  // ── Smart Groups ──────────────────────────────────────────────────────────

  async _snapshotSmartGroups(client, environmentId, ogId) {
    let groups;
    try {
      groups = await client.getSmartGroups(ogId);
    } catch (e) {
      logger.warn(`Smart groups fetch failed for OG ${ogId}: ${e.message}`);
      return 0;
    }
    for (const sg of groups) {
      const sgId = sg.SmartGroupID?.Value || sg.SmartGroupId || sg.Id;
      // Fetch full detail to get criteria
      let detail = sg;
      try { detail = await client.getSmartGroupDetail(sgId); } catch {}
      await query(
        `INSERT INTO smart_groups
           (environment_id, job_id, uem_id, uem_uuid, og_uem_id, name,
            managed_by_og_id, criteria_type, group_type,
            criterias, user_additions, user_exclusions,
            device_additions, device_exclusions, ogs_additions, raw_payload, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT DO NOTHING`,
        [
          environmentId, this.jobId, sgId, detail.Uuid || null, ogId,
          detail.Name || sg.Name,
          detail.ManagedByOrganizationGroupId || null,
          detail.CriteriaType || null, detail.GroupType || null,
          JSON.stringify(detail.Criterias || []),
          JSON.stringify(detail.UserAdditions || []),
          JSON.stringify(detail.UserExclusions || []),
          JSON.stringify(detail.DeviceAdditions || []),
          JSON.stringify(detail.DeviceExclusions || []),
          JSON.stringify(detail.OrganizationGroupAdditions || []),
          JSON.stringify(detail),
        ]
      );
    }
    return groups.length;
  }

  // ── Sensors ───────────────────────────────────────────────────────────────

  async _snapshotSensors(client, environmentId, ogUuid, ogId) {
    let sensors;
    try {
      sensors = await client.getSensors(ogUuid);
    } catch (e) {
      logger.warn(`Sensors fetch failed for OG ${ogUuid}: ${e.message}`);
      return 0;
    }
    for (const s of sensors) {
      const sensorUuid = s.Uuid || s.SensorUuid || s.Id;
      let detail = s;
      try { detail = await client.getSensorDetail(sensorUuid); } catch {}
      const scriptBody = UEMClient.decodeScriptBody(detail.ScriptBody || detail.Query);
      await query(
        `INSERT INTO sensors
           (environment_id, job_id, uem_id, uem_uuid, og_uem_id, og_uuid,
            name, description, platform, execution_context, execution_architecture,
            script_type, script_body, return_type, assigned_groups, raw_payload, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT DO NOTHING`,
        [
          environmentId, this.jobId,
          detail.ID || detail.Id || null, sensorUuid, ogId, ogUuid,
          detail.Name,
          detail.Description || null,
          detail.Platform || detail.OperatingSystem,
          detail.ExecutionContext || null,
          detail.ExecutionArchitecture || null,
          detail.ScriptType || detail.QueryType || null,
          scriptBody,
          detail.ReturnType || null,
          JSON.stringify(detail.SmartGroups || detail.AssignedGroups || []),
          JSON.stringify(detail),
        ]
      );
    }
    return sensors.length;
  }

  // ── Scripts ───────────────────────────────────────────────────────────────

  async _snapshotScripts(client, environmentId, ogUuid, ogId) {
    let scripts;
    try {
      scripts = await client.getScripts(ogUuid);
    } catch (e) {
      logger.warn(`Scripts fetch failed for OG ${ogUuid}: ${e.message}`);
      return 0;
    }
    for (const sc of scripts) {
      const scriptUuid = sc.Uuid || sc.ScriptUuid || sc.Id;
      let detail = sc;
      try { detail = await client.getScriptDetail(scriptUuid); } catch {}
      const scriptBody = UEMClient.decodeScriptBody(detail.ScriptBody);
      await query(
        `INSERT INTO scripts
           (environment_id, job_id, uem_id, uem_uuid, og_uem_id, og_uuid,
            name, description, platform, script_type, execution_context,
            execution_architecture, timeout_seconds, script_body,
            trigger_type, schedule, assigned_groups, script_variables, raw_payload, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
         ON CONFLICT DO NOTHING`,
        [
          environmentId, this.jobId,
          detail.ID || detail.Id || null, scriptUuid, ogId, ogUuid,
          detail.Name,
          detail.Description || null,
          detail.Platform || detail.OperatingSystem,
          detail.ScriptType || null,
          detail.ExecutionContext || null,
          detail.ExecutionArchitecture || null,
          detail.TimeoutInSeconds || 30,
          scriptBody,
          detail.TriggerType || null,
          JSON.stringify(detail.Schedule || {}),
          JSON.stringify(detail.SmartGroups || detail.AssignedGroups || []),
          JSON.stringify(detail.ScriptVariables || []),
          JSON.stringify(detail),
        ]
      );
    }
    return scripts.length;
  }
}

module.exports = SnapshotService;
