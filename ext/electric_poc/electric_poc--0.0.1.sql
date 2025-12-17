-- electric_poc extension SQL definitions

-- Function to execute a read-only query as-of a specific MVCC snapshot
CREATE OR REPLACE FUNCTION electric_exec_as_of(
    snapshot pg_snapshot,
    sql text,
    args jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
AS 'MODULE_PATHNAME', 'electric_exec_as_of'
LANGUAGE C STRICT VOLATILE;

COMMENT ON FUNCTION electric_exec_as_of(pg_snapshot, text, jsonb) IS
    'Execute a read-only SELECT query under the specified MVCC snapshot and return results as JSON';
