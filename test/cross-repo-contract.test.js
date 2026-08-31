const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Core = require('../data-core.js');
const webRoot = path.resolve(__dirname, '..');
const candidates = [
  process.env.ZAOLANGZHE_DATA_DIR,
  path.join(webRoot, 'zaolangzhe-data'),
  path.resolve(webRoot, '..', 'zaolangzhe-data'),
  path.resolve(webRoot, '../../..', 'zaolangzhe-data', '.worktrees', 'data-v2-cutover'),
].filter(Boolean);
const dataRoot = candidates.find(candidate => fs.existsSync(path.join(candidate, 'data', 'index.json')));

test('web loader accepts every real v2 day shard without duplicate keys', { skip: dataRoot ? false : '未找到相邻 zaolangzhe-data；设置 ZAOLANGZHE_DATA_DIR 可启用' }, () => {
  const index = Core.validateIndex(JSON.parse(fs.readFileSync(path.join(dataRoot, 'data', 'index.json'), 'utf8')));
  const globalKeys = new Set();
  for (const entry of index.days) {
    const file = Core.validateDayFile(JSON.parse(fs.readFileSync(path.join(dataRoot, entry.path), 'utf8')), entry);
    for (const [kind, field] of [['x', 'id'], ['podcasts', 'guid'], ['blogs', 'url']]) {
      for (const item of file[kind]) {
        const key = `${kind}:${item[field]}`;
        assert.equal(globalKeys.has(key), false, `跨日重复：${key}`);
        globalKeys.add(key);
      }
    }
  }
  assert.ok(globalKeys.size > 0, '真实数据仓不应为空');
});
