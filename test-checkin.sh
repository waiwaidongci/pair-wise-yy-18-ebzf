#!/usr/bin/env bash
set -uo pipefail
cd /workspace

# 彻底清掉占用测试端口的旧服务（fuser 不在时退化为按 pid 文件）
if command -v fuser >/dev/null 2>&1; then fuser -k 3914/tcp 2>/dev/null || true; fi
if [ -f /tmp/srv.pid ]; then kill "$(cat /tmp/srv.pid)" 2>/dev/null || true; fi
sleep 0.5
rm -rf /workspace/data

PORT=3914
node server.js > /tmp/server.log 2>&1 &
SRV=$!
echo "$SRV" > /tmp/srv.pid
cleanup() { kill "$SRV" 2>/dev/null || true; }
trap cleanup EXIT

# 等待「新进程」真正监听端口
UP=0
for i in $(seq 1 40); do
  if ! kill -0 "$SRV" 2>/dev/null; then echo "server exited early"; cat /tmp/server.log; exit 1; fi
  if curl -s http://localhost:$PORT/health 2>/dev/null | grep -q '"ok":true'; then UP=1; break; fi
  sleep 0.3
done
[ "$UP" = 1 ] || { echo "server not up"; cat /tmp/server.log; exit 1; }

B=http://localhost:$PORT
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1));
  else echo "FAIL: $1 (expected [$2] got [$3])"; FAIL=$((FAIL+1)); fi
}
jqget() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[sys.argv[1]])' "$1"; }

echo "=== 1. 旧箱单无 capacity，清点时按原清单回填；串箱/缺少/损坏同一份差异 ==="
curl -s -X POST $B/api/tourBoxes/box-seed-tour-1/checkin -H 'Content-Type: application/json' -d '{
  "requestId":"req-001","actor":"张三","note":"苏州返场",
  "items":[
    {"itemType":"puppetHead","itemId":"head-tour-1","condition":"完好"},
    {"itemType":"puppetHead","itemId":"head-tour-2","condition":"损坏","damage":"右翎子折断"},
    {"itemType":"accessory","itemId":"acc-tour-1","condition":"完好"},
    {"itemType":"accessory","itemId":"acc-tour-2","condition":"完好"},
    {"itemType":"accessory","itemId":"acc-other-1","condition":"完好","foundBox":"巡演箱甲-01"}
  ]
}' > /tmp/r1.json

python3 - <<'PY'
import json
d=json.load(open('/tmp/r1.json'))
s=d['summary']
assert d['capacity']==5, d['capacity']
assert s['manifestCount']==5 and s['scannedCount']==5, s
# 损坏1 + 串箱1 占箱；完好3件即验即放；猪八戒未扫到=缺少1
assert s['damaged']==1 and s['missing']==1 and s['crossed']==1 and s['queued']==0, s
assert s['occupied']==2 and s['goodReleased']==3, s
pendkinds={x['kind'] for x in d['pendingDiscrepancies']}
assert pendkinds=={'damaged','missing','crossed'}, pendkinds
dam=[x for x in d['pendingDiscrepancies'] if x['kind']=='damaged'][0]
assert dam['repairRecordId'], '损坏件应开修补记录'
print('summary:', s)
print('releasable:', [(x['itemName'],x['reason']) for x in d['releasableItems']])
open('/tmp/dam_disc','w').write(dam['id'])
open('/tmp/repair','w').write(dam['repairRecordId'])
open('/tmp/cross_disc','w').write([x for x in d['pendingDiscrepancies'] if x['kind']=='crossed'][0]['id'])
open('/tmp/missing_disc','w').write([x for x in d['pendingDiscrepancies'] if x['kind']=='missing'][0]['id'])
PY
check "回填容量+串箱/缺少/损坏同份差异+损坏开修补" ok ok

echo
echo "=== 2. 物件状态联动 ==="
check "损坏偶头=待修补" "待修补" "$(curl -s $B/api/puppetHeads/head-tour-2 | jqget "status")"
check "损坏偶头 currentUsable=false" "False" "$(curl -s $B/api/puppetHeads/head-tour-2 | jqget "currentUsable")"
check "缺少偶头=不可演出" "不可演出" "$(curl -s $B/api/puppetHeads/head-tour-3 | jqget "status")"
check "完好偶头=可演出" "可演出" "$(curl -s $B/api/puppetHeads/head-tour-1 | jqget "status")"
check "完好配件=在库" "在库" "$(curl -s $B/api/accessories/acc-tour-1 | jqget "status")"
check "箱单=返场清点中" "返场清点中" "$(curl -s $B/api/tourBoxes/box-seed-tour-1 | jqget "status")"
check "缺少件同步开缺损追踪" "1" "$(curl -s "$B/api/lossReports?search=head-tour-3" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
check "箱单已回填 capacity" "5" "$(curl -s $B/api/tourBoxes/box-seed-tour-1 | jqget "capacity")"

