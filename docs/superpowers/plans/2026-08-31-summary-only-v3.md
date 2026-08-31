# Summary-Only v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all Chinese translation fields with one real `summaryZh` field, keep AI processing in GitHub Actions, and remove the web language toggle.

**Architecture:** The web ships first with a transition loader that accepts schema 2 and 3 but renders only `summaryZh`. The data pipeline then upgrades v2 archives in memory, strips translation fields, backfills missing tweet summaries through the existing GitHub Actions secret, validates the complete v3 repository, and atomically publishes it.

**Tech Stack:** Node.js 22, browser JavaScript, `node:test`, GitHub Actions, static JSON archives, GitHub Pages, Zhipu GLM chat completions.

**Spec:** `docs/superpowers/specs/2026-08-31-summary-only-v3-design.md`

## Global Constraints

- `schemaVersion` is exactly `3` after data migration.
- English source fields remain authoritative; the only Chinese content field is `summaryZh`.
- Remove `textZh`, `titleZh`, `contentZh`, and `transcriptZh` from persisted v3 data.
- Tweet summaries are 1–2 sentences, approximately 80 Chinese characters maximum, and must not be mechanical translations.
- Podcast summaries remain approximately 400 Chinese characters; blog summaries remain 2–3 sentences.
- AI continues to run only in `zaolangzhe-data` GitHub Actions with `secrets.ZHIPU_API_KEY`.
- The web never labels `textZh` as “AI 简述”; English originals remain visible.
- Publish web compatibility before converting the data repository to v3.

---

### Task 1: Make the web loader transition-safe for schema 2 and 3

**Repository:** `follow-builders-web`

**Files:**
- Modify: `data-core.js:54-104`
- Modify: `test/data-core.test.js`
- Modify: `test/cross-repo-contract.test.js`

**Interfaces:**
- Consumes: v2 or v3 `data/index.json` and matching day shards.
- Produces: `validateIndex(index)` and `validateDayFile(file, entry)` that accept versions 2/3 only when index and shard versions match.

- [ ] **Step 1: Write failing version-transition tests**

Add tests that clone the existing fixture with versions 2 and 3, reject version 4, and reject an index/day mismatch:

```js
test('loader accepts matching v2 and v3 archives during cutover', () => {
  for (const schemaVersion of [2, 3]) {
    const file = { ...day('2026-08-30'), schemaVersion };
    const index = { schemaVersion, generatedAt: file.generatedAt, days: [{ day: file.day, path: `data/days/${file.day}.json`, counts: { x: 1, podcasts: 0, blogs: 0 } }] };
    assert.equal(Core.validateIndex(index).schemaVersion, schemaVersion);
    assert.equal(Core.validateDayFile(file, index.days[0], schemaVersion).schemaVersion, schemaVersion);
  }
});

test('loader rejects unsupported and mixed archive versions', () => {
  assert.throws(() => Core.validateIndex({ schemaVersion: 4, days: [] }), /v2 或 v3/);
  const file = { ...day('2026-08-30'), schemaVersion: 2 };
  const entry = { day: file.day, counts: { x: 1, podcasts: 0, blogs: 0 } };
  assert.throws(() => Core.validateDayFile(file, entry, 3), /版本不一致/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- --test-name-pattern="matching v2 and v3|unsupported and mixed"`

Expected: FAIL because `validateIndex` only accepts v2 and `validateDayFile` has no expected-version argument.

- [ ] **Step 3: Implement minimal version matching**

Use an allowlist and pass the index version into shard validation:

```js
const ARCHIVE_VERSIONS = new Set([2, 3]);

function validateIndex(index) {
  if (!index || !ARCHIVE_VERSIONS.has(index.schemaVersion) || !Array.isArray(index.days) || index.days.length === 0) {
    throw new Error('中文归档 index 不是有效的 v2 或 v3 数据');
  }
  // retain existing path, count, ordering, and duplicate checks
}

function validateDayFile(file, entry, schemaVersion) {
  if (!file || file.schemaVersion !== schemaVersion || file.day !== entry.day) {
    throw new Error(`${entry.day} 日分片版本不一致`);
  }
  // retain existing array, count, key, and URL checks
}
```

