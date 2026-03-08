# UEM Migration Tool — Backend

A Node.js + PostgreSQL backend for migrating Workspace ONE UEM environments using a **Diff & Merge** approach.

---

## Architecture Overview

```
Source UEM ──► Snapshot ──► Diff Engine ──► Human Review ──► Executor ──► Destination UEM
                  ↓               ↓                                           ↓
             PostgreSQL      diff_results                               id_mappings
             (snapshots)     (decisions)                                audit_log
```

### Migration Flow

```
1. Create Environments    POST /api/environments
2. Test Connectivity      POST /api/environments/:id/test
3. Create Job             POST /api/jobs
4. Snapshot + Diff        POST /api/jobs/:id/snapshot       ← async, auto-diffs after
5. Review Diff Results    GET  /api/jobs/:id/diff
6. Override Actions       PATCH /api/jobs/:id/diff/:diffId  ← optional, for manual review
7. Execute Migration      POST /api/jobs/:id/migrate        ← async
8. Monitor Progress       GET  /api/jobs/:id
9. Audit Trail            GET  /api/jobs/:id/audit
10. ID Mappings           GET  /api/jobs/:id/mappings
```

---

## Database Schema

| Table | Purpose |
|---|---|
| `environments` | UEM tenant configs (source & destination) |
| `migration_jobs` | Top-level job records with status tracking |
| `org_groups` | Snapshots of Organization Group trees |
| `profiles` | Snapshots of MDM profiles |
| `applications` | Snapshots of MAM applications |
| `products` | Snapshots of WS1 products |
| `diff_results` | Field-level comparison results per entity |
| `id_mappings` | Source → Destination UEM ID translation table |
| `migration_audit_log` | Every API call & action logged |
| `rollback_log` | Tracks created/updated items for potential rollback |

### Diff Statuses

| Status | Meaning |
|---|---|
| `only_in_source` | Exists in source, not in destination → will be **created** |
| `modified` | Exists in both, fields differ → will be **updated** |
| `identical` | Exists in both, identical → **skipped** |
| `only_in_dest` | Exists in destination, not in source → **skipped** by default |
| `conflict` | Reserved for manual resolution cases |

---

## Setup

### 1. Prerequisites

- Node.js 18+
- PostgreSQL 14+

### 2. Install dependencies

```bash
npm install
```

### 3. Create PostgreSQL database

```sql
CREATE DATABASE uem_migration;
```

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env with your DB credentials
```

### 5. Run migrations

```bash
npm run migrate
```

### 6. Start server

```bash
npm run dev      # development (with nodemon)
npm start        # production
```

---

## API Reference

### Environments

```
GET    /api/environments              List all environments
POST   /api/environments              Create environment
GET    /api/environments/:id          Get environment
PUT    /api/environments/:id          Update environment
DELETE /api/environments/:id          Delete environment
POST   /api/environments/:id/test     Test UEM connectivity
```

**Create Environment (OAuth2)**
```json
{
  "name": "Production UEM",
  "console_url": "https://cn1234.awmdm.com",
  "api_url": "https://as1234.awmdm.com/api",
  "auth_type": "oauth2",
  "environment_type": "source",
  "oauth_token_url": "https://uat.uemauth.vmwservices.com/connect/token",
  "client_id": "your-client-id",
  "client_secret": "your-client-secret"
}
```

**Create Environment (Basic Auth)**
```json
{
  "name": "Dev UEM",
  "console_url": "https://cn5678.awmdm.com",
  "api_url": "https://as5678.awmdm.com/api",
  "auth_type": "basic",
  "environment_type": "destination",
  "api_username": "api-admin",
  "api_password": "password",
  "api_key": "your-aw-tenant-code"
}
```

### Jobs

```
GET    /api/jobs                      List all jobs
POST   /api/jobs                      Create job
GET    /api/jobs/:id                  Get job (with summary stats)
POST   /api/jobs/:id/snapshot         Snapshot both envs + auto-diff (async)
GET    /api/jobs/:id/diff             Get diff results (filterable)
PATCH  /api/jobs/:id/diff/:diffId     Override migration action
POST   /api/jobs/:id/migrate          Execute migration (async)
GET    /api/jobs/:id/audit            Audit log
GET    /api/jobs/:id/mappings         ID mappings (source → dest)
```

**Create Job**
```json
{
  "name": "Prod to Dev Migration - March 2026",
  "source_env_id": "uuid-of-source",
  "dest_env_id": "uuid-of-destination",
  "migrate_orgs": true,
  "migrate_profiles": true,
  "migrate_apps": true,
  "migrate_products": true
}
```

**Filter Diff Results**
```
GET /api/jobs/:id/diff?entity_type=profile&diff_status=modified
GET /api/jobs/:id/diff?migration_action=create&page=0&pagesize=50
```

**Override a diff action (skip a specific item)**
```json
PATCH /api/jobs/:id/diff/:diffId
{
  "migration_action": "skip",
  "notes": "This profile is environment-specific, do not migrate"
}
```

---

## Migration Order

Entities are always migrated in this order to preserve dependencies:

```
1. Org Groups   (top-down by depth, root first)
2. Profiles     (OG must exist first)
3. Applications (OG must exist first)
4. Products     (OG must exist first)
```

ID mappings are written after each successful create/update so dependent entities can resolve their parent references.

---

## Production Recommendations

- **Encrypt credentials**: Store `client_secret` / `api_password` with AES-256 (e.g. `node-forge`)
- **Add auth middleware**: JWT auth for the migration tool itself
- **Queue large jobs**: Use Bull/BullMQ with Redis for jobs with 1000+ entities
- **Rollback**: Use `rollback_log` + a rollback endpoint to undo a migration
- **Retry failed items**: Add `POST /api/jobs/:id/retry-failed` to re-run failed diff items
