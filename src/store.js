import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { PostgresDatabase } from './postgres.js';

export class Store {
  constructor(path) {
    if (/^postgres(?:ql)?:\/\//.test(path) || process.env.PLANNER_TEST_DATABASE_URL) {
      this.db = new PostgresDatabase(process.env.PLANNER_TEST_DATABASE_URL || path, { isolated: Boolean(process.env.PLANNER_TEST_DATABASE_URL), testPath: path });
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, username TEXT, name TEXT NOT NULL, private_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS members (
        chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(chat_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, source_update_id INTEGER UNIQUE NOT NULL,
        chat_id INTEGER NOT NULL, thread_id INTEGER, creator_id INTEGER NOT NULL REFERENCES users(id),
        assignee_id INTEGER NOT NULL REFERENCES users(id), description TEXT NOT NULL,
        due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status,due_at);
      CREATE INDEX IF NOT EXISTS tasks_chat ON tasks(chat_id,status);
      CREATE TABLE IF NOT EXISTS deliveries (
        task_id INTEGER NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL,
        event_at INTEGER NOT NULL, kind TEXT NOT NULL,
        destination TEXT NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_code INTEGER,
        PRIMARY KEY(task_id,generation,event_at,destination)
      );
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (update_id INTEGER PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, start_update_id INTEGER UNIQUE NOT NULL, chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, revision INTEGER NOT NULL,
        body TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_receipts (update_id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_access (chat_id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, approved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_picks (
        request_id INTEGER PRIMARY KEY, draft_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.migrate();
  }
  migrate() {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
      if (!columns.includes('priority')) this.db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'");
      if (!columns.includes('reminder_minutes')) this.db.exec("ALTER TABLE tasks ADD COLUMN reminder_minutes TEXT NOT NULL DEFAULT '[]'");
      if (!columns.includes('next_overdue_at')) {
        this.db.exec('ALTER TABLE tasks ADD COLUMN next_overdue_at INTEGER NOT NULL DEFAULT 0; UPDATE tasks SET next_overdue_at=due_at');
      }
      const deliveryColumns = this.db.prepare('PRAGMA table_info(deliveries)').all().map(c => c.name);
      if (!deliveryColumns.includes('event_at')) {
        this.db.exec(`
          ALTER TABLE deliveries RENAME TO deliveries_legacy;
          CREATE TABLE deliveries (
            task_id INTEGER NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL,
            event_at INTEGER NOT NULL, kind TEXT NOT NULL, destination TEXT NOT NULL,
            chat_id INTEGER NOT NULL, thread_id INTEGER, state TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_code INTEGER,
            PRIMARY KEY(task_id,generation,event_at,destination)
          );
          INSERT INTO deliveries SELECT d.task_id,d.generation,t.due_at,'overdue',d.destination,d.chat_id,
            d.thread_id,d.state,d.attempts,d.next_attempt_at,d.last_code FROM deliveries_legacy d JOIN tasks t ON t.id=d.task_id;
          UPDATE tasks SET next_overdue_at=MAX(due_at, ${Date.now()})+900000
            WHERE EXISTS(SELECT 1 FROM deliveries_legacy d WHERE d.task_id=tasks.id AND d.generation=tasks.generation);
          DROP TABLE deliveries_legacy;
        `);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(state,next_attempt_at)');
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  remember(user, chatId, privateEnabled = false) {
    if (!user || user.is_bot) return;
    // Usernames can be reassigned. A newly observed owner supersedes stale cached profiles.
    if (user.username) this.db.prepare('UPDATE users SET username=NULL WHERE username=? AND id<>?').run(user.username.toLowerCase(), user.id);
    this.db.prepare(`INSERT INTO users(id,username,name,private_enabled) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name,
      private_enabled=MAX(users.private_enabled,excluded.private_enabled)`)
      .run(user.id, user.username?.toLowerCase() || null, [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.id), Number(privateEnabled));
    if (chatId < 0) this.db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(chatId, user.id);
  }
  findMember(chatId, username) {
    return this.db.prepare(`SELECT u.* FROM users u JOIN members m ON u.id=m.user_id WHERE m.chat_id=? AND u.username=?`).get(chatId, username.toLowerCase());
  }
  findUser(username) { return this.db.prepare('SELECT * FROM users WHERE username=?').get(username.toLowerCase()); }
  forgetMember(chatId, userId) { this.db.prepare('DELETE FROM members WHERE chat_id=? AND user_id=?').run(chatId, userId); }
  approveGroup(chatId, ownerId) {
    this.db.prepare('INSERT INTO group_access VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET owner_id=excluded.owner_id,approved_at=excluded.approved_at').run(chatId, ownerId, Date.now());
  }
  groupApproved(chatId, ownerId) { return Boolean(this.db.prepare('SELECT 1 FROM group_access WHERE chat_id=? AND owner_id=?').get(chatId, ownerId)); }
  groupDenied(chatId) { return Boolean(this.db.prepare('SELECT 1 FROM group_access WHERE chat_id=? AND owner_id=0').get(chatId)); }
  revokeGroup(chatId) {
    this.db.prepare('INSERT INTO group_access VALUES(?,0,?) ON CONFLICT(chat_id) DO UPDATE SET owner_id=0,approved_at=excluded.approved_at').run(chatId, Date.now());
  }
  members(chatId, search = '', page = 0) {
    const query = search.toLocaleLowerCase('uk');
    return this.db.prepare(`SELECT u.* FROM users u JOIN members m ON u.id=m.user_id
      WHERE m.chat_id=? ORDER BY u.name,u.id`).all(chatId)
      .filter(user => `${user.name} ${user.username || ''}`.toLocaleLowerCase('uk').includes(query)).slice(page * 8, page * 8 + 9);
  }
  member(chatId, userId) {
    return this.db.prepare('SELECT u.* FROM users u JOIN members m ON u.id=m.user_id WHERE m.chat_id=? AND u.id=?').get(chatId, userId);
  }
  privateEnabled(userId) { return Boolean(this.db.prepare('SELECT private_enabled FROM users WHERE id=?').get(userId)?.private_enabled); }
  disablePrivate(userId) { this.db.prepare('UPDATE users SET private_enabled=0 WHERE id=?').run(userId); }
  task(id) {
    return this.db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.id=?`).get(id);
  }
  taskByUpdate(updateId) { const row = this.db.prepare('SELECT id FROM tasks WHERE source_update_id=?').get(updateId); return row ? this.task(row.id) : undefined; }
  createTask({ updateId, chatId, threadId, creatorId, assigneeId, description, dueAt, priority = 'medium', reminderMinutes = [] }, now = Date.now()) {
    const existing = this.taskByUpdate(updateId);
    if (existing) return existing;
    if (!['low', 'medium', 'high'].includes(priority) || !Array.isArray(reminderMinutes) || reminderMinutes.some(m => ![5,15,30,60].includes(m))) throw new Error('Invalid task settings');
    const result = this.db.prepare(`INSERT INTO tasks(source_update_id,chat_id,thread_id,creator_id,assignee_id,description,due_at,created_at,updated_at,priority,reminder_minutes,next_overdue_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(updateId, chatId, threadId ?? null, creatorId, assigneeId, description, dueAt, now, now, priority, JSON.stringify([...new Set(reminderMinutes)].sort((a,b) => a-b)), dueAt);
    return this.task(Number(result.lastInsertRowid));
  }
  list({ chatId, assigneeId, creatorId, offset = 0 }) {
    const clauses = [];
    const params = [];
    if (chatId) { clauses.push('chat_id=?'); params.push(chatId); }
    if (assigneeId) { clauses.push('assignee_id=?'); params.push(assigneeId); }
    if (creatorId) { clauses.push('creator_id=?'); params.push(creatorId); }
    return this.db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t JOIN users u ON u.id=t.assignee_id
      WHERE status='open' AND ${clauses.join(' AND ')} ORDER BY due_at,t.id LIMIT 11 OFFSET ?`).all(...params, offset);
  }
  visibleTasks(chatId, userId, offset = 0) {
    const condition = chatId < 0 ? 't.chat_id=?' : '(t.creator_id=? OR t.assignee_id=?)';
    const parameters = chatId < 0 ? [chatId] : [userId, userId];
    return this.db.prepare(`SELECT t.*,u.name AS assignee_name FROM tasks t JOIN users u ON u.id=t.assignee_id
      WHERE ${condition} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,t.due_at,t.id LIMIT 11 OFFSET ?`)
      .all(...parameters, offset);
  }
  previousAction(updateId) {
    const row = this.db.prepare('SELECT result FROM actions WHERE update_id=?').get(updateId);
    return row ? JSON.parse(row.result) : undefined;
  }
  changeTask(taskId, action, updateId, now = Date.now()) {
    return this.transaction(() => {
      const previous = this.previousAction(updateId);
      if (previous) return previous;
      const task = this.task(taskId);
      if (!task || task.status !== 'open') return null;
      if (action === 'snooze') {
        this.db.prepare('UPDATE tasks SET due_at=?,next_overdue_at=?,generation=generation+1,updated_at=? WHERE id=?').run(now + 15 * 60_000, now + 15 * 60_000, now, taskId);
      } else {
        this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(action === 'done' ? 'done' : 'cancelled', now, taskId);
      }
      this.db.prepare("DELETE FROM deliveries WHERE task_id=? AND state='pending'").run(taskId);
      const result = this.task(taskId);
      this.db.prepare('INSERT INTO actions VALUES(?,?)').run(updateId, JSON.stringify(result));
      return result;
    });
  }
  prepareDeliveries(now = Date.now()) {
    this.transaction(() => {
      const tasks = this.db.prepare("SELECT t.*,u.private_enabled FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE status='open' AND due_at<=?").all(now + 3_600_000);
      const insert = this.db.prepare('INSERT OR IGNORE INTO deliveries(task_id,generation,event_at,kind,destination,chat_id,thread_id,state,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const task of tasks) {
        const destinations = [['chat', task.chat_id, task.thread_id]];
        if (task.chat_id < 0 && task.private_enabled) destinations.push(['private', task.assignee_id, null]);
        if (task.due_at <= now) {
          if (task.next_overdue_at > now) continue;
          // Resume from one current event after downtime; never replay a backlog of overdue alerts.
          this.db.prepare("UPDATE deliveries SET state='skipped' WHERE task_id=? AND state='pending'").run(task.id);
          for (const [destination, chatId, threadId] of destinations) insert.run(task.id, task.generation, now, 'overdue', destination, chatId, threadId, 'pending', now);
          this.db.prepare('UPDATE tasks SET next_overdue_at=? WHERE id=?').run(now + 900_000, task.id);
        } else {
          const events = JSON.parse(task.reminder_minutes).map(minutes => task.due_at - minutes * 60_000)
            .filter(at => at > task.updated_at && at <= now).sort((a,b) => a-b);
          const latest = events.at(-1);
          if (latest === undefined) continue;
          this.db.prepare("UPDATE deliveries SET state='skipped' WHERE task_id=? AND state='pending' AND event_at<?").run(task.id, latest);
          for (const eventAt of events) for (const [destination, chatId, threadId] of destinations) {
            insert.run(task.id, task.generation, eventAt, 'pre', destination, chatId, threadId, eventAt === latest ? 'pending' : 'skipped', now);
          }
        }
      }
    });
  }
  pendingDeliveries(now = Date.now()) {
    return this.db.prepare(`SELECT d.* FROM deliveries d JOIN tasks t ON t.id=d.task_id
      WHERE d.state='pending' AND d.next_attempt_at<=? AND t.status='open' AND d.generation=t.generation ORDER BY d.next_attempt_at LIMIT 50`).all(now);
  }
  deliveryResult(delivery, code = null, retryAfter = 0, now = Date.now()) {
    const attempts = delivery.attempts + 1;
    const terminal = code !== null && ((code >= 400 && code < 500 && code !== 429) || attempts >= 10);
    this.db.prepare(`UPDATE deliveries SET state=?,attempts=?,next_attempt_at=?,last_code=? WHERE task_id=? AND generation=? AND event_at=? AND destination=?`)
      .run(code === null ? 'sent' : terminal ? 'failed' : 'pending', attempts,
        now + Math.max(retryAfter * 1000, Math.min(3_600_000, 5000 * 2 ** Math.min(attempts, 10))), code,
        delivery.task_id, delivery.generation, delivery.event_at, delivery.destination);
  }
  draft(id, now = Date.now()) {
    const row = this.db.prepare('SELECT body FROM drafts WHERE id=? AND expires_at>?').get(id, now);
    return row ? JSON.parse(row.body) : undefined;
  }
  draftReceipt(updateId) {
    const row = this.db.prepare('SELECT body FROM wizard_receipts WHERE update_id=?').get(updateId);
    return row ? JSON.parse(row.body) : undefined;
  }
  openUserPick(draft) {
    const existing = this.db.prepare('SELECT request_id FROM user_picks WHERE draft_id=? AND user_id=? AND expires_at>? AND consumed=0')
      .get(draft.id, draft.userId, Date.now());
    if (existing) return existing.request_id;
    let requestId;
    do { requestId = randomInt(1, 2_147_483_647); } while (this.db.prepare('SELECT 1 FROM user_picks WHERE request_id=?').get(requestId));
    this.db.prepare('INSERT INTO user_picks(request_id,draft_id,user_id,expires_at) VALUES(?,?,?,?)')
      .run(requestId, draft.id, draft.userId, Math.min(draft.expiresAt, Date.now()+600_000));
    return requestId;
  }
  userPick(requestId) { return this.db.prepare('SELECT * FROM user_picks WHERE request_id=? AND expires_at>?').get(requestId, Date.now()); }
  consumeUserPick(requestId) { this.db.prepare('UPDATE user_picks SET consumed=1 WHERE request_id=?').run(requestId); }
  saveDraft(draft) {
    this.db.prepare(`INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE
      SET revision=excluded.revision,body=excluded.body,expires_at=excluded.expires_at`)
      .run(draft.id, draft.startUpdateId, draft.chatId, draft.userId, draft.threadId, draft.revision, JSON.stringify(draft), draft.expiresAt);
  }
  beginDraft(updateId, user, chatId, threadId = 0, now = Date.now()) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT body FROM drafts WHERE start_update_id=?').get(updateId);
      if (existing) return JSON.parse(existing.body);
      this.db.prepare('DELETE FROM drafts WHERE expires_at<=? OR (chat_id=? AND user_id=? AND thread_id=?)').run(now, chatId, user.id, threadId);
      const draft = { id: randomBytes(6).toString('hex'), startUpdateId: updateId, chatId, userId: user.id, userName: user.first_name || String(user.id),
        threadId, revision: 0, stage: 'assignee', priority: 'medium', reminderMinutes: [15], expiresAt: now + 1_800_000 };
      this.saveDraft(draft);
      return draft;
    });
  }
  transitionDraft(id, revision, updateId, mutate, now = Date.now()) {
    return this.transaction(() => {
      const previous = this.draftReceipt(updateId);
      if (previous) return previous;
      const draft = this.draft(id, now);
      if (!draft || draft.revision !== revision) return null;
      mutate(draft);
      draft.revision++;
      delete draft.promptId;
      draft.expiresAt = now + 1_800_000;
      this.saveDraft(draft);
      this.db.prepare('INSERT INTO wizard_receipts VALUES(?,?)').run(updateId, JSON.stringify(draft));
      return draft;
    });
  }
  setDraftPrompt(id, revision, promptId) {
    const draft = this.draft(id);
    if (draft?.revision === revision) { draft.promptId = promptId; this.saveDraft(draft); }
  }
  setDraftPanel(id, revision, panelId) {
    const draft = this.draft(id);
    if (draft?.revision === revision) { draft.panelId = panelId; this.saveDraft(draft); }
  }
  activeDraft(chatId, userId, threadId) {
    const row = this.db.prepare('SELECT body FROM drafts WHERE chat_id=? AND user_id=? AND thread_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1')
      .get(chatId, userId, threadId, Date.now());
    return row ? JSON.parse(row.body) : undefined;
  }
  replyDraft(chatId, userId, threadId, promptId) {
    if (!Number.isSafeInteger(promptId) || promptId <= 0) return undefined;
    return this.db.prepare('SELECT body FROM drafts WHERE chat_id=? AND user_id=? AND thread_id=? AND expires_at>?').all(chatId, userId, threadId, Date.now())
      .map(row => JSON.parse(row.body)).find(draft => draft.promptId === promptId);
  }
  enqueue(update, now = Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO updates(id,payload,received_at) VALUES(?,?,?)').run(update.update_id, JSON.stringify(update), now);
  }
  nextUpdate(now = Date.now()) {
    return this.db.prepare("SELECT * FROM updates WHERE state='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1").get(now);
  }
  finishUpdate(id, code = null, retryAfter = 0, now = Date.now()) {
    const row = this.db.prepare('SELECT attempts FROM updates WHERE id=?').get(id);
    const attempts = row.attempts + 1;
    const terminal = code === null || (code >= 400 && code < 500 && code !== 429) || attempts >= 8;
    this.db.prepare('UPDATE updates SET state=?,payload=CASE WHEN ? THEN ? ELSE payload END,attempts=?,next_attempt_at=? WHERE id=?')
      .run(terminal ? code === null ? 'done' : 'failed' : 'pending', Number(terminal), '{}', attempts,
        now + Math.max(retryAfter * 1000, Math.min(300_000, 1000 * 2 ** attempts)), id);
  }
}
