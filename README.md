# Follow Builders Web

follow-builders iOS app 的网页版：按天浏览 AI 构建者内容（X 推文 / 播客转录 / 官方博客全文）。纯静态页面，零依赖、零构建、零后端，无需任何 API key。

## 使用方式

### 方式一：直接打开（最快）

双击 `index.html` 即可在浏览器使用（GitHub raw 与 jsDelivr 均允许跨域，本地文件也能拉数据）。

### 方式二：本地起服务

```bash
cd follow-builders-web
python3 -m http.server 8931
# 浏览器打开 http://127.0.0.1:8931
```

### 方式三：发布到 GitHub Pages（免费、手机随时访问）

1. 在 GitHub 新建一个仓库（或直接把本目录推到现有仓库的 `web` 分支）
2. 仓库 Settings → Pages → Source 选分支和 `/ (root)` → Save
3. 一分钟后访问 `https://<你的用户名>.github.io/<仓库名>/`

## 功能

- **按天时间线**：本地时区日历日分组，今天/昨天高亮，顶部日期快捷条一键跳转
- **推文**：按构建者分组（头像/签名/条数），互动数据，跳转 X 原文
- **播客**：点开全屏转录阅读器，"说话人 | 时间段" 分段渲染
- **博客**：点开全屏阅读器，正文轻量 Markdown 渲染（粗体/链接/标题）
- **历史回填**：与 iOS 版同策略（commit 台账 → X 每日一份 / 博客隔天 / 播客每 7 天），分批拉取带进度，断点续传（已下载的快照存 localStorage 不重复下载）
- **镜像自动切换**：GitHub 直连优先，失败自动切 jsDelivr；设置里可手动锁定线路（大陆网络建议保持"自动"）
- **本地缓存**：已拉取内容存 localStorage，二次打开秒出，后台静默刷新（1 小时节流）
- **深色模式**：跟随系统

## 文件结构

```
follow-builders-web/
├── index.html              # 页面骨架（顶栏 / 日期条 / 时间线 / 阅读器 / 设置面板）
├── about.html              # 信息源介绍页（26 构建者 + 6 播客 + 2 博客，设置面板可进入）
├── style.css               # 移动端优先样式（safe-area、深色模式、粘性头部）
├── app.js                  # 数据层 + 交互（镜像、去重合并、分组渲染、回填、阅读器、头像）
├── avatars/                # 构建期核验下载的真实头像（14 人）
└── scripts/
    ├── cdp-shot.js         # 无头 Chrome 手机视口验证脚本
    └── fetch-avatars.js    # 真实头像抓取（GitHub API 核验身份后下载）
```

## 真实头像的三层兜底

头像源为 **X 与 YouTube**（不经 GitHub）：

1. **unavatar.io 运行时获取**：人物走 `unavatar.io/twitter/{handle}`（X 源）；播客走 `unavatar.io/youtube/{频道}`；博客走 `unavatar.io/{官方域名}`。部分网络对该服务限流（429），失败自动落下一层
2. **本地 `avatars/{xhandle}.png` 缓存**：历史上经身份核验下载的真实头像（14 人），unavatar 不可用时兜底
3. **首字母圆标**：前两层都失败的最终兜底

补充/更新头像：`node scripts/fetch-avatars.js`（从 X 源拉取，`--force` 覆盖现有文件；部分网络限流时换环境重跑，或依赖页面运行时自动在线补齐）。

## 实现约定（改代码前读）

- **数据流与 iOS 版一致**：feed JSON → 内存 DB（按唯一键去重：推文 id / 播客 guid / 博客 url）→ 按本地日历日分组渲染。改去重或分组逻辑时两端保持对齐。
- **日期回退**：`publishedAt` 缺失回退快照 commit 时间（回填 job 传入），禁止 `Date()`。
- **HTML 转义符**：上游内容偶见 `&#x27;` 等实体，入库前统一 `decodeEntities`；新增字段记得套一层。
- **安全**：所有 feed 内容一律 `textContent` / DOM API 渲染，禁止 `innerHTML` 拼接（内容是第三方数据）。
- **缓存版本**：`Store.KEY` 的版本号在数据结构/清洗规则变化时递增（当前 v2），旧缓存自动弃用。
- **localStorage 容量**：30 天全量约 1-2MB，`save()` 已做 quota 容错（超限只保留内存数据）。
- 回填 API 走 `api.github.com`（未认证限流 60 次/小时，每次回填仅 3 次 API 调用 + N 次内容拉取）。

## 测试

本地起服务后用无头 Chrome 走移动端视口验证：

```bash
python3 -m http.server 8931 &
node scripts/cdp-shot.js "http://127.0.0.1:8931/index.html" /tmp/shot.png ".day-section" 0 30000
```

调试参数：`?open=first-podcast` / `?open=first-blog` 可直接打开对应阅读器（测试钩子，见 app.js `testHook`）。