echo
echo "=== 3. 同一请求重复提交只算一次 ==="
curl -s -X POST $B/api/tourBoxes/box-seed-tour-1/checkin -H 'Content-Type: application/json' -d '{
  "requestId":"req-001","actor":"张三",
  "items":[{"itemType":"puppetHead","itemId":"head-tour-1","condition":"损坏"}]
}' > /tmp/r3.json
check "重复请求返回同一 checkinId" "$(jqget "checkinId" < /tmp/r1.json)" "$(jqget "checkinId" < /tmp/r3.json)"
check "重复请求不重复开修补" "1" "$(curl -s "$B/api/repairRecords?search=head-tour-2" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
check "重复请求不覆盖物件状态" "待修补" "$(curl -s $B/api/puppetHeads/head-tour-2 | jqget "status")"

echo
echo "=== 4. 两人同交：先到者拿锁，后到者 409、见差异不可覆盖 ==="
code=$(curl -s -o /tmp/r4.json -w '%{http_code}' -X POST $B/api/tourBoxes/box-seed-tour-1/checkin -H 'Content-Type: application/json' -d '{
  "requestId":"req-002","actor":"李四",
  "items":[{"itemType":"puppetHead","itemId":"head-tour-1","condition":"完好"}]
}')
check "后到者 HTTP 409" "409" "$code"
check "锁持有人=先到者请求" "req-001" "$(python3 -c 'import json;print(json.load(open("/tmp/r4.json"))["lockHolder"])')"
check "后到者看得到待处理差异" "3" "$(python3 -c 'import json;print(len(json.load(open("/tmp/r4.json"))["pendingDiscrepancies"]))')"
check "后到者看得到可释放物件" "1" "$(python3 -c 'import json;print(len(json.load(open("/tmp/r4.json"))["releasableItems"]))')"
check "后到者请求登记为 rejected" "rejected" "$(curl -s $B/api/checkin/requests/req-002 | jqget "requestStatus")"
check "后到者未产生第二张清点单" "1" "$(curl -s $B/api/tourBoxes/box-seed-tour-1/checkin | python3 -c 'import sys,json;json.load(sys.stdin);print(1)')"

echo
echo "=== 5. 超容量排队：满箱后后到件排队，串箱路由回箱腾位后按序释放 ==="
# 小箱 capacity=1（独立配件清单，避免污染主箱数据）：损坏配件占满，串箱件与完好件依次排队
BOXN=$(curl -s -X POST $B/api/tourBoxes -H 'Content-Type: application/json' -d '{
  "showName":"小箱返场","venue":"镇江","play":"火焰山",
  "headIds":[],"accessoryIds":["acc-tour-2"],
  "boxNo":"小箱-01","capacity":1
}' | jqget "id")
curl -s -X POST $B/api/tourBoxes/$BOXN/checkin -H 'Content-Type: application/json' -d '{
  "requestId":"req-q1","actor":"张三",
  "items":[
    {"itemType":"accessory","itemId":"acc-tour-2","condition":"损坏","damage":"扇骨开裂"},
    {"itemType":"accessory","itemId":"acc-other-1","condition":"完好","foundBox":"配件箱-02"},
    {"itemType":"accessory","itemId":"accessory-seed-1","condition":"完好"}
  ]
}' > /tmp/rq.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/rq.json'))
s=d['summary']
assert s['occupied']==1 and s['damaged']==1 and s['crossed']==0 and s['queued']==2, s
q=sorted([x for x in d['discrepancies'] if x['kind']=='overflow'], key=lambda x:x['queuePosition'])
assert [x['itemId'] for x in q]==['acc-other-1','accessory-seed-1'], q
print('queue:', [(x['itemName'],x['queuePosition']) for x in q])
PY
check "满箱后两件排队（串箱在前、完好在后）" ok ok
# 未腾位前 processQueue 不释放
curl -s -X POST $B/api/tourBoxes/$BOXN/checkin/processQueue -H 'Content-Type: application/json' -d '{}' > /tmp/rq0.json
check "无空位时排队件不释放" "2" "$(python3 -c 'import json;print(len(json.load(open("/tmp/rq0.json"))["stillQueued"]))')"
# 损坏配件修补完成离场，腾出唯一位置；系统自动按序提队：队首串箱件入箱（不直接放行，转 crossed）
QREP=$(curl -s $B/api/tourBoxes/$BOXN/checkin | python3 -c 'import sys,json;print([x["repairRecordId"] for x in json.load(sys.stdin)["discrepancies"] if x["kind"]=="damaged"][0])')
curl -s -X POST $B/api/repairRecords/$QREP/complete -H 'Content-Type: application/json' -d '{"actor":"王师傅"}' > /dev/null
CK=$(curl -s $B/api/tourBoxes/$BOXN/checkin)
check "队首串箱件自动入箱转 crossed" "crossed" "$(echo "$CK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print([x["kind"] for x in d["pendingDiscrepancies"] if x["itemId"]=="acc-other-1"][0])')"
check "完好件仍排队" "1" "$(echo "$CK" | python3 -c 'import sys,json;print(len([x for x in json.load(sys.stdin)["pendingDiscrepancies"] if x["kind"]=="overflow"]))')"
check "串箱入箱件未被错误放行（仍在库原状）" "在库" "$(curl -s $B/api/accessories/acc-other-1 | jqget "status")"
# 串箱件接收放行 -> 自动腾位并提队，队次完好件随即释放
QDISC=$(echo "$CK" | python3 -c 'import sys,json;print([x["id"] for x in json.load(sys.stdin)["pendingDiscrepancies"] if x["itemId"]=="acc-other-1"][0])')
curl -s -X POST $B/api/checkin/discrepancies/$QDISC/resolve -H 'Content-Type: application/json' -d '{"action":"acceptHere","actor":"张三"}' > /dev/null
check "队次完好件自动获位释放" "在库" "$(curl -s $B/api/accessories/accessory-seed-1 | jqget "status")"
curl -s -X POST $B/api/tourBoxes/$BOXN/checkin/processQueue -H 'Content-Type: application/json' -d '{"actor":"张三"}' > /tmp/rq2.json
check "排队清零" "0" "$(python3 -c 'import json;print(len(json.load(open("/tmp/rq2.json"))["stillQueued"]))')"
check "损坏配件修补后恢复在库" "在库" "$(curl -s $B/api/accessories/acc-tour-2 | jqget "status")"

