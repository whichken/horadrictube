import { Database } from 'bun:sqlite';
import { HttpError } from './log.ts';

export type Status = 'queued' | 'running' | 'completed' | 'skipped' | 'failed';
export interface Job {
  id: string;
  dedupe: string;
  source: string;
  profile: string;
  status: Status;
  attempts: number;
  available: number;
  created: number;
  updated: number;
  progress: number;
  message: string | null;
  output: string | null;
  decision: string | null;
}
export interface Submission {
  source: string;
  profile: string;
  fingerprint: string;
  delaySeconds: number;
}
export class Store {
  private db: Database;
  constructor(file: string) {
    this.db = new Database(file, { strict: true });
    // Retain an OS-backed exclusive SQLite lock for this process's lifetime.
    // A second instance must never recover another instance's running encodes.
    try {
      this.db.exec(
        'PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;',
      );
      this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, dedupe TEXT NOT NULL UNIQUE, source TEXT NOT NULL, profile TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, progress REAL NOT NULL DEFAULT 0,
      message TEXT, output TEXT, decision TEXT
    ); CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available);`);
      this.db
        .query(
          "UPDATE jobs SET status='queued', progress=0, message='Recovered after service restart', updated=? WHERE status='running'",
        )
        .run(Date.now());
    } catch (error) {
      this.db.close(true);
      throw error;
    }
  }
  enqueueMany(inputs: Submission[], maxQueued: number): Job[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results: Job[] = [];
      let count = (
        this.db
          .query("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')")
          .get() as { n: number }
      ).n;
      for (const input of inputs) {
        const dedupe = new Bun.CryptoHasher('sha256')
          .update(JSON.stringify([input.source, input.profile, input.fingerprint]))
          .digest('hex');
        const existing =
          (this.db
            .query('SELECT * FROM jobs WHERE dedupe=?')
            .get(dedupe) as unknown as Job | null) ?? undefined;
        if (existing) {
          results.push(existing);
          continue;
        }
        if (++count > maxQueued) throw new HttpError(429, 'Queue is full');
        const now = Date.now(),
          id = crypto.randomUUID();
        this.db
          .query(
            "INSERT INTO jobs(id,dedupe,source,profile,status,available,created,updated) VALUES (?,?,?,?,'queued',?,?,?)",
          )
          .run(id, dedupe, input.source, input.profile, now + input.delaySeconds * 1000, now, now);
        results.push(this.get(id)!);
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claim(): Job | undefined {
    // One event loop owns this database. The update/return is a single atomic statement.
    return (
      (this.db
        .query(
          `UPDATE jobs SET status='running', attempts=attempts+1, progress=0, updated=?
      WHERE id=(SELECT id FROM jobs WHERE status='queued' AND available<=?
        AND source NOT IN (SELECT source FROM jobs WHERE status='running')
        ORDER BY available, created LIMIT 1) RETURNING *`,
        )
        .get(Date.now(), Date.now()) as unknown as Job | null) ?? undefined
    );
  }
  get(id: string): Job | undefined {
    return (
      (this.db.query('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job | null) ?? undefined
    );
  }
  list(limit = 100, offset = 0): Job[] {
    return this.db
      .query('SELECT * FROM jobs ORDER BY created DESC, id LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as Job[];
  }
  counts(): Record<string, number> {
    return Object.fromEntries(
      (
        this.db.query('SELECT status, count(*) AS n FROM jobs GROUP BY status').all() as {
          status: string;
          n: number;
        }[]
      ).map((r) => [r.status, r.n]),
    );
  }
  patch(
    id: string,
    fields: Partial<
      Pick<
        Job,
        'status' | 'progress' | 'message' | 'output' | 'decision' | 'available' | 'attempts'
      >
    >,
  ): void {
    const entries = Object.entries({ ...fields, updated: Date.now() });
    this.db
      .query(`UPDATE jobs SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
      .run(...entries.map(([, value]) => value), id);
  }
  retry(id: string, maxQueued: number): Job {
    const job = this.get(id);
    if (!job) throw new HttpError(404, 'Job not found');
    if (job.status !== 'failed' && job.status !== 'skipped')
      throw new HttpError(409, 'Only failed or skipped jobs can be retried');
    const counts = this.counts();
    if ((counts.queued ?? 0) + (counts.running ?? 0) >= maxQueued)
      throw new HttpError(429, 'Queue is full');
    this.patch(id, {
      status: 'queued',
      attempts: 0,
      progress: 0,
      available: Date.now(),
      message: null,
    });
    return this.get(id)!;
  }
  close(): void {
    this.db.close(true);
  }
}
