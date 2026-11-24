// dsh-memory-garden · 记忆花园
//
// 给 DSH 用的「自生长」记忆：骨架默认是空的，靠聊天慢慢长出三块档案
// （关于你 / 关于我 / 我们之间）。所有数据都是工作区里的 md / json，
// 能读、能手改、能拷走。
//
// 它做四件事：
//   1. 铺骨架：/memory init 建好 人设 / 档案 / 存档 / 交接 / 日记 / 原文 / 索引 / 纠错
//   2. 开局索引：每轮注入一小块状态（积压多少条、今天日记写没写、上次提炼几天前）
//   3. 压缩前落款：会话压缩时往 交接.md 追一条机械快照，不覆盖人写的
//   4. 自生长：模型看到「积压够了」就自己总结，调 memory_grow 写进三块档案
//
// 它不做的：不替用户调模型（提炼由当前模型自己做，插件只负责存和提示）、
// 不做备份、不加密。

import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, renameSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export const name = 'memory-garden'
export const inject = ['systemPrompt']

const DEFAULTS = {
  dir: '记忆花园',
  index: { enabled: true, order: 240, maxChars: 1400 },
  snapshot: { enabled: true, scanHours: 6 },
  grow: { threshold: 20, maxPerBlock: 14, maxCharsPerItem: 120 },
  cwd: '',
  debug: false,
}

const 人设模板 = `# 人设（骨架）

> 只写「她本来是谁」：名字、自称、语气、底线。这里是手写的，不会自动长。
> 留空也行，用默认值。

- 名字：
- 自称：我
- 语气：温柔

## 用户改的

（还没改过）
`

const 存档模板 = `# 记忆存档（世界观）

> 从日记里沉淀出来的结论，分两段。可以手改，也可以让模型重写。

## 【稳定的】他是什么样的人、我们约定过什么

（还空着）

## 【在变的】最近的状态、新的经历

（还空着）
`

const 交接模板 = `# 交接

> 换会话、压缩前，把「手上在做什么」写在这儿。插件也会往里落机械快照。

（还空着）
`

const 纠错模板 = `# 纠错

> 用户纠正过你的原话。存原文，不改写；「当时」是当时的理解。

（还空着）
`

