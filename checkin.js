/**
 * 返场清点入账流程
 *
 * - 每张巡演装箱单带原装箱清单(manifest)和箱内容量(capacity)
 * - 回来逐件核对：串箱(crossed)、缺少(missing)、损坏(damaged) 进入同一份差异结果
 * - 超过容量的清点排队(queued)，容量空出后按先到先得释放
 * - 损坏件同时开修补记录(repairRecords)，修补完成才恢复可演出/在库
 * - requestId 幂等：同一请求重复提交只算一次；写入失败凭请求号恢复
 * - 同一张箱单并发：先到者拿锁，后到者看到差异但返回 409，不覆盖
 */
const express = require('express');
const {
  db,
  now,
  newId,
  getOne,
  getAll,
  run,
  loadRecord,
  saveRecord,
  insertEvent,
  findCollection
} = require('./db');

const HEAD = 'puppetHead';
const ACC = 'accessory';

const GOOD_HOME = { [HEAD]: '可演出', [ACC]: '在库' };
const BOXED = '已装箱';
const DAMAGED_HOME = { [HEAD]: '待修补', [ACC]: '缺损' };
const MISSING_STATUS = { [HEAD]: '不可演出', [ACC]: '遗失' };

// 差异状态：pending（待处理）/ queued（排队中）/ resolved（已处理）
const D_PENDING = 'pending';
const D_QUEUED = 'queued';
const D_RESOLVED = 'resolved';

// 事务内统一通过预编译语句执行
function txRun(sql, params = {}) {
  db.prepare(sql).run(params);
}

function initCheckinTables() {
  db.exec(`
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  box_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  checkin_id TEXT,
  response TEXT,
  locked_by INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_box ON requests(box_id);

CREATE TABLE IF NOT EXISTS box_locks (
  box_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  checkin_id TEXT,
  actor TEXT,
  status TEXT NOT NULL DEFAULT 'locked',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  actor TEXT,
  status TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  occupied INTEGER NOT NULL DEFAULT 0,
  manifest TEXT NOT NULL,
  scans TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_box ON checkins(box_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_request ON checkins(request_id);

CREATE TABLE IF NOT EXISTS discrepancies (
  id TEXT PRIMARY KEY,
  checkin_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id TEXT,
  item_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  queue_position INTEGER,
  record_id TEXT,
  repair_record_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_disc_checkin ON discrepancies(checkin_id);
CREATE INDEX IF NOT EXISTS idx_disc_status ON discrepancies(status);
`);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// ---------- 清单 / 容量 ----------

function itemCollection(type) {
  return type === HEAD ? 'puppetHeads' : 'accessories';
}

function itemNameOf(type, record) {
  if (!record) return '';
  if (type === HEAD) {
    return [record.role, record.play].filter(Boolean).join(' / ') || record.id;
  }
  return record.name || record.id;
}

/** 从装箱单提取原装箱清单 [{type,id,storeBox}] */
function extractManifest(box) {
  const manifest = [];
  const push = (type, ids, storeMap = {}) => {
    for (const id of ids || []) {
      manifest.push({ type, id: String(id), storeBox: storeMap[String(id)] || '' });
    }
  };
  push(HEAD, box.headIds, box.headStoreBoxes);
  push(ACC, box.accessoryIds, box.accessoryStoreBoxes);
  return manifest;
}

/** 旧装箱单缺少容量时，按原装箱清单回填 */
function ensureManifestCapacity(box) {
  const manifest = extractManifest(box);
  const rawCapacity = box.capacity;
  const hasCapacity = rawCapacity !== undefined && rawCapacity !== null && rawCapacity !== '' &&
    Number.isFinite(Number(rawCapacity));
  const capacity = hasCapacity ? Number(rawCapacity) : manifest.length;

  const next = { ...box };
  let changed = false;
  if (!Array.isArray(next.originalManifest)) {
    next.originalManifest = manifest;
    changed = true;
  }
  if (!hasCapacity) {
    next.capacity = capacity;
    changed = true;
  }
  return { data: next, manifest, capacity, changed };
}

// ---------- 清点核心（纯计算，便于理解与测试） ----------

function normalizeScans(body) {
  const raw = body.items || body.scans || [];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw fail(400, 'items 不能为空，需逐件提交清点结果');
  }
  return raw.map((rawItem, index) => {
    const item = rawItem || {};
    const type = item.itemType === ACC ? ACC : HEAD;
    const id = item.itemId !== undefined && item.itemId !== null ? String(item.itemId) : '';
    if (!id) throw fail(400, `第 ${index + 1} 件缺少 itemId`);
    const damageText = [item.damage, item.damageDescription, item.problem]
      .filter((text) => text !== undefined && text !== null && String(text).trim() !== '')
      .map((text) => String(text).trim())[0];
    return {
      seq: index,
      type,
      id,
      condition: item.condition === '损坏' ? '损坏' : (item.condition || '完好'),
      damageText: damageText || '',
      foundBox: item.foundBox !== undefined && item.foundBox !== null ? String(item.foundBox) : '',
      note: item.note || ''
    };
  });
}

/**
 * 计算清点结果。
 * 所有返场实物都占箱内容量名额，按扫码顺序先到先得，满了（physical >= capacity）
 * 即进入排队(overflow)。差异类型（damaged/crossed/missing）独立标记：
 * - 损坏件：在容量内 -> 留箱等修补（占用直到修补完成离场）
 * - 串箱件：在容量内 -> 等差异处理（路由回箱离场 / 接收放行）
 * - 完好件：在容量内 -> 即验即放，恢复 可演出/在库
 * - 缺少件：原清单有、未扫到，不占容量
 */