Update `loadChineseDays` to call `validateDayFile(result.value, entry, index.schemaVersion)`. Update the cross-repository test to pass `index.schemaVersion` and rename it to “accepts every real v2/v3 day shard”.

- [ ] **Step 4: Run web unit tests**

Run: `npm test`

Expected: all Node tests pass against the current v2 data repository.

- [ ] **Step 5: Commit**

```bash
git add data-core.js test/data-core.test.js test/cross-repo-contract.test.js
git commit -m "feat: accept v2 and v3 data during cutover"
```

---

### Task 2: Render summaries only and remove the language control

**Repository:** `follow-builders-web`

**Files:**
- Modify: `index.html:17-23`
- Modify: `app.js` storage, normalization, reader, tweet-card, and event-binding sections
- Modify: `style.css` only where `.lang-btn` becomes unused
- Modify: `test/app-integration.test.js`
- Modify: `test/security-a11y.test.js`
- Modify: `scripts/feature-test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: optional `summaryZh` plus English `text`, `title`, `transcript`, and `content`.
- Produces: fixed summary-first cards with no language mode and cache key `fb.web.v6`.

- [ ] **Step 1: Write failing structural and browser-fixture tests**

Add static assertions:

```js
test('app is summary-only with no language toggle', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotMatch(html, /id="btn-lang"/);
  assert.doesNotMatch(app, /langMode|textZh|titleZh|contentZh/);
  assert.match(app, /KEY:\s*'fb\.web\.v6'/);
  assert.match(app, /summaryZh/);
});
```

Change feature-test fixtures so a tweet contains both a trap translation and a real summary:

```js
text: `Day ${i} tweet ${j}-${k}`,
textZh: '不得显示的旧翻译',
summaryZh: k === 0 ? `真正总结·第${i}天·${j}` : '',
```

Assert the rendered `.zh-brief` contains `真正总结` and does not contain `不得显示的旧翻译`; assert `document.querySelector('#btn-lang') === null` and `.tweet-orig` contains the English text.

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test`

Expected: FAIL because `btn-lang`, `langMode`, v5 cache, and translation rendering still exist.

- [ ] **Step 3: Implement summary-only normalization and rendering**

Upgrade `Store.KEY` to `fb.web.v6`. Normalize `summaryZh` for all three kinds and stop copying translation fields into in-memory records. Replace the tweet branch with:

```js
const summary = (p.summaryZh || '').trim();
if (summary) {
  const brief = el('div', 'zh-brief');
  brief.appendChild(el('span', 'brief-tag', 'AI 简述'));
  brief.appendChild(document.createTextNode(summary));
  card.appendChild(brief);
  card.appendChild(el('div', 'tweet-orig', p.text));
} else {
  card.appendChild(el('div', 'tweet-text', p.text));
}
```

Podcast/blog titles always use English `title`. Their cards and readers show `summaryZh` when present and English transcript/content as the original. Remove `langMode`, the `btn-lang` event handler, language preference persistence, `#btn-lang` markup, and unused `.lang-btn` CSS.

- [ ] **Step 4: Run Node and browser suites**

Run: `npm test`

Run in one terminal: `python3 -m http.server 8931 --bind 127.0.0.1`

Run in another terminal: `node scripts/feature-test.js http://127.0.0.1:8931`

