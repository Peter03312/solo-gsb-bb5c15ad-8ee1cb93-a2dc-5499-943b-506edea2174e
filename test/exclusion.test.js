import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { solve, verify, computeHash } from '../src/solver.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

const base = (over = {}) => ({
  holes: 4,
  tolerance: 1,
  holeMaxMass: [100, 100, 100, 100],
  tubes: [],
  weights: [],
  ...over,
});
const allHoles = (n) => Array.from({ length: n }, (_, i) => i);
const holeOf = (r, id) => r.arrangement.findIndex((s) => s && s.ref === id);
const adjacent = (h1, h2, N) => (h1 + 1) % N === h2 || (h2 + 1) % N === h1;

// ---------- 求解器（纯函数） ----------

test('避邻对不被排入相邻孔位；N=4 下两支互避管只能对径放置', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
    exclusions: [{ a: 'A', b: 'B' }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  const ha = holeOf(r, 'A');
  const hb = holeOf(r, 'B');
  assert.ok(!adjacent(ha, hb, 4));
  assert.equal((ha + 2) % 4, hb); // 只能对径
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('避邻规则下保持原优化顺序（配重数最少 → 差和最小 → 字典序）', () => {
  // 3 支 50 g 管 + 1 枚 50 g 配重、容差 0：必须使用 1 枚配重；
  // 无避邻时字典序最优为 A@0,B@1,C@2（A、B 相邻），避邻后 B 移到孔 2。
  const data = base({
    tolerance: 0,
    tubes: ['A', 'B', 'C'].map((id) => ({ id, mass: 50, usableHoles: allHoles(4) })),
    weights: [{ mass: 50, quantity: 1 }],
    exclusions: [{ a: 'A', b: 'B' }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(r.weightCount, 1);
  assert.equal(r.diffSum, 0);
  assert.equal(holeOf(r, 'A'), 0);
  assert.equal(holeOf(r, 'C'), 1);
  assert.equal(holeOf(r, 'B'), 2);
  assert.ok(!adjacent(holeOf(r, 'A'), holeOf(r, 'B'), 4));
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('环绕边（孔 N-1 与孔 0）同样视为相邻', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
    exclusions: [{ a: 'A', b: 'B' }],
  });
  // 孔 3 与孔 0 环形相邻：该摆放必须被独立复核拒绝
  const bad = [
    { kind: 'tube', ref: 'A', mass: 50 },
    null,
    null,
    { kind: 'tube', ref: 'B', mass: 50 },
  ];
  const v = verify(data, bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.join(' ').includes('相邻'));
});

test('避邻冲突导致无解时给出说明冲突的原因', () => {
  // 4 孔 4 管满载，A 与其余三支全部互避：A 的对径孔位只有一个，放不下三支
  const data = base({
    tubes: ['A', 'B', 'C', 'D'].map((id) => ({ id, mass: 50, usableHoles: allHoles(4) })),
    exclusions: [
      { a: 'A', b: 'B' },
      { a: 'A', b: 'C' },
      { a: 'A', b: 'D' },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
  assert.ok(r.reasons.join(' ').includes('避邻'));
});

test('空避邻规则与无规则字段求解结果一致（行为与性能走原路径）', () => {
  const d = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 60, usableHoles: allHoles(4) },
    ],
    weights: [
      { mass: 50, quantity: 1 },
      { mass: 60, quantity: 1 },
    ],
  });
  const r1 = solve(d);
  const r2 = solve({ ...d, exclusions: [] });
  assert.deepEqual(r2, r1);
});

test('求解时防御性忽略指向未知编号的避邻对', () => {
  const d = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
  });
  const r1 = solve(d);
  const r2 = solve({ ...d, exclusions: [{ a: 'A', b: 'GHOST' }] });
  assert.deepEqual(r2, r1);
});

test('数据指纹：空避邻规则与无规则字段等价；配置规则后指纹变化', () => {
  const d1 = base({ tubes: [{ id: 'A', mass: 1, usableHoles: [0] }] });
  const d2 = { ...d1, exclusions: [] };
  const d3 = { ...d1, exclusions: [{ a: 'A', b: 'B' }] };
  assert.equal(computeHash(d1), computeHash(d2));
  assert.notEqual(computeHash(d1), computeHash(d3));
});

// ---------- HTTP API ----------

test('未配置离心管时：非空避邻对因未知编号被拒绝，空列表可保存', async () => {
  let r = await call('PUT', '/api/exclusions', [{ a: 'X', b: 'Y' }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('未知'));
  r = await call('PUT', '/api/exclusions', []);
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('准备：配置转子与离心管', async () => {
  let r = await call('PUT', '/api/config', cfg);
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/tubes', [
    tube('A', 50),
    tube('B', 50),
    tube('C', 50),
    tube('D', 50),
  ]);
  assert.equal(r.status, 200);
});

test('保存避邻对（自动规范化），state 与 GET 均可查看', async () => {
  const r = await call('PUT', '/api/exclusions', [{ a: 'B', b: 'A' }]); // 颠倒输入
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.exclusions, [{ a: 'A', b: 'B' }]);
  const g = await call('GET', '/api/exclusions');
  assert.deepEqual(g.json, [{ a: 'A', b: 'B' }]);
  const s = await call('GET', '/api/state');
  assert.deepEqual(s.json.data.exclusions, [{ a: 'A', b: 'B' }]);
});

test('未知编号 / 自配对 / 重复配对（含颠倒）/ 非法结构整次拒绝且不留部分数据', async () => {
  let r = await call('PUT', '/api/exclusions', [{ a: 'A', b: 'ZZ' }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('未知'));

  r = await call('PUT', '/api/exclusions', [{ a: 'A', b: 'A' }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('自身'));

  r = await call('PUT', '/api/exclusions', [
    { a: 'A', b: 'B' },
    { a: 'B', b: 'A' },
  ]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('重复'));

  r = await call('PUT', '/api/exclusions', [{ a: 'A' }]);
  assert.equal(r.status, 400);

  r = await call('PUT', '/api/exclusions', 'not-an-array');
  assert.equal(r.status, 400);

  // 既有规则未被任何失败请求破坏
  const g = await call('GET', '/api/exclusions');
  assert.deepEqual(g.json, [{ a: 'A', b: 'B' }]);
});

test('草稿按避邻规则求解；规则变化使草稿标记过期', async () => {
  let r = await call('POST', '/api/solve');
  assert.equal(r.json.feasible, true);
  const arr = r.json.result.arrangement;
  const ha = arr.findIndex((s) => s && s.ref === 'A');
  const hb = arr.findIndex((s) => s && s.ref === 'B');
  assert.ok(!adjacent(ha, hb, 4));

  let s = await call('GET', '/api/state');
  assert.equal(s.json.draft.stale, false);
  await call('PUT', '/api/exclusions', [{ a: 'A', b: 'C' }]);
  s = await call('GET', '/api/state');
  assert.equal(s.json.draft.stale, true);
  await call('PUT', '/api/exclusions', [{ a: 'A', b: 'B' }]);
});

let pubId;

test('发布冻结规则与装载图；规则变化使旧图不可用但不改写，改回后恢复可用', async () => {
  await call('POST', '/api/solve');
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  pubId = pub.json.id;
  // 冻结快照含避邻规则
  assert.deepEqual(pub.json.config.exclusions, [{ a: 'A', b: 'B' }]);
  // 冻结图本身满足避邻
  const arr = pub.json.result.arrangement;
  const ha = arr.findIndex((s) => s && s.ref === 'A');
  const hb = arr.findIndex((s) => s && s.ref === 'B');
  assert.ok(!adjacent(ha, hb, 4));

  // 规则变化 → 旧图不可用于当前装载，内容保持冻结不变
  await call('PUT', '/api/exclusions', [{ a: 'A', b: 'C' }]);
  let list = await call('GET', '/api/publications');
  assert.equal(list.json.find((p) => p.id === pubId).usable, false);
  const detail = await call('GET', `/api/publications/${pubId}`);
  assert.deepEqual(detail.json.result, pub.json.result);
  assert.deepEqual(detail.json.config.exclusions, [{ a: 'A', b: 'B' }]);

  // 规则改回 → 仍按原规则判定为可用
  await call('PUT', '/api/exclusions', [{ a: 'A', b: 'B' }]);
  list = await call('GET', '/api/publications');
  assert.equal(list.json.find((p) => p.id === pubId).usable, true);
});

test('清空规则后按无规则判定：带规则的旧发布不可用，新发布照常可用', async () => {
  await call('PUT', '/api/exclusions', []);
  const g = await call('GET', '/api/exclusions');
  assert.deepEqual(g.json, []);
  let list = await call('GET', '/api/publications');
  assert.equal(list.json.find((p) => p.id === pubId).usable, false);

  const r = await call('POST', '/api/solve');
  assert.equal(r.json.feasible, true);
  const pub2 = await call('POST', '/api/publish');
  assert.equal(pub2.status, 201);
  list = await call('GET', '/api/publications');
  assert.equal(list.json.find((p) => p.id === pub2.json.id).usable, true);
});

test('替换离心管若留下失效避邻对：整次拒绝并保留原数据；先删对后可替换', async () => {
  await call('PUT', '/api/exclusions', [{ a: 'A', b: 'B' }]);
  const before = await call('GET', '/api/state');

  // 新列表移除了 A（避邻对仍指向 A）→ 整次拒绝
  const r = await call('PUT', '/api/tubes', [tube('B', 50), tube('C', 50), tube('D', 50)]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('避邻对'));
  const afterState = await call('GET', '/api/state');
  assert.deepEqual(afterState.json.data.tubes, before.json.data.tubes);
  assert.deepEqual(afterState.json.data.exclusions, [{ a: 'A', b: 'B' }]);

  // 先删除避邻对，再替换 → 允许
  const r2 = await call('PUT', '/api/exclusions', []);
  assert.equal(r2.status, 200);
  const r3 = await call('PUT', '/api/tubes', [tube('B', 50), tube('C', 50), tube('D', 50)]);
  assert.equal(r3.status, 200, JSON.stringify(r3.json));
});

test('避邻冲突无解时 API 说明原因且不能发布', async () => {
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50), tube('C', 50), tube('D', 50)]);
  await call('PUT', '/api/exclusions', [
    { a: 'A', b: 'B' },
    { a: 'A', b: 'C' },
    { a: 'A', b: 'D' },
  ]);
  const r = await call('POST', '/api/solve');
  assert.equal(r.json.feasible, false);
  assert.ok(r.json.reasons.join(' ').includes('避邻'));
  const p = await call('POST', '/api/publish');
  assert.equal(p.status, 400);
  assert.ok(p.json.errors.join(' ').includes('避邻'));
  await call('PUT', '/api/exclusions', []);
});

test('配置避邻规则时发布与现场核验流程照常', async () => {
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50), tube('C', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 1 }]);
  await call('PUT', '/api/exclusions', [{ a: 'A', b: 'B' }]);
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));

  const v = await call('POST', '/api/verifications', { publicationId: pub.json.id });
  assert.equal(v.status, 201, JSON.stringify(v.json));
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const put = await call('PUT', `/api/verifications/${v.json.id}`, { version: 1, entries });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const done = await call('POST', `/api/verifications/${v.json.id}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.completed, true);

  // 清理：恢复无规则、无配重状态
  await call('PUT', '/api/exclusions', []);
  await call('PUT', '/api/weights', []);
});
