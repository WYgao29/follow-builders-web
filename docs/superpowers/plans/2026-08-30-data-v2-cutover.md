# 造浪者数据 v2 全量切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将网页与中文数据仓直接切换为按北京时间批次日分片的 v2 协议，并修复数据加载、回填、校验、安全、无障碍、CI 和文档问题。

**Architecture:** 数据仓通过纯函数契约层生成和校验 `data/index.json` 与 `data/days/YYYY-MM-DD.json`，管线只原子写入受影响分片。网页通过可在浏览器和 Node 中共用的 `data-core.js` 加载中文分片，失败时完整降级到上游当前快照；DOM 交互仍保留在 `app.js`。

**Tech Stack:** Node.js 22、Node 内置 `node:test`、原生浏览器 JavaScript、HTML/CSS、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-08-30-data-v2-cutover-design.md`

## Global Constraints

- 网页保持零构建、零运行时依赖、无后端。
- 数据管线不引入 npm 第三方依赖。
- v2 直接切换，不保留旧 aggregate 或浏览器 v4 缓存兼容逻辑。
- 批次日固定使用 `Asia/Shanghai` 语义。
- 所有可点击第三方 URL 仅允许 HTTP/HTTPS。
- 不处理已失效历史 Key，不执行 push。

---

### Task 1: 数据 v2 契约纯函数

**Files:**
- Create: `../zaolangzhe-data/package.json`
- Create: `../zaolangzhe-data/pipeline/contract.js`
- Create: `../zaolangzhe-data/test/contract.test.js`

**Interfaces:**
- Produces: `beijingDay(ms)`, `itemKey(kind, item)`, `mergeDuplicate(kind, older, newer)`, `dedupeItems(kind, items)`, `validateDayFile(value, options)`, `buildIndex(dayFiles, generatedAt)`, `validateIndex(index, dayFiles)`。

- [ ] **Step 1: 写失败测试**

使用 `node:test` 编写字面量 fixture，覆盖北京时间 UTC 边界、三类唯一键、互补重复字段合并、丰富记录胜出、非法 URL、近期缺失中文字段、跨日重复、错误计数和 index 路径穿越。

- [ ] **Step 2: 验证测试因模块不存在而失败**

Run: `node --test test/contract.test.js`

Expected: FAIL，错误为无法导入 `pipeline/contract.js`。

- [ ] **Step 3: 实现最小契约模块**

`contract.js` 使用 ES module 导出上述接口；校验函数返回 `{ errors: string[], warnings: string[] }`，不读写文件、不访问网络。

```js
export function beijingDay(ms) {}
export function itemKey(kind, item) {}
export function mergeDuplicate(kind, older, newer) {}
export function dedupeItems(kind, items) {}
export function validateDayFile(value, { now = Date.now() } = {}) {}
export function buildIndex(dayFiles, generatedAt) {}
export function validateIndex(index, dayFiles, { now = Date.now() } = {}) {}
```

- [ ] **Step 4: 验证绿色并运行语法检查**

Run: `npm test`

Expected: 所有 contract 测试 PASS。

- [ ] **Step 5: 提交数据仓契约层**

```bash
git add package.json pipeline/contract.js test/contract.test.js
git commit -m "feat: add data v2 contract"
```

---

### Task 2: 一次性 v2 数据迁移

**Files:**
- Create: `../zaolangzhe-data/pipeline/migrate-v2.js`
- Create: `../zaolangzhe-data/test/migrate-v2.test.js`
- Create: `../zaolangzhe-data/data/index.json`
- Create: `../zaolangzhe-data/data/days/2026-08-28.json`
- Create: `../zaolangzhe-data/data/days/2026-08-29.json`
- Create: `../zaolangzhe-data/data/days/2026-08-30.json`
- Delete: `../zaolangzhe-data/data/feed-x.json`
- Delete: `../zaolangzhe-data/data/feed-podcasts.json`
- Delete: `../zaolangzhe-data/data/feed-blogs.json`
- Delete: `../zaolangzhe-data/digest/2026-08-28.json`
- Delete: `../zaolangzhe-data/digest/2026-08-29.json`
- Delete: `../zaolangzhe-data/digest/2026-08-30.json`

**Interfaces:**
- Consumes: Task 1 contract functions。
- Produces: `migrateLegacy({ xFeed, podcastFeed, blogFeed, generatedAt })` and validated v2 repository data。

- [ ] **Step 1: 写失败迁移测试**

Fixture 包含同 URL 的未翻译博客和中文字段更完整博客。断言迁移输出只有一个博客，互补字段被合并，三类条目按 `batchDay` 进入正确分片，index 计数等于实际数组长度。

- [ ] **Step 2: 验证红色**

Run: `node --test test/migrate-v2.test.js`

Expected: FAIL，`migrate-v2.js` 不存在。

- [ ] **Step 3: 实现纯迁移函数和 CLI**

CLI 默认读取旧 aggregate，先在内存迁移和验证，再以临时目录生成 v2 文件。仅在全部验证通过后替换 `data/` 内容；`--check` 只计算不写入。

```js
export function migrateLegacy({ xFeed, podcastFeed, blogFeed, generatedAt }) {
  return { index: {}, dayFiles: new Map() };
}
```

- [ ] **Step 4: 验证测试绿色并运行真实迁移**

Run: `npm test`

Run: `node pipeline/migrate-v2.js`

Expected: 生成三个日期分片；博客 URL 全局唯一；旧 aggregate 和 digest 目录被删除。

- [ ] **Step 5: 对真实产物运行契约验证**

Run: `node pipeline/migrate-v2.js --check-v2`

Expected: errors 为 0；近期缺失中文字段若存在则明确列出并由后续自愈处理。

- [ ] **Step 6: 提交迁移与 v2 数据**

```bash
git add -A pipeline/migrate-v2.js test/migrate-v2.test.js data digest
git commit -m "feat: migrate archive to daily v2 data"
```

---

### Task 3: 管线 v2 读写、自愈和原子落盘

**Files:**
- Modify: `../zaolangzhe-data/pipeline/process.js`
- Create: `../zaolangzhe-data/pipeline/storage.js`
- Create: `../zaolangzhe-data/test/pipeline.test.js`
- Modify: `../zaolangzhe-data/state/processed.json`

**Interfaces:**
- Consumes: Task 1 contract and Task 2 v2 files。
- Produces: `loadRepository(root)`, `atomicWriteJSON(path, value, validate)`, `buildWorkQueue(repository, incoming, now)`, `applyProcessedItem(repository, workItem)`。

- [ ] **Step 1: 写失败测试**

测试 dry-run 队列包含“新增 + 近期缺译文”，空 AI 输出不标记成功，博客正文失败保留标题摘要但继续排队正文，原子写校验失败保留旧正式文件，`state.digests` 被清除。

- [ ] **Step 2: 验证红色**

Run: `node --test test/pipeline.test.js`

Expected: FAIL，storage 接口和 v2 队列接口不存在。

- [ ] **Step 3: 提取存储和队列逻辑**

将网络、AI 与纯数据处理分离；`process.js` 只负责编排。正式写入使用同目录 `<name>.tmp-<pid>`，验证后 `renameSync`，`finally` 清理临时文件。

```js
export function loadRepository(root) {}
export function atomicWriteJSON(file, value, validate) {}
export function buildWorkQueue(repository, incoming, now) {}
export function applyProcessedItem(repository, workItem) {}
```

- [ ] **Step 4: 移除日报和旧 aggregate 代码**

删除 `DIR_DIGEST`、`generateDigest`、`state.digests`、旧 archive shape 和对应 CDN purge；只更新受影响日分片和 index。

- [ ] **Step 5: 让 dry-run 在自愈扫描后退出**

输出 `新增 X / 自愈 Y / 重复 Z / 警告 W`，确认调用 AI 与文件写入次数均为 0。

- [ ] **Step 6: 验证绿色**

Run: `npm test`

Run: `node pipeline/process.js --dry-run`

Expected: 测试全通过；dry-run 工作树无变化并准确报告缺失字段。

- [ ] **Step 7: 提交管线切换**

```bash
git add pipeline/process.js pipeline/storage.js test/pipeline.test.js state/processed.json
git commit -m "feat: process daily v2 archives atomically"
```

---

### Task 4: 数据验证 CLI 与数据仓 CI

**Files:**
- Create: `../zaolangzhe-data/scripts/validate-data.js`
- Create: `../zaolangzhe-data/test/validate-data.test.js`
- Modify: `../zaolangzhe-data/package.json`
- Modify: `../zaolangzhe-data/.github/workflows/pipeline.yml`

**Interfaces:**
- Consumes: `loadRepository` and contract validators。
- Produces: CLI exit code 0 on valid repository, 1 on validation errors; warnings remain visible but do not fail historical data。

- [ ] **Step 1: 写失败 CLI 测试**

在临时目录创建有效仓库、计数错误仓库、跨日重复仓库和近期空译文仓库，运行真实 CLI 并断言退出码。

- [ ] **Step 2: 验证红色**

Run: `node --test test/validate-data.test.js`

Expected: FAIL，验证脚本不存在。

- [ ] **Step 3: 实现 CLI 和 npm scripts**

增加 `validate:data`、`dry-run`；输出文件数、条目数、errors 和 warnings。

```json
{
  "type": "module",
  "scripts": {
    "test": "node --test",
    "validate:data": "node scripts/validate-data.js",
    "dry-run": "node pipeline/process.js --dry-run"
  }
}
```

- [ ] **Step 4: 更新 workflow**

在管线运行前执行 `npm test`，运行后执行 `npm run validate:data`；只有两者通过才 commit。checkout/setup-node 固定到官方提交 SHA，并用注释标注对应 v4。

- [ ] **Step 5: 验证绿色**

Run: `npm test`

Run: `npm run validate:data`

Expected: 全部通过，真实数据无重复、index 计数正确。

- [ ] **Step 6: 提交验证和 CI**

```bash
git add scripts/validate-data.js test/validate-data.test.js package.json .github/workflows/pipeline.yml
git commit -m "ci: validate v2 data before publish"
```

---

### Task 5: 网页共享数据核心

**Files:**
- Create: `package.json`
- Create: `data-core.js`
- Create: `test/data-core.test.js`
- Modify: `index.html`

**Interfaces:**
- Produces browser global and CommonJS export `FBDataCore` with `safeURL`, `mirrorKey`, `buildSourceURL`, `validateIndex`, `validateDayFile`, `mergeRichItem`, `loadChineseDays`, `loadUpstreamSnapshot`。

- [ ] **Step 1: 写失败测试**

测试中文 index/day URL、上游根 feed URL、仓库隔离冷却键、非法协议拒绝、最新日失败触发降级、上游任一 feed 失败导致整体失败、所有源失败抛错。

- [ ] **Step 2: 验证红色**

Run: `node --test test/data-core.test.js`

Expected: FAIL，`data-core.js` 不存在。

- [ ] **Step 3: 实现 UMD 风格纯模块**

浏览器设置 `globalThis.FBDataCore`，Node 设置 `module.exports`。网络函数接收注入的 `fetchJSON`，测试使用完整真实 shape fixture，不访问公网。

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FBDataCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    safeURL,
    mirrorKey,
    buildSourceURL,
    validateIndex,
    validateDayFile,
    mergeRichItem,
    loadChineseDays,
    loadUpstreamSnapshot,
  };
});
```

