# 造浪者数据 v2 全量切换设计

## 目标

将网页和中文数据仓直接切换到按批次日分片的 v2 数据协议，修复当前中文仓路径、上游回填、静默失败、重复数据、空产物、外链安全、测试缺口和文档漂移问题。当前项目仍处于测试阶段，因此不保留旧 `data/feed-*.json` 协议或旧浏览器缓存的兼容读取逻辑。

## 约束

- 网页继续保持纯静态 HTML、CSS、JavaScript，无构建步骤、无运行时依赖、无后端。
- 数据管线继续使用 Node.js 22 和 GitHub Actions，不引入 npm 第三方依赖。
- 智谱 Key 只通过 GitHub Actions secret `ZHIPU_API_KEY` 注入；历史 Key 已失效，本次不处理历史重写。
- 所有日期分片使用北京时间日历日，格式固定为 `YYYY-MM-DD`。
- 第三方正文只通过 DOM `textContent` 或受限 Markdown 渲染展示；所有可点击 URL 只允许 `http:` 和 `https:`。
- 两个仓库分别保持独立 Git 历史；实现和测试不执行 push。

## 方案选择

采用直接切换方案，不保留旧 aggregate 文件：

- 删除 `data/feed-x.json`、`data/feed-podcasts.json`、`data/feed-blogs.json`。
- 新增轻量清单 `data/index.json`。
- 每个批次日写入一个 `data/days/YYYY-MM-DD.json`。
- 网页优先读取中文仓 v2 清单和所需日分片。
- 中文仓整体不可用时，网页降级读取上游当前快照；上游历史仍通过 commits API 回填。

此方案允许一次性清除旧数据中的重复项和空产物，并避免继续维护两套格式。

## 数据协议