Expected: Node suite passes; browser suite verifies no language button, only `summaryZh` in “AI 简述”, and visible English originals.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js style.css test/app-integration.test.js test/security-a11y.test.js scripts/feature-test.js README.md
git commit -m "feat: render Chinese summaries without language toggle"
```

---

### Task 3: Define the strict v3 contract and pure v2 migration

**Repository:** `zaolangzhe-data`

**Files:**
- Create: `pipeline/migrate-v3.js`
- Create: `test/migrate-v3.test.js`
- Modify: `pipeline/contract.js`
- Modify: `test/contract.test.js`

**Interfaces:**
- Produces: `migrateDayFileToV3(file) -> { file, changed, missingSummaryKeys }`.
- Produces: v3-only `validateDayFile`/`validateIndex`; `requireAllSummaries` controls whether any missing summary is an error.
- Consumes later: storage loader uses the pure migration before strict validation.

- [ ] **Step 1: Write failing migration and contract tests**

```js
test('migrateDayFileToV3 strips translations and preserves summaries', () => {
  const source = dayFile('2026-08-30', {
    schemaVersion: 2,
    x: [tweet({ textZh: '译文' })],
    podcasts: [{ guid: 'p', title: 'Title', titleZh: '标题', transcript: 'Original', summaryZh: '播客总结' }],
    blogs: [blog({ titleZh: '标题', contentZh: '全文翻译', summaryZh: '博客总结' })],
  });
  const result = migrateDayFileToV3(source);
  assert.equal(result.file.schemaVersion, 3);
  assert.equal(result.file.x[0].textZh, undefined);
  assert.equal(result.file.x[0].summaryZh, undefined);
  assert.equal(result.file.podcasts[0].titleZh, undefined);
  assert.equal(result.file.blogs[0].contentZh, undefined);
  assert.deepEqual(result.missingSummaryKeys, ['x:x-1']);
});

