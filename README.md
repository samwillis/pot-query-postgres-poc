# Electric Snapshot POC

A proof-of-concept demonstrating "point-in-time" reads in PostgreSQL using synthetic MVCC snapshots derived from logical replication (WAL tailing). This enables querying the database as-of a specific commit, even after subsequent commits have modified the data.

## What This POC Proves

### Core Hypothesis Validated ✅

**We can execute read-only queries against historical database states by:**
1. Observing transaction commits via logical replication (WAL tailing)
2. Computing MVCC snapshot identifiers at each commit point
3. Using those snapshots to query PostgreSQL and retrieve the exact data that existed at that point in time

### Evidence: Physical Tuple Examination

The `vacuum-proof.spec.ts` test provides **definitive proof** by examining PostgreSQL's physical heap storage:

```
Heap page contains 11 tuple versions
Old (dead) tuple versions in heap: 10
```

Using the `pageinspect` extension, we can see the actual heap page contents:

```
 lp | t_ctid | t_xmin | t_xmax | data (decoded)
----+--------+--------+--------+------------------
  1 | (0,2)  |    852 |    853 | "initial data"
  2 | (0,3)  |    853 |    854 | "data version 1"
  3 | (0,4)  |    854 |    855 | "data version 2"
  ...
 11 | (0,11) |    862 |      0 | "data version 10"
```

This proves:
- **11 physical tuple versions** exist in the heap for the same logical row
- **10 are "dead" versions** (superseded by updates, with `t_xmax > 0`)
- Each version contains the **actual historical data**
- Our queries read these **real old tuples**, not just transaction ID tricks

### Key Test: "As-Of Hides Later Commit"

```typescript
// 1. Tx1: Set allowed=false, capture snapshot1
await client.query(`UPDATE acl SET allowed = false WHERE ...`);
// snapshot1 = "762:762:"

// 2. Tx2: Set allowed=true  
await client.query(`UPDATE acl SET allowed = true WHERE ...`);

// 3. Current query returns TRUE (the new value)
const current = await client.query(`SELECT allowed FROM acl`);
expect(current.rows[0].allowed).toBe(true);

// 4. As-of query with snapshot1 returns FALSE (the old value!)
const asOf = await client.query(`
  SELECT electric_exec_as_of($1::pg_snapshot, 'SELECT allowed FROM acl', '[]')
`, [snapshot1]);
expect(asOf.rows[0].electric_exec_as_of[0].allowed).toBe(false);
```

## How It Works

### 1. Logical Replication Stream (WAL Tailing)

We use `pg-logical-replication` to consume the PostgreSQL logical replication stream:

```typescript
service.on('data', (lsn, message) => {
  if (message.tag === 'begin') {
    // Transaction started - track the xid
    inFlightXids.add(BigInt(message.xid));
  } else if (message.tag === 'commit') {
    // Transaction committed - compute snapshot
    const snapshot = computeSnapshotAfterCommit(xid, inFlightXids);
    // This snapshot represents "just after this commit"
  }
});
```

### 2. Snapshot Computation

When a transaction commits, we compute a snapshot string representing the database state immediately after:

```typescript
function computeSnapshotAfterCommit(committedXid, inFlightXids) {
  const inFlightAfter = new Set(inFlightXids);
  inFlightAfter.delete(committedXid);
  
  // xmax = one past the highest xid we've seen
  const xmax = max([committedXid, ...inFlightAfter]) + 1n;
  
  // xmin = lowest still-in-flight xid, or xmax if none
  const xmin = inFlightAfter.size > 0 
    ? min([...inFlightAfter]) 
    : xmax;
  
  // xip = in-flight transactions in range [xmin, xmax)
  const xip = [...inFlightAfter]
    .filter(x => x >= xmin && x < xmax)
    .sort();
  
  return `${xmin}:${xmax}:${xip.join(',')}`;
}
```

**Snapshot format: `xmin:xmax:xip1,xip2,...`**
- `xmin`: Oldest transaction still in-progress (or xmax if none)
- `xmax`: First transaction ID not yet assigned
- `xip`: List of in-progress transaction IDs

### 3. PostgreSQL C Extension

The `electric_exec_as_of` function:

```sql
SELECT electric_exec_as_of(
  '762:763:'::pg_snapshot,           -- The historical snapshot
  'SELECT * FROM users WHERE id=$1', -- Query to execute
  '["user123"]'::jsonb               -- Parameters
);
-- Returns: [{"id": "user123", "name": "Alice", ...}]
```

**Implementation:**

