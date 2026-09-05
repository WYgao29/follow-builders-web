/* 说明：本文件同样是"源码形态守卫"（防关键安全/无障碍模式被悄悄移除），
 * 不是行为测试；真实行为由 scripts/feature-test.js 的浏览器 E2E 验证。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const about = fs.readFileSync(path.join(root, 'about.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

test('every reader link goes through the HTTP(S) whitelist', () => {
  assert.doesNotMatch(app, /link\.href\s*=\s*url/);
  assert.match(app, /const href = safeURL\(url\)/);
  assert.match(app, /link\.removeAttribute\('href'\)/);
});

test('dialogs manage focus and trap keyboard navigation', () => {
  assert.match(app, /modalReturnFocus/);
  assert.match(app, /function trapDialogFocus/);
  assert.match(app, /requestAnimationFrame\(\(\) => focusTarget\.focus\(\)\)/);
  assert.match(css, /:focus-visible/);
});

test('about page images use one delegated, two-stage fallback handler', () => {
  const images = about.match(/<img\b[^>]*>/g) || [];
  assert.ok(images.length > 20);
  for (const image of images) {
    assert.doesNotMatch(image, /\sonerror=/, image);
  }
  assert.match(about, /<script src="about\.js"><\/script>/);
});

test('E2E script validates CHROME_BIN as an absolute executable file', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/feature-test.js'), 'utf8');
  assert.match(script, /path\.isAbsolute/);
  assert.match(script, /fs\.accessSync[^;]*X_OK/);
  assert.match(script, /fs\.statSync[^;]*isFile/);
});

test('avatar fetcher whitelists handles before writing files', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/fetch-avatars.js'), 'utf8');
  assert.match(script, /A-Za-z0-9_/);
  assert.match(script, /startsWith\(outDir \+ path\.sep\)/);
});
