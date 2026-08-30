const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('browser loads data-core before app.js', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<script src="data-core\.js"><\/script>\s*<script src="app\.js"><\/script>/);
});

test('app uses v5 storage and the strict v2 primary/fallback loaders', () => {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(source, /KEY:\s*'fb\.web\.v5'/);
  assert.match(source, /Core\.loadChineseDays/);
  assert.match(source, /Core\.loadUpstreamSnapshot/);
  assert.doesNotMatch(source, /Mirrors\.fetchJSON\(PATHS\[job\.kind\], job\.sha\)/);
  assert.match(source, /attempted.*succeeded.*failed/s);
  assert.doesNotMatch(source, /已回填 \$\{done\}\/\$\{total\}/);
});
