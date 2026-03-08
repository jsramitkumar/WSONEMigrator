<div align="center">

# 🚀 WS1 UEM Migration Tool
### *Enterprise-grade Workspace ONE UEM environment migration via Diff & Merge*

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)

> Safely migrate **Org Groups · Profiles · Applications · Products · Smart Groups · Sensors · Scripts**  
> between Workspace ONE UEM tenants — with full diff review before a single change is made.

</div>

---

## 📋 Table of Contents

- [How It Works](#-how-it-works)
- [Architecture](#-architecture)
- [Database Schema](#-database-schema)
- [Quick Start — Docker Compose](#-quick-start--docker-compose-recommended)
- [Manual Setup](#-manual-setup-bare-metal)
- [API Reference](#-api-reference)
- [Migration Order & Dependency Resolution](#-migration-order--dependency-resolution)
- [Configuration Reference](#-configuration-reference)
- [CI/CD & Docker Hub](#-cicd--docker-hub)
- [Production Hardening](#-production-hardening)

---

## 💡 How It Works

The tool follows a **non-destructive Diff & Merge** model — it never blindly overwrites the destination. Every migration goes through five distinct phases:

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│  1. SNAPSHOT │───▶│  2. DIFF     │───▶│  3. REVIEW  │───▶│  4. EXECUTE  │───▶│ 5. AUDIT    │
│             │    │              │    │             │    │              │    │             │
│ Pull source │    │ Compare src  │    │ Human can   │    │ Apply only   │    │ Full log of │
│ & dest into │    │ vs dest      │    │ override any│    │ approved     │    │ every API   │
│ PostgreSQL  │    │ field-by-    │    │ action      │    │ diff actions │    │ call made   │
│             │    │ field        │    │ before exec │    │ in order     │    │             │
└─────────────┘    └──────────────┘    └─────────────┘    └──────────────┘    └─────────────┘
```

### Step-by-Step API Flow

| Step | Method | Endpoint | Description |
|:----:|--------|----------|-------------|
| 1 | `POST` | `/api/environments` | Register source & destination UEM tenants |
| 2 | `POST` | `/api/environments/:id/test` | Verify API connectivity before proceeding |
| 3 | `POST` | `/api/jobs` | Create a migration job linking source → dest |
| 4 | `POST` | `/api/jobs/:id/snapshot` | Pull snapshots from both envs, auto-diff *(async)* |
| 5 | `GET` | `/api/jobs/:id/diff` | Review field-level diff results |
| 6 | `PATCH` | `/api/jobs/:id/diff/:diffId` | Override any auto-decided action *(optional)* |
| 7 | `POST` | `/api/jobs/:id/migrate` | Execute the approved migration *(async)* |
| 8 | `GET` | `/api/jobs/:id` | Monitor job progress & stats |
| 9 | `GET` | `/api/jobs/:id/audit` | Full audit trail of every action |
| 10 | `GET` | `/api/jobs/:id/mappings` | Source → Destination ID translation table |

---

## 🏗 Architecture

### System Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           Load Balancer (SSL)            │
                    │         Terminates HTTPS → HTTP          │
                    └───────────────────┬─────────────────────┘
                                        │ :5271
                    ┌───────────────────▼─────────────────────┐
                    │          Node.js API Server              │
                    │                                          │
                    │  ┌────────────────────────────────────┐  │
                    │  │          Express Routes             │  │
                    │  │  /api/environments  /api/jobs       │  │
                    │  └────────────┬───────────────────────┘  │
                    │               │                          │
                    │  ┌────────────▼───────────────────────┐  │
                    │  │          Service Layer              │  │
                    │  │  SnapshotService  │  DiffService    │  │
                    │  │  MigrationExecutor│  UEMClient      │  │
                    │  └────────────┬───────────────────────┘  │
                    └───────────────┼─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │           PostgreSQL 16                  │
                    │                                          │
                    │  environments   migration_jobs           │
                    │  org_groups     profiles                 │
                    │  applications   products                 │
                    │  smart_groups   sensors    scripts       │
                    │  diff_results   id_mappings              │
                    │  migration_audit_log   rollback_log      │
                    └──────────────────────────────────────────┘
                                    │ Pull / Push
              ┌─────────────────────┴──────────────────────┐
              │                                            │
  ┌───────────▼──────────┐                    ┌───────────▼──────────┐
  │   Source UEM Tenant  │                    │  Dest UEM Tenant     │
  │  (snapshot read-only)│                    │  (migration writes)  │
  └──────────────────────┘                    └──────────────────────┘
```

### Module Breakdown

| Module | File | Responsibility |
|--------|------|---------------|
| **HTTP Server** | `index.js` | Express app, middleware, startup, auto-migration |
| **Environments Router** | `environmentsRouter.js` | CRUD for UEM tenant configs |
| **Jobs Router** | `jobsRouter.js` | Job lifecycle — snapshot, diff, migrate, audit |
| **Snapshot Service** | `snapshotService.js` | Pulls all entities from a UEM env into PostgreSQL |
| **Diff Service** | `diffService.js` | Field-level comparison; writes `diff_results` |
| **Migration Executor** | `migrationExecutor.js` | Applies approved diffs to destination UEM |
| **UEM Client** | `uemClient.js` | OAuth2/Basic auth, retries, rate limiting, pagination |
| **Database** | `config/database.js` | pg connection pool, `query()`, `withTransaction()` |
| **Schema** | `config/schema.js` | Consolidated idempotent schema, runs on every boot |
| **Logger** | `utils/logger.js` | Winston structured logger |

### Authentication Support

| Auth Type | How it Works |
|-----------|-------------|
| **OAuth2 (Client Credentials)** | Token fetched from `oauth_token_url`, cached with 60-second expiry buffer, auto-refreshed |
| **Basic Auth** | Base64-encoded `api_username:api_password` + `aw-tenant-code` header per request |

---

## 🗄 Database Schema

### Entity Relationship Overview

```
environments ──┬──< migration_jobs >──┬──< org_groups
               │                      ├──< profiles
               │                      ├──< applications
               │                      ├──< products
               │                      ├──< smart_groups
               │                      ├──< sensors
               │                      ├──< scripts
               │                      ├──< diff_results ──< migration_audit_log
               │                      ├──< id_mappings
               │                      └──< rollback_log
               └── (source_env_id / dest_env_id)
```

### Tables

| Table | Purpose |
|-------|---------|
| `environments` | UEM tenant configs — URL, auth type, credentials |
| `migration_jobs` | Top-level job record with status, flags, and stats |
| `org_groups` | Snapshotted Org Group tree from source & dest |
| `profiles` | MDM device/user profiles |
| `applications` | MAM internal & public applications |
| `products` | WS1 Freestyle / Legacy products |
| `smart_groups` | Criteria-based device/user groups |
| `sensors` | Custom device attribute queries (PowerShell / Bash / Python) |
| `scripts` | Hub remediation scripts with trigger/schedule support |
| `diff_results` | Per-entity field-level comparison outcome & migration decision |
| `id_mappings` | Source UEM ID → Destination UEM ID translation (post-migration) |
| `migration_audit_log` | Immutable log of every API call, action, and outcome |
| `rollback_log` | Tracks created/updated destination items for potential rollback |

### Diff Status Values

| Status | Meaning | Default Action |
|--------|---------|----------------|
| `only_in_source` | Exists in source, missing in destination | ✅ `create` |
| `modified` | Exists in both, fields differ | ✅ `update` |
| `identical` | Exists in both, no changes | ⏭ `skip` |
| `only_in_dest` | Exists in destination only | ⏭ `skip` |
| `conflict` | Reserved for manual resolution | 🔍 `manual_review` |

> Any action can be overridden via `PATCH /api/jobs/:id/diff/:diffId` before execution.

### Job Status Lifecycle

```
pending ──▶ snapshotting ──▶ diffing ──▶ ready ──▶ migrating ──▶ completed
                                                                 └──▶ completed_with_errors
   └──────────────────────────────────────────────────────────────▶ failed
```

---

## 🐳 Quick Start — Docker Compose *(Recommended)*

The fastest way to run the full stack. Brings up the API server **and** PostgreSQL with a single command — no separate database install required.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) *(Windows / macOS)*  
  or Docker Engine + Compose plugin *(Linux)*

### 1 · Configure environment

```bash
cp .env.example .env
```

Open `.env` and set your database password — the only required value:

```dotenv
DB_PASSWORD=choose_a_strong_password
```

Everything else defaults correctly for the Compose stack.

### 2 · Start the stack

```bash
docker compose up -d
```

Docker Compose will:

1. Pull **`jsrankit/wsonemigratorsrv:latest`** from Docker Hub
2. Pull **`postgres:16-alpine`**
3. Start PostgreSQL and wait for its health check to pass
4. Start the API — schema migrations run automatically on first boot
5. Serve the API at **`http://localhost:5271`**

### 3 · Verify it's running

```bash
curl http://localhost:5271/health
```
```json
{ "status": "ok", "service": "uem-migration-tool", "timestamp": "2026-03-08T..." }
```

### 4 · View logs

```bash
docker compose logs -f          # all services
docker compose logs -f api      # API server only
docker compose logs -f postgres # database only
```

### 5 · Stop the stack

```bash
docker compose down       # stops containers, database volume is preserved
docker compose down -v    # ⚠️  stops containers and DELETES database volume
```

### 6 · Update to the latest image

```bash
docker compose pull
docker compose up -d
```

### 7 · Build the image locally

```bash
docker compose up -d --build
```

Builds from the local `Dockerfile` instead of pulling from Docker Hub — useful for development.

---

## 🔧 Manual Setup *(Bare Metal)*

### Prerequisites

- Node.js 20+
- PostgreSQL 14+

### 1 · Install dependencies

```bash
npm install
```

### 2 · Create the database

```sql
CREATE DATABASE uem_migration;
```

### 3 · Configure environment

```bash
cp .env.example .env
# Fill in DB credentials and any UEM API settings
```

### 4 · Start the server

```bash
npm run dev      # development — hot reload with nodemon
npm start        # production
```

The schema is created automatically on startup. No separate migration step needed.

---

## 📡 API Reference

> Base URL: `http://localhost:5271/api`

### 🔌 Environments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/environments` | List all environments |
| `POST` | `/environments` | Create environment |
| `GET` | `/environments/:id` | Get environment details |
| `PUT` | `/environments/:id` | Update environment |
| `DELETE` | `/environments/:id` | Delete environment |
| `POST` | `/environments/:id/test` | Test UEM API connectivity |

#### Create Environment — OAuth2
```json
POST /api/environments
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

#### Create Environment — Basic Auth
```json
POST /api/environments
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

---

### 💼 Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/jobs` | List all jobs (with summary stats) |
| `POST` | `/jobs` | Create a migration job |
| `GET` | `/jobs/:id` | Get job details & progress |
| `POST` | `/jobs/:id/snapshot` | Snapshot both environments + auto-diff *(async)* |
| `GET` | `/jobs/:id/diff` | Get diff results *(filterable / paginated)* |
| `PATCH` | `/jobs/:id/diff/:diffId` | Override a migration action |
| `POST` | `/jobs/:id/migrate` | Execute the migration *(async)* |
| `GET` | `/jobs/:id/audit` | Full audit log |
| `GET` | `/jobs/:id/mappings` | Source → destination ID mappings |

#### Create Job
```json
POST /api/jobs
{
  "name": "Prod → Dev Migration — March 2026",
  "source_env_id": "uuid-of-source-environment",
  "dest_env_id": "uuid-of-destination-environment",
  "migrate_orgs": true,
  "migrate_profiles": true,
  "migrate_apps": true,
  "migrate_products": true,
  "migrate_smart_groups": false,
  "migrate_sensors": false,
  "migrate_scripts": false
}
```

#### Filter Diff Results
```
GET /api/jobs/:id/diff?entity_type=profile&diff_status=modified
GET /api/jobs/:id/diff?migration_action=create&page=0&pagesize=50
GET /api/jobs/:id/diff?entity_type=org_group
```

Supported filter params: `entity_type`, `diff_status`, `migration_action`, `page`, `pagesize`

#### Override a Diff Action
```json
PATCH /api/jobs/:id/diff/:diffId
{
  "migration_action": "skip",
  "notes": "This profile is environment-specific — do not migrate"
}
```

Valid `migration_action` values: `create` · `update` · `skip` · `manual_review`

---

## 🔗 Migration Order & Dependency Resolution

Entities are always migrated in dependency order to ensure references are valid:

```
Step 1 ── Org Groups       (root-first, ordered by depth)
             │
Step 2 ── Smart Groups     (OG must exist first)
             │
Step 3 ── Profiles         (OG must exist first)
             │
Step 4 ── Applications     (OG must exist first)
             │
Step 5 ── Products         (OG must exist first)
             │
Step 6 ── Sensors          (OG UUID required; Smart Groups may be referenced)
             │
Step 7 ── Scripts          (OG UUID required; Smart Groups may be referenced)
```

After each successful `create`, the new destination UEM ID is written to `id_mappings`. All later entities resolve their parent references through this table before making API calls.

---

## ⚙️ Configuration Reference

| Variable | Default | Required | Description |
|----------|---------|:--------:|-------------|
| `PORT` | `5271` | | HTTP port the server listens on |
| `NODE_ENV` | `development` | | `production` disables debug output |
| `LOG_LEVEL` | `info` | | `debug` · `info` · `warn` · `error` |
| `DB_HOST` | `localhost` | | PostgreSQL host (`postgres` inside Docker) |
| `DB_PORT` | `5432` | | PostgreSQL port |
| `DB_NAME` | `uem_migration` | | Database name |
| `DB_USER` | `postgres` | | Database user |
| `DB_PASSWORD` | | ✅ | Database password |
| `DB_POOL_MAX` | `20` | | Max concurrent DB connections |
| `UEM_API_TIMEOUT` | `30000` | | Per-request timeout in milliseconds |
| `UEM_API_MAX_RETRIES` | `3` | | Retry count on `429` / `5xx` |
| `UEM_API_RATE_LIMIT_DELAY` | `200` | | Delay between API calls in milliseconds |
| `MIGRATION_BATCH_SIZE` | `50` | | Entities per migration batch |
| `MIGRATION_MAX_CONCURRENT` | `5` | | Parallel migration workers (p-limit) |

---

## 🔄 CI/CD & Docker Hub

Every commit to `main` that changes `server/**` triggers a GitHub Actions workflow that:

1. Checks out the repository
2. Sets up Docker Buildx with layer caching
3. Logs into Docker Hub using repository secrets
4. Builds the image from `server/Dockerfile`
5. Pushes two tags:
   - `jsrankit/wsonemigratorsrv:latest`
   - `jsrankit/wsonemigratorsrv:sha-<short-commit>`

**Required GitHub repository secrets:**

| Secret | Value |
|--------|-------|
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token *(not your password)* |

---

## 🛡 Production Hardening

| Topic | Recommendation |
|-------|---------------|
| **Credential encryption** | Store `client_secret` / `api_password` with AES-256 at rest (e.g. `node-forge` or AWS Secrets Manager) |
| **Authentication** | Add JWT middleware to protect all `/api/*` routes |
| **TLS** | Place the server behind a load balancer / reverse proxy that terminates HTTPS — the app listens on plain HTTP port `5271` |
| **Large environments** | Use Bull/BullMQ + Redis to queue snapshot & migration jobs for tenants with 1,000+ entities |
| **Rollback** | Implement a `POST /api/jobs/:id/rollback` endpoint using the `rollback_log` table to undo a migration |
| **Retry failed items** | Add `POST /api/jobs/:id/retry-failed` to re-queue `migration_status = 'failed'` diff items |
| **Rate limiting** | `UEM_API_RATE_LIMIT_DELAY` defaults to 200 ms — increase if the source/dest tenant enforces stricter API limits |
| **DB backups** | Snapshot the `pgdata` Docker volume or use a managed PostgreSQL service (RDS, Cloud SQL, Azure DB) |

---

<div align="center">

Built with ❤️ for Workspace ONE UEM administrators

</div>