echo
echo "=== 5b. 串箱件接收(acceptHere)放行（另一张箱单） ==="
BOXB=$(curl -s -X POST $B/api/tourBoxes -H 'Content-Type: application/json' -d '{
  "showName":"测试场B","venue":"扬州","play":"火焰山",
  "headIds":["head-tour-1"],"accessoryIds":[],
  "boxNo":"测试箱B-01","capacity":5
}' | jqget "id")
curl -s -X POST $B/api/tourBoxes/$BOXB/checkin -H 'Content-Type: application/json' -d '{
  "requestId":"req-005b","actor":"张三",
  "items":[
    {"itemType":"puppetHead","itemId":"head-tour-1","condition":"完好"},
    {"itemType":"puppetHead","itemId":"head-seed-1","condition":"完好","foundBox":"木箱乙-04"}
  ]
}' > /tmp/r5b2.json
check "B单串箱差异 1 条" "crossed" "$(python3 -c 'import json;print(json.load(open("/tmp/r5b2.json"))["pendingDiscrepancies"][0]["kind"])')"
BDISC=$(python3 -c 'import json;print(json.load(open("/tmp/r5b2.json"))["pendingDiscrepancies"][0]["id"])')
curl -s -X POST $B/api/checkin/discrepancies/$BDISC/resolve -H 'Content-Type: application/json' -d '{"action":"acceptHere","actor":"张三"}' > /dev/null
check "接收后偶头可演出" "可演出" "$(curl -s $B/api/puppetHeads/head-seed-1 | jqget "status")"
check "B单差异清零闭环" "已闭环" "$(curl -s $B/api/tourBoxes/$BOXB | jqget "status")"

echo
echo "=== 5c. 主箱串箱件（短靠）路由回配件箱 ==="
curl -s -X POST $B/api/checkin/discrepancies/$(cat /tmp/cross_disc)/resolve -H 'Content-Type: application/json' -d '{"action":"routeBack","actor":"张三"}' > /dev/null
check "主箱串箱差异 resolved" "resolved" "$(curl -s $B/api/tourBoxes/box-seed-tour-1/checkin | python3 -c 'import sys,json;print([x["status"] for x in json.load(sys.stdin)["discrepancies"] if x["kind"]=="crossed"][0])')"

