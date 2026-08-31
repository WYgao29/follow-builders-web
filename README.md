# 造浪者（Follow Builders Web）

「造浪者」是 [follow-builders](https://github.com/zarazhangrui/follow-builders) 的中文网页阅读器：每天看一眼正在构建 AI 产品的人。它优先读取 [zaolangzhe-data](https://github.com/WYgao29/zaolangzhe-data) 预加工的中文 v2 数据，纯静态、零运行时依赖、无需 API Key。

## 运行

建议通过本地 HTTP 服务打开：

```bash
python3 -m http.server 8931
# http://127.0.0.1:8931
```

也可直接发布到 GitHub Pages：在仓库 Settings → Pages 中选择目标分支及 `/ (root)`。

## 数据与降级策略

网页首先请求中文数据仓的 `data/index.json`，再按设置读取最近 7、14 或 30 个 `data/days/YYYY-MM-DD.json` 日分片。日分片是 v2 扁平数组，按推文 `id`、播客 `guid`、博客 `url` 去重；重复项保留译文更完整的版本。

最新中文分片必须成功并通过结构、计数和 URL 校验；较早分片失败时保留已成功加载的日期并明确提示。index 或最新分片不可用时，网页会整体降级到上游当前的三份完整快照；不会把缺少其中一种内容的 partial snapshot 当成成功。两层都失败时保留已有缓存并显示错误，且不会更新成功刷新时间。

浏览器缓存键为 `fb.web.v6`。网页兼容 v2/v3 日分片，但只把 `summaryZh` 显示为“AI 简述”；英文原文始终保留，旧翻译字段不会参与渲染。

## 功能

- 单日时间线与最近 7/14/30 日切换
- X 推文、播客转录、博客正文的中英文阅读
- GitHub 直连与 jsDelivr 自动切换，线路状态按仓库隔离
- 内容分类筛选、深色模式、本地缓存与小时级静默刷新
- 外链只允许 HTTP(S)，第三方内容只通过 `textContent` / DOM API 渲染
- 抽屉、设置和阅读器支持焦点接管、Tab 循环、Escape 关闭及焦点恢复

## 文件结构

```text
follow-builders-web/
├── index.html              # 页面骨架
├── about.html              # 信息源介绍
├── style.css               # 移动端优先样式
├── data-core.js            # 可测试的 v2 契约、加载与安全 URL 核心
├── app.js                  # 浏览器状态、渲染、镜像与上游降级
├── avatars/                # 本地头像缓存
├── test/                   # Node 单元与跨仓契约测试
└── scripts/feature-test.js # 无头 Chrome 端到端回归
```

## 测试

```bash
npm test
python3 -m http.server 8931
node scripts/feature-test.js http://127.0.0.1:8931
```

`npm test` 在相邻位置找到 `zaolangzhe-data` 时，会读取真实 index 与全部日分片做跨仓契约验证。CI 会将数据仓检出到网页仓内并强制执行该测试。

## 头像降级

信息源介绍页优先使用已有本地头像；本地文件加载失败时尝试对应的 unavatar.io 地址，再失败则保留首字母圆标。远程图片均使用 `referrerpolicy="no-referrer"`。

## 许可与内容版权

网页代码采用 [MIT License](LICENSE)。聚合的推文、播客、博客及其译文版权归原作者或相应权利人所有；本仓库许可证不授予对聚合内容的额外权利。