function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = base ? base[k] : undefined
    out[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? merge(cur && typeof cur === 'object' ? cur : {}, v)
      : v
  }
  return out
}
const pad = n => String(n).padStart(2, '0')
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`

function readIf(path) { try { return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null } catch { return null } }
function writeAtomic(path, text) {
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}
function readJson(path, fallback) {
  try { const t = readIf(path); if (!t) return fallback; return JSON.parse(t) } catch { return fallback }
}
function writeJson(path, obj) { writeAtomic(path, JSON.stringify(obj, null, 1)) }

export function paths(cwd, cfg) {
  const root = join(resolve(cwd), cfg.dir)
  return {
    root,
    persona: join(root, '人设.md'),
    files: join(root, '档案.json'),
    canon: join(root, '存档.md'),
    handoff: join(root, '交接.md'),
    diary: join(root, '日记'),
    raw: join(root, '原文'),
    index: join(root, '索引.json'),
    fix: join(root, '纠错.md'),
    state: join(root, '状态.json'),
  }
}

export function initSkeleton(cwd, cfg, force = false) {
  const p = paths(cwd, cfg)
  const created = [], skipped = []
  mkdirSync(p.diary, { recursive: true })
  mkdirSync(p.raw, { recursive: true })
  const put = (path, rel, text) => {
    if (existsSync(path) && !force) { skipped.push(rel); return }
    writeAtomic(path, text); created.push(rel)
  }
  put(p.persona, '人设.md', 人设模板)
  put(p.canon, '存档.md', 存档模板)
  put(p.handoff, '交接.md', 交接模板)
  put(p.fix, '纠错.md', 纠错模板)
  if (!existsSync(p.files)) { writeJson(p.files, { 关于你: [], 关于我: [], 我们之间: [] }); created.push('档案.json') }
  else skipped.push('档案.json')
  if (!existsSync(p.index)) { writeJson(p.index, {}); created.push('索引.json') } else skipped.push('索引.json')
  if (!existsSync(p.state)) { writeJson(p.state, { pending: 0, lastGrow: '', turns: 0 }); created.push('状态.json') } else skipped.push('状态.json')
  return { created, skipped }
}

function diaryDays(p) {
  try { return readdirSync(p.diary).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() } catch { return [] }
}

export function buildIndex(cwd, cfg) {
  const p = paths(cwd, cfg)
  const canon = readIf(p.canon) || ''
  const handoff = readIf(p.handoff) || ''
  const 档案 = readJson(p.files, null)
  const st = readJson(p.state, { pending: 0, lastGrow: '', turns: 0 })
  const days = diaryDays(p)
  const today = ymd(new Date()) + '.md'
  const 块 = 档案 ? Object.keys(档案) : []
  const 条数 = 档案 ? 块.reduce((a, k) => a + (档案[k] || []).length, 0) : 0
  const 天前 = st.lastGrow ? Math.floor((Date.now() - Date.parse(st.lastGrow + 'T00:00:00')) / 86400000) : null
  const lines = [
    '[记忆花园]',
    `档案：${条数} 条（${块.map(k => `${k}${(档案[k] || []).length}`).join(' / ') || '空'}）`,
    `存档：${canon ? canon.length + ' 字' : '没有'}｜交接：${handoff ? handoff.length + ' 字' : '没有'}`,
    `日记：${days.length} 篇，今天${days.includes(today) ? '已写' : '还没写'}`,
    `积压：${st.pending || 0} 条${天前 == null ? '' : `｜上次长档案：${天前} 天前`}`,
  ]
  const 人设 = readIf(p.persona)
  const 用户段 = 人设 && 人设.includes('## 用户改的') ? 人设.split('## 用户改的')[1].trim() : ''
  const 改条数 = (用户段.match(/^- \[/gm) || []).length
  if (改条数) lines.push(`人设：用户改过 ${改条数} 条${st.lastPersona ? `（最近 ${st.lastPersona}）` : ''}`)
  if ((st.pending || 0) >= (cfg.grow.threshold || 20)) {
    lines.push('→ 攒够了：用 memory_grow 把新认识的写进三块档案（关于你/关于我/我们之间），写完插件会把积压清零。')
  }
  if (days.length && !days.includes(today)) lines.push('→ 今天的日记还没写，收工时记得补。')
  let text = lines.join('\n')
  if (text.length > (cfg.index.maxChars || 1400)) text = text.slice(0, cfg.index.maxChars) + '…'
  return text
}

export function searchGarden(cwd, cfg, q, limit = 4) {
  const p = paths(cwd, cfg)
  const query = String(q || '').trim()
  if (!query) return { hits: [], text: '给个词' }
  const 词 = query.split(/[\s，。、？！,?!]+/).filter(w => w.length >= 2)
  const 命中 = []
  // 日期说法
  const m = query.match(/(\d{1,2})\s*[月\-/]\s*(\d{1,2})/)
  for (const f of diaryDays(p)) {
    if (m && +f.slice(5, 7) === +m[1] && +f.slice(8, 10) === +m[2]) 命中.push({ kind: '日记', day: f, text: readIf(join(p.diary, f)) || '' })
  }
  const 索引 = readJson(p.index, {})
  for (const f of diaryDays(p)) {
    if (命中.some(h => h.day === f)) continue
    const it = 索引[f.replace(/\.md$/, '')] || {}
    const tags = (it.tags || []).join(' ')
    const body = readIf(join(p.diary, f)) || ''
    const score = 词.reduce((a, w) => a + (tags.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0), 0)
    if (score) 命中.push({ kind: '日记', day: f, text: body, score })
  }
  命中.sort((a, b) => (b.score || 0) - (a.score || 0))
  const 纠 = readIf(p.fix) || ''
  const 纠行 = 纠.split('\n').filter(ln => ln.trim() && !ln.trim().startsWith('>') && 词.some(w => ln.includes(w))).slice(0, 5)
  const out = 命中.slice(0, limit).map(h => `${h.day}：${h.text.replace(/\n+/g, ' ').slice(0, 300)}`)
  const text = [
    out.length ? out.join('\n') : '日记里没翻到。',
    纠行.length ? '纠错记录：\n' + 纠行.map(x => '· ' + x.trim().slice(0, 120)).join('\n') : '',
  ].filter(Boolean).join('\n\n')
  return { hits: 命中.slice(0, limit), text }
}

export function growFiles(cwd, cfg, 块, items) {
  const p = paths(cwd, cfg)
  const 档案 = readJson(p.files, { 关于你: [], 关于我: [], 我们之间: [] })
  const 合法 = ['关于你', '关于我', '我们之间']
  if (!合法.includes(块)) return { ok: false, text: `块名只能是 ${合法.join(' / ')}` }
  if (!Array.isArray(items) || !items.length) return { ok: false, text: '没给条目' }
  const arr = 档案[块] || (档案[块] = [])
  let 加 = 0, 跳 = 0
  for (const it of items) {
    const t = String((it && (it.text || it)) || '').trim().slice(0, cfg.grow.maxCharsPerItem || 120)
    if (!t) continue
    if (arr.some(x => String(x.text || '').trim() === t)) { 跳++; continue }
    arr.push({ text: t, from: 'chat', at: ymd(new Date()) })
    加++
  }
  while (arr.length > (cfg.grow.maxPerBlock || 14)) arr.shift()
  writeJson(p.files, 档案)
  const st = readJson(p.state, { pending: 0, lastGrow: '', turns: 0 })
  if (加) { st.pending = 0; st.lastGrow = ymd(new Date()) }
  writeJson(p.state, st)
  return { ok: true, text: `${块}：加 ${加} 条，重复跳过 ${跳} 条（现在 ${arr.length} 条）` }
}

const 人格追加 = /-人格编辑追加[：:]?\s*([\s\S]*?)-人格编辑结束/g
const 人格替换 = /-人格编辑替换[：:]?\s*([\s\S]*?)-人格编辑结束/g

/** 聊天里现场改人设：-人格编辑追加：…-人格编辑结束 / -人格编辑替换…-人格编辑结束 */
export function editPersona(cwd, cfg, text) {
  const raw = String(text || '')
  const 任务 = []
  for (const m of raw.matchAll(人格追加)) 任务.push({ 模式: '追加', 内容: m[1].trim() })
  for (const m of raw.matchAll(人格替换)) 任务.push({ 模式: '替换', 内容: m[1].trim() })
  if (!任务.length) return { 动了: false, 条数: 0, 模式: '' }
  const p = paths(cwd, cfg)
  const 标 = '## 用户改的'
  let ps = readIf(p.persona)
  if (!ps) ps = 人设模板
  if (!ps.includes(标)) ps = ps.trimEnd() + '\n\n' + 标 + '\n'
  let [头, 尾] = ps.split(标)
  let 几条 = 0, 最近模式 = ''
  for (const t of 任务) {
    if (!t.内容) continue
    const 条目 = `- [${ymd(new Date())}] ${t.内容.replace(/\n/g, ' ') }`
    if (t.模式 === '追加') {
      尾 = (尾 || '').trim() && !(尾 || '').includes('（还没改过）') ? (尾.trim() + '\n' + 条目) : 条目
    } else {
      尾 = 条目
    }
    几条++; 最近模式 = t.模式
  }
  writeAtomic(p.persona, (头 + 标 + '\n\n' + 尾.trim() + '\n'))
  const st = readJson(p.state, { pending: 0, lastGrow: '', turns: 0 })
  st.lastPersona = ymd(new Date())
  writeJson(p.state, st)
  return { 动了: true, 条数: 几条, 模式: 最近模式 }
}

export function writeSnapshot(cwd, cfg, sessionId = '') {
  const p = paths(cwd, cfg)
  const 现在 = new Date()
  const 日 = diaryDays(p)
  const canon = readIf(p.canon) || ''
  const 行 = [
    '',
    `## 机制落款 ${ymd(现在)} ${hm(现在)}`,
    `- 工作区：${resolve(cwd)}`,
    `- 会话：${sessionId || '（不知道）'}`,
    `- 存档：${canon ? canon.length + ' 字' : '没有'}`,
    `- 日记：${日.length} 篇，今天${日.includes(ymd(现在) + '.md') ? '已写' : '还没写'}`,
  ].join('\n')
  try { writeFileSync(p.handoff, 行 + '\n', { flag: 'a' }) } catch { return false }
  return true
}

