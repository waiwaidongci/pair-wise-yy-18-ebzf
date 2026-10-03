const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const config = require('./project.config');

// 环境无 sqlite3 CLI 时，回退到随仓库提供的 Python 垫片
process.env.PATH = path.join(__dirname, '.bin') + ':' + (process.env.PATH || '');

const app = express();
const PORT = process.env.PORT || config.port;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

app.use(express.json({ limit: '2mb' }));

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return execFileSync('sqlite3', [DB_FILE], {
    input: sql,
    encoding: 'utf8'
  });
}

function select(sql) {
  const output = runSql('.mode json\n' + sql);
  if (!output.trim()) return [];
  return JSON.parse(output);
}

function now() {
  return new Date().toISOString();
}

function toRecord(row) {
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
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  runSql(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function initDb() {
  runSql(`
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
CREATE TABLE IF NOT EXISTS return_checks (
  id TEXT PRIMARY KEY,
  request_no TEXT NOT NULL UNIQUE,
  tour_box_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_return_checks_box ON return_checks(tour_box_id);
CREATE INDEX IF NOT EXISTS idx_return_checks_status ON return_checks(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_checks_one_inflight
  ON return_checks(tour_box_id) WHERE status = '入账中';
`);

  const count = select('SELECT COUNT(*) AS count FROM records;')[0].count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(seed.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(seed.updatedAt || createdAt)
      ].join(', ') +
      ');'
    );
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
}

function loadRecord(collection, id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  runSql(
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

initDb();

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// ===== 返场清点入账 =====

function normalizeItemType(type) {
  if (type === 'puppetHead' || type === 'puppetHeads') return 'puppetHead';
  if (type === 'accessory' || type === 'accessories') return 'accessory';
  return type;
}

function itemCollection(itemType) {
  return itemType === 'puppetHead' ? 'puppetHeads' : 'accessories';
}

function loadItemsByIds(ids, itemType) {
  if (!Array.isArray(ids) || !ids.length) return new Map();
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(itemCollection(itemType)) +
    ' AND id IN (' + ids.map(sqlValue).join(',') + ');'
  ).map(toRecord);
  const map = new Map();
  for (const row of rows) {
    map.set(itemType + ':' + row.id, {
      itemType,
      itemId: row.id,
      name: row.title || row.name || row.role || row.id,
      boxNo: row.boxNo || '',
      status: row.status
    });
  }
  return map;
}

function toReturnCheck(row) {
  const result = JSON.parse(row.result || '{}');
  const payload = JSON.parse(row.payload || '{}');
  return {
    id: row.id,
    requestNo: row.request_no,
    tourBoxId: row.tour_box_id,
    status: row.status,
    actor: payload.actor || '',
    note: payload.note || '',
    returned: payload.returned || [],
    discrepancies: result.discrepancies || [],
    queuedItems: result.queuedItems || [],
    releasable: result.releasable || [],
    repairRecordIds: result.repairRecordIds || [],
    summary: result.summary || {},
    boxCapacities: result.boxCapacities || null,
    capacity: result.capacity || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getReturnCheckByRequestNo(requestNo) {
  const rows = select('SELECT * FROM return_checks WHERE request_no = ' + sqlValue(requestNo) + ' LIMIT 1;');
  return rows[0] ? toReturnCheck(rows[0]) : null;
}

function getLatestReturnCheck(tourBoxId) {
  const rows = select(
    'SELECT * FROM return_checks WHERE tour_box_id = ' + sqlValue(tourBoxId) + ' ORDER BY created_at DESC LIMIT 1;'
  );
  return rows[0] ? toReturnCheck(rows[0]) : null;
}

function getReturnCheckById(id) {
  const rows = select('SELECT * FROM return_checks WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? toReturnCheck(rows[0]) : null;
}

// 乐观锁：同一张装箱单先到者拿锁，后到者不可覆盖
function acquireBoxLock(boxId) {
  const versionRows = select(
    "SELECT COALESCE(CAST(json_extract(data, '$.lockVersion') AS INTEGER), 0) AS version " +
    'FROM records WHERE id = ' + sqlValue(boxId) + " AND collection = 'tourBoxes';"
  );
  const expected = versionRows[0] ? versionRows[0].version : 0;
  const out = runSql(
    '.mode json\n' +
    "UPDATE records SET " +
    "data = json_set(data, '$.lockVersion', COALESCE(CAST(json_extract(data, '$.lockVersion') AS INTEGER), 0) + 1), " +
    'updated_at = ' + sqlValue(now()) + ' ' +
    'WHERE id = ' + sqlValue(boxId) + " AND collection = 'tourBoxes' " +
    "AND COALESCE(CAST(json_extract(data, '$.lockVersion') AS INTEGER), 0) = " + expected + '; ' +
    'SELECT changes() AS changes;'
  );
  const changes = JSON.parse(out)[0].changes;
  return { acquired: changes > 0, version: expected + 1 };
}

// 旧装箱单缺少容量时按原清单回填（幂等，已有值保留）
function backfillCapacities(boxId, boxCapacities, totalCapacity) {
  runSql(
    'UPDATE records SET data = json_set(data, ' +
    "'$.boxCapacities', COALESCE(json_extract(data, '$.boxCapacities'), json(" + sqlValue(JSON.stringify(boxCapacities)) + ')), ' +
    "'$.capacity', COALESCE(CAST(json_extract(data, '$.capacity') AS INTEGER), " + totalCapacity + '), ' +
    "'$.lockVersion', COALESCE(CAST(json_extract(data, '$.lockVersion') AS INTEGER), 0)), " +
    'updated_at = ' + sqlValue(now()) + ' ' +
    'WHERE id = ' + sqlValue(boxId) + " AND collection = 'tourBoxes';"
  );
}

// 仅当物件仍为已装箱状态时推进状态（幂等，恢复入账可安全重试）
function setItemStatusIfAtBox(itemType, itemId, status) {
  const coll = itemCollection(itemType);
  let dataExpr = "json_set(data, '$.status', " + sqlValue(status) + ')';
  if (itemType === 'puppetHead') {
    dataExpr = 'json_set(' + dataExpr + ", '$.currentUsable', " + (status === '可演出' ? 'true' : 'false') + ')';
  }
  runSql(
    'UPDATE records SET status = ' + sqlValue(status) + ', data = ' + dataExpr + ', updated_at = ' + sqlValue(now()) + ' ' +
    'WHERE collection = ' + sqlValue(coll) + ' AND id = ' + sqlValue(itemId) + " AND status = '已装箱';"
  );
}

// 修补完成后才恢复可演出/在库（幂等）
function restoreItemAfterRepair(itemType, itemId) {
  const coll = itemCollection(itemType);
  const status = itemType === 'puppetHead' ? '可演出' : '在库';
  let dataExpr = "json_set(data, '$.status', " + sqlValue(status) + ')';
  if (itemType === 'puppetHead') {
    dataExpr = 'json_set(' + dataExpr + ", '$.currentUsable', true)";
  }
  runSql(
    'UPDATE records SET status = ' + sqlValue(status) + ', data = ' + dataExpr + ', updated_at = ' + sqlValue(now()) + ' ' +
    'WHERE collection = ' + sqlValue(coll) + ' AND id = ' + sqlValue(itemId) + " AND status IN ('待修补', '缺损', '修补中');"
  );
}

function findOpenRepair(itemType, itemId, boxId) {
  const rows = select(
    "SELECT id, data FROM records WHERE collection = 'repairRecords' " +
    "AND json_extract(data, '$.tourBoxId') = " + sqlValue(boxId) + ';'
  );
  for (const row of rows) {
    const data = JSON.parse(row.data || '{}');
    const linked = data.itemId || data.puppetHeadId;
    if (linked === itemId && data.status !== '已完成') return row.id;
  }
  return null;
}

function createRepairRecord({ itemType, itemId, problem, actor, boxId }) {
  const id = randomUUID();
  const repairType = problem ? String(problem).slice(0, 50) : (itemType === 'puppetHead' ? '返场损坏修补' : '返场配件修补');
  const data = {
    puppetHeadId: itemId,
    itemType,
    itemId,
    repairType,
    handler: actor || '返场清点',
    tourBoxId: boxId,
    status: '待处理'
  };
  runSql(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue('repairRecords'),
      sqlValue('待处理'),
      sqlValue(repairType + ' / ' + data.handler),
      sqlValue(JSON.stringify(data)),
      sqlValue(now()),
      sqlValue(now())
    ].join(', ') + ');'
  );
  insertEvent({
    recordId: id,
    collection: 'repairRecords',
    action: '返场报修',
    status: '待处理',
    actor: actor || '',
    note: '返场清点自动开修补记录',
    data
  });
  return id;
}

// 返场逐件核对：串箱/缺少/损坏进同一份差异结果，超容排队，损坏开修补，好件释放
function runReconciliation({ boxId, returned, actor, note, requestNo }) {
  const tourBox = loadRecord('tourBoxes', boxId);
  if (!tourBox) {
    const error = new Error('tourBox not found');
    error.status = 404;
    throw error;
  }
  const headIds = Array.isArray(tourBox.headIds) ? tourBox.headIds : [];
  const accessoryIds = Array.isArray(tourBox.accessoryIds) ? tourBox.accessoryIds : [];

  const original = new Map();
  for (const [key, value] of loadItemsByIds(headIds, 'puppetHead')) original.set(key, value);
  for (const [key, value] of loadItemsByIds(accessoryIds, 'accessory')) original.set(key, value);

  // 旧装箱单缺容量 → 按原清单回填
  let boxCapacities = tourBox.boxCapacities || tourBox.capacities || null;
  if (!boxCapacities) {
    boxCapacities = {};
    for (const item of original.values()) {
      if (!item.boxNo) continue;
      boxCapacities[item.boxNo] = (boxCapacities[item.boxNo] || 0) + 1;
    }
  }
  const totalCapacity = Number(tourBox.capacity) || original.size;
  backfillCapacities(boxId, boxCapacities, totalCapacity);

  const discrepancies = [];
  const releasable = [];
  const queuedItems = [];
  const repairRecordIds = [];
  const returnedKeys = new Set();
  const normalByBox = {};

  for (const raw of returned) {
    const itemType = normalizeItemType(raw.itemType);
    const itemId = raw.itemId;
    if (!itemType || !itemId) continue;
    const key = itemType + ':' + itemId;
    returnedKeys.add(key);
    const origItem = original.get(key);
    const reportedBox = raw.boxNo || (origItem && origItem.boxNo) || '';
    const name = (origItem && origItem.name) || raw.itemName || itemId;
    const problem = raw.problem || '';

    if (!origItem) {
      discrepancies.push({ type: '串箱', itemType, itemId, itemName: name, boxNo: reportedBox, expectedBoxNo: '', problem: problem || '非原装箱清单物件', status: '待处理' });
      continue;
    }
    if (origItem.boxNo && reportedBox && origItem.boxNo !== reportedBox) {
      discrepancies.push({ type: '串箱', itemType, itemId, itemName: name, boxNo: reportedBox, expectedBoxNo: origItem.boxNo, problem: problem || ('应在' + origItem.boxNo), status: '待处理' });
      continue;
    }
    if (raw.condition === '损坏' || raw.condition === 'damaged' || raw.damaged === true) {
      let repairId = findOpenRepair(itemType, itemId, boxId);
      if (!repairId) repairId = createRepairRecord({ itemType, itemId, problem, actor, boxId });
      repairRecordIds.push(repairId);
      discrepancies.push({ type: '损坏', itemType, itemId, itemName: name, boxNo: reportedBox, expectedBoxNo: origItem.boxNo, problem: problem || '返场损坏', repairRecordId: repairId, status: '待处理' });
      setItemStatusIfAtBox(itemType, itemId, itemType === 'puppetHead' ? '待修补' : '缺损');
      continue;
    }
    const normal = { itemType, itemId, itemName: name, boxNo: reportedBox, expectedBoxNo: origItem.boxNo };
    normalByBox[reportedBox] = normalByBox[reportedBox] || [];
    normalByBox[reportedBox].push(normal);
    releasable.push(normal);
  }

  // 容量超出 → 排队（同一份差异结果）
  for (const [boxNo, items] of Object.entries(normalByBox)) {
    const cap = boxCapacities[boxNo];
    if (cap && items.length > cap) {
      for (const item of items.slice(cap)) {
        queuedItems.push(item);
        const idx = releasable.findIndex((x) => x.itemType === item.itemType && x.itemId === item.itemId);
        if (idx >= 0) releasable.splice(idx, 1);
        discrepancies.push({ type: '超容', itemType: item.itemType, itemId: item.itemId, itemName: item.itemName, boxNo, expectedBoxNo: item.expectedBoxNo, problem: '容量超出，排队候检', status: '待处理' });
      }
    }
  }

  // 原清单有但没交回 → 缺少
  for (const [key, origItem] of original) {
    if (!returnedKeys.has(key)) {
      discrepancies.push({ type: '缺少', itemType: origItem.itemType, itemId: origItem.itemId, itemName: origItem.name, boxNo: '', expectedBoxNo: origItem.boxNo, problem: '返场未交回', status: '待处理' });
    }
  }

  // 释放可释放物件（幂等）
  for (const item of releasable) {
    setItemStatusIfAtBox(item.itemType, item.itemId, item.itemType === 'puppetHead' ? '可演出' : '在库');
  }

  const summary = {
    totalOriginal: original.size,
    returned: returned.length,
    matched: releasable.length,
    queued: queuedItems.length,
    missing: discrepancies.filter((d) => d.type === '缺少').length,
    damaged: discrepancies.filter((d) => d.type === '损坏').length,
    mixed: discrepancies.filter((d) => d.type === '串箱').length,
    overCapacity: queuedItems.length
  };

  return {
    requestNo,
    tourBoxId: boxId,
    status: '已完成',
    actor,
    note,
    discrepancies,
    queuedItems,
    releasable,
    repairRecordIds,
    summary,
    boxCapacities,
    capacity: totalCapacity,
    completedAt: now()
  };
}

function completeReturnCheck(checkId, result) {
  runSql(
    'UPDATE return_checks SET status = ' + sqlValue('已完成') + ', result = ' + sqlValue(JSON.stringify(result)) +
    ', updated_at = ' + sqlValue(now()) + ' WHERE id = ' + sqlValue(checkId) + ';'
  );
  return getReturnCheckById(checkId);
}

// 入账收尾：箱单置已闭环 + 记事件（新提交与中断恢复共用）
function finalizeBox(boxId, requestNo, actor, result) {
  runSql(
    "UPDATE records SET status = '已闭环', data = json_set(data, '$.status', '已闭环'), updated_at = " + sqlValue(now()) +
    ' WHERE id = ' + sqlValue(boxId) + " AND collection = 'tourBoxes';"
  );
  insertEvent({
    recordId: boxId,
    collection: 'tourBoxes',
    action: '返场清点入账',
    status: '已闭环',
    actor,
    note: '请求号 ' + requestNo + ' 返场清点完成',
    data: { requestNo, summary: result.summary }
  });
}

// 修补完成 → 恢复可演出/在库，并联动把损坏差异标记为已处理
function handleRepairCompleted(repairRecord) {
  if (!repairRecord || repairRecord.status !== '已完成') return;
  const itemType = normalizeItemType(repairRecord.itemType || 'puppetHead');
  const itemId = repairRecord.itemId || repairRecord.puppetHeadId;
  if (!itemId) return;
  restoreItemAfterRepair(itemType, itemId);
  const boxId = repairRecord.tourBoxId;
  if (!boxId) return;
  const rows = select('SELECT * FROM return_checks WHERE tour_box_id = ' + sqlValue(boxId) + ' ORDER BY created_at DESC LIMIT 1;');
  if (!rows.length) return;
  const row = rows[0];
  const result = JSON.parse(row.result || '{}');
  let changed = false;
  for (const disc of result.discrepancies || []) {
    if (disc.repairRecordId === repairRecord.id && disc.status === '待处理') {
      disc.status = '已处理';
      disc.resolvedAt = now();
      changed = true;
    }
  }
  if (changed) {
    runSql(
      'UPDATE return_checks SET result = ' + sqlValue(JSON.stringify(result)) +
      ', updated_at = ' + sqlValue(now()) + ' WHERE id = ' + sqlValue(row.id) + ';'
    );
  }
}

app.get('/api/returnChecks', (req, res, next) => {
  try {
    let checks = select('SELECT * FROM return_checks ORDER BY created_at DESC;').map(toReturnCheck);
    if (req.query.tourBoxId) checks = checks.filter((c) => c.tourBoxId === req.query.tourBoxId);
    if (req.query.status) checks = checks.filter((c) => c.status === req.query.status);
    if (req.query.pending === '1' || req.query.pending === 'true') {
      checks = checks.filter((c) => c.discrepancies.some((d) => d.status === '待处理'));
    }
    res.json(checks);
  } catch (error) {
    next(error);
  }
});

app.get('/api/returnChecks/:id', (req, res, next) => {
  try {
    const check = getReturnCheckById(req.params.id);
    if (!check) return res.status(404).json({ error: 'returnCheck not found' });
    res.json(check);
  } catch (error) {
    next(error);
  }
});

app.get('/api/tourBoxes/:id/returnCheck', (req, res, next) => {
  try {
    const check = getLatestReturnCheck(req.params.id);
    if (!check) return res.status(404).json({ error: 'returnCheck not found' });
    res.json(check);
  } catch (error) {
    next(error);
  }
});

// 返场清点入账：请求号幂等 + 乐观锁 + 可恢复
app.post('/api/tourBoxes/:id/returnCheck', (req, res, next) => {
  try {
    const boxId = req.params.id;
    const requestNo = String(req.body.requestNo || '').trim();
    if (!requestNo) {
      return res.status(400).json({ error: 'requestNo 请求号必填，用于幂等与恢复' });
    }
    const returned = Array.isArray(req.body.returned) ? req.body.returned : [];
    const actor = req.body.actor || '';
    const note = req.body.note || '';

    const tourBox = loadRecord('tourBoxes', boxId);
    if (!tourBox) return res.status(404).json({ error: 'tourBox not found' });

    // 同一请求重复提交只算一次；写入失败则凭请求号恢复
    const existing = getReturnCheckByRequestNo(requestNo);
    if (existing) {
      if (existing.tourBoxId !== boxId) {
        return res.status(409).json({ error: '请求号已用于其他装箱单', returnCheck: existing });
      }
      if (existing.status === '已完成') {
        return res.json({ returnCheck: existing, tourBox: loadRecord('tourBoxes', boxId), idempotent: true });
      }
      const result = runReconciliation({
        boxId,
        returned: existing.returned,
        actor: existing.actor || actor,
        note: existing.note || note,
        requestNo
      });
      const completed = completeReturnCheck(existing.id, result);
      finalizeBox(boxId, requestNo, existing.actor || actor, result);
      return res.json({ returnCheck: completed, tourBox: loadRecord('tourBoxes', boxId), resumed: true });
    }

    // 同一张箱单已有清点入账（含在途/已闭环）→ 后到者看得到差异但不能覆盖
    const boxCheck = getLatestReturnCheck(boxId);
    if (boxCheck) {
      return res.status(409).json({ error: '该装箱单已有清点入账，差异可查看但不可覆盖', returnCheck: boxCheck });
    }

    // 并发兜底：先到者拿锁，后到者不可覆盖
    const lock = acquireBoxLock(boxId);
    if (!lock.acquired) {
      const current = getLatestReturnCheck(boxId);
      return res.status(409).json({ error: '该装箱单已有清点入账，差异可查看但不可覆盖', returnCheck: current });
    }

    const checkId = randomUUID();
    const createdAt = now();
    runSql(
      'INSERT INTO return_checks (id, request_no, tour_box_id, status, payload, result, created_at, updated_at) VALUES (' +
      [
        sqlValue(checkId),
        sqlValue(requestNo),
        sqlValue(boxId),
        sqlValue('入账中'),
        sqlValue(JSON.stringify({ returned, actor, note })),
        sqlValue(JSON.stringify({ status: '入账中', discrepancies: [], queuedItems: [], releasable: [], summary: {} })),
        sqlValue(createdAt),
        sqlValue(createdAt)
      ].join(', ') + ');'
    );

    const result = runReconciliation({ boxId, returned, actor, note, requestNo });
    const completed = completeReturnCheck(checkId, result);
    finalizeBox(boxId, requestNo, actor, result);

    res.status(201).json({ returnCheck: completed, tourBox: loadRecord('tourBoxes', boxId) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;'
    ).map(toRecord);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    const createdAt = now();
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(req.params.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(createdAt)
      ].join(', ') +
      ');'
    );
    insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    if (req.params.collection === 'repairRecords' && status === '已完成') {
      handleRepairCompleted(loadRecord('repairRecords', req.params.id));
    }
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    if (req.params.collection === 'repairRecords' && status === '已完成') {
      handleRepairCompleted(loadRecord('repairRecords', req.params.id));
    }
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = select(
      'SELECT * FROM events WHERE record_id = ' + sqlValue(req.params.id) + ' ORDER BY created_at ASC;'
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    runSql('DELETE FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' AND id = ' + sqlValue(req.params.id) + ';');
    runSql('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});