function planCheckin({ manifest, capacity, scans, boxId, boxNo, itemResolver }) {
  capacity = Math.max(0, Number(capacity) || 0);
  const selfBoxes = new Set([boxId, boxNo || ''].filter(Boolean));
  const manifestByKey = new Map();
  for (const entry of manifest) {
    manifestByKey.set(entry.type + ':' + entry.id, entry);
  }
  const homeBoxOf = (type, id) => {
    const entry = manifestByKey.get(type + ':' + id);
    return entry ? entry.storeBox : '';
  };

  const seen = new Set();
  const accepted = []; // 拿到容量名额、本次入账处理的扫描件
  const allScans = []; // 去重后的全部扫描件（按扫码顺序）
  let retainedCount = 0;

  // 第一趟：补全物件信息并标记差异属性
  for (const scan of scans) {
    const key = scan.type + ':' + scan.id;
    if (seen.has(key)) {
      scan.duplicate = true; // 同一请求内重复扫码，忽略
      continue;
    }
    seen.add(key);

    const record = itemResolver(scan.type, scan.id);
    scan.exists = Boolean(record);
    scan.name = scan.exists ? itemNameOf(scan.type, record) : scan.id;

    const inManifest = manifestByKey.has(key);
    const foundBox = scan.foundBox;
    const expectedBox = inManifest
      ? (homeBoxOf(scan.type, scan.id) || boxId)
      : (record ? (record.boxNo || '') : '');
    scan.expectedBox = expectedBox;
    scan.crossed = foundBox !== '' && !selfBoxes.has(foundBox);
    scan.damaged = scan.condition === '损坏';
    scan.inManifest = inManifest;
    // 需留在箱内等处理的才占物理容量：损坏（等修补）、串箱（等路由/接收）
    scan.retains = scan.damaged || scan.crossed || !inManifest;
    allScans.push(scan);
  }

  // 第二趟：按扫码顺序先到先得。完好即验即放不占箱；
  // 留存件（损坏/串箱）占容量，容量满后后续件（无论好坏）排队。
  let seq = 0;
  for (const scan of allScans) {
    seq += 1;
    scan.seq = seq;
    if (scan.retains && retainedCount >= capacity) {
      scan.queued = true; // 容量超出就排队
      continue;
    }
    if (scan.retains) retainedCount += 1;
    accepted.push(scan);
  }
  const physical = retainedCount;

  const missing = manifest.filter(
    (entry) => !seen.has(entry.type + ':' + entry.id)
  );

  // 构造差异
  const discrepancies = [];
  const itemStates = [];
  let queuePosition = 0;

  for (const scan of accepted) {
    if (scan.damaged) {
      discrepancies.push({
        itemType: scan.type, itemId: scan.id, itemName: scan.name,
        kind: 'damaged', status: D_PENDING,
        detail: scan.damageText || '返场清点发现损坏，待修补',
        queuePosition: null
      });
      itemStates.push({ key: scan.type + ':' + scan.id, outcome: 'repair' });
    } else if (scan.crossed) {
      discrepancies.push({
        itemType: scan.type, itemId: scan.id, itemName: scan.name,
        kind: 'crossed', status: D_PENDING,
        detail: `应在「${scan.expectedBox || '原箱'}」，实际扫到于「${scan.foundBox}」`,
        queuePosition: null
      });
      itemStates.push({ key: scan.type + ':' + scan.id, outcome: 'crossed' });
    } else if (!scan.inManifest) {
      discrepancies.push({
        itemType: scan.type, itemId: scan.id, itemName: scan.name,
        kind: 'crossed', status: D_PENDING,
        detail: scan.exists
          ? `不在本箱原清单（属「${scan.expectedBox || '其他箱'}」），按串箱处理`
          : '系统中查无此件，按串箱/异物处理',
        queuePosition: null
      });
      itemStates.push({ key: scan.type + ':' + scan.id, outcome: 'crossed' });
    } else {
      itemStates.push({ key: scan.type + ':' + scan.id, outcome: 'release' });
    }
  }

  for (const scan of scans) {
    if (scan.queued) {
      queuePosition += 1;
      const detail = scan.damaged
        ? `损坏件超出箱内容量 ${capacity}，排队等待空位（入箱后开修补）`
        : `超出箱内容量 ${capacity}，排队等待空位`;
      discrepancies.push({
        itemType: scan.type, itemId: scan.id, itemName: scan.name,
        kind: 'overflow', status: D_QUEUED,
        detail,
        queuePosition
      });
      itemStates.push({ key: scan.type + ':' + scan.id, outcome: 'queued' });
    }
  }

  for (const entry of missing) {
    const record = itemResolver(entry.type, entry.id);
    discrepancies.push({
      itemType: entry.type, itemId: entry.id,
      itemName: record ? itemNameOf(entry.type, record) : entry.id,
      kind: 'missing', status: D_PENDING,
      detail: '原装箱清单有、返场未扫到',
      queuePosition: null
    });
    itemStates.push({ key: entry.type + ':' + entry.id, outcome: 'missing' });
  }

  const summary = {
    manifestCount: manifest.length,
    scannedCount: scans.filter((s) => !s.duplicate).length,
    capacity,
    occupied: physical,
    goodReleased: itemStates.filter((s) => s.outcome === 'release').length,
    damaged: discrepancies.filter((d) => d.kind === 'damaged').length,
    crossed: discrepancies.filter((d) => d.kind === 'crossed').length,
    missing: missing.length,
    queued: queuePosition
  };

  return { scans: scans.filter((s) => !s.duplicate), discrepancies, itemStates, summary };
}

// ---------- 结果组装 ----------

function discRowToApi(row) {
  return {
    id: row.id,
    checkinId: row.checkin_id,
    boxId: row.box_id,
    requestId: row.request_id,
    itemType: row.item_type,
    itemId: row.item_id || undefined,
    itemName: row.item_name,
    kind: row.kind, // damaged 损坏 / missing 缺少 / crossed 串箱 / overflow 超容量排队
    status: row.status,
    detail: row.detail,
    queuePosition: row.queue_position,
    repairRecordId: row.repair_record_id || undefined,
    recordId: row.record_id || undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || undefined,
    resolution: row.resolution || undefined
  };
}

function getCheckinRows(checkinId) {
  return getAll('SELECT * FROM discrepancies WHERE checkin_id = @id ORDER BY created_at ASC, rowid ASC;', {
    id: checkinId
  }).map(discRowToApi);
}

