/* 说明：本文件是"源码形态守卫"——用正则断言关键实现点还在，属于防回退的
 * 快速检查，不是行为测试。真正的行为覆盖在 data-core.test.js（加载器）、
 * scripts/feature-test.js（真实浏览器 E2E）与跨仓契约测试中。
 * 重构改名导致这里误报时，先确认行为测试仍绿，再同步更新正则。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('browser loads data-core before app.js', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<script src="data-core\.js"><\/script>\s*<script src="app\.js"><\/script>/);
});

test('app uses v6 storage and the v2/v3 primary/fallback loaders', () => {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(source, /KEY:\s*'fb\.web\.v6'/);
  assert.match(source, /Core\.loadChineseDays/);
  assert.match(source, /Core\.loadUpstreamSnapshot/);
  assert.doesNotMatch(source, /Mirrors\.fetchJSON\(PATHS\[job\.kind\], job\.sha\)/);
  assert.match(source, /attempted.*succeeded.*failed/s);
  assert.doesNotMatch(source, /已回填 \$\{done\}\/\$\{total\}/);
});

test('app renders data-provided summaries with no language toggle', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotMatch(html, /id="btn-lang"/);
  assert.doesNotMatch(source, /langMode|textZh|titleZh|contentZh/);
  assert.match(source, /summaryZh/);
});
