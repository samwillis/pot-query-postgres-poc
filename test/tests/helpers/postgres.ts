import { Client } from 'pg';

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  connectionString: string;
}

/**
 * Get the local Postgres connection configuration.
 * 
 * For Testcontainers setup (when Docker is available), this can be replaced
 * with container-based configuration.
 * 
 * Environment variables:
 * - PGHOST: Postgres host (default: localhost)
 * - PGPORT: Postgres port (default: 5432)
 * - PGDATABASE: Database name (default: testdb)
 * - PGUSER: Username (default: postgres)
 * - PGPASSWORD: Password (default: empty)
 */
export function getLocalPostgresConfig(): PostgresConfig {
  const host = process.env.PGHOST || 'localhost';
  const port = parseInt(process.env.PGPORT || '5432', 10);
  const database = process.env.PGDATABASE || 'testdb';
  const username = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD || '';
  
  return {
    host,
    port,
    database,
    username,
    password,
    connectionString: `postgresql://${username}${password ? ':' + password : ''}@${host}:${port}/${database}`,
  };
}

/**
 * Create a new Postgres client
 */
export function createClient(config: PostgresConfig): Client {
  return new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
  });
}

/**
 * Initialize the database with extension and test table
 */
export async function initializeDatabase(client: Client): Promise<void> {
  // Create the extension
  await client.query('CREATE EXTENSION IF NOT EXISTS electric_poc');
  
  // Drop and recreate the test table for fresh state
  await client.query('DROP TABLE IF EXISTS acl CASCADE');
  
  // Create the test table
  await client.query(`
    CREATE TABLE acl (
      user_id text NOT NULL,
      doc_id text NOT NULL,
      allowed boolean NOT NULL,
      PRIMARY KEY (user_id, doc_id)
    )
  `);
  
  // Disable autovacuum for the table to prevent old versions from being cleaned up
  await client.query(`
    ALTER TABLE acl SET (autovacuum_enabled = false)
  `);
  
  // Insert initial data
  await client.query(`
    INSERT INTO acl (user_id, doc_id, allowed)
    VALUES ('u1', 'd1', true)
    ON CONFLICT (user_id, doc_id) DO UPDATE SET allowed = EXCLUDED.allowed
  `);
}

/**
 * Create publication and replication slot
 */
export async function setupReplication(client: Client): Promise<void> {
  // Drop existing publication if any
  await client.query(`DROP PUBLICATION IF EXISTS pub`);
  
  // Create publication for the acl table
  await client.query(`CREATE PUBLICATION pub FOR TABLE acl`);
  
  // Drop existing slot if any
  try {
    const result = await client.query(`
      SELECT pg_drop_replication_slot('slot1')
      FROM pg_replication_slots 
      WHERE slot_name = 'slot1'
    `);
  } catch {
    // Ignore errors if slot doesn't exist
  }
  
  // Create logical replication slot
  await client.query(`
    SELECT pg_create_logical_replication_slot('slot1', 'pgoutput')
  `);
}

/**
 * Clean up replication resources
 */
export async function cleanupReplication(client: Client): Promise<void> {
  try {
    await client.query(`DROP PUBLICATION IF EXISTS pub`);
  } catch {
    // Ignore
  }
  try {
    await client.query(`
      SELECT pg_drop_replication_slot('slot1')
      FROM pg_replication_slots
      WHERE slot_name = 'slot1'
    `);
  } catch {
    // Ignore
  }
}

/*
 * Optional: Testcontainers-based setup
 * 
 * When Docker is available and properly configured (not in nested overlay environments),
 * you can use this function to start a Postgres container:
 * 
 * import { GenericContainer, Wait } from 'testcontainers';
 * 
 * export async function startPostgresContainer(): Promise<PostgresConfig> {
 *   const imageName = 'electric-postgres:test';
 *   
 *   // Build image first (see docker/Dockerfile)
 *   // docker build -f docker/Dockerfile -t electric-postgres:test .
 *   
 *   const container = await new GenericContainer(imageName)
 *     .withExposedPorts(5432)
 *     .withEnvironment({
 *       POSTGRES_USER: 'postgres',
 *       POSTGRES_PASSWORD: 'postgres',
 *       POSTGRES_DB: 'testdb',
 *     })
 *     .withCommand([
 *       'postgres',
 *       '-c', 'wal_level=logical',
 *       '-c', 'max_replication_slots=10',
 *       '-c', 'max_wal_senders=10',
 *     ])
 *     .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
 *     .start();
 *   
 *   return {
 *     host: container.getHost(),
 *     port: container.getMappedPort(5432),
 *     database: 'testdb',
 *     username: 'postgres',
 *     password: 'postgres',
 *     connectionString: `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/testdb`,
 *   };
 * }
 */
