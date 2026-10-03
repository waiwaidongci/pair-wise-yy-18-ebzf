# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 返场清点入账

巡演回来逐件核对装箱单，差异（串箱、缺少、损坏、超容排队）进同一份清点结果，损坏件自动开修补记录，修补完成后才恢复可演出/在库。

- `POST /api/tourBoxes/:id/returnCheck` 提交返场清点
  - `requestNo` 请求号（必填）：同一请求重复提交只算一次；写入中断后凭请求号恢复
  - `returned` 逐件核对：`{ itemType, itemId, boxNo?, condition?, problem? }`，`condition` 为 `损坏` 时开修补记录
  - 返回 `returnCheck`（含 `discrepancies` 待处理差异、`queuedItems` 排队物件、`releasable` 可释放物件、`summary`）与闭环后的 `tourBox`
  - 并发：同一张箱单先到者入账，后到者返回 `409` 且能看到差异但不能覆盖
  - 旧装箱单缺少 `boxCapacities/capacity` 时按原清单自动回填
- `GET /api/tourBoxes/:id/returnCheck` 查看某箱单最近一次清点结果
- `GET /api/returnChecks?pending=1` 列出仍有待处理差异的清点单
- `GET /api/returnChecks/:id` 按请求号查询清点结果

SQLite数据库文件会在首次启动时创建到`data/app.db`。