function buildResult(checkin, box, includeAll) {
  const all = getCheckinRows(checkin.id);
  const pending = all.filter((d) => d.status !== D_RESOLVED);
  const summary = JSON.parse(checkin.summary);

  // 可释放物件：超容量排队件（有空位即可放行）与串箱件（路由/接收后可放行）。
  // 损坏件须等修补完成、缺少件须等确认，故不在此列。
  const releasable = pending
    .filter((d) => d.kind === 'overflow' || d.kind === 'crossed')
    .map((d) => ({
      discrepancyId: d.id,
      itemType: d.itemType,
      itemId: d.itemId,
      itemName: d.itemName,
      reason: d.kind === 'overflow' ? 'queue' : 'crossed',
      queuePosition: d.queuePosition,
      detail: d.detail
    }))
    .sort((a, b) => {
      if (a.reason === 'queue' && b.reason === 'queue') {
        return (a.queuePosition || 0) - (b.queuePosition || 0);
      }
      return a.reason === 'queue' ? -1 : 1;
    });

  const lockRow = getOne('SELECT * FROM box_locks WHERE box_id = @boxId;', { boxId: checkin.box_id });

  const result = {
    requestId: checkin.request_id,
    boxId: checkin.box_id,
    boxStatus: box ? box.status : undefined,
    checkinId: checkin.id,
    status: checkin.status,
    lockStatus: lockRow ? lockRow.status : null,
    lockedBy: lockRow ? lockRow.request_id : null,
    lockedByActor: lockRow ? lockRow.actor : null,
    capacity: checkin.capacity,
    occupied: checkin.occupied,
    summary,
    discrepancies: includeAll ? all : pending,
    pendingDiscrepancies: pending,
    releasableItems: releasable
  };
  return result;
}

function checkinStatus(checkinId) {
  const checkin = getOne('SELECT * FROM checkins WHERE id = @id;', { id: checkinId });
  if (!checkin) return null;
  const box = loadRecord('tourBoxes', checkin.box_id);
  return buildResult(checkin, box, true);
}

// ---------- 入账事务 ----------

function createGenericRecord(collection, data, status, actor, action, note) {
  const collectionConfig = findCollection(collection);
  const id = newId();
  const recordData = { ...data, status };
  const timestamp = now();
  txRun(
    `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
     VALUES (@id, @collection, @status, @title, @data, @now, @now);`,
    {
      id,
      collection,
      status,
      title: require('./db').titleFor(collectionConfig, recordData),
      data: JSON.stringify(recordData),
      now: timestamp
    }
  );
  txRun(
    `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
     VALUES (@id, @recordId, @collection, @action, @status, @actor, @note, @data, @now);`,
    {
      id: newId(), recordId: id, collection, action, status,
      actor: actor || '', note: note || '', data: JSON.stringify(recordData), now: timestamp
    }
  );
  return id;
}

/**
 * 写入清点结果。调用前必须已拿到 box_locks 行锁。
 * 在 db.transaction 回调内执行，统一用 txRun（预编译语句）。
 */
function applyCheckin({ requestId, box, actor, scans, plan, note, manifest }) {
  const checkinId = newId();
  const timestamp = now();
  const hasBlocking = plan.discrepancies.some((d) => d.kind !== 'overflow');

  // 1) 建 checkin
  txRun(
    `INSERT INTO checkins
       (id, box_id, request_id, actor, status, capacity, occupied, manifest, scans, summary, created_at, updated_at)
     VALUES
       (@id, @boxId, @requestId, @actor, @status, @capacity, @occupied, @manifest, @scans, @summary, @now, @now);`,
    {
      id: checkinId,
      boxId: box.id,
      requestId,
      actor: actor || '',
      status: hasBlocking ? '差异待处理' : '清点完成',
      capacity: plan.summary.capacity,
      occupied: plan.summary.occupied,
      manifest: JSON.stringify(manifest),
      scans: JSON.stringify(scans),
      summary: JSON.stringify(plan.summary),
      now: timestamp
    }
  );

  // 2) 差异 + 物件状态流转 + 修补记录 / 缺损追踪
  const itemResolver = (type, id) => loadRecord(itemCollection(type), id);

  for (const d of plan.discrepancies) {
    const discId = newId();
    let repairRecordId = null;
    let recordId = null;

    if (d.kind === 'damaged' && d.itemId) {
      const record = itemResolver(d.itemType, d.itemId);
      if (record) {
        recordId = record.id;
        // 损坏件同时开修补记录，完成前物件为 待修补/缺损
        const payload = {
          puppetHeadId: d.itemType === HEAD ? record.id : '',
          itemType: d.itemType,
          itemId: record.id,
          itemName: d.itemName,
          repairType: d.detail || '返场损坏修补',
          handler: actor || '待分派',
          source: '返场清点',
          tourBoxId: box.id,
          discrepancyId: discId
        };
        repairRecordId = createGenericRecord(
          'repairRecords', payload, '待处理', actor || 'system',
          '返场清点开修补', '箱单 ' + box.id + ' 清点发现损坏：' + d.detail
        );

        const nextStatus = DAMAGED_HOME[d.itemType];
        const nextData = { ...record, status: nextStatus };
        if (d.itemType === HEAD) nextData.currentUsable = false;
        delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
        txRun(
          'UPDATE records SET status = @status, data = @data, updated_at = @now WHERE id = @id;',
          { status: nextStatus, data: JSON.stringify(nextData), now: now(), id: record.id }
        );
        txRun(
          `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
           VALUES (@id, @recordId, @collection, @action, @status, @actor, @note, @data, @now);`,
          {
            id: newId(), recordId: record.id, collection: itemCollection(d.itemType),
            action: '返场清点-损坏扣留', status: nextStatus, actor: actor || '',
            note: d.detail, data: JSON.stringify({ discrepancyId: discId, repairRecordId }), now: now()
          }
        );
      }
    }

    if (d.kind === 'missing' && d.itemId) {
      const record = itemResolver(d.itemType, d.itemId);
      if (record) {
        recordId = record.id;
        const nextStatus = MISSING_STATUS[d.itemType];
        const nextData = { ...record, status: nextStatus };
        if (d.itemType === HEAD) nextData.currentUsable = false;
        delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
        txRun(
          'UPDATE records SET status = @status, data = @data, updated_at = @now WHERE id = @id;',
          { status: nextStatus, data: JSON.stringify(nextData), now: now(), id: record.id }
        );
        txRun(
          `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
           VALUES (@id, @recordId, @collection, @action, @status, @actor, @note, @data, @now);`,
          {
            id: newId(), recordId: record.id, collection: itemCollection(d.itemType),
            action: '返场清点-缺少/遗失', status: nextStatus, actor: actor || '',
            note: d.detail, data: JSON.stringify({ discrepancyId: discId }), now: now()
          }
        );
      }
      // 缺损与缺少没人接上 -> 同一份差异之外，同步开缺损追踪，保证有人接
      txRun(
        `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
         VALUES (@id, 'lossReports', '待处理', @title, @data, @now, @now);`,
        {
          id: newId(),
          title: d.itemName + ' / ' + (d.itemType === HEAD ? '偶头缺少' : '配件缺少'),
          data: JSON.stringify({
            tourBoxId: box.id,
            itemType: d.itemType === HEAD ? '偶头' : '配件',
            itemName: d.itemName,
            itemId: d.itemId || '',
            problem: '返场清点缺少：' + d.detail,
            status: '待处理',
            discrepancyId: discId
          }),
          now: now()
        }
      );
    }

    if (d.kind === 'crossed' && d.itemId) {
      const record = itemResolver(d.itemType, d.itemId);
      if (record) recordId = record.id;
      // 串箱物件保持现状，不动其状态，等差异处理（路由回箱 / 接收）
    }

    txRun(
      `INSERT INTO discrepancies
         (id, checkin_id, box_id, request_id, item_type, item_id, item_name, kind, status,
          detail, queue_position, record_id, repair_record_id, created_at)
       VALUES
         (@id, @checkinId, @boxId, @requestId, @itemType, @itemId, @itemName, @kind, @status,
          @detail, @queuePosition, @recordId, @repairRecordId, @now);`,
      {
        id: discId, checkinId, boxId: box.id, requestId,
        itemType: d.itemType, itemId: d.itemId || null, itemName: d.itemName,
        kind: d.kind, status: d.status, detail: d.detail,
        queuePosition: d.queuePosition || null,
        recordId, repairRecordId,
        now: timestamp
      }
    );
  }

  // 3) 完好件即验即放 -> 恢复 可演出 / 在库
  for (const state of plan.itemStates) {
    if (state.outcome !== 'release') continue;
    const [type, id] = splitKey(state.key);
    const record = itemResolver(type, id);
    if (!record) continue;
    const nextStatus = GOOD_HOME[type];
    const nextData = { ...record, status: nextStatus };
    if (type === HEAD) nextData.currentUsable = true;
    delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
    txRun(
      'UPDATE records SET status = @status, data = @data, updated_at = @now WHERE id = @id;',
      { status: nextStatus, data: JSON.stringify(nextData), now: now(), id: record.id }
    );
    txRun(
      `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
       VALUES (@id, @recordId, @collection, @action, @status, @actor, @note, @data, @now);`,
      {
        id: newId(), recordId: record.id, collection: itemCollection(type),
        action: '返场清点-核验放行', status: nextStatus, actor: actor || '',
        note: '完好，恢复' + nextStatus, data: '{}', now: now()
      }
    );
  }

  // 4) 装箱单状态：已封箱 -> 返场清点中；无阻塞差异 -> 已闭环
  const boxStatus = hasBlocking ? '返场清点中' : '已闭环';
  const boxData = { ...box, status: boxStatus };
  delete boxData.id; delete boxData.collection; delete boxData.createdAt; delete boxData.updatedAt;
  txRun(
    `UPDATE records SET status = @status, data = @data, title = @title, updated_at = @now
     WHERE collection = 'tourBoxes' AND id = @id;`,
    {
      status: boxStatus,
      data: JSON.stringify(boxData),
      title: require('./db').titleFor(findCollection('tourBoxes'), boxData),
      now: now(),
      id: box.id
    }
  );
  txRun(
    `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
     VALUES (@id, @recordId, 'tourBoxes', @action, @status, @actor, @note, @data, @now);`,
    {
      id: newId(), recordId: box.id, action: '返场清点入账', status: boxStatus,
      actor: actor || '', note: note || '',
      data: JSON.stringify({ requestId, checkinId, summary: plan.summary }), now: now()
    }
  );

  // 5) 锁绑定到 checkin
  txRun('UPDATE box_locks SET checkin_id = @checkinId, status = @status WHERE box_id = @boxId;', {
    checkinId, status: boxStatus === '已闭环' ? 'closed' : 'locked', boxId: box.id
  });

  return { checkinId, boxStatus };
}

