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

test('app is English-only with no language toggle', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotMatch(html, /id="btn-lang"/);
  assert.doesNotMatch(source, /langMode|textZh|titleZh|contentZh/);
  assert.match(source, /summaryZh/);
});
