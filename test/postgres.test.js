import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../src/postgres.js';

const enabled = Boolean(process.env.PLANNER_TEST_DATABASE_URL);
test('PostgreSQL binds values separately and preserves safe 64-bit Telegram IDs', { skip: !enabled }, t => {
  const db = new PostgresDatabase(process.env.PLANNER_TEST_DATABASE_URL, { isolated: true }); t.after(() => db.close());
  const row = db.prepare("SELECT '?' AS marker, ?::bigint AS id").get(-1001234567890);
  assert.deepEqual(row, { marker: '?', id: -1001234567890 });
  assert.throws(() => db.prepare('SELECT ?::bigint AS id').get('9007199254740993'), /Unsafe/);
});
test('PostgreSQL session lock excludes a second worker and releases on disconnect', { skip: !enabled }, async t => {
  const a = new PostgresDatabase(process.env.PLANNER_TEST_DATABASE_URL, { isolated: true }); t.after(() => a.close());
  const b = new PostgresDatabase(process.env.PLANNER_TEST_DATABASE_URL, { isolated: true }); t.after(() => b.close());
  assert.equal(b.client.querySync('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [a.schema])[0].acquired, false);
  a.close();
  b.client.querySync('SELECT pg_advisory_lock(hashtext($1))', [a.schema]);
  assert.equal(b.client.querySync('SELECT pg_advisory_unlock(hashtext($1)) AS released', [a.schema])[0].released, true);
});