function splitKey(key) {
  const index = key.indexOf(':');
  return [key.slice(0, index), key.slice(index + 1)];
}

// ---------- 路由 ----------

const router = express.Router();

/**
 * POST /api/tourBoxes/:boxId/checkin
 * body: { requestId, actor?, note?, items: [{itemType, itemId, condition, damage?, foundBox?}] }
 */
router.post('/tourBoxes/:boxId/checkin', (req, res, next) => {
  try {
    const boxId = req.params.boxId;
    const requestId = req.body && req.body.requestId;
    if (!requestId) throw fail(400, '缺少 requestId，请求号用于幂等与失败恢复');

    const box = loadRecord('tourBoxes', boxId);
    if (!box) throw fail(404, '装箱单不存在: ' + boxId);

    // 幂等优先：同一 requestId 即使箱单已闭环也返回原结果（先于闭环校验）
    const existing = getOne('SELECT * FROM requests WHERE request_id = @requestId;', { requestId });
    if (existing) {
      if (existing.box_id && existing.box_id !== boxId) {
        throw fail(409, `请求号 ${requestId} 已用于另一张装箱单 ${existing.box_id}`);
      }
      if (existing.status === 'done' && existing.checkin_id) {
        return res.json(checkinStatus(existing.checkin_id));
      }
      if (existing.status === 'failed') {
        // 写入失败后凭请求号恢复：沿用原 payload 重试
        return recoverRequest(existing, box, res);
      }
      // inflight：上次提交在途中断（进程崩溃/写入失败未标记）。凭相同请求号恢复
      if (existing.status === 'inflight') {
        const lock = getOne('SELECT * FROM box_locks WHERE box_id = @boxId;', { boxId });
        if (lock && lock.request_id !== requestId) {
          const result = lock.checkin_id ? checkinStatus(lock.checkin_id) : null;
          return res.status(409).json({
            error: '装箱单由另一请求 ' + lock.request_id + ' 持有',
            conflict: 'lock_held_by_other',
            lockHolder: lock.request_id,
            pendingDiscrepancies: result ? result.pendingDiscrepancies : [],
            releasableItems: result ? result.releasableItems : []
          });
        }
        return recoverRequest(existing, box, res);
      }
      throw fail(409, '请求正在处理中，请稍后凭 requestId 重试');
    }

    if (box.status === '已闭环') throw fail(409, '装箱单已闭环，如需重新清点请新建装箱单');

    // 校验扫描件（在开事务前先报参数错）
    const scans = normalizeScans(req.body);
    const payload = JSON.stringify({
      boxId,
      actor: req.body.actor || '',
      note: req.body.note || '',
      items: req.body.items
    });

    // 登记请求并尝试拿箱单锁（先到先得）
    run(
      `INSERT INTO requests (request_id, box_id, payload, status, locked_by, created_at, updated_at)
       VALUES (@requestId, @boxId, @payload, 'inflight', 0, @now, @now);`,
      { requestId, boxId, payload, now: now() }
    );

    try {
      run(
        `INSERT INTO box_locks (box_id, request_id, actor, status, created_at)
         VALUES (@boxId, @requestId, @actor, 'locked', @now);`,
        { boxId, requestId, actor: req.body.actor || '', now: now() }
      );
    } catch (error) {
      // 唯一约束冲突 = 后到者
      const lock = getOne('SELECT * FROM box_locks WHERE box_id = @boxId;', { boxId });
      run("UPDATE requests SET status = 'rejected', updated_at = @now WHERE request_id = @requestId;", {
        now: now(), requestId
      });
      const result = lock && lock.checkin_id ? checkinStatus(lock.checkin_id) : null;
      return res.status(409).json({
        error: `装箱单已被请求 ${lock ? lock.request_id : '?'} 锁定（先到者），本次提交未入账`,
        conflict: 'lock_held_by_other',
        lockHolder: lock ? lock.request_id : null,
        lockHolderActor: lock ? lock.actor : null,
        yourRequestId: requestId,
        // 后到者仍能看到差异，但不能覆盖
        pendingDiscrepancies: result ? result.pendingDiscrepancies : [],
        releasableItems: result ? result.releasableItems : []
      });
    }

    try {
      const result = commitCheckin({ requestId, box, actor: req.body.actor || '', note: req.body.note || '', scans });
      return res.status(201).json(result);
    } catch (error) {
      // 写入失败：标记 failed 并保留锁/请求，客户端凭 requestId 恢复
      run('UPDATE requests SET status = @status, error = @error, updated_at = @now WHERE request_id = @requestId;', {
        status: 'failed', error: error.message || String(error), now: now(), requestId
      });
      error.status = error.status || 500;
      error.recoverable = true;
      error.requestId = requestId;
      next(error);
    }
  } catch (error) {
    next(error);
  }
});

