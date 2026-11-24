# dsh-memory-garden · 记忆花园

给 DeepSeek Harness 用的**自生长记忆**插件。

骨架默认是空的，靠聊天慢慢长出三块档案——**关于你 / 关于我 / 我们之间**。所有数据都是工作区里的 md / json：能读、能手改、能拷走，换机器也不丢。

## 它做什么

1. **铺骨架**：`memory_init` 或 `/memory init`，建好
   ```
   记忆花园/
     人设.md      手写：名字、自称、语气
     档案.json    自生长：关于你 / 关于我 / 我们之间
     存档.md      世界观：稳定 / 在变
     交接.md      换会话时写「手上在做什么」；压缩前插件会追一条机械快照
     日记/        一天一篇
     原文/        会话原文（可选，自己往里放）
     索引.json    日记标签
     纠错.md      用户纠正过你的原话
     状态.json    积压计数（自动维护）
   ```
2. **开局索引**：每轮注入一小块状态——档案几条、日记几篇、积压多少、今天写没写。不塞全文。
3. **自生长**：积压到阈值（默认 20 条）时，索引里会提示「攒够了」，模型用 `memory_grow` 把新认识写进档案；写完积压自动清零。
4. **压缩前落款**：会话压缩时往 `交接.md` 追加一条机械快照，**不覆盖**人写的那份。

## 它不做什么

- 不替用户调模型：提炼由当前模型自己做，插件只负责「存」和「提醒该长了」。
- 不做备份、不加密、不建库。

## 四个工具

| 工具 | 干什么 |
| --- | --- |
| `memory_init` | 铺骨架（已有文件不覆盖，`force: true` 才覆盖） |
| `memory_status` | 看状态：档案几条、日记几篇、积压多少 |
| `memory_search` | 按关键词或日期（`11月19`）翻旧日记和纠错 |
| `memory_grow` | 往「关于你/关于我/我们之间」写条目，自动去重、封顶、清零 |

命令：`/memory init`、`/memory search 关键词`、`/memory`（看状态）。

## 装

**从 npm（推荐）**

```bash
npm i -g dsh-memory-garden
# 或者装进某个 profile
dsh plugin --profile <你的profile> add dsh-memory-garden
```

**从源码**

```bash
git clone https://github.com/switch-ran/dsh-memory-garden
dsh plugin --profile <你的profile> add ./dsh-memory-garden
```

装完重载插件，第一件事在会话里说一句 `/memory init`。

## 配置

在 profile 里给插件传配置，例如：

```yaml
memory-garden:
  dir: 记忆花园
  grow:
    threshold: 20        # 攒多少条提示一次
    maxPerBlock: 14      # 每块最多几条，超了挤掉最老的
    maxCharsPerItem: 120
  index:
    maxChars: 1400
  snapshot:
    enabled: true
```

## 边界

- 默认**不预置任何人的记忆**，第一版打开就是空骨架——别人用不会看到我的。
- 日记和原文都是普通文件，想备份自己拷。