1. **Parse the snapshot string** into xmin, xmax, and xip array
2. **Create a custom SnapshotData** structure based on the current transaction's snapshot
3. **Override MVCC fields** (xmin, xmax, xcnt, xip) with our historical values
4. **Push the custom snapshot** using `PushActiveSnapshot()`
5. **Execute the query via SPI** with the snapshot active
6. **Return results as JSON**

```c
// Create custom snapshot from parsed values
snap = (Snapshot) MemoryContextAllocZero(TopTransactionContext, size);
memcpy(snap, base, sizeof(SnapshotData));

snap->xmin = xmin;  // Our historical xmin
snap->xmax = xmax;  // Our historical xmax
snap->xip = xip;    // Our in-flight xid list
snap->xcnt = xcnt;

// Execute with this snapshot
PushActiveSnapshot(snap);
ret = SPI_execute(wrapped_sql, true, 0);
PopActiveSnapshot();
```

### 4. MVCC Visibility Rules

PostgreSQL's MVCC determines tuple visibility using:

- **xmin**: Transaction that created this tuple version
- **xmax**: Transaction that deleted/updated this tuple (0 if still current)

A tuple is visible to snapshot S if:
- `tuple.xmin < S.xmax` AND `tuple.xmin` is committed AND `tuple.xmin` not in `S.xip`
- AND (`tuple.xmax == 0` OR `tuple.xmax >= S.xmax` OR `tuple.xmax` in `S.xip` OR `tuple.xmax` aborted)

By providing a historical snapshot, we see **exactly the tuples that were visible at that point in time**.

## Use Case: ElectricSQL Sync/Auth Validation

This POC demonstrates the foundation for ElectricSQL-style sync validation:

1. **Client syncs data** from a specific point in time
2. **Server observes commits** via logical replication
3. **Auth rules need validation** against the data state the client saw
4. **Use `electric_exec_as_of`** to query with the client's snapshot
5. **Validate permissions** against historical data, not current data

Example: A user had read access to document X at sync time T1. By T2, their access was revoked. When validating operations from the T1 sync, we query with snapshot T1 to correctly see they DID have access.

## Data Retention: The VACUUM Problem

### Why Old Tuples Might Disappear

PostgreSQL's VACUUM removes "dead" tuple versions that are no longer visible to any active snapshot. Without protection, our historical queries would fail.

### Solution: Replication Slot Retention

Logical replication slots track a `restart_lsn`. PostgreSQL will NOT vacuum tuples that might be needed by any slot:

```sql
-- Create a slot
SELECT pg_create_logical_replication_slot('my_slot', 'pgoutput');

-- Check the slot's restart_lsn
SELECT slot_name, restart_lsn FROM pg_replication_slots;
```

**By not acknowledging WAL consumption**, the slot's `restart_lsn` stays old, preventing VACUUM from removing tuples needed for historical snapshots.

### Current POC Approach

The tests disable autovacuum:
```sql
ALTER TABLE acl SET (autovacuum_enabled = false);
```

In production, you would:
1. Keep replication slots for each "active" historical point
2. Acknowledge WAL only up to the oldest needed snapshot
3. Clean up slots when snapshots are no longer needed

## Project Structure

```
/electric-snapshot-poc
├── ext/electric_poc/           # PostgreSQL C extension
│   ├── Makefile                # PGXS build file
│   ├── electric_poc.control    # Extension metadata
│   ├── electric_poc--0.0.1.sql # SQL function definition
│   └── electric_poc.c          # C implementation (~300 lines)
├── docker/
│   └── Dockerfile              # Postgres 16 + extension image
├── test/
│   ├── package.json            # Node.js dependencies
│   ├── vitest.config.ts        # Test configuration
│   └── tests/
│       ├── asof.spec.ts        # Main integration tests (10 tests)
│       ├── vacuum-proof.spec.ts # Heap examination tests (2 tests)
│       └── helpers/
│           ├── postgres.ts     # Database connection helpers
│           └── replication.ts  # WAL tailing + snapshot computation
├── .gitignore
└── README.md
```

## Running the Tests

### Prerequisites

- PostgreSQL 16 with development headers
- Node.js 18+
- Build tools (gcc, make)

### Setup

```bash
# Install Postgres (Ubuntu/Debian)
sudo apt-get install postgresql-16 postgresql-server-dev-16 build-essential

# Build and install the extension
cd ext/electric_poc
make && sudo make install

# Configure Postgres for logical replication
# Add to postgresql.conf:
#   wal_level = logical
#   max_replication_slots = 10
#   max_wal_senders = 10

# Restart Postgres
sudo systemctl restart postgresql

# Create test database
sudo -u postgres createdb testdb

# Install test dependencies and run
cd test
npm install
npm test
```