test('v3 contract requires summaries and rejects translation fields', () => {
  const result = validateDayFile({ ...dayFile('2026-08-30'), schemaVersion: 3, x: [tweet({ textZh: '旧译文', summaryZh: '' })] }, { requireAllSummaries: true });
  assert.ok(result.errors.some(value => value.includes('summaryZh')));
  assert.ok(result.errors.some(value => value.includes('textZh')));
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/migrate-v3.test.js test/contract.test.js`

Expected: FAIL because the migration module and v3 rules do not exist.

- [ ] **Step 3: Implement the pure migration**

```js
const REMOVED_FIELDS = ['textZh', 'titleZh', 'contentZh', 'transcriptZh'];

export function migrateDayFileToV3(value) {
  const file = structuredClone(value);
  const missingSummaryKeys = [];
  file.schemaVersion = 3;
  for (const kind of ['x', 'podcasts', 'blogs']) {
    for (const item of file[kind] || []) {
      for (const field of REMOVED_FIELDS) delete item[field];
      if (!String(item.summaryZh || '').trim()) missingSummaryKeys.push(itemKey(kind, item));
    }
  }
  return { file, changed: JSON.stringify(file) !== JSON.stringify(value), missingSummaryKeys };
}
```

Change contract richness to weight only `summaryZh`, build indexes/day files with version 3, require English source fields and `summaryZh`, and emit an error for every own-property matching `REMOVED_FIELDS`. Rename `requireRecentTranslations` to `requireAllSummaries`; when false, missing summaries are warnings so the in-memory migration can be processed before final strict validation.

- [ ] **Step 4: Run contract and migration tests**

Run: `node --test test/migrate-v3.test.js test/contract.test.js`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline/migrate-v3.js pipeline/contract.js test/migrate-v3.test.js test/contract.test.js
git commit -m "feat: define summary-only v3 contract"
```

---

### Task 4: Load v2 safely and queue every missing v3 summary

**Repository:** `zaolangzhe-data`

**Files:**
- Modify: `pipeline/storage.js`
- Modify: `test/pipeline.test.js`
- Modify: `test/validate-data.test.js`
- Modify: `scripts/validate-data.js`

**Interfaces:**
- Produces: `loadRepository(root, { migrateV2: true }) -> { index, dayFiles, warnings, migratedDays }`.
- Produces: `buildWorkQueue(dayFiles, { addedKeys, includeAllMissing })` using only `summaryZh`.
- Consumes: `migrateDayFileToV3` from Task 3.

- [ ] **Step 1: Write failing storage tests**

Add tests showing that `loadRepository(..., { migrateV2: true })` returns v3 files and all migrated days, while normal validation rejects v2. Add a queue test with an old tweet missing `summaryZh`:

```js
test('v3 migration queues old missing summaries when includeAllMissing is true', () => {
  const files = new Map([['2026-01-01', dayFile('2026-01-01', { schemaVersion: 3, x: [tweet('old', '')] })]]);
  const normal = buildWorkQueue(files, { now: NOW, includeAllMissing: false });
  const migration = buildWorkQueue(files, { now: NOW, includeAllMissing: true });
  assert.equal(normal.work.length, 0);
  assert.deepEqual(migration.work.map(entry => entry.key), ['x:old']);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/pipeline.test.js test/validate-data.test.js`

Expected: FAIL because storage still checks translation fields and cannot migrate v2.

- [ ] **Step 3: Implement migration-aware loading and summary queueing**

During `loadRepository`, accept a v2 index only when `migrateV2` is true, migrate every shard, record changed day names, build a v3 index in memory, then validate with `requireAllSummaries: false`. Replace `missingTranslation` with:

```js
function missingSummary(item) {
  return !String(item.summaryZh || '').trim();
}
```

`buildWorkQueue` skips old days only when `includeAllMissing` is false. New items and every migration gap enter the queue exactly once. New day files use schema 3. `writeRepository` defaults to strict `requireAllSummaries: true` for its final publication path.

- [ ] **Step 4: Run storage, validator, and full data tests**

Run: `npm test`

Expected: all tests pass; validator fixtures use schema 3 and `summaryZh`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/storage.js pipeline/contract.js scripts/validate-data.js test/pipeline.test.js test/validate-data.test.js
git commit -m "feat: queue all missing v3 summaries"
```

---

### Task 5: Replace translation processing with summaries and make cutover atomic

**Repository:** `zaolangzhe-data`

**Files:**
- Modify: `pipeline/process.js`
- Modify: `test/pipeline.test.js`
- Modify: `.github/workflows/pipeline.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: migration-aware repository and summary-only work queue from Task 4.
- Produces: tweet/blog/podcast processors that only set `summaryZh`; successful first run writes complete v3 JSON.

- [ ] **Step 1: Write failing processor/source tests**

Export `processTweet`, `processPodcast`, and `processBlog` with an injectable AI function or test the prompt builder as a pure function. Assert:

```js
test('tweet processing stores a summary and no translation', async () => {
  const item = { text: 'We shipped a faster model today.' };
  await processTweet(item, async () => '团队发布了速度更快的新模型。');
  assert.equal(item.summaryZh, '团队发布了速度更快的新模型。');
  assert.equal(item.textZh, undefined);
});

test('blog processing requests only a short summary', async () => {
  const calls = [];
  const item = { title: 'Post', content: 'Long English body' };
  await processBlog(item, async messages => { calls.push(messages); return '{"summaryZh":"文章概括了核心发布内容。"}'; });
  assert.equal(item.summaryZh, '文章概括了核心发布内容。');
  assert.equal(item.contentZh, undefined);
  assert.equal(calls.length, 1);
});
```

Also statically assert the workflow still injects `${{ secrets.ZHIPU_API_KEY }}` and does not contain a literal credential.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/pipeline.test.js`

Expected: FAIL because tweet processing writes `textZh` and blog processing translates chunks.

- [ ] **Step 3: Implement summary-only AI prompts**

Tweet prompt requests one Chinese semantic summary, 1–2 sentences and approximately 80 characters maximum, preserving key names/numbers while excluding incidental links and explicitly forbidding line-by-line translation. Podcast returns only `{ "summaryZh": "..." }`; blog returns only `{ "summaryZh": "..." }` and makes one capped-content request. Delete `splitChunks` and all title/body translation writes.

At startup call `loadRepository(ROOT, { migrateV2: true })`. Set `includeAllMissing` when `migratedDays.size > 0`, add those days to `changedDays`, and keep all intermediate writes non-strict. Before the state write or CDN purge, require strict v3 validation of every summary. Any AI failure therefore exits before Git commit and the Actions runner discards partial files.

- [ ] **Step 4: Update workflow labels and documentation**

Keep the existing schedules, manual dispatch, permissions, pinned actions, Secret injection, validation, commit, and push. Change descriptions from “补加工” or “翻译” to “补总结”; document that the first v3 run automatically backfills every missing historical summary and that subsequent runs are incremental.

- [ ] **Step 5: Run all data verification**

Run: `node --check pipeline/process.js`

Run: `npm test`

Run: `npm run dry-run`

Expected: syntax and tests pass; dry-run fetches upstream, reports the v3 migration and missing-summary work without calling AI or writing files.

- [ ] **Step 6: Commit**

```bash
git add pipeline/process.js test/pipeline.test.js .github/workflows/pipeline.yml README.md
git commit -m "feat: generate summaries only in GitHub Actions"
```

---

### Task 6: Review, publish in dependency order, and complete the v3 backfill

**Repositories:** both

**Files:**
- Verify all modified files from Tasks 1–5.
- Generated by Actions after merge: `zaolangzhe-data/data/index.json`, `data/days/*.json`, `state/processed.json`.

**Interfaces:**
- Consumes: passing web compatibility branch and passing data migration branch.
- Produces: deployed GitHub Pages reading validated summary-only v3 data.

- [ ] **Step 1: Run final local verification**

Web:

```bash
npm test
node --check app.js
node --check data-core.js
node scripts/feature-test.js http://127.0.0.1:8931
```

Data:

```bash
npm test
node --check pipeline/process.js
npm run dry-run
```

Expected: every command exits 0. Do not run `npm run validate:data` against the still-persisted v2 archive before the Actions migration.

- [ ] **Step 2: Request code review and resolve findings**

Review for contract consistency, forbidden translation-field references, transition ordering, secret handling, empty-summary failure behavior, and test coverage. Re-run Step 1 after any correction.

- [ ] **Step 3: Push and merge the web PR first**

Create a PR from `codex/summary-only-v3` to `main`. Its CI must pass against the still-current v2 data. Merge it and wait for the GitHub Pages deployment to succeed. Verify the header has no `EN` button and v2 tweets show English only rather than mislabeled translations.

- [ ] **Step 4: Push and merge the data PR**

Create the data branch `codex/summary-only-v3`, push it, and merge its PR only after the web deployment from Step 3 is live.

- [ ] **Step 5: Trigger and monitor the first v3 Actions run**

Run:

```bash
gh workflow run pipeline.yml --repo WYgao29/zaolangzhe-data --ref main -f backfill_days=0
gh run list --repo WYgao29/zaolangzhe-data --workflow pipeline.yml --limit 1
```

Watch the returned run with `gh run watch <run-id> --repo WYgao29/zaolangzhe-data --exit-status`. Expected: all historical missing tweet summaries are processed, validation passes, and the bot commits v3 data to `main`.

- [ ] **Step 6: Verify the published contract and deployment**

Fetch the live index/day shards and assert:

```js
assert.equal(index.schemaVersion, 3);
for (const file of days) {
  assert.equal(file.schemaVersion, 3);
  for (const kind of ['x', 'podcasts', 'blogs']) {
    for (const item of file[kind]) {
      assert.ok(String(item.summaryZh || '').trim());
      for (const field of ['textZh', 'titleZh', 'contentZh', 'transcriptZh']) assert.equal(field in item, false);
    }
  }
}
```

Confirm GitHub Pages redeploys successfully and a production tweet card shows a genuine Chinese “AI 简述” plus its English original. Keep feature branches/worktrees unless the user explicitly requests cleanup.