### `data/index.json`

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-08-30T06:55:52.607Z",
  "days": [
    {
      "day": "2026-08-30",
      "path": "data/days/2026-08-30.json",
      "counts": { "x": 31, "podcasts": 1, "blogs": 0 }
    }
  ]
}
```

要求：

- `schemaVersion` 必须严格等于 `2`。
- `days` 按日期从新到旧排序，`day` 唯一。
- `path` 必须等于 `data/days/<day>.json`，不得包含绝对地址或路径穿越。
- `counts` 必须与对应日分片中的实际数量一致。

### `data/days/YYYY-MM-DD.json`

```json
{
  "schemaVersion": 2,
  "day": "2026-08-30",
  "generatedAt": "2026-08-30T06:55:52.607Z",
  "x": [
    {
      "id": "2093074288295481470",
      "handle": "example",
      "builder": "Example Builder",
      "bio": "",
      "text": "English text",
      "textZh": "中文译文",
      "createdAt": "2026-08-30T01:00:00.000Z",
      "url": "https://x.com/example/status/2093074288295481470",
      "likes": 0,
      "retweets": 0,
      "replies": 0
    }
  ],
  "podcasts": [],
  "blogs": []
}
```

要求：

- 三类内容统一为扁平数组；推文不再使用“构建者→tweets”两层归档结构。
- 唯一键分别为推文 `id`、播客 `guid`、博客 `url`。
- 分片内和所有分片之间均不得出现重复唯一键。
- `day` 是采集批次日，不以内容发布时间重新分组。
- 英文原文始终保留。
- 最近三天内的推文必须有非空 `textZh`；播客必须有非空 `titleZh` 和 `summaryZh`；博客必须有非空 `titleZh`、`summaryZh`，正文非空时还必须有非空 `contentZh`。
- 三天窗口之外允许保留缺少中文字段的历史内容，但数据验证器必须明确报告为警告而不是错误。

## 数据仓结构

数据仓调整为：

```text
zaolangzhe-data/
├── data/
│   ├── index.json
│   └── days/
│       └── YYYY-MM-DD.json
├── pipeline/
│   ├── process.js
│   ├── contract.js
│   └── migrate-v2.js
├── scripts/
│   └── validate-data.js
├── test/
│   ├── contract.test.js
│   └── pipeline.test.js
├── state/
│   └── processed.json
├── package.json
└── .github/workflows/pipeline.yml
```

### `pipeline/contract.js`

提供不产生副作用的纯函数：

- `itemKey(kind, item)`：返回稳定唯一键，无键时抛错。
- `richnessScore(kind, item)`：按中文字段完整度和正文完整度评分。
- `dedupeItems(kind, items)`：同键冲突时保留评分更高的记录；评分相同时保留较新的输入。
- `validateDayFile(value, options)`：校验 schema、日期、字段、URL、唯一键和近期中文覆盖。
- `buildIndex(dayFiles, generatedAt)`：生成排序后的 v2 清单。
- `validateIndex(index, dayFiles)`：校验路径、计数、排序和跨日唯一性。
- `beijingDay(ms)`：使用固定 `Asia/Shanghai` 语义生成批次日，不依赖 runner 或浏览器本地时区。

### `pipeline/migrate-v2.js`

一次性读取旧三个 aggregate 文件，将内容按 `batchDay` 扁平化、去重后写入日分片和清单。迁移成功并经过验证后删除旧 aggregate 文件和 `digest/` 目录。

现有重复博客 URL 应保留中文字段更完整的副本；如果多个副本分别含有互补字段，则先按非空字段合并，再以丰富度评分决定冲突字段。

### `pipeline/process.js`

管线直接读写 v2 日分片：

1. 读取并验证现有 `index.json` 及全部列出的日分片。
2. 拉取上游当前快照或指定历史快照。
3. 计算北京时间 `batchDay`，将新内容合并到对应日分片。
4. 在 AI 调用前建立“新增 + 最近三天缺失中文字段”的完整工作队列。
5. `--dry-run` 在队列建立和数据校验后退出，输出新增、自愈、重复和缺失字段统计，不调用 AI、不写文件。
6. AI 返回内容必须通过非空和类型验证；失败项不标记完成，下次运行继续处理。
7. 每批 AI 工作完成后将受影响日分片写入同目录临时文件，验证通过后原子重命名。
8. 所有工作完成后重新生成并验证 `index.json`，再原子替换正式清单。
9. 只 purge `data/index.json` 和本轮变更的日分片。

日报生成、`digest/` 文件和 `state.digests` 全部移除。

## 网页数据层

新增 `data-core.js`，通过普通 `<script>` 在浏览器提供 `window.FBDataCore`，同时通过 CommonJS 导出供 Node 测试使用。它只包含纯逻辑：

- v2 index 和 day file 校验。
- 来源 URL 构造。
- 内容唯一键和丰富度去重。
- HTTP/HTTPS URL 白名单。
- 完整数据包判定和错误聚合。

`app.js` 保留 DOM、状态和交互逻辑，并改为以下加载流程：

1. 请求中文仓 `data/index.json`。
2. 根据设置的 7/14/30 天深度选择清单中的日期。
3. 以有限并发加载对应日分片；首次加载至少要拿到最新一天，其他日期失败时显示明确的部分失败提示。
4. 校验后合并到内存 DB；同键冲突保留中文字段更完整的记录。
5. 中文仓清单或最新日分片不可用时，降级到上游三个根目录 feed。
6. 上游三类 feed 必须全部成功才视为完整当前快照；任何一类失败都报告错误，不再静默接受残缺包。
7. 上游模式下历史回填显式使用 `UPSTREAM_REPO`，分别显示成功和失败数；零成功时视为失败。
8. 所有来源均失败时抛出错误，不更新 `lastRefresh`，首次加载显示重试按钮，已有缓存时保留缓存并显示非阻断提示。

浏览器缓存键升级为 `fb.web.v5`。不读取 v4 数据，避免旧 aggregate 结构污染 v2 状态。

## 镜像与错误处理

- 镜像冷却键统一为 `<repo>|<mirror>`，读取、写入、删除使用同一函数生成。
- 镜像活动状态按仓库记录，防止中文仓的一次成功影响上游仓排序。
- 每个请求保留 12 秒超时。
- 用户手动锁定单一镜像时不自动切换另一镜像，但错误信息必须包含仓库、路径和 HTTP 状态。
- 部分日期失败不清除已成功加载的内容；最新日期失败则触发上游降级。

## 安全与无障碍

- 推文、播客、博客、Markdown 链接统一调用同一个 URL 白名单函数。
- 不合法 URL 不设置 `href`，对应按钮或链接隐藏。
- 抽屉、设置面板、阅读器打开时：记录原焦点、将焦点移入、限制 Tab 循环、设置 `aria-expanded` 或 `aria-hidden`。
- 关闭时恢复原焦点；Esc 行为保持现有优先级。
- 移除 `about.html` 中重复的内联 `onerror` 属性，统一使用一个安全的图片回退处理函数。

## 自动化与测试

两个仓库均使用 Node 内置 `node:test`，不增加安装步骤。

### 数据仓测试

- 唯一键重复时保留字段更完整的记录。
- 互补重复记录正确合并。
- 北京日历日在 UTC 边界前后保持正确。
- 空中文字段、空索引、错误计数、跨日重复被验证器拒绝。
- dry-run 能报告现有缺失译文但不写文件。
- AI 空响应不会产生成功状态或正式文件。
- 原子写入失败时旧正式文件保持完整。
- 迁移后的实际仓库数据通过 schema、唯一键和计数验证。

### 网页测试

- 中文仓 URL 使用 `data/index.json` 和 `data/days/...`。
- 上游 URL 仍使用根目录 `feed-*.json`。
- 最新中文分片失败时降级到上游。
- 上游任一 feed 失败时整个快照失败。
- 全部失败时不更新 `lastRefresh`。
- 回填 URL 始终包含 `zarazhangrui/follow-builders`。
- 回填全部失败时显示失败而不是完成。
- 冷却键按仓库隔离。
- `javascript:`、`data:` 和畸形 URL 被拒绝。
- 现有 16 项浏览器交互测试继续通过，并新增焦点管理断言。
- 增加跨仓契约测试，直接读取相邻 `zaolangzhe-data/data/index.json` 和日分片；如果相邻仓库不存在则明确跳过并输出原因，CI 中通过 checkout 第二仓保证必跑。

### GitHub Actions

数据仓 workflow 顺序调整为：

1. checkout。
2. setup Node 22。
3. `npm test`。
4. 运行管线。
5. `npm run validate:data`。
6. 仅在全部通过后 commit 和 push。

网页仓新增 CI，运行 Node 单元测试和现有浏览器测试。Actions 使用固定提交 SHA，并在注释中保留对应版本号，降低供应链漂移风险。

## 文档与清理

- 两仓添加标准 MIT `LICENSE`。
- 网页 README 更新为 v2 分片数据流、默认 7 天、缓存 v5，并删除 AI 日报描述。
- 数据仓 README 更新 v2 schema、调度时间、dry-run 与验证命令。
- 关于页默认深度改为 7 天。
- 删除日报卡片、AI 输入框等已无引用的 CSS。
- 删除 `digest/`、旧 aggregate 文件和 `state.digests`。

## 验收标准

- 全新浏览器首次加载时直接显示中文仓最新日期内容，不产生旧根路径 404。
- 中文仓不可用时可以在明确提示后展示完整上游当前快照。
- 7/14/30 天设置只下载相应数量的日分片。
- 当前数据中所有唯一键无重复，最近三天中文字段符合规则。
- 所有外链只允许 HTTP/HTTPS。
- dry-run 能准确报告新增和自愈队列且工作树无变化。
- 两仓语法检查、单元测试、数据验证和浏览器功能测试全部通过。
- 两个仓库最终只包含任务相关修改，不包含临时文件、浏览器配置或测试截图。
