import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const persistentTestSchemas = new Map();
const closingClients = new Set();

// The existing planner uses synchronous storage transactions. libpq supplies a native,
// bounded synchronous API, so no worker-thread/Atomics bridge or async transaction leak is needed.
export class PostgresDatabase {
  constructor(url, { isolated = false, testPath = ':memory:' } = {}) {
    const Client = require('pg-native');
    const parsers = require('pg-types');
    const types = { getTypeParser(oid) {
      if (oid === 20) return value => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error('Unsafe PostgreSQL integer.');
        return number;
      };
      return parsers.getTypeParser(oid);
    } };
    const connection = new URL(url); connection.searchParams.set('connect_timeout', '10');
    this.client = new Client({ types }); this.client.connectSync(connection.toString());
    try {
      this.client.querySync("SET statement_timeout = '5s'; SET lock_timeout = '5s'");
      if (isolated) {
        this.persistentTest = testPath !== ':memory:';
        if (this.persistentTest && !persistentTestSchemas.has(testPath)) persistentTestSchemas.set(testPath, `planner_test_${randomBytes(10).toString('hex')}`);
        this.schema = this.persistentTest ? persistentTestSchemas.get(testPath) : `planner_test_${randomBytes(10).toString('hex')}`;
        this.client.querySync(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"; SET search_path TO "${this.schema}"`);
      }
      const lockName = this.schema || 'telegram-task-planner-worker';
      if (!this.client.querySync('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockName])[0].acquired) {
        throw new Error('Another planner already holds this database.');
      }
      this.client.querySync(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    } catch (error) { this.client.end(); throw error; }
  }
  exec(sql) { return this.client.querySync(sql.replace(/\bBEGIN IMMEDIATE\b/g, 'BEGIN')); }
  prepare(original) {
    // Only fixed application SQL reaches this adapter. User values remain bound parameters.
    let sql = original.replace(/\bMAX\((users\.private_enabled),(excluded\.private_enabled)\)/g, 'GREATEST($1,$2)')
      .replace(/CASE WHEN \? THEN/g, 'CASE WHEN ? <> 0 THEN');
    if (/^\s*INSERT OR IGNORE\b/i.test(sql)) {
      sql = sql.replace(/INSERT OR IGNORE/i, 'INSERT') + ' ON CONFLICT DO NOTHING';
    }
    const taskInsert = /^\s*INSERT INTO tasks\s*\(/i.test(sql);
    if (taskInsert) sql += ' RETURNING id';
    let parameter = 0; let quoted = false; let converted = '';
    for (let i = 0; i < sql.length; ++i) {
      const char = sql[i];
      if (char === "'") {
        converted += char;
        if (quoted && sql[i + 1] === "'") { converted += sql[++i]; continue; }
        quoted = !quoted;
      } else converted += char === '?' && !quoted ? `$${++parameter}` : char;
    }
    const execute = values => {
      if (values.length !== parameter) throw new Error('SQL parameter count mismatch.');
      return this.client.querySync(converted, values.map(value => value === null ? null : String(value)));
    };
    return {
      all: (...values) => execute(values),
      get: (...values) => execute(values)[0],
      run: (...values) => {
        const rows = execute(values);
        return { changes: Number(this.client.pq.cmdTuples()) || 0, lastInsertRowid: taskInsert ? rows[0]?.id : undefined };
      },
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.schema && !this.persistentTest) this.client.querySync(`DROP SCHEMA "${this.schema}" CASCADE`);
    // libpq releases its uv handles in the close phase. Retain the native owner until
    // that phase has completed, including when tests repeatedly close/reopen stores.
    const client = this.client; closingClients.add(client);
    this.client.end();
    setImmediate(() => setImmediate(() => closingClients.delete(client)));
  }
}
