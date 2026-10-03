# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和**返场清点入账**（串箱/缺少/损坏差异、超容量排队、修补恢复、请求幂等、箱单锁）。

## 启动

```bash
npm install
npm start          # 或 npm test 跑端到端测试（会临时使用 data/test 之外的全新库）
```

默认地址：http://localhost:3914

## 数据模型

- `puppetHeads` 偶头：可演出 / 已装箱 / 待修补 / 修补中 / 不可演出
- `accessories` 配件：在库 / 已装箱 / 缺损 / 遗失
- `repairRecords` 修补记录：待处理 … 已完成
- `tourBoxes` 巡演装箱单：草稿 / 已装箱 / 巡演中 / 返场清点中 / 已闭环
  - `headIds`、`accessoryIds` 即**原装箱清单**
  - `headStoreBoxes`、`accessoryStoreBoxes` 记录每件原属箱号（用于识别串箱）
  - `capacity` 箱内容量；**旧装箱单缺容量时，返场清点按原清单件数自动回填**
  - `originalManifest` 清点时固化的原清单快照
- `lossReports` 缺损追踪

## 返场清点流程

### 提交清点（幂等入账）

`POST /api/tourBoxes/:boxId/checkin`

```json
{
  "requestId": "req-20261002-001",
  "actor": "张三",
  "note": "苏州返场清点",
  "items": [
    { "itemType": "puppetHead", "itemId": "head-tour-1", "condition": "完好" },
    { "itemType": "puppetHead", "itemId": "head-tour-2", "condition": "损坏", "damage": "右翎子折断" },
    { "itemType": "accessory", "itemId": "acc-other-1", "condition": "完好", "foundBox": "配件箱-02" }
  ]
}
```

- `condition`：`完好` / `损坏`；`foundBox` 实际扫到的箱号（与本箱不同即**串箱**）
- 逐件核对，同一请求内重复扫码自动忽略
- 返回一份结果：`discrepancies`（串箱 `crossed` / 缺少 `missing` / 损坏 `damaged` / 超容量 `overflow`）、
  `pendingDiscrepancies` 待处理差异、`releasableItems` 可释放物件、`summary` 计数、`capacity/occupied`
- 状态联动：
  - 完好件 → 即验即放，恢复 **可演出 / 在库**
  - 损坏件 → 物件置 待修补/缺损，同时**自动开修补记录**，修补完成才恢复
  - 缺少件 → 物件置 不可演出/遗失，并自动开缺损追踪（待处理）
  - 串箱件 → 保持现状，进差异待路由/接收
- **容量**：损坏件、串箱件留在箱内占容量；容量满后后到件按扫码顺序**排队**（`overflow`），
  空位出现后先到先得自动提队——完好件提入即放，损坏件转修补，串箱件转差异

### 可靠性与并发

- **同一 `requestId` 重复提交只算一次**：返回同一张清点结果，不重复开修补/不覆盖状态
  （并发重放也安全：1 个 201 + 其余 200，同一 checkinId）
- **写入失败可恢复**：失败的请求标记 `failed`，用相同 `requestId` 重放即凭保存的请求体恢复；
  事务已落库仅状态未翻转时自动衔接，不会重复入账
- **两人同交一张箱单**：先到者经 `box_locks` 唯一约束拿锁，后到者返回 **409**，
  响应里带 `lockHolder` 且仍包含 `pendingDiscrepancies`、`releasableItems`——**看得到差异但不能覆盖**
- `GET /api/checkin/requests/:requestId` 凭请求号查询状态（done / failed 可恢复 / rejected）

### 差异处理与释放

- `POST /api/checkin/discrepancies/:id/resolve`
  - `routeBack` 串箱件路由回原箱（腾位）
  - `acceptHere` 本箱接收并放行，恢复可演出/在库（腾位）
  - `found` 缺少件找回放行，缺损追踪→已补齐
  - `confirmLoss` 确认为遗失，缺损追踪→确认为遗失
- `POST /api/tourBoxes/:boxId/checkin/processQueue` 手动触发排队提队
  （损坏离场/串箱处理后也会自动提队，按 `queuePosition` 先到先得）
- `POST /api/repairRecords/:id/complete` 修补完成 → 恢复物件可演出/在库、关闭损坏差异、腾位提队
- 所有差异清零且排队清空后，装箱单自动 **已闭环**，拒绝再次清点

### 查询

- `GET /api/tourBoxes/:boxId/checkin` 某箱清点结果（含待处理差异、可释放物件、容量占用）
- `GET /api/checkins/pending` 全局各箱**待处理差异**与**可释放物件**汇总
- `GET /api/tourBoxes/:boxId/timeline` 装箱单事件时间线

## 其他常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords` / `POST /api/tourBoxes` / `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 存储

使用 better-sqlite3（WAL，同步事务），数据库文件在 `data/app.db`，首次启动自动建表并写入演示种子
（含一张已封箱、缺容量的巡演装箱单 `box-seed-tour-1`，可直接演示容量回填与完整清点）。
