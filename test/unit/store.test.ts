import { test, expect, afterEach } from 'bun:test';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
import { join } from 'node:path';
import { Store, type Submission } from '../../src/store.ts';
import { fixture } from '../helpers.ts';
const input = (source: string, profile = 'default'): Submission => ({
  source,
  profile,
  fingerprint: '1',
  delaySeconds: 0,
});

test('deduplication, atomic capacity limit, per-source exclusion and persisted recovery', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const file = join(f.rt.configDir, 'jobs.sqlite');
  let store = new Store(file);
  cleanups.push(() => store.close());
  const [first] = store.enqueueMany([input('/a'), input('/a')], 3);
  expect(store.list().length).toBe(1);
  expect(store.enqueueMany([input('/a')], 3)[0]!.id).toBe(first!.id);
  expect(() => store.enqueueMany([input('/b'), input('/c'), input('/d')], 3)).toThrow(/full/);
  expect(store.list().length).toBe(1);
  store.enqueueMany([input('/a', 'compact'), input('/b')], 3);
  expect(store.claim()!.id).toBe(first!.id);
  expect(store.claim()!.source).toBe('/b');
  expect(store.claim()).toBe(undefined);
  store.close();
  store = new Store(file);
  expect(store.get(first!.id)!.status).toBe('queued');
  expect(store.get(first!.id)!.attempts).toBe(1);
  store.patch(first!.id, { status: 'failed' });
  expect(store.retry(first!.id, 10).attempts).toBe(0);
  expect(() => store.retry(first!.id, 10)).toThrow(/Only failed/);
});

test('delayed jobs survive reopen and another instance cannot own the queue', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const file = join(f.rt.configDir, 'jobs.sqlite');
  const store = new Store(file);
  cleanups.push(() => store.close());
  store.enqueueMany([{ ...input('/later'), delaySeconds: 60 }], 10);
  expect(store.claim()).toBe(undefined);
  expect(() => new Store(file)).toThrow(/locked/);
});