- [ ] **Step 4: 在 HTML 中先加载核心模块**

`index.html` 按顺序加载 `data-core.js`、`app.js`。

- [ ] **Step 5: 验证绿色**

Run: `npm test`

Expected: data-core 测试全通过。

- [ ] **Step 6: 提交网页数据核心**

```bash
git add package.json data-core.js test/data-core.test.js index.html
git commit -m "feat: add testable v2 web data core"
```

---

### Task 6: 网页 v2 加载、错误语义和回填

**Files:**
- Modify: `app.js`
- Create: `test/app-data.test.js`
- Modify: `scripts/feature-test.js`

**Interfaces:**
- Consumes: Task 5 `FBDataCore`。
- Produces: `fetchAllFeeds` v2 behavior, per-repo mirror state, explicit upstream backfill repository and `{ attempted, succeeded, failed }` progress。

- [ ] **Step 1: 写失败数据层测试**

在最小 DOM/状态适配器下验证：中文源只请求所选深度、最新日失败后完整降级、全部失败不更新 `lastRefresh`、上游 partial snapshot 拒绝、回填 URL 含上游 repo、零成功显示失败。

- [ ] **Step 2: 验证红色**

Run: `node --test test/app-data.test.js`

Expected: 当前 app 数据层无法满足 v2 接口和错误语义。

