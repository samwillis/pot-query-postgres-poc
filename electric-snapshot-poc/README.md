# Electric Snapshot POC

A proof-of-concept demonstrating "point-in-time" reads in Postgres using synthetic MVCC snapshots derived from logical replication (WAL tailing).

## Overview

This POC implements a Postgres C extension that allows executing read-only queries under a specific MVCC snapshot, enabling you to query the database as-of approximately a specific commit, even after later commits have occurred.

This is useful for ElectricSQL-style sync/auth validation: when observing commits in a logical replication stream, you can query Postgres as-of that commit for validation purposes.

## Components

### C Extension (`ext/electric_poc`)

Provides the SQL function:

```sql
electric_exec_as_of(snapshot pg_snapshot, sql text, args jsonb DEFAULT '[]') RETURNS jsonb
```

- Executes a read-only SELECT under the supplied MVCC snapshot
- Returns results as JSON array
- Only allows SELECT queries (validates query prefix)
- Supports parameterized queries with `$1`, `$2`, etc. placeholders
- Args are passed as a JSON array of strings

**Example usage:**

```sql
-- Get a point-in-time read
SELECT electric_exec_as_of(
    '750:751:'::pg_snapshot,
    'SELECT * FROM users WHERE id = $1',
    '["user123"]'::jsonb
);
-- Returns: [{"id": "user123", "name": "Alice", ...}]
```

### Docker Image (`docker/Dockerfile`)

Builds a Postgres 16 image with the extension pre-installed. Useful for:
- CI/CD pipelines
- Testcontainers-based testing
- Production deployments

```bash
# Build the image
cd electric-snapshot-poc
docker build -f docker/Dockerfile -t electric-postgres:test .

# Run with logical replication enabled
docker run -d \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  electric-postgres:test \
  postgres -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10
```

### Integration Tests (`test/`)

TypeScript/Vitest tests that prove the point-in-time read functionality:

1. **Smoke tests**: Basic function execution with current snapshots
2. **Time travel test**: Proves that old snapshots return old values even after newer commits
3. **Guardrail tests**: Validates that non-SELECT queries are rejected
4. **Stress test**: Multiple sequential commits with snapshot verification

## Prerequisites

### For Local Development

- PostgreSQL 16 with development headers
- Build tools (gcc, make)
- Node.js 18+
- npm or pnpm

### For Docker-based Setup

- Docker
- Node.js 18+
- npm or pnpm

## Quick Start

### Option 1: Local Postgres Setup

```bash
# Install Postgres and development headers (Ubuntu/Debian)
sudo apt-get install postgresql-16 postgresql-server-dev-16 build-essential

# Build and install the extension
cd ext/electric_poc
make && sudo make install

# Configure Postgres for logical replication
# Add to postgresql.conf:
#   wal_level = logical
#   max_replication_slots = 10
#   max_wal_senders = 10

# Restart Postgres and create test database
sudo systemctl restart postgresql
sudo -u postgres createdb testdb

# Run tests
cd test
npm install
npm test
```

### Option 2: Docker Setup

```bash
# Build the Docker image
docker build -f docker/Dockerfile -t electric-postgres:test .

# Run the container
docker run -d --name pg-test \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=testdb \
  -p 5432:5432 \
  electric-postgres:test \
  postgres -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10

# Wait for startup
sleep 5

# Run tests
cd test
npm install
PGPASSWORD=postgres npm test
```

## How It Works

### Snapshot Computation from WAL

When tailing the logical replication stream:

1. **On BEGIN**: Add transaction ID (xid) to in-flight set
2. **On COMMIT**: Compute snapshot representing "just after this commit"
   - `xmax` = max(committed_xid, remaining_in_flight_xids) + 1
   - `xmin` = min(remaining_in_flight) or xmax if none
   - `xip` = sorted list of remaining in-flight xids in range [xmin, xmax)
   - Format: `xmin:xmax:xip1,xip2,...`
3. Remove committed xid from in-flight set

### C Extension Implementation

The extension:
1. Parses the `pg_snapshot` string into xmin, xmax, and xip list
2. Creates a `SnapshotData` structure with `SNAPSHOT_MVCC` type
3. Pushes the custom snapshot as active using `PushActiveSnapshot()`
4. Executes the query via SPI, wrapped in `json_agg(row_to_json(q))`
5. Pops the snapshot and returns the JSON result

### Snapshot String Format

PostgreSQL's `pg_snapshot` type uses the format: `xmin:xmax:xip1,xip2,...`

- `xmin`: Earliest transaction ID still in-progress at snapshot time
- `xmax`: First transaction ID not yet assigned at snapshot time
- `xip`: List of in-progress transaction IDs at snapshot time

## API Reference

### `electric_exec_as_of(snapshot, sql, args)`

Execute a read-only query under a specific MVCC snapshot.

**Parameters:**
- `snapshot` (pg_snapshot): The MVCC snapshot to use
- `sql` (text): The SELECT query to execute
- `args` (jsonb, optional): JSON array of parameter values (default: `'[]'`)

**Returns:** `jsonb` - Array of result rows as JSON objects

**Errors:**
- Non-SELECT queries are rejected with an error
- Malformed snapshots cause parsing errors
- SPI execution errors are propagated

## Limitations

This is a proof-of-concept with known limitations:

- **No subxid support**: Subtransactions are not tracked
- **Approximate snapshots**: Based on BEGIN/COMMIT observation timing
- **Vacuum sensitivity**: Requires autovacuum to be disabled/delayed to preserve old tuple versions
- **Read-only**: Only SELECT queries are allowed
- **Text parameters**: All parameters are bound as TEXT type
- **Single-line queries**: No multi-statement support

## Project Structure

```
/electric-snapshot-poc
  /ext/electric_poc
    Makefile              # PGXS build file
    electric_poc.control  # Extension control file
    electric_poc--0.0.1.sql  # SQL function definitions
    electric_poc.c        # C implementation
  /docker
    Dockerfile            # Postgres + extension image
  /test
    package.json          # Node dependencies
    tsconfig.json         # TypeScript config
    vitest.config.ts      # Vitest config
    /tests
      asof.spec.ts        # Integration tests
      /helpers
        postgres.ts       # Database connection helpers
        replication.ts    # Logical replication helpers
  README.md
```

## Test Output Example

```
 ✓ tests/asof.spec.ts (10 tests) 4508ms
   ✓ Test 1 - Smoke test function
     ✓ should execute a simple query with current snapshot
     ✓ should execute a query with parameters
     ✓ should return empty array for no matching rows
   ✓ Test 2 - As-of hides later commit
     ✓ should return old value when querying with old snapshot
   ✓ Test 3 - Guardrails
     ✓ should reject UPDATE queries
     ✓ should reject INSERT queries
     ✓ should reject DELETE queries
     ✓ should reject malformed snapshot strings
     ✓ should reject snapshot with missing parts
   ✓ Test 4 - Stress test with multiple commits
     ✓ should correctly read historical values across multiple commits

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

## License

MIT
