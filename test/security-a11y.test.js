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

test('about page images have at most one non-recursive error handler', () => {
  const images = about.match(/<img\b[^>]*>/g) || [];
  assert.ok(images.length > 20);
  for (const image of images) {
    assert.ok((image.match(/\sonerror=/g) || []).length <= 1, image);
    assert.doesNotMatch(image, /this\.onerror\s*=\s*\(\)\s*=>/);
  }
});