- [ ] **Step 3: 改造 DB 合并 v2 扁平数组**

推文按条目自带的 `handle/builder/bio` 建 builder map；三类冲突统一通过 `mergeRichItem` 合并，不再先到先得。

```js
mergeDay(dayFile) {
  for (const post of dayFile.x) this.mergePost(post, dayFile.day);
  for (const episode of dayFile.podcasts) this.mergeEpisode(episode, dayFile.day);
  for (const blog of dayFile.blogs) this.mergeBlog(blog, dayFile.day);
}
```

- [ ] **Step 4: 改造中文分片加载与上游完整降级**

首次加载要求 index 和最新日成功；其他日失败显示部分失败信息。所有源失败时抛错且不写 `lastRefresh`。

- [ ] **Step 5: 修复镜像状态与回填**

active/cooldown 均按 repo 保存；回填调用显式传 `UPSTREAM_REPO`，进度只累计成功项，零成功进入错误分支。

- [ ] **Step 6: 升级缓存并调整清空流程**

缓存键改为 `fb.web.v5`；清空后重新拉取 v2，不读取 v4。

- [ ] **Step 7: 验证绿色和既有浏览器测试**

Run: `npm test`

Run: `python3 -m http.server 8931`

Run: `node scripts/feature-test.js http://127.0.0.1:8931`

