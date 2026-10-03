const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const config = require('./project.config');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

function now() {
  return new Date().toISOString();
}

function newId() {
  return randomUUID();
}

function getOne(sql, params = {}) {
  return db.prepare(sql).get(params);
}

function getAll(sql, params = {}) {
  return db.prepare(sql).all(params);
}

function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}

function toRecord(row) {
  if (!row) return null;
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function loadRecord(collection, id) {
  const row = getOne(
    'SELECT * FROM records WHERE collection = @collection AND id = @id LIMIT 1;',
    { collection, id }
  );
  return toRecord(row);
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  run(
    `UPDATE records
       SET status = @status, title = @title, data = @data, updated_at = @now
     WHERE collection = @collection AND id = @id;`,
    {
      status,
      title: titleFor(collectionConfig, data),
      data: JSON.stringify(data),
      now: now(),
      collection,
      id
    }
  );
}

let _insertEventStmt = null;
function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  if (!_insertEventStmt) {
    _insertEventStmt = db.prepare(
      `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
       VALUES (@id, @recordId, @collection, @action, @status, @actor, @note, @data, @createdAt);`
    );
  }
  _insertEventStmt.run({
    id: newId(),
    recordId,
    collection,
    action: action || '记录',
    status: status || '',
    actor: actor || '',
    note: note || '',
    data: JSON.stringify(data || {}),
    createdAt: now()
  });
}

function initCoreTables() {
  db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
`);
}

function seedIfEmpty() {
  const count = getOne('SELECT COUNT(*) AS count FROM records;').count;
  if (count > 0) return;

  const insertRecord = db.prepare(
    `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
     VALUES (@id, @collection, @status, @title, @data, @createdAt, @updatedAt);`
  );
  const seedAll = db.transaction((seeds) => {
    for (const seed of seeds) {
      const collectionConfig = findCollection(seed.collection);
      const id = seed.id || newId();
      const createdAt = seed.createdAt || now();
      const status = seed.status || collectionConfig.defaultStatus || '';
      const data = { ...seed.data, status };
      insertRecord.run({
        id,
        collection: seed.collection,
        status,
        title: titleFor(collectionConfig, data),
        data: JSON.stringify(data),
        createdAt,
        updatedAt: seed.updatedAt || createdAt
      });
      insertEvent({
        recordId: id,
        collection: seed.collection,
        action: seed.eventAction || '创建',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data
      });
    }
  });
  seedAll(config.seed || []);
}

module.exports = {
  db,
  now,
  newId,
  getOne,
  getAll,
  run,
  toRecord,
  loadRecord,
  findCollection,
  titleFor,
  validate,
  saveRecord,
  insertEvent,
  initCoreTables,
  seedIfEmpty
};