function commitCheckin({ requestId, box, actor, note, scans }) {
  // 恢复场景：事务已成功、仅请求状态没来得及翻转，则直接返回已有结果
  const already = getOne('SELECT id FROM checkins WHERE request_id = @requestId;', { requestId });
  if (already) {
    run('UPDATE requests SET status = @status, checkin_id = @checkinId, updated_at = @now WHERE request_id = @requestId;', {
      status: 'done', checkinId: already.id, now: now(), requestId
    });
    return checkinStatus(already.id);
  }

  const tx = db.transaction(() => {
    // 事务内重新读取装箱单（可能已被回填）
    let current = loadRecord('tourBoxes', box.id);
    const filled = ensureManifestCapacity(current);
    if (filled.changed) {
      saveRecord('tourBoxes', current.id, stripMeta({ ...filled.data, status: current.status }), current.status);
      insertEvent({
        recordId: current.id, collection: 'tourBoxes', action: '回填清单容量',
        status: current.status, actor: actor || '',
        note: '旧装箱单缺少容量，按原装箱清单回填 capacity=' + filled.capacity,
        data: { capacity: filled.capacity, manifest: filled.manifest }
      });
      current = loadRecord('tourBoxes', current.id);
    }

    const plan = planCheckin({
      manifest: filled.manifest,
      capacity: filled.capacity,
      scans: scans.map((s) => ({ ...s })),
      boxId: current.id,
      boxNo: current.boxNo || '',
      itemResolver: (type, id) => loadRecord(itemCollection(type), id)
    });

    // planCheckin 会在扫描对象上原地补全 crossed/damaged/retains/name 等标记，
    // 入账时存增强后的版本，供排队释放时判断损坏/串箱
    const { checkinId } = applyCheckin({
      requestId, box: current, actor, scans: plan.scans, plan, note, manifest: filled.manifest
    });
    return checkinId;
  });

  const checkinId = tx();
  run('UPDATE requests SET status = @status, checkin_id = @checkinId, updated_at = @now WHERE request_id = @requestId;', {
    status: 'done', checkinId, now: now(), requestId
  });
  return checkinStatus(checkinId);
}

function recoverRequest(requestRow, box, res) {
  let payload;
  try {
    payload = JSON.parse(requestRow.payload);
  } catch (error) {
    throw fail(500, '保存的请求体损坏，无法恢复: ' + requestRow.request_id);
  }
  const scans = normalizeScans({ items: payload.items });
  const result = commitCheckin({
    requestId: requestRow.request_id,
    box: loadRecord('tourBoxes', box.id),
    actor: payload.actor || '',
    note: payload.note || '',
    scans
  });
  return res.status(200).json({ recovered: true, ...result });
}

function stripMeta(record) {
  const next = { ...record };
  delete next.id; delete next.collection; delete next.createdAt; delete next.updatedAt;
  return next;
}

/** GET /api/checkin/requests/:requestId —— 凭请求号查询/恢复结果 */
router.get('/checkin/requests/:requestId', (req, res, next) => {
  try {
    const requestRow = getOne('SELECT * FROM requests WHERE request_id = @requestId;', {
      requestId: req.params.requestId
    });
    if (!requestRow) return res.status(404).json({ error: '请求号不存在' });
    if (requestRow.status === 'done' && requestRow.checkin_id) {
      return res.json({ requestStatus: 'done', ...checkinStatus(requestRow.checkin_id) });
    }
    if (requestRow.status === 'failed') {
      return res.json({
        requestStatus: 'failed',
        recoverable: true,
        boxId: requestRow.box_id,
        error: requestRow.error,
        hint: '使用相同 requestId 重新 POST /api/tourBoxes/:boxId/checkin 即可恢复'
      });
    }
    if (requestRow.status === 'rejected') {
      const lock = getOne('SELECT * FROM box_locks WHERE box_id = @boxId;', { boxId: requestRow.box_id });
      return res.status(409).json({
        requestStatus: 'rejected',
        conflict: 'lock_held_by_other',
        boxId: requestRow.box_id,
        lockHolder: lock ? lock.request_id : null,
        pendingDiscrepancies: lock && lock.checkin_id ? checkinStatus(lock.checkin_id).pendingDiscrepancies : []
      });
    }
    return res.json({ requestStatus: requestRow.status, boxId: requestRow.box_id });
  } catch (error) {
    next(error);
  }
});