Expected: Node 测试及原有 16 项浏览器测试通过。

- [ ] **Step 8: 提交网页加载改造**

```bash
git add app.js test/app-data.test.js scripts/feature-test.js
git commit -m "feat: load daily v2 data with strict fallback"
```

---

### Task 7: 外链安全与弹层无障碍

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify: `about.html`
- Modify: `scripts/feature-test.js`
- Create: `test/accessibility.test.js`

**Interfaces:**
- Consumes: `FBDataCore.safeURL`。
- Produces: `openModal(node, trigger)`, `closeModal(node)`, `trapModalFocus(event, node)` and safe external links。

- [ ] **Step 1: 写失败安全和焦点测试**

Node 测试验证播客、博客和推文不为非法 URL 生成可点击 href；浏览器测试验证按钮 `aria-expanded`、打开后焦点进入弹层、Tab 循环、Esc 后焦点恢复。

- [ ] **Step 2: 验证红色**

Run: `node --test test/accessibility.test.js`

Run: `node scripts/feature-test.js http://127.0.0.1:8931`

Expected: URL 或焦点断言失败。

- [ ] **Step 3: 统一安全 URL 和弹层生命周期**

`openReader`、博客阅读器、推文和 Markdown 链接全部使用同一白名单；抽屉、设置、阅读器共享焦点记录、焦点锁定和恢复逻辑。

```js
function openModal(node, trigger) {}
function closeModal(node) {}
function trapModalFocus(event, node) {}
function setSafeLink(link, rawURL) {}
```

- [ ] **Step 4: 清理 about 图片回退**

删除重复 `onerror` 属性，使用一个页面级监听器按 `data-fallback-src` 尝试远程图片，第二次失败移除图片。

- [ ] **Step 5: 验证绿色**

Run: `npm test`

Run: `node scripts/feature-test.js http://127.0.0.1:8931`

Expected: 安全、焦点和既有交互测试全部通过。

- [ ] **Step 6: 提交安全与无障碍修改**