function eventText(event) {
  try {
    const d = (event && event.data) || {}
    const parts = (d.content || []).filter(c => c && c.type === 'text').map(c => c.text || '')
    if (parts.length) return parts.join('\n')
    if (typeof d.text === 'string') return d.text
    if (typeof event.text === 'string') return event.text
  } catch {}
  return ''
}

export function apply(ctx, config = {}) {
  const cfg = merge(DEFAULTS, config)
  const cwdBySession = new Map()
  let lastCwd = ''

  const noteCwd = (session) => {
    if (!session) return lastCwd
    const c = cfg.cwd ? resolve(cfg.cwd) : (session.cwd ? resolve(session.cwd) : '')
    if (!c) return lastCwd
    const id = String(session.id || session.sessionId || '')
    if (id) cwdBySession.set(id, c)
    lastCwd = c
    return c
  }
  const cwdFor = (scope) => {
    try {
      const key = scope && (scope.sessionId || scope.session || scope.id || scope.key)
      if (key && cwdBySession.has(String(key))) return cwdBySession.get(String(key))
    } catch {}
    return cfg.cwd ? resolve(cfg.cwd) : (lastCwd || process.cwd())
  }

  // 1) 开局索引
  try {
    if (cfg.index.enabled && ctx.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
      ctx.effect(() => ctx.systemPrompt.context({
        name: 'memory-garden-index',
        order: Number(cfg.index.order) || 240,
        text: (assembly) => {
          try { return buildIndex(cwdFor(assembly && assembly.scope), cfg) }
          catch (e) { return '[记忆花园] 索引读不出来：' + (e && e.message) }
        },
      }))
    }
  } catch (e) { console.error('[garden] 索引没挂上：', e && e.message) }

  // 2) 计数 + 压缩前落款
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/created', (s) => { try { noteCwd(s) } catch {} })
      ctx.on('session/event', (session, event) => {
        try {
          const cwd = noteCwd(session)
          if (!cwd) return
          if (event && event.type === 'compaction/start' && cfg.snapshot.enabled) {
            writeSnapshot(cwd, cfg, String((session && (session.id || session.sessionId)) || ''))
            console.error('[garden] 压缩前落款：', cwd)
          }
          if (event && (event.type === 'user/message' || event.type === 'assistant/message')) {
            const p = paths(cwd, cfg)
            const st = readJson(p.state, { pending: 0, lastGrow: '', turns: 0 })
            st.pending = (st.pending || 0) + 1
            st.turns = (st.turns || 0) + 1
            writeJson(p.state, st)
            if (event.type === 'user/message') {
              const 文 = eventText(event)
              if (文 && 文.includes('-人格编辑')) {
                const r = editPersona(cwd, cfg, 文)
                if (r.动了) console.error(`[garden] 人设${r.模式}：${r.条数} 条`)
              }
            }
          }
        } catch (e) { if (cfg.debug) console.error('[garden] 事件处理失败：', e && e.message) }
      })
    }
  } catch (e) { console.error('[garden] 钩子没挂上：', e && e.message) }

  const resolveCwdFromExec = (exec) => {
    try {
      const id = exec && exec.agent && String(exec.agent.id || '')
      if (id && cwdBySession.has(id)) return cwdBySession.get(id)
      const c = exec && exec.agent && (exec.agent.cwd || (exec.agent.session && exec.agent.session.cwd))
      if (c) return resolve(c)
    } catch {}
    return cfg.cwd ? resolve(cfg.cwd) : (lastCwd || process.cwd())
  }

  const whenReady = (deps, fn) => {
    const run = (c) => { try { fn(c || ctx) } catch (e) { console.error('[garden] 挂载失败：', e && e.message) } }
    try { if (typeof ctx.inject === 'function') return ctx.inject(deps, (c) => run(c)) } catch {}
    run(ctx)
  }

  const textOut = (v) => [{ type: 'text', text: String((v && v.text) || '') }]
  const sch = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } }

  const registerTools = (c) => {
    try {
      const tools = typeof c.get === 'function' ? c.get('tools') : undefined
      if (!tools || typeof tools.register !== 'function') return

      tools.register({
        name: 'memory_init',
        description: '在当前工作区铺一份记忆花园的骨架（人设/档案/存档/交接/日记/原文/索引/纠错）。默认不覆盖已有文件。',
        parameters: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } },
        output: { schema: sch, render: (_a, v) => textOut(v) },
        async execute(args, exec) {
          try {
            const cwd = resolveCwdFromExec(exec)
            const r = initSkeleton(cwd, cfg, Boolean(args && args.force))
            return { ok: true, text: `工作区：${cwd}\n新建：${r.created.join('、') || '无'}\n跳过：${r.skipped.join('、') || '无'}` }
          } catch (e) { return { ok: false, text: '铺骨架失败：' + (e && e.message) } }
        },
      })

      tools.register({
        name: 'memory_status',
        description: '看一眼记忆花园的状态：档案几条、日记几篇、积压多少、今天写没写。只读。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: sch, render: (_a, v) => textOut(v) },
        async execute(_a, exec) {
          try { return { ok: true, text: buildIndex(resolveCwdFromExec(exec), cfg) } }
          catch (e) { return { ok: false, text: '读不出来：' + (e && e.message) } }
        },
      })

      tools.register({
        name: 'memory_search',
        description: '按关键词或日期（「11月19」）翻旧日记和纠错记录，返回命中的片段。查不到就明说。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { q: { type: 'string', description: '关键词或日期' } },
          required: ['q'],
        },
        output: { schema: sch, render: (_a, v) => textOut(v) },
        async execute(args, exec) {
          try {
            const r = searchGarden(resolveCwdFromExec(exec), cfg, args && args.q)
            return { ok: true, text: r.text }
          } catch (e) { return { ok: false, text: '搜失败：' + (e && e.message) } }
        },
      })

      tools.register({
        name: 'memory_grow',
        description: '把新认识写进三块档案之一。块名只会是「关于你 / 关于我 / 我们之间」，条目是短句，重复会自动跳过，写完积压清零。',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            块: { type: 'string', enum: ['关于你', '关于我', '我们之间'] },
            items: { type: 'array', items: { type: 'string' }, description: '要加的短句' },
          },
          required: ['块', 'items'],
        },
        output: { schema: sch, render: (_a, v) => textOut(v) },
        async execute(args, exec) {
          try {
            const r = growFiles(resolveCwdFromExec(exec), cfg, args && args.块, args && args.items)
            return { ok: Boolean(r.ok), text: r.text }
          } catch (e) { return { ok: false, text: '写档案失败：' + (e && e.message) } }
        },
      })
    } catch (e) { console.error('[garden] 工具没挂上：', e && e.message) }
  }

  const registerCommands = (c) => {
    try {
      const commands = typeof c.get === 'function' ? c.get('commands') : undefined
      if (!commands || typeof commands.register !== 'function') return
      const dispose = commands.register({
        name: 'memory',
        description: '记忆花园：init 铺骨架 / status 看状态 / search 关键词',
        handler: async (调用) => {
          try {
            const cwd = resolveCwdFromExec(调用)
            const arg = String((调用 && (调用.args || 调用.arguments || '')) || '').trim()
            if (arg.startsWith('init')) {
              const r = initSkeleton(cwd, cfg, false)
              return { kind: 'success', text: `铺好了：新建 ${r.created.join('、') || '无'}；跳过 ${r.skipped.join('、') || '无'}` }
            }
            if (arg.startsWith('search')) {
              const q = arg.replace(/^search\s*/, '')
              return { kind: 'success', text: searchGarden(cwd, cfg, q).text }
            }
            return { kind: 'success', text: buildIndex(cwd, cfg) }
          } catch (e) { return { kind: 'error', text: '失败：' + (e && e.message) } }
        },
      })
      if (typeof dispose === 'function') ctx.effect(() => dispose)
    } catch (e) { console.error('[garden] 命令没挂上：', e && e.message) }
  }

  whenReady(['tools'], registerTools)
  whenReady(['commands'], registerCommands)
}

export const __test = { merge, initSkeleton, buildIndex, searchGarden, growFiles, writeSnapshot, editPersona, paths, ymd }