echo
echo "=== 6. 损坏件：修补完成后才恢复 ==="
check "修补完成前仍待修补" "待修补" "$(curl -s $B/api/puppetHeads/head-tour-2 | jqget "status")"
curl -s -X POST $B/api/repairRecords/$(cat /tmp/repair)/complete -H 'Content-Type: application/json' -d '{"actor":"王师傅","note":"重配翎子"}' > /tmp/r6.json
check "修补记录=已完成" "已完成" "$(python3 -c 'import json;print(json.load(open("/tmp/r6.json"))["repairRecord"]["status"])')"
check "损坏偶头恢复可演出" "可演出" "$(curl -s $B/api/puppetHeads/head-tour-2 | jqget "status")"
check "损坏差异随之 resolved" "resolved" "$(curl -s $B/api/tourBoxes/box-seed-tour-1/checkin | python3 -c 'import sys,json;d=json.load(sys.stdin);print([x["status"] for x in d["discrepancies"] if x["kind"]=="damaged"][0])')"
check "重复完成修补报 409" "409" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/repairRecords/$(cat /tmp/repair)/complete -H 'Content-Type: application/json' -d '{}')"

echo
echo "=== 7. 缺少件确认/找回 -> 缺损追踪联动 -> 箱单闭环 ==="
curl -s -X POST $B/api/checkin/discrepancies/$(cat /tmp/missing_disc)/resolve -H 'Content-Type: application/json' -d '{"action":"found","actor":"张三","note":"压在另一包袱底"}' > /dev/null
check "缺少件找回后可演出" "可演出" "$(curl -s $B/api/puppetHeads/head-tour-3 | jqget "status")"
check "缺损追踪=已补齐" "已补齐" "$(curl -s "$B/api/lossReports?search=head-tour-3" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["status"])')"
check "差异清零箱单闭环" "已闭环" "$(curl -s $B/api/tourBoxes/box-seed-tour-1 | jqget "status")"
check "全局待处理差异为空" "0" "$(curl -s $B/api/checkins/pending | python3 -c 'import sys,json;print(sum(len(b["pendingDiscrepancies"]) for b in json.load(sys.stdin)["boxes"]))')"
check "已闭环箱单拒绝再清点" "409" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/tourBoxes/box-seed-tour-1/checkin -H 'Content-Type: application/json' -d '{"requestId":"req-x","items":[{"itemType":"puppetHead","itemId":"head-tour-1","condition":"完好"}]}')"

echo
echo "=== 8. 写入失败后凭请求号恢复（模拟 failed 请求行） ==="
BOXC=$(curl -s -X POST $B/api/tourBoxes -H 'Content-Type: application/json' -d '{
  "showName":"测试场C","venue":"杭州","play":"火焰山",
  "headIds":["head-tour-3"],"accessoryIds":[]
}' | jqget "id")
node - "$BOXC" <<'PY'
const { db } = require('/workspace/db');
const box = process.argv[2];
db.prepare(`INSERT INTO requests (request_id, box_id, payload, status, locked_by, created_at, updated_at)
            VALUES ('req-fail', @box, @payload, 'failed', 0, @now, @now)`).run({
  box,
  payload: JSON.stringify({ boxId: box, actor: '张三', note: '', items: [
    { itemType: 'puppetHead', itemId: 'head-tour-3', condition: '完好' }
  ]}),
  now: new Date().toISOString()
});
db.prepare(`INSERT INTO box_locks (box_id, request_id, actor, status, created_at)
            VALUES (@box, 'req-fail', '张三', 'locked', @now)`).run({ box, now: new Date().toISOString() });
console.log('seeded failed request for', box);
PY
check "失败请求查询=failed 且可恢复" "failed" "$(curl -s $B/api/checkin/requests/req-fail | jqget "requestStatus")"
curl -s -X POST $B/api/tourBoxes/$BOXC/checkin -H 'Content-Type: application/json' -d '{"requestId":"req-fail"}' > /tmp/r8.json
check "凭原请求号恢复成功" "True" "$(jqget "recovered" < /tmp/r8.json)"
check "恢复后物件可演出" "可演出" "$(curl -s $B/api/puppetHeads/head-tour-3 | jqget "status")"
check "恢复后请求状态=done" "done" "$(curl -s $B/api/checkin/requests/req-fail | jqget "requestStatus")"
check "再次重放幂等" "$(jqget "checkinId" < /tmp/r8.json)" "$(curl -s -X POST $B/api/tourBoxes/$BOXC/checkin -H 'Content-Type: application/json' -d '{"requestId":"req-fail"}' | jqget "checkinId")"

echo
echo "=== 9. 参数校验 ==="
check "缺 requestId 报 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/tourBoxes/$BOXC/checkin -H 'Content-Type: application/json' -d '{"items":[]}')"
check "箱单不存在报 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/tourBoxes/nope/checkin -H 'Content-Type: application/json' -d '{"requestId":"r","items":[{"itemType":"puppetHead","itemId":"x","condition":"完好"}]}')"

echo "==================="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