/** GET /api/tourBoxes/:boxId/checkin —— 查询某张箱单的清点结果（待处理差异 + 可释放物件） */
router.get('/tourBoxes/:boxId/checkin', (req, res, next) => {
  try {
    const checkin = getOne('SELECT * FROM checkins WHERE box_id = @boxId;', { boxId: req.params.boxId });
    if (!checkin) return res.status(404).json({ error: '该装箱单尚未清点' });
    res.json(checkinStatus(checkin.id));
  } catch (error) {
    next(error);
  }
});

/** GET /api/checkins/pending —— 全局待处理差异与可释放物件 */
router.get('/checkins/pending', (req, res, next) => {
  try {
    const rows = getAll(
      'SELECT * FROM discrepancies WHERE status != @resolved ORDER BY box_id, created_at;',
      { resolved: D_RESOLVED }
    ).map(discRowToApi);
    const byBox = new Map();
    for (const row of rows) {
      if (!byBox.has(row.boxId)) {
        byBox.set(row.boxId, { boxId: row.boxId, pendingDiscrepancies: [], releasableItems: [] });
      }
      const entry = byBox.get(row.boxId);
      entry.pendingDiscrepancies.push(row);
      if (row.kind === 'overflow' || row.kind === 'crossed') {
        entry.releasableItems.push({
          discrepancyId: row.id,
          itemType: row.itemType,
          itemId: row.itemId,
          itemName: row.itemName,
          reason: row.kind === 'overflow' ? 'queue' : 'crossed',
          queuePosition: row.queuePosition,
          detail: row.detail
        });
      }
    }
    res.json({ boxes: [...byBox.values()] });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tourBoxes/:boxId/checkin/processQueue
 * 容量空出后，按先到先得处理排队物件：
 * 完好件提入即放（恢复可演出/在库），损坏件转修补，串箱件转差异。
 */
router.post('/tourBoxes/:boxId/checkin/processQueue', (req, res, next) => {
  try {
    const actor = (req.body && req.body.actor) || '';
    const checkin = getOne('SELECT * FROM checkins WHERE box_id = @boxId;', { boxId: req.params.boxId });
    if (!checkin) throw fail(404, '该装箱单尚未清点');

    let released;
    let stillQueued;
    const tx = db.transaction(() => {
      const current = loadRecord('tourBoxes', checkin.box_id);
      released = promoteQueue(checkin.id, actor, db);
      stillQueued = getAll(
        'SELECT * FROM discrepancies WHERE checkin_id = @id AND status = @status ORDER BY queue_position ASC;',
        { id: checkin.id, status: D_QUEUED }
      ).map(discRowToApi);
      maybeCloseBox(current, checkin.id, actor, db);
    });
    tx();

    res.json({ released, stillQueued, checkin: checkinStatus(checkin.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * 空位出现后，按先到先得把队首排队件提入箱内（不直接对客户端返回结果）。
 * - 提入的完好件：即验即放（恢复可演出/在库），差异 resolved，不占用
 * - 提入的损坏件：转 damaged 待修补并开修补记录，占用 +1
 * - 提入的串箱件：转 crossed 待处理，占用 +1
 * 返回本次被提入的差异行（API 形态）。
 */
function promoteQueue(checkinId, actor, tx, hintOccupied) {
  const live = tx.prepare('SELECT * FROM checkins WHERE id = @id;').get({ id: checkinId });
  let occupied = hintOccupied === undefined ? live.occupied : hintOccupied;
  const capacity = live.capacity;
  const scanByKey = new Map();
  for (const scan of JSON.parse(live.scans || '[]')) {
    scanByKey.set(scan.type + ':' + scan.id, scan);
  }
  const promoted = [];

  while (occupied < capacity) {
    const row = tx.prepare(
      'SELECT * FROM discrepancies WHERE checkin_id = @id AND status = @status ORDER BY queue_position ASC LIMIT 1;'
    ).get({ id: checkinId, status: D_QUEUED });
    if (!row) break;

    const scan = scanByKey.get(row.item_type + ':' + row.item_id);
    const wasDamaged = Boolean(scan && scan.damaged);
    const wasCrossed = Boolean(scan && scan.crossed);
    const record = row.item_id ? loadRecord(itemCollection(row.item_type), row.item_id) : null;

    if (wasCrossed) {
      occupied += 1;
      const detail = scan && scan.foundBox
        ? `应在「${scan.expectedBox || '原箱'}」，实际扫到于「${scan.foundBox}」`
        : (scan && !scan.inManifest && scan.exists
          ? `不在本箱原清单（属「${scan.expectedBox || '其他箱'}」），按串箱处理`
          : row.detail);
      tx.prepare(
        `UPDATE discrepancies SET kind = 'crossed', status = 'pending', queue_position = NULL,
           detail = @detail WHERE id = @id;`
      ).run({ detail, id: row.id });
      tx.prepare(
        `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
         VALUES (@id, @recordId, 'tourBoxes', '排队空位释放-串箱入箱', '差异待处理', @actor, @note, @data, @now);`
      ).run({
        id: newId(), recordId: live.box_id, actor,
        note: '超容量串箱排队件获空位，转串箱差异',
        data: JSON.stringify({ discrepancyId: row.id, itemId: row.item_id }), now: now()
      });
      promoted.push(tx.prepare('SELECT * FROM discrepancies WHERE id = @id;').get({ id: row.id }));
      continue;
    }

    if (wasDamaged && record) {
      occupied += 1;
      const repairRecordId = createGenericRecord(
        'repairRecords',
        {
          puppetHeadId: row.item_type === HEAD ? record.id : '',
          itemType: row.item_type,
          itemId: record.id,
          itemName: row.item_name,
          repairType: (scan && scan.damageText) || row.detail || '返场损坏修补',
          handler: actor || '待分派',
          source: '返场清点-排队入箱',
          tourBoxId: live.box_id,
          discrepancyId: row.id
        },
        '待处理', actor || 'system',
        '排队空位释放-损坏扣留', '超容量损坏排队件获空位，转修补'
      );
      const holdStatus = DAMAGED_HOME[row.item_type];
      const holdData = { ...record, status: holdStatus };
      if (row.item_type === HEAD) holdData.currentUsable = false;
      delete holdData.id; delete holdData.collection; delete holdData.createdAt; delete holdData.updatedAt;
      tx.prepare('UPDATE records SET status = @status, data = @data, updated_at = @now WHERE id = @id;').run({
        status: holdStatus, data: JSON.stringify(holdData), now: now(), id: record.id
      });
      tx.prepare(
        `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
         VALUES (@id, @recordId, @collection, @action, @status, @actor, @note, @data, @now);`
      ).run({
        id: newId(), recordId: record.id, collection: itemCollection(row.item_type),
        action: '排队空位释放-损坏扣留', status: holdStatus, actor,
        note: (scan && scan.damageText) || '排队入箱发现损坏，转修补',
        data: JSON.stringify({ discrepancyId: row.id, repairRecordId }), now: now()
      });
      tx.prepare(
        `UPDATE discrepancies SET kind = 'damaged', status = 'pending', queue_position = NULL,
           repair_record_id = @repairId, detail = @detail WHERE id = @id;`
      ).run({
        repairId: repairRecordId,
        detail: (scan && scan.damageText) || '排队入箱发现损坏，待修补',
        id: row.id
      });
      promoted.push(tx.prepare('SELECT * FROM discrepancies WHERE id = @id;').get({ id: row.id }));
      continue;
    }

    // 完好件提入即验即放：不占用
    if (record) {
      const nextStatus = GOOD_HOME[row.item_type];
      const nextData = { ...record, status: nextStatus };
      if (row.item_type === HEAD) nextData.currentUsable = true;
      delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
      tx.prepare('UPDATE records SET status = @status, data = @data, updated_at = @now WHERE id = @id;').run({
        status: nextStatus, data: JSON.stringify(nextData), now: now(), id: record.id
      });
      tx.prepare(
        `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
         VALUES (@id, @recordId, @collection, @action, @status, @actor, @note, @data, @now);`
      ).run({
        id: newId(), recordId: record.id, collection: itemCollection(row.item_type),
        action: '排队空位释放', status: nextStatus, actor,
        note: '超容量排队件获空位，恢复' + nextStatus,
        data: JSON.stringify({ discrepancyId: row.id }), now: now()
      });
    }
    tx.prepare(
      `UPDATE discrepancies SET status = @resolved, resolved_at = @now,
         resolution = @resolution WHERE id = @id;`
    ).run({
      resolved: D_RESOLVED, now: now(),
      resolution: '空位释放，恢复可演出/在库', id: row.id
    });
    promoted.push(tx.prepare('SELECT * FROM discrepancies WHERE id = @id;').get({ id: row.id }));
  }

  tx.prepare('UPDATE checkins SET occupied = @occupied, updated_at = @now WHERE id = @id;').run({
    occupied, now: now(), id: checkinId
  });
  return promoted.map(discRowToApi);
}

function maybeCloseBox(box, checkinId, actor, tx) {
  const pending = tx.prepare(
    'SELECT COUNT(*) AS c FROM discrepancies WHERE checkin_id = @id AND status != @resolved;'
  ).get({ id: checkinId, resolved: D_RESOLVED }).c;
  if (pending > 0) return false;
  const live = tx.prepare('SELECT * FROM checkins WHERE id = @id;').get({ id: checkinId });
  const boxData = { ...box, status: '已闭环' };
  delete boxData.id; delete boxData.collection; delete boxData.createdAt; delete boxData.updatedAt;
  tx.prepare(
    `UPDATE records SET status = '已闭环', data = @data, title = @title, updated_at = @now
     WHERE collection = 'tourBoxes' AND id = @id;`
  ).run({
    data: JSON.stringify(boxData),
    title: require('./db').titleFor(findCollection('tourBoxes'), boxData),
    now: now(), id: box.id
  });
  tx.prepare(
    `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
     VALUES (@id, @recordId, 'tourBoxes', '差异清零闭环', '已闭环', @actor, @note, '{}', @now);`
  ).run({ id: newId(), recordId: box.id, actor: actor || '', note: '所有差异已处理', now: now() });
  tx.prepare("UPDATE checkins SET status = '已闭环', updated_at = @now WHERE id = @id;").run({
    now: now(), id: checkinId
  });
  tx.prepare("UPDATE box_locks SET status = 'closed' WHERE box_id = @boxId;").run({ boxId: box.id });
  return true;
}

/**
 * POST /api/checkin/discrepancies/:id/resolve
 * 处理单条差异：
 *  body: { action: 'routeBack' | 'acceptHere' | 'confirmLoss' | 'found', note?, actor? }
 */
router.post('/checkin/discrepancies/:id/resolve', (req, res, next) => {
  try {
    const discId = req.params.id;
    const action = (req.body && req.body.action) || '';
    const actor = (req.body && req.body.actor) || '';
    const row = getOne('SELECT * FROM discrepancies WHERE id = @id;', { id: discId });
    if (!row) throw fail(404, '差异不存在');
    if (row.status === D_RESOLVED) throw fail(409, '差异已处理');

    const allowed = ['routeBack', 'acceptHere', 'confirmLoss', 'found'];
    if (!allowed.includes(action)) {
      throw fail(400, 'action 必须为 ' + allowed.join(' / '));
    }

    const tx = db.transaction(() => {
      const box = loadRecord('tourBoxes', row.box_id);

      if (row.kind === 'crossed') {
        const record = row.item_id ? loadRecord(itemCollection(row.item_type), row.item_id) : null;
        if (action === 'routeBack' || action === 'acceptHere' || action === 'found') {
          if (record && action !== 'routeBack') {
            const nextStatus = GOOD_HOME[row.item_type];
            const nextData = { ...record, status: nextStatus };
            if (row.item_type === HEAD) nextData.currentUsable = true;
            delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
            db.prepare('UPDATE records SET status = @status, data = @data, updated_at = @now WHERE id = @id;')
              .run({ status: nextStatus, data: JSON.stringify(nextData), now: now(), id: record.id });
          }
          // 路由回原箱 / 接收放行，串箱件都离开本箱 -> 物理占用 -1 后立即按序提队
          if (action === 'routeBack' || action === 'acceptHere') {
            const live = db.prepare('SELECT occupied FROM checkins WHERE id = @id;').get({ id: row.checkin_id });
            const freed = Math.max(0, (live.occupied || 0) - 1);
            promoteQueue(row.checkin_id, actor, db, freed);
          }
        }
      }

      if (row.kind === 'missing' && (action === 'confirmLoss' || action === 'found')) {
        const record = row.item_id ? loadRecord(itemCollection(row.item_type), row.item_id) : null;
        if (action === 'found' && record) {
          const nextStatus = GOOD_HOME[row.item_type];
          const nextData = { ...record, status: nextStatus };
          if (row.item_type === HEAD) nextData.currentUsable = true;
          delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
          db.prepare('UPDATE records SET status = @status, data = @data, updated_at = @now WHERE id = @id;')
            .run({ status: nextStatus, data: JSON.stringify(nextData), now: now(), id: record.id });
        }
        // 关联缺损追踪 -> 已补齐 / 确认为遗失
        const lossStatus = action === 'found' ? '已补齐' : '确认为遗失';
        const lossRows = getAll(
          `SELECT id FROM records WHERE collection = 'lossReports' AND data LIKE @pattern;`,
          { pattern: '%"discrepancyId":"' + row.id + '"%' }
        );
        for (const loss of lossRows) {
          const full = loadRecord('lossReports', loss.id);
          const nextData = { ...full, status: lossStatus };
          delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
          saveRecord('lossReports', loss.id, nextData, lossStatus);
        }
      }

      const resolutionText = {
        routeBack: '串箱件已路由回原箱',
        acceptHere: '串箱件由本箱接收并放行',
        confirmLoss: '确认为遗失',
        found: '缺少件已找到并放行'
      }[action];

      db.prepare(
        `UPDATE discrepancies SET status = @resolved, resolved_at = @now, resolution = @resolution WHERE id = @id;`
      ).run({ resolved: D_RESOLVED, now: now(), resolution: resolutionText + (req.body.note ? '：' + req.body.note : ''), id: discId });

      db.prepare(
        `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
         VALUES (@id, @recordId, 'tourBoxes', @action, '差异处理', @actor, @note, @data, @now);`
      ).run({
        id: newId(), recordId: row.box_id, action: '差异处理-' + action, actor,
        note: resolutionText, data: JSON.stringify({ discrepancyId: discId }), now: now()
      });

      // 串箱离场/损坏修补已在各自路由腾位；差异处理后若有空位，自动先到先得提队
      if (row.kind === 'crossed' || row.kind === 'missing') {
        promoteQueue(row.checkin_id, actor, db);
      }

      maybeCloseBox(box, row.checkin_id, actor, db);
    });
    tx();

    const row2 = getOne('SELECT * FROM discrepancies WHERE id = @id;', { id: discId });
    res.json(discRowToApi(row2));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/repairRecords/:id/complete
 * body: { actor?, note?, result? }
 * 修补完成：恢复物件 可演出/在库，并把对应损坏差异置为已处理。
 */
router.post('/repairRecords/:id/complete', (req, res, next) => {
  try {
    const repairId = req.params.id;
    const repair = loadRecord('repairRecords', repairId);
    if (!repair) throw fail(404, '修补记录不存在');
    if (repair.status === '已完成') throw fail(409, '修补已完成');

    const actor = (req.body && req.body.actor) || repair.handler || '';
    const note = (req.body && req.body.note) || '';

    const tx = db.transaction(() => {
      // 修补记录 -> 已完成
      const repairData = { ...repair, status: '已完成', completedAt: now() };
      if (req.body && req.body.result) repairData.result = req.body.result;
      delete repairData.id; delete repairData.collection; delete repairData.createdAt; delete repairData.updatedAt;
      saveRecord('repairRecords', repairId, repairData, '已完成');
      insertEvent({
        recordId: repairId, collection: 'repairRecords', action: '修补完成',
        status: '已完成', actor, note, data: repairData
      });

      // 恢复物件
      const itemType = repair.itemType || (repair.puppetHeadId ? HEAD : '');
      const itemId = repair.itemId || repair.puppetHeadId;
      let restored = null;
      if (itemType && itemId) {
        const record = loadRecord(itemCollection(itemType), itemId);
        if (record) {
          const nextStatus = GOOD_HOME[itemType];
          const nextData = { ...record, status: nextStatus };
          if (itemType === HEAD) nextData.currentUsable = true;
          delete nextData.id; delete nextData.collection; delete nextData.createdAt; delete nextData.updatedAt;
          saveRecord(itemCollection(itemType), itemId, nextData, nextStatus);
          insertEvent({
            recordId: itemId, collection: itemCollection(itemType),
            action: '修补完成-恢复' + nextStatus, status: nextStatus, actor,
            note: note || '修补完成，恢复可演出/在库', data: { repairRecordId: repairId }
          });
          restored = { itemType, itemId, status: nextStatus };

          // 损坏件修补完成离场 -> 箱内物理占用 -1，差异关闭
          const disc = getOne('SELECT * FROM discrepancies WHERE repair_record_id = @rid;', { rid: repairId })
            || getAll('SELECT * FROM discrepancies WHERE kind = @kind AND status != @resolved LIMIT 1;', {
              kind: 'damaged', resolved: D_RESOLVED
            }).find((d) => d.item_id === itemId);
          if (disc) {
            db.prepare(
              `UPDATE discrepancies SET status = @resolved, resolved_at = @now,
                 resolution = @resolution WHERE id = @id;`
            ).run({
              resolved: D_RESOLVED, now: now(),
              resolution: '修补完成，恢复' + GOOD_HOME[itemType], id: disc.id
            });
            const live = db.prepare('SELECT occupied FROM checkins WHERE id = @id;').get({ id: disc.checkin_id });
            const freed = Math.max(0, (live.occupied || 0) - 1);
            // 损坏件离场腾出空位 -> 以扣减后的占用按序提队
            promoteQueue(disc.checkin_id, actor, db, freed);
            const box = loadRecord('tourBoxes', disc.box_id);
            if (box) maybeCloseBox(box, disc.checkin_id, actor, db);
          }
        }
      }
      return restored;
    });
    const restored = tx();

    res.json({
      repairRecord: loadRecord('repairRecords', repairId),
      restored,
      message: '修补完成，物件已恢复可演出/在库'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = {
  router,
  initCheckinTables,
  // 导出纯函数供测试
  planCheckin,
  extractManifest,
  ensureManifestCapacity,
  normalizeScans,
  HEAD,
  ACC
};
