import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  getLocalPostgresConfig,
  createClient,
  initializeDatabase,
  setupReplication,
  cleanupReplication,
  PostgresConfig,
} from './helpers/postgres.js';
import {
  startReplicationStream,
  stopReplicationStream,
  waitForNthCommit,
  ReplicationState,
} from './helpers/replication.js';

describe('electric_exec_as_of', () => {
  let pgConfig: PostgresConfig;
  let client: Client;

  beforeAll(async () => {
    // Get local Postgres configuration
    pgConfig = getLocalPostgresConfig();
    
    // Create client and connect
    client = createClient(pgConfig);
    await client.connect();
    
    // Initialize database with extension and test table
    await initializeDatabase(client);
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  describe('Test 1 - Smoke test function', () => {
    it('should execute a simple query with current snapshot', async () => {
      // Get current snapshot - need to add 1 to xmax to see committed data
      const snapshotResult = await client.query('SELECT pg_current_snapshot()::text as snapshot');
      const rawSnapshot = snapshotResult.rows[0].snapshot;
      
      // Parse and adjust the snapshot to see the committed data
      const parts = rawSnapshot.split(':');
      const xmin = parseInt(parts[0]);
      const xmax = parseInt(parts[1]) + 1; // Advance xmax to see committed data
      const adjustedSnapshot = `${xmin}:${xmax}:`;
      
      // Execute a simple query using electric_exec_as_of
      const result = await client.query(
        `SELECT electric_exec_as_of($1::pg_snapshot, 'SELECT user_id, doc_id, allowed FROM acl', '[]'::jsonb)`,
        [adjustedSnapshot]
      );
      
      const jsonResult = result.rows[0].electric_exec_as_of;
      
      // Should return an array with one row
      expect(Array.isArray(jsonResult)).toBe(true);
      expect(jsonResult.length).toBe(1);
      expect(jsonResult[0]).toEqual({
        user_id: 'u1',
        doc_id: 'd1',
        allowed: true,
      });
    });

    it('should execute a query with parameters', async () => {
      const snapshotResult = await client.query('SELECT pg_current_snapshot()::text as snapshot');
      const rawSnapshot = snapshotResult.rows[0].snapshot;
      const parts = rawSnapshot.split(':');
      const xmin = parseInt(parts[0]);
      const xmax = parseInt(parts[1]) + 1;
      const adjustedSnapshot = `${xmin}:${xmax}:`;
      
      const result = await client.query(
        `SELECT electric_exec_as_of($1::pg_snapshot, 'SELECT allowed FROM acl WHERE user_id = $1 AND doc_id = $2', '["u1", "d1"]'::jsonb)`,
        [adjustedSnapshot]
      );
      
      const jsonResult = result.rows[0].electric_exec_as_of;
      
      expect(jsonResult.length).toBe(1);
      expect(jsonResult[0].allowed).toBe(true);
    });

    it('should return empty array for no matching rows', async () => {
      const snapshotResult = await client.query('SELECT pg_current_snapshot()::text as snapshot');
      const rawSnapshot = snapshotResult.rows[0].snapshot;
      const parts = rawSnapshot.split(':');
      const xmin = parseInt(parts[0]);
      const xmax = parseInt(parts[1]) + 1;
      const adjustedSnapshot = `${xmin}:${xmax}:`;
      
      const result = await client.query(
        `SELECT electric_exec_as_of($1::pg_snapshot, 'SELECT * FROM acl WHERE user_id = $1', '["nonexistent"]'::jsonb)`,
        [adjustedSnapshot]
      );
      
      const jsonResult = result.rows[0].electric_exec_as_of;
      
      expect(jsonResult).toEqual([]);
    });
  });

  describe('Test 2 - As-of hides later commit', () => {
    let replicationState: ReplicationState;

    beforeAll(async () => {
      // Setup replication
      await setupReplication(client);
      
      // Start replication stream
      replicationState = await startReplicationStream(pgConfig.connectionString);
    }, 30000);

    afterAll(async () => {
      if (replicationState) {
        await stopReplicationStream(replicationState);
      }
      await cleanupReplication(client);
    });

    it('should return old value when querying with old snapshot', async () => {
      // Clear any existing commits from previous tests
      const initialCommitCount = replicationState.commitSnapshots.length;
      
      // Tx1: Set allowed to false
      await client.query('BEGIN');
      await client.query(`UPDATE acl SET allowed = false WHERE user_id = 'u1' AND doc_id = 'd1'`);
      await client.query('COMMIT');
      
      // Wait for Tx1 commit in replication stream
      const commit1 = await waitForNthCommit(replicationState, initialCommitCount + 1, 15000);
      const snapshot1 = commit1.snapshotString;
      
      console.log('Commit 1 XID:', commit1.xid.toString());
      console.log('Snapshot after commit 1:', snapshot1);
      
      // Verify the value is now false
      const currentValue1 = await client.query(
        `SELECT allowed FROM acl WHERE user_id = 'u1' AND doc_id = 'd1'`
      );
      expect(currentValue1.rows[0].allowed).toBe(false);
      
      // Tx2: Set allowed back to true
      await client.query('BEGIN');
      await client.query(`UPDATE acl SET allowed = true WHERE user_id = 'u1' AND doc_id = 'd1'`);
      await client.query('COMMIT');
      
      // Wait for Tx2 commit
      const commit2 = await waitForNthCommit(replicationState, initialCommitCount + 2, 15000);
      
      console.log('Commit 2 XID:', commit2.xid.toString());
      console.log('Snapshot after commit 2:', commit2.snapshotString);
      
      // Verify current value is now true
      const currentValue2 = await client.query(
        `SELECT allowed FROM acl WHERE user_id = 'u1' AND doc_id = 'd1'`
      );
      expect(currentValue2.rows[0].allowed).toBe(true);
      
      // NOW the key test: query using snapshot1 should return false (the Tx1 state)
      const asOfResult = await client.query(
        `SELECT electric_exec_as_of(
          $1::pg_snapshot,
          'SELECT allowed FROM acl WHERE user_id = $1 AND doc_id = $2',
          '["u1", "d1"]'::jsonb
        )`,
        [snapshot1]
      );
      
      const jsonResult = asOfResult.rows[0].electric_exec_as_of;
      
      console.log('As-of query result:', jsonResult);
      
      // This is the key assertion: the as-of query should see the old value
      expect(jsonResult.length).toBe(1);
      expect(jsonResult[0].allowed).toBe(false);
    }, 60000);
  });

  describe('Test 3 - Guardrails', () => {
    it('should reject UPDATE queries', async () => {
      const snapshotResult = await client.query('SELECT pg_current_snapshot()::text as snapshot');
      const currentSnapshot = snapshotResult.rows[0].snapshot;
      
      await expect(
        client.query(
          `SELECT electric_exec_as_of($1::pg_snapshot, 'UPDATE acl SET allowed = false', '[]'::jsonb)`,
          [currentSnapshot]
        )
      ).rejects.toThrow(/only SELECT queries are allowed/i);
    });

    it('should reject INSERT queries', async () => {
      const snapshotResult = await client.query('SELECT pg_current_snapshot()::text as snapshot');
      const currentSnapshot = snapshotResult.rows[0].snapshot;
      
      await expect(
        client.query(
          `SELECT electric_exec_as_of($1::pg_snapshot, 'INSERT INTO acl VALUES (''u2'', ''d2'', true)', '[]'::jsonb)`,
          [currentSnapshot]
        )
      ).rejects.toThrow(/only SELECT queries are allowed/i);
    });

    it('should reject DELETE queries', async () => {
      const snapshotResult = await client.query('SELECT pg_current_snapshot()::text as snapshot');
      const currentSnapshot = snapshotResult.rows[0].snapshot;
      
      await expect(
        client.query(
          `SELECT electric_exec_as_of($1::pg_snapshot, 'DELETE FROM acl', '[]'::jsonb)`,
          [currentSnapshot]
        )
      ).rejects.toThrow(/only SELECT queries are allowed/i);
    });

    it('should reject malformed snapshot strings', async () => {
      await expect(
        client.query(
          `SELECT electric_exec_as_of('invalid'::pg_snapshot, 'SELECT 1', '[]'::jsonb)`
        )
      ).rejects.toThrow();
    });

    it('should reject snapshot with missing parts', async () => {
      // pg_snapshot type itself validates format, so Postgres will reject it
      await expect(
        client.query(
          `SELECT electric_exec_as_of('123'::pg_snapshot, 'SELECT 1', '[]'::jsonb)`
        )
      ).rejects.toThrow();
    });
  });

  describe('Test 4 - Stress test with multiple commits', () => {
    let replicationState: ReplicationState;

    beforeAll(async () => {
      // Setup fresh replication
      await setupReplication(client);
      
      // Start replication stream
      replicationState = await startReplicationStream(pgConfig.connectionString);
    }, 30000);

    afterAll(async () => {
      if (replicationState) {
        await stopReplicationStream(replicationState);
      }
      await cleanupReplication(client);
    });

    it('should correctly read historical values across multiple commits', async () => {
      const initialCommitCount = replicationState.commitSnapshots.length;
      const snapshots: Array<{ value: number; snapshot: string }> = [];
      
      // Create a counter table for this test
      await client.query(`
        DROP TABLE IF EXISTS counter CASCADE
      `);
      await client.query(`
        CREATE TABLE counter (
          id int PRIMARY KEY,
          value int NOT NULL
        )
      `);
      await client.query(`
        ALTER TABLE counter SET (autovacuum_enabled = false)
      `);
      
      // Add to publication
      try {
        await client.query(`ALTER PUBLICATION pub ADD TABLE counter`);
      } catch {
        // Table might already be in publication
      }
      
      // Insert initial value
      await client.query('BEGIN');
      await client.query(`INSERT INTO counter VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET value = 0`);
      await client.query('COMMIT');
      
      // Wait for initial commit
      await waitForNthCommit(replicationState, initialCommitCount + 1, 15000);
      
      // Now make 5 more commits, recording snapshot after each
      for (let i = 1; i <= 5; i++) {
        await client.query('BEGIN');
        await client.query(`UPDATE counter SET value = $1 WHERE id = 1`, [i]);
        await client.query('COMMIT');
        
        const commit = await waitForNthCommit(replicationState, initialCommitCount + 1 + i, 15000);
        snapshots.push({
          value: i,
          snapshot: commit.snapshotString,
        });
        
        console.log(`Commit ${i}: value=${i}, snapshot=${commit.snapshotString}`);
      }
      
      // Verify current value is 5
      const currentResult = await client.query(`SELECT value FROM counter WHERE id = 1`);
      expect(currentResult.rows[0].value).toBe(5);
      
      // Now query with each historical snapshot and verify we get the expected value
      for (const { value, snapshot } of snapshots) {
        const result = await client.query(
          `SELECT electric_exec_as_of(
            $1::pg_snapshot,
            'SELECT value FROM counter WHERE id = 1',
            '[]'::jsonb
          )`,
          [snapshot]
        );
        
        const jsonResult = result.rows[0].electric_exec_as_of;
        console.log(`Snapshot ${snapshot} -> expected ${value}, got ${jsonResult[0]?.value}`);
        
        expect(jsonResult.length).toBe(1);
        expect(jsonResult[0].value).toBe(value);
      }
    }, 120000);
  });
});
