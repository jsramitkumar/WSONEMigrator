const { pool } = require('./database');
const logger = require('../utils/logger');

/**
 * Consolidated, idempotent schema.
 * Safe to run on every startup — uses IF NOT EXISTS / CREATE OR REPLACE throughout.
 * Merges what was previously 001_initial_schema.sql + 002_smart_groups_sensors_scripts.sql
 */
const SCHEMA_SQL = `

-- ── Extensions ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── environments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS environments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  console_url      VARCHAR(500) NOT NULL,
  api_url          VARCHAR(500) NOT NULL,
  tenant_code      VARCHAR(100),
  auth_type        VARCHAR(20)  NOT NULL DEFAULT 'oauth2',
  oauth_token_url  VARCHAR(500),
  client_id        VARCHAR(255),
  client_secret    TEXT,
  api_username     VARCHAR(255),
  api_password     TEXT,
  api_key          VARCHAR(500),
  is_active        BOOLEAN      DEFAULT TRUE,
  environment_type VARCHAR(20)  DEFAULT 'source',
  created_at       TIMESTAMPTZ  DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  DEFAULT NOW()
);

-- ── migration_jobs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_jobs (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                 VARCHAR(255) NOT NULL,
  description          TEXT,
  source_env_id        UUID NOT NULL REFERENCES environments(id),
  dest_env_id          UUID NOT NULL REFERENCES environments(id),
  status               VARCHAR(30) NOT NULL DEFAULT 'pending',
  migrate_orgs         BOOLEAN DEFAULT TRUE,
  migrate_profiles     BOOLEAN DEFAULT TRUE,
  migrate_apps         BOOLEAN DEFAULT TRUE,
  migrate_products     BOOLEAN DEFAULT TRUE,
  migrate_smart_groups BOOLEAN DEFAULT FALSE,
  migrate_sensors      BOOLEAN DEFAULT FALSE,
  migrate_scripts      BOOLEAN DEFAULT FALSE,
  total_entities       INT DEFAULT 0,
  entities_added       INT DEFAULT 0,
  entities_updated     INT DEFAULT 0,
  entities_skipped     INT DEFAULT 0,
  entities_failed      INT DEFAULT 0,
  started_at           TIMESTAMPTZ,
  snapshot_at          TIMESTAMPTZ,
  diff_completed_at    TIMESTAMPTZ,
  migration_started_at TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_by           VARCHAR(255),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── org_groups ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_groups (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment_id UUID NOT NULL REFERENCES environments(id),
  job_id         UUID REFERENCES migration_jobs(id),
  uem_id         INT  NOT NULL,
  uem_uuid       VARCHAR(100),
  parent_uem_id  INT,
  parent_uuid    VARCHAR(100),
  name           VARCHAR(255) NOT NULL,
  group_id       VARCHAR(255),
  type           VARCHAR(100),
  country        VARCHAR(100),
  locale         VARCHAR(50),
  address_line1  VARCHAR(255),
  address_line2  VARCHAR(255),
  city           VARCHAR(100),
  state          VARCHAR(100),
  zip_code       VARCHAR(50),
  depth          INT  DEFAULT 0,
  hierarchy_path TEXT,
  raw_payload    JSONB,
  snapshot_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_groups_env    ON org_groups(environment_id);
CREATE INDEX IF NOT EXISTS idx_org_groups_uem_id ON org_groups(environment_id, uem_id);
CREATE INDEX IF NOT EXISTS idx_org_groups_parent ON org_groups(environment_id, parent_uem_id);

-- ── profiles ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment_id  UUID NOT NULL REFERENCES environments(id),
  job_id          UUID REFERENCES migration_jobs(id),
  uem_id          INT  NOT NULL,
  uem_uuid        VARCHAR(100),
  og_uem_id       INT,
  og_uuid         VARCHAR(100),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  platform        VARCHAR(100),
  profile_type    VARCHAR(100),
  assignment_type VARCHAR(100),
  managed_by      VARCHAR(100),
  status          VARCHAR(50),
  version         INT DEFAULT 1,
  payload_summary JSONB,
  raw_payload     JSONB,
  snapshot_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_env      ON profiles(environment_id);
CREATE INDEX IF NOT EXISTS idx_profiles_uem_id   ON profiles(environment_id, uem_id);
CREATE INDEX IF NOT EXISTS idx_profiles_platform ON profiles(environment_id, platform);

-- ── applications ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS applications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment_id  UUID NOT NULL REFERENCES environments(id),
  job_id          UUID REFERENCES migration_jobs(id),
  uem_id          INT  NOT NULL,
  uem_uuid        VARCHAR(100),
  og_uem_id       INT,
  og_uuid         VARCHAR(100),
  name            VARCHAR(255) NOT NULL,
  bundle_id       VARCHAR(500),
  version         VARCHAR(100),
  build_version   VARCHAR(100),
  platform        VARCHAR(100),
  app_type        VARCHAR(100),
  status          VARCHAR(50),
  supported_models JSONB,
  assignment_groups JSONB,
  managed_config  JSONB,
  raw_payload     JSONB,
  snapshot_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_applications_env    ON applications(environment_id);
CREATE INDEX IF NOT EXISTS idx_applications_uem_id ON applications(environment_id, uem_id);
CREATE INDEX IF NOT EXISTS idx_applications_bundle ON applications(environment_id, bundle_id);

-- ── products ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment_id  UUID NOT NULL REFERENCES environments(id),
  job_id          UUID REFERENCES migration_jobs(id),
  uem_id          INT  NOT NULL,
  uem_uuid        VARCHAR(100),
  og_uem_id       INT,
  og_uuid         VARCHAR(100),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  platform        VARCHAR(100),
  product_type    VARCHAR(100),
  status          VARCHAR(50),
  activation_type VARCHAR(100),
  steps           JSONB,
  conditions      JSONB,
  smart_groups    JSONB,
  raw_payload     JSONB,
  snapshot_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_env    ON products(environment_id);
CREATE INDEX IF NOT EXISTS idx_products_uem_id ON products(environment_id, uem_id);

-- ── smart_groups ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smart_groups (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment_id   UUID NOT NULL REFERENCES environments(id),
  job_id           UUID REFERENCES migration_jobs(id),
  uem_id           INT  NOT NULL,
  uem_uuid         VARCHAR(100),
  og_uem_id        INT,
  og_uuid          VARCHAR(100),
  name             VARCHAR(255) NOT NULL,
  managed_by_og_id INT,
  criteria_type    VARCHAR(100),
  group_type       VARCHAR(100),
  criterias        JSONB,
  user_additions   JSONB,
  user_exclusions  JSONB,
  device_additions JSONB,
  device_exclusions JSONB,
  ogs_additions    JSONB,
  raw_payload      JSONB,
  snapshot_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_smart_groups_env    ON smart_groups(environment_id);
CREATE INDEX IF NOT EXISTS idx_smart_groups_uem_id ON smart_groups(environment_id, uem_id);
CREATE INDEX IF NOT EXISTS idx_smart_groups_name   ON smart_groups(environment_id, name);

-- ── sensors ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sensors (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment_id         UUID NOT NULL REFERENCES environments(id),
  job_id                 UUID REFERENCES migration_jobs(id),
  uem_id                 INT,
  uem_uuid               VARCHAR(100),
  og_uem_id              INT,
  og_uuid                VARCHAR(100),
  name                   VARCHAR(255) NOT NULL,
  description            TEXT,
  platform               VARCHAR(100),
  execution_context      VARCHAR(100),
  execution_architecture VARCHAR(100),
  script_type            VARCHAR(50),
  script_body            TEXT,
  return_type            VARCHAR(50),
  assigned_groups        JSONB,
  raw_payload            JSONB,
  snapshot_at            TIMESTAMPTZ DEFAULT NOW(),
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sensors_env    ON sensors(environment_id);
CREATE INDEX IF NOT EXISTS idx_sensors_uem_id ON sensors(environment_id, uem_id);
CREATE INDEX IF NOT EXISTS idx_sensors_name   ON sensors(environment_id, name);

-- ── scripts ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scripts (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment_id         UUID NOT NULL REFERENCES environments(id),
  job_id                 UUID REFERENCES migration_jobs(id),
  uem_id                 INT,
  uem_uuid               VARCHAR(100),
  og_uem_id              INT,
  og_uuid                VARCHAR(100),
  name                   VARCHAR(255) NOT NULL,
  description            TEXT,
  platform               VARCHAR(100),
  script_type            VARCHAR(50),
  execution_context      VARCHAR(100),
  execution_architecture VARCHAR(100),
  timeout_seconds        INT DEFAULT 30,
  script_body            TEXT,
  trigger_type           VARCHAR(100),
  schedule               JSONB,
  assigned_groups        JSONB,
  script_variables       JSONB,
  raw_payload            JSONB,
  snapshot_at            TIMESTAMPTZ DEFAULT NOW(),
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scripts_env    ON scripts(environment_id);
CREATE INDEX IF NOT EXISTS idx_scripts_uem_id ON scripts(environment_id, uem_id);
CREATE INDEX IF NOT EXISTS idx_scripts_name   ON scripts(environment_id, name);

-- ── diff_results ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diff_results (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id              UUID NOT NULL REFERENCES migration_jobs(id),
  entity_type         VARCHAR(50)  NOT NULL,
  source_entity_id    UUID,
  source_uem_id       INT,
  source_name         VARCHAR(255),
  dest_entity_id      UUID,
  dest_uem_id         INT,
  dest_name           VARCHAR(255),
  diff_status         VARCHAR(30)  NOT NULL,
  match_key           VARCHAR(500),
  diff_details        JSONB,
  migration_action    VARCHAR(30)  DEFAULT 'pending',
  action_override     BOOLEAN      DEFAULT FALSE,
  notes               TEXT,
  migration_status    VARCHAR(30),
  migrated_at         TIMESTAMPTZ,
  dest_created_uem_id INT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ  DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diff_job              ON diff_results(job_id);
CREATE INDEX IF NOT EXISTS idx_diff_type             ON diff_results(job_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_diff_status           ON diff_results(job_id, diff_status);
CREATE INDEX IF NOT EXISTS idx_diff_migration_status ON diff_results(job_id, migration_status);

-- ── id_mappings ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS id_mappings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID        NOT NULL REFERENCES migration_jobs(id),
  entity_type   VARCHAR(50) NOT NULL,
  source_uem_id INT         NOT NULL,
  source_uuid   VARCHAR(100),
  dest_uem_id   INT,
  dest_uuid     VARCHAR(100),
  status        VARCHAR(30) DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(job_id, entity_type, source_uem_id)
);

CREATE INDEX IF NOT EXISTS idx_idmap_job_type ON id_mappings(job_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_idmap_source   ON id_mappings(job_id, entity_type, source_uem_id);

-- ── migration_audit_log ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_audit_log (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id           UUID         NOT NULL REFERENCES migration_jobs(id),
  diff_result_id   UUID         REFERENCES diff_results(id),
  entity_type      VARCHAR(50),
  entity_name      VARCHAR(255),
  source_uem_id    INT,
  dest_uem_id      INT,
  action           VARCHAR(100) NOT NULL,
  status           VARCHAR(30),
  request_url      TEXT,
  request_payload  JSONB,
  response_status  INT,
  response_payload JSONB,
  error_message    TEXT,
  duration_ms      INT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_job    ON migration_audit_log(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON migration_audit_log(job_id, action, status);

-- ── rollback_log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rollback_log (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id           UUID        NOT NULL REFERENCES migration_jobs(id),
  entity_type      VARCHAR(50) NOT NULL,
  dest_uem_id      INT         NOT NULL,
  dest_uuid        VARCHAR(100),
  entity_name      VARCHAR(255),
  action_taken     VARCHAR(30) NOT NULL,
  original_payload JSONB,
  rollback_status  VARCHAR(30) DEFAULT 'pending',
  rolled_back_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rollback_job ON rollback_log(job_id);

-- ── Views ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_job_summary AS
SELECT
  j.id,
  j.name,
  j.status,
  s.name AS source_env,
  d.name AS dest_env,
  j.total_entities,
  j.entities_added,
  j.entities_updated,
  j.entities_skipped,
  j.entities_failed,
  j.migrate_orgs,
  j.migrate_profiles,
  j.migrate_apps,
  j.migrate_products,
  j.migrate_smart_groups,
  j.migrate_sensors,
  j.migrate_scripts,
  COUNT(dr.id) FILTER (WHERE dr.diff_status = 'only_in_source') AS new_in_source,
  COUNT(dr.id) FILTER (WHERE dr.diff_status = 'modified')       AS modified,
  COUNT(dr.id) FILTER (WHERE dr.diff_status = 'identical')      AS identical,
  COUNT(dr.id) FILTER (WHERE dr.diff_status = 'conflict')       AS conflicts,
  j.created_at,
  j.completed_at
FROM migration_jobs j
LEFT JOIN environments   s  ON j.source_env_id = s.id
LEFT JOIN environments   d  ON j.dest_env_id   = d.id
LEFT JOIN diff_results   dr ON dr.job_id        = j.id
GROUP BY j.id, s.name, d.name;

CREATE OR REPLACE VIEW v_diff_detail AS
SELECT
  dr.*,
  j.name AS job_name,
  s.name AS source_env_name,
  d.name AS dest_env_name
FROM diff_results   dr
JOIN migration_jobs  j ON dr.job_id        = j.id
JOIN environments    s ON j.source_env_id  = s.id
JOIN environments    d ON j.dest_env_id    = d.id;

-- ── updated_at trigger function ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── updated_at triggers (idempotent via OR REPLACE, requires PG 14+) ─────
CREATE OR REPLACE TRIGGER trg_environments_updated_at
  BEFORE UPDATE ON environments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_migration_jobs_updated_at
  BEFORE UPDATE ON migration_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_diff_results_updated_at
  BEFORE UPDATE ON diff_results
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_id_mappings_updated_at
  BEFORE UPDATE ON id_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

/**
 * Run the consolidated schema against the connected database.
 * All statements use IF NOT EXISTS / CREATE OR REPLACE so this is
 * safe to call on every startup — it will only create what is missing.
 */
async function runMigrations() {
  const client = await pool.connect();
  try {
    logger.info('Running database migrations…');
    await client.query(SCHEMA_SQL);
    logger.info('✅ Database schema is up to date');
  } catch (err) {
    logger.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
