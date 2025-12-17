import {
  LogicalReplicationService,
  PgoutputPlugin,
  Pgoutput,
} from 'pg-logical-replication';

export interface CommitSnapshot {
  xid: bigint;
  snapshotString: string;
  lsn: string;
}

export interface ReplicationState {
  service: LogicalReplicationService;
  plugin: PgoutputPlugin;
  inFlightXids: Set<bigint>;
  commitSnapshots: CommitSnapshot[];
  isRunning: boolean;
  stopPromise: Promise<void> | null;
  currentXid: bigint | null; // Track current transaction's xid
}

/**
 * Compute an approximate snapshot string after a commit.
 * This represents the database state "just after" the given xid committed.
 */
export function computeSnapshotAfterCommit(
  committedXid: bigint,
  inFlightXids: Set<bigint>
): string {
  // Remove the committed xid from in-flight set
  const inFlightAfter = new Set(inFlightXids);
  inFlightAfter.delete(committedXid);
  
  // Collect all xids we need to consider
  const allXids = [committedXid, ...inFlightAfter];
  
  // xmax = max of all xids + 1
  const xmax = allXids.reduce((max, x) => x > max ? x : max, 0n) + 1n;
  
  // xmin = min of in-flight (if any), otherwise xmax
  let xmin: bigint;
  if (inFlightAfter.size > 0) {
    xmin = [...inFlightAfter].reduce((min, x) => x < min ? x : min, BigInt(Number.MAX_SAFE_INTEGER));
  } else {
    xmin = xmax;
  }
  
  // xip = sorted list of in-flight xids where xmin <= xid < xmax
  const xip = [...inFlightAfter]
    .filter(x => x >= xmin && x < xmax)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  
  // Format: xmin:xmax:xip1,xip2,...
  const xipStr = xip.map(x => x.toString()).join(',');
  return `${xmin}:${xmax}:${xipStr}`;
}

/**
 * Start a logical replication stream and track transactions
 */
export async function startReplicationStream(
  connectionString: string,
  slotName: string = 'slot1',
  publicationName: string = 'pub'
): Promise<ReplicationState> {
  const service = new LogicalReplicationService({
    connectionString,
  }, {
    acknowledge: {
      auto: true,
      timeoutSeconds: 10,
    },
  });

  const plugin = new PgoutputPlugin({
    protoVersion: 1,
    publicationNames: [publicationName],
  });

  const state: ReplicationState = {
    service,
    plugin,
    inFlightXids: new Set(),
    commitSnapshots: [],
    isRunning: false,
    stopPromise: null,
    currentXid: null,
  };

  // Handle messages
  service.on('data', (lsn: string, message: Pgoutput.Message) => {
    // console.log('Replication message:', message.tag, message);
    
    if (message.tag === 'begin') {
      // Transaction started - xid is on the begin message
      const beginMsg = message as Pgoutput.MessageBegin;
      if (beginMsg.xid !== undefined) {
        const xid = BigInt(beginMsg.xid);
        state.inFlightXids.add(xid);
        state.currentXid = xid;
      }
    } else if (message.tag === 'commit') {
      // Transaction committed - use the xid we captured from BEGIN
      const commitMsg = message as Pgoutput.MessageCommit;
      
      // Try to get xid from commit message first, otherwise use currentXid
      let xid: bigint | null = null;
      
      // In pgoutput protocol v1, xid may be on commit or we use the one from begin
      if ((commitMsg as any).xid !== undefined) {
        xid = BigInt((commitMsg as any).xid);
      } else if (state.currentXid !== null) {
        xid = state.currentXid;
      }
      
      if (xid !== null) {
        // Compute snapshot representing "just after this commit"
        const snapshotString = computeSnapshotAfterCommit(xid, state.inFlightXids);
        
        state.commitSnapshots.push({
          xid,
          snapshotString,
          lsn,
        });
        
        // Remove from in-flight
        state.inFlightXids.delete(xid);
      }
      
      state.currentXid = null;
    }
    // We ignore INSERT/UPDATE/DELETE messages for snapshot tracking
  });

  service.on('error', (err: Error) => {
    console.error('Replication error:', err);
  });

  // Start the replication
  state.isRunning = true;
  state.stopPromise = service.subscribe(plugin, slotName).catch((err) => {
    if (state.isRunning) {
      console.error('Replication subscription error:', err);
    }
  });

  // Give it a moment to connect
  await new Promise(resolve => setTimeout(resolve, 1000));

  return state;
}

/**
 * Wait for a commit matching the predicate
 */
export async function waitForCommit(
  state: ReplicationState,
  predicate: (snapshot: CommitSnapshot) => boolean,
  timeoutMs: number = 10000
): Promise<CommitSnapshot> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    // Check existing snapshots
    const match = state.commitSnapshots.find(predicate);
    if (match) {
      return match;
    }
    
    // Wait a bit and check again
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  throw new Error(`Timeout waiting for commit matching predicate`);
}

/**
 * Wait for the Nth commit
 */
export async function waitForNthCommit(
  state: ReplicationState,
  n: number,
  timeoutMs: number = 10000
): Promise<CommitSnapshot> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (state.commitSnapshots.length >= n) {
      return state.commitSnapshots[n - 1];
    }
    
    // Wait a bit and check again
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  throw new Error(`Timeout waiting for commit #${n}. Got ${state.commitSnapshots.length} commits.`);
}

/**
 * Stop the replication stream
 */
export async function stopReplicationStream(state: ReplicationState): Promise<void> {
  state.isRunning = false;
  
  try {
    state.service.stop();
  } catch {
    // Ignore stop errors
  }
  
  if (state.stopPromise) {
    try {
      await Promise.race([
        state.stopPromise,
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    } catch {
      // Ignore
    }
  }
}