```bash
git add app.js index.html about.html scripts/feature-test.js test/accessibility.test.js
git commit -m "fix: secure links and manage modal focus"
```

---

### Task 8: 跨仓契约测试、文档、许可证和清理

**Files:**
- Create: `test/cross-repo-contract.test.js`
- Create: `.github/workflows/test.yml`
- Create: `LICENSE`
- Modify: `README.md`
- Modify: `about.html`
- Modify: `style.css`
- Create: `../zaolangzhe-data/LICENSE`
- Modify: `../zaolangzhe-data/README.md`

**Interfaces:**
- Consumes: 两仓最终 v2 契约和测试命令。

- [ ] **Step 1: 写跨仓失败测试**

测试直接读取相邻数据仓 index 和全部列出的日分片，使用网页 `FBDataCore` 验证；当前网页尚未完成所有契约时测试必须失败。相邻仓不存在时使用 `test.skip` 并输出明确原因。

- [ ] **Step 2: 验证红色或确认前序实现已使其绿色**

Run: `node --test test/cross-repo-contract.test.js`

Expected: 若前序实现尚有契约差异则 FAIL；若已满足则记录这是覆盖前序真实产物的集成验证，不为制造红色而篡改测试。

- [ ] **Step 3: 更新文档和许可证**

网页文档描述 v2 分片、默认 7 天、缓存 v5、完整降级；数据仓文档描述 schema、真实 Actions 调度、迁移、dry-run 和验证命令。两仓加入标准 MIT 文本，版权年份为 2026，版权所有人为 WYgao29。

```text
MIT License

Copyright (c) 2026 WYgao29
```

- [ ] **Step 4: 删除遗留样式**

移除 `.summary-card`、`.sum-*`、`.sheet-input`，确认 HTML/JS 无引用。

- [ ] **Step 5: 增加网页 CI**

workflow checkout/setup-node 固定官方 SHA；checkout 相邻数据仓到 `../zaolangzhe-data` 可访问位置，运行 `npm test`，启动本地服务器后运行 feature-test，并确保后台服务器在 `always()` 清理步骤结束。

- [ ] **Step 6: 完整验证**

Web Run: `npm test`

Data Run: `npm test && npm run validate:data && node pipeline/process.js --dry-run`

Browser Run: `node scripts/feature-test.js http://127.0.0.1:8931`

Expected: 全部通过，输出无页面错误、无旧 feed 路径 404。

- [ ] **Step 7: 提交文档与清理**

Web:

```bash
git add README.md about.html style.css LICENSE .github/workflows/test.yml test/cross-repo-contract.test.js
git commit -m "docs: document data v2 architecture"
```

Data:

```bash
git add README.md LICENSE
git commit -m "docs: document v2 dataset"
```

---

### Task 9: 最终回归与工作树审计

**Files:**
- Verify only; modify only if a failing test exposes a task-scoped defect, following a new red-green cycle。

- [ ] **Step 1: 运行两仓完整测试和静态检查**

Web:

```bash
node --check app.js
node --check data-core.js
npm test
```

Data:

```bash
node --check pipeline/process.js
node --check pipeline/contract.js
node --check pipeline/storage.js
npm test
npm run validate:data
```

- [ ] **Step 2: 运行真实网络 smoke test**

启动网页本地服务器，以空 localStorage 加载页面，确认 `activeSource === 'zh'`、最新日中文内容出现、网络请求只包含 `data/index.json` 与 `data/days/...`，没有旧中文仓根路径 404。

- [ ] **Step 3: 运行数据管线 dry-run 并核对无写入**

记录执行前后 `git status --short`，运行 dry-run，确认状态完全一致。

- [ ] **Step 4: 审核 diff 与提交历史**

确认两个仓库没有临时文件、测试截图、Chrome profile、旧 digest、旧 aggregate 或无关修改；列出每仓提交和测试证据。

- [ ] **Step 5: 使用 `superpowers:verification-before-completion` 和 `superpowers:finishing-a-development-branch` 完成交付**

不得在未运行最终验证的情况下声明完成。