### Expected Output

```
 ✓ tests/asof.spec.ts (10 tests) 4492ms
   ✓ Test 1 - Smoke test function (3 tests)
   ✓ Test 2 - As-of hides later commit (1 test)
   ✓ Test 3 - Guardrails (5 tests)
   ✓ Test 4 - Stress test (1 test)

 ✓ tests/vacuum-proof.spec.ts (2 tests) 2613ms
   ✓ should read old tuple versions after multiple updates
   ✓ should verify multiple tuple versions exist in heap

 Test Files  2 passed (2)
      Tests  12 passed (12)
```

## API Reference

### `electric_exec_as_of(snapshot, sql, args)`

Execute a read-only query under a historical MVCC snapshot.

```sql
SELECT electric_exec_as_of(
  snapshot pg_snapshot,  -- Historical snapshot (e.g., '750:751:')
  sql text,              -- SELECT query with $1, $2 placeholders
  args jsonb             -- Parameter array: '["value1", "value2"]'
) RETURNS jsonb;         -- Array of result rows as JSON objects
```

**Example:**

```sql
SELECT electric_exec_as_of(
  '750:751:'::pg_snapshot,
  'SELECT * FROM users WHERE id = $1 AND active = $2',
  '["user123", "true"]'::jsonb
);
-- Returns: [{"id": "user123", "name": "Alice", "active": true}]
```

**Errors:**
- Non-SELECT queries are rejected
- Malformed snapshot strings cause errors
- Only text parameters are supported (bound as `TEXTOID`)

### `SET LOCAL electric.snapshot = '<pg_snapshot text>'` (transaction-scoped mode)

Install a **synthetic MVCC snapshot for the rest of the current transaction**, so you can run **normal SQL** (no wrapper) under that point-in-time view.

**Usage:**

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL electric.snapshot = 'xmin:xmax:xip1,xip2,...'; -- xip list may be empty
SELECT ...;  -- runs under the synthetic snapshot
COMMIT;
```

**Important guardrails (enforced by the extension):**

- **Must be inside an explicit transaction block** (`BEGIN ...`, not autocommit).
- **Isolation level must be** `REPEATABLE READ` **or** `SERIALIZABLE` (i.e. uses a transaction snapshot).
- **Must be set before the first query** in the transaction (before PostgreSQL fixes the transaction snapshot).
- **Not supported in subtransactions** (e.g. after `SAVEPOINT`) in this POC.
- Set `''` (empty string) to clear: `SET LOCAL electric.snapshot = ''`.

**Notes:**

- Snapshot format is `pg_snapshot`-style text: `xmin:xmax:xip_list`. Subxids are not tracked in this POC.
- This implementation touches PostgreSQL snapshot internals and is **version-sensitive**; it’s intended for a POC.

## Limitations

This is a proof-of-concept with known limitations:

| Limitation | Description | Production Consideration |
|------------|-------------|-------------------------|
| No subtransaction support | `subxip` is always empty | May miss some edge cases |
| Approximate snapshots | Based on BEGIN/COMMIT timing | Generally safe, may be slightly conservative |
| Text-only parameters | All args bound as TEXT | Add type inference for production |
| No VACUUM handling | Relies on disabled autovacuum | Use replication slot retention |
| Single-threaded WAL tailing | One stream per test | Scale with multiple consumers |

## Key Insights

1. **PostgreSQL MVCC stores multiple tuple versions** - This is the foundation that makes point-in-time queries possible.

2. **Snapshots are just metadata** - A snapshot is just xmin/xmax/xip values that determine visibility rules.

3. **We can construct synthetic snapshots** - By observing transaction commits via WAL, we can build valid snapshots.

4. **Custom snapshots work with SPI** - The `PushActiveSnapshot` API allows executing queries under any valid snapshot.

5. **Data retention is separate from visibility** - Snapshots control what's *visible*, but we must also ensure old tuples *exist* (via slot retention or disabled vacuum).

## References

- [PostgreSQL MVCC Documentation](https://www.postgresql.org/docs/current/mvcc.html)
- [pg_snapshot Type](https://www.postgresql.org/docs/current/datatype-pg-snapshot.html)
- [Logical Replication Protocol](https://www.postgresql.org/docs/current/protocol-logical-replication.html)
- [SPI (Server Programming Interface)](https://www.postgresql.org/docs/current/spi.html)
- [pageinspect Extension](https://www.postgresql.org/docs/current/pageinspect.html)

## License

MIT
