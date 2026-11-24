import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __test as T } from '../index.mjs'

const cfg = { dir: '记忆花园', grow: { threshold: 20, maxPerBlock: 14, maxCharsPerItem: 120 }, index: { maxChars: 1400 } }
const newWs = () => mkdtempSync(join(tmpdir(), 'garden-'))

test('铺骨架：默认空，不覆盖已有', () => {
  const ws = newWs()
  const r1 = T.initSkeleton(ws, cfg)
  assert.ok(r1.created.includes('人设.md'))
  assert.ok(r1.created.includes('档案.json'))
  const p = T.paths(ws, cfg)
  assert.ok(existsSync(p.canon))
  assert.ok(existsSync(p.handoff))
  assert.ok(existsSync(p.fix))
  writeFileSync(p.canon, '改过的存档', 'utf8')
  const r2 = T.initSkeleton(ws, cfg)
  assert.ok(r2.skipped.includes('存档.md'))
  assert.equal(readFileSync(p.canon, 'utf8'), '改过的存档')
})

test('档案：加条目、去重、封顶、积压清零', () => {
  const ws = newWs()
  T.initSkeleton(ws, cfg)
  const p = T.paths(ws, cfg)
  const st = JSON.parse(readFileSync(p.state, 'utf8'))
  st.pending = 25
  writeFileSync(p.state, JSON.stringify(st), 'utf8')

  let r = T.growFiles(ws, cfg, '关于你', ['喜欢晚上写代码', '不喜欢被叫小助手'])
  assert.ok(r.ok)
  assert.match(r.text, /加 2 条/)
  r = T.growFiles(ws, cfg, '关于你', ['喜欢晚上写代码'])
  assert.match(r.text, /跳过 1 条/)
  const st2 = JSON.parse(readFileSync(p.state, 'utf8'))
  assert.equal(st2.pending, 0)
  const many = Array.from({ length: 30 }, (_, i) => '条目' + i)
  T.growFiles(ws, cfg, '关于我', many)
  const f = JSON.parse(readFileSync(p.files, 'utf8'))
  assert.ok(f['关于我'].length <= cfg.grow.maxPerBlock)
})

test('块名不合法要拒绝', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  const r = T.growFiles(ws, cfg, '关于他', ['x'])
  assert.equal(r.ok, false)
})

test('索引：带积压提示和今日日记状态', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  const p = T.paths(ws, cfg)
  const st = JSON.parse(readFileSync(p.state, 'utf8'))
  st.pending = 21
  writeFileSync(p.state, JSON.stringify(st), 'utf8')
  const t = T.buildIndex(ws, cfg)
  assert.match(t, /\[记忆花园\]/)
  assert.match(t, /积压：21/)
  assert.match(t, /攒够了/)
})

test('检索：按日期和关键词都能命中', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  const p = T.paths(ws, cfg)
  writeFileSync(join(p.diary, '2026-11-19.md'), '今天聊了音色和火山复刻', 'utf8')
  writeFileSync(join(p.diary, '2026-11-20.md'), '今天在弄新芽的三块档案', 'utf8')
  let r = T.searchGarden(ws, cfg, '11月19')
  assert.match(r.text, /2026-11-19/)
  r = T.searchGarden(ws, cfg, '新芽')
  assert.match(r.text, /2026-11-20/)
  r = T.searchGarden(ws, cfg, '完全不存在的东西')
  assert.match(r.text, /没翻到/)
})

test('压缩前落款：追加，不覆盖', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  const p = T.paths(ws, cfg)
  writeFileSync(p.handoff, '# 交接\n\n人写的', 'utf8')
  assert.ok(T.writeSnapshot(ws, cfg, 's-1'))
  const t = readFileSync(p.handoff, 'utf8')
  assert.match(t, /人写的/)
  assert.match(t, /机制落款/)
  assert.match(t, /s-1/)
})

test('merge 不炸', () => {
  const m = T.merge({ a: { b: 1 } }, { a: { c: 2 } })
  assert.equal(m.a.b, 1); assert.equal(m.a.c, 2)
})

test('人格编辑·追加：加一条，带日期', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  const p = T.paths(ws, cfg)
  const r = T.editPersona(ws, cfg, '随便聊两句 -人格编辑追加：以后说话短一点-人格编辑结束 继续聊')
  assert.equal(r.动了, true)
  assert.equal(r.模式, '追加')
  const ps = readFileSync(p.persona, 'utf8')
  assert.match(ps, /以后说话短一点/)
  assert.match(ps, /## 用户改的/)
})

test('人格编辑·替换：覆盖用户段，不动骨架', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  const p = T.paths(ws, cfg)
  T.editPersona(ws, cfg, '-人格编辑追加：旧的一条-人格编辑结束')
  T.editPersona(ws, cfg, '-人格编辑替换：只留这一条-人格编辑结束')
  const ps = readFileSync(p.persona, 'utf8')
  assert.ok(!ps.includes('旧的一条'))
  assert.match(ps, /只留这一条/)
  assert.match(ps, /名字/)            // 骨架还在
})

test('人格编辑：普通消息不动', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  const r = T.editPersona(ws, cfg, '今天天气不错')
  assert.equal(r.动了, false)
})

test('索引里能看到人设改过几条', () => {
  const ws = newWs(); T.initSkeleton(ws, cfg)
  T.editPersona(ws, cfg, '-人格编辑追加：说话短一点-人格编辑结束')
  const t = T.buildIndex(ws, cfg)
  assert.match(t, /人设：用户改过 1 条/)
})
