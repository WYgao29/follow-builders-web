const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../data-core.js');

function day(day, id = day) {
  return {
    schemaVersion: 2,
    day,
    generatedAt: `${day}T08:00:00.000Z`,
    x: [{ id, text: 'Hello', textZh: '你好', handle: 'a', builder: 'A', createdAt: `${day}T01:00:00.000Z`, url: `https://x.com/a/status/${id}` }],
    podcasts: [],
    blogs: [],
  };
}

function index(days) {
  return {
    schemaVersion: 2,
    generatedAt: `${days[0]}T08:00:00.000Z`,
    days: days.map(value => ({ day: value, path: `data/days/${value}.json`, counts: { x: 1, podcasts: 0, blogs: 0 } })),
  };
}

test('safeURL only permits explicit HTTP and HTTPS URLs', () => {
  assert.equal(Core.safeURL('https://example.com/a'), 'https://example.com/a');
  assert.equal(Core.safeURL('http://example.com/a'), 'http://example.com/a');
  assert.equal(Core.safeURL('javascript:alert(1)'), null);
  assert.equal(Core.safeURL('/relative'), null);
});

test('mirror state keys include repository and mirror kind', () => {
  assert.equal(Core.mirrorKey('a/repo', 'github'), 'a/repo|github');
  assert.notEqual(Core.mirrorKey('a/repo', 'github'), Core.mirrorKey('b/repo', 'github'));
});

test('loadChineseDays reads the selected v2 shards from newest to oldest', async () => {
  const days = ['2026-08-30', '2026-08-29', '2026-08-28'];
  const seen = [];
  const fetchJSON = async (path, ref, repo) => {
    seen.push({ path, ref, repo });
    if (path === 'data/index.json') return index(days);
    return day(path.match(/(\d{4}-\d{2}-\d{2})/)[1]);
  };
  const result = await Core.loadChineseDays({ fetchJSON, repo: 'owner/data', depth: 2 });
  assert.deepEqual(result.days.map(value => value.day), days.slice(0, 2));
  assert.deepEqual(seen.map(value => value.path), ['data/index.json', 'data/days/2026-08-30.json', 'data/days/2026-08-29.json']);
  assert.ok(seen.every(value => value.repo === 'owner/data'));
});

test('loadChineseDays keeps the latest shard and reports older shard failures', async () => {
  const fetchJSON = async (path) => {
    if (path === 'data/index.json') return index(['2026-08-30', '2026-08-29']);
    if (path.endsWith('30.json')) return day('2026-08-30');
    throw new Error('network down');
  };
  const result = await Core.loadChineseDays({ fetchJSON, repo: 'owner/data', depth: 2 });
  assert.deepEqual(result.days.map(value => value.day), ['2026-08-30']);
  assert.deepEqual(result.failures.map(value => value.day), ['2026-08-29']);
});

test('loadChineseDays rejects the archive when the newest shard fails', async () => {
  const fetchJSON = async (path) => {
    if (path === 'data/index.json') return index(['2026-08-30', '2026-08-29']);
    if (path.endsWith('29.json')) return day('2026-08-29');
    throw new Error('network down');
  };
  await assert.rejects(
    Core.loadChineseDays({ fetchJSON, repo: 'owner/data', depth: 2 }),
    /中文归档最新日加载失败.*2026-08-30/,
  );
});

test('loadUpstreamSnapshot requires all three feeds and passes the repository explicitly', async () => {
  const calls = [];
  const fetchJSON = async (path, ref, repo) => {
    calls.push({ path, ref, repo });
    if (path === 'feed-blogs.json') throw new Error('missing blog feed');
    return path === 'feed-x.json' ? { generatedAt: '2026-08-30T00:00:00Z', x: [] } : { generatedAt: '2026-08-30T00:00:00Z', podcasts: [] };
  };
  await assert.rejects(
    Core.loadUpstreamSnapshot({ fetchJSON, repo: 'owner/upstream' }),
    /上游完整快照加载失败.*博客/,
  );
  assert.ok(calls.every(value => value.repo === 'owner/upstream'));
});

test('mergeRichItem fills gaps without replacing richer translations', () => {
  const older = { id: '1', text: 'Original', textZh: '完整中文', likes: 1 };
  const newer = { id: '1', text: 'Original updated', textZh: '', likes: 5 };
  assert.deepEqual(Core.mergeRichItem('x', older, newer), {
    id: '1', text: 'Original updated', textZh: '完整中文', likes: 5,
  });
});
