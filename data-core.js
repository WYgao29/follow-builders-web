(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FBDataCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const KINDS = ['x', 'podcasts', 'blogs'];
  const ARCHIVE_VERSIONS = new Set([2, 3]);
  const LEGACY_TRANSLATION_FIELDS = ['textZh', 'titleZh', 'contentZh', 'transcriptZh'];
  const AI_SUMMARIES_VISIBLE = false;
  const UPSTREAM_PATHS = {
    x: 'feed-x.json',
    podcasts: 'feed-podcasts.json',
    blogs: 'feed-blogs.json',
  };
  const LABELS = { x: '推文', podcasts: '播客', blogs: '博客' };

  function hasValue(value) {
    return value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
  }

  function safeURL(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
      const value = new URL(raw);
      return value.protocol === 'http:' || value.protocol === 'https:' ? value.href : null;
    } catch (_) {
      return null;
    }
  }

  function stripLegacyTranslations(item) {
    const clean = { ...(item || {}) };
    for (const field of LEGACY_TRANSLATION_FIELDS) delete clean[field];
    return clean;
  }

  function visibleSummary(item, enabled = AI_SUMMARIES_VISIBLE) {
    // 纯英文模式：保留数据中的 summaryZh，但暂停在页面上显示。
    return enabled && typeof item?.summaryZh === 'string' ? item.summaryZh.trim() : '';
  }

  function mirrorKey(repo, kind) {
    return `${repo}|${kind}`;
  }

  function buildSourceURL(kind, repo, ref, path) {
    if (!repo || !path) throw new Error('数据源参数不完整');
    if (kind === 'github') return `https://raw.githubusercontent.com/${repo}/${ref || 'main'}/${path}`;
    if (kind === 'jsdelivr') return `https://cdn.jsdelivr.net/gh/${repo}@${ref || 'main'}/${path}`;
    throw new Error(`未知镜像线路：${kind}`);
  }

  function itemKey(kind, item) {
    const key = kind === 'x' ? item && item.id : kind === 'podcasts' ? item && item.guid : item && item.url;
    if (!hasValue(key)) throw new Error(`${kind} 条目缺少唯一键`);
    return String(key);
  }

  function mergeRichItem(kind, older, newer) {
    itemKey(kind, older);
    itemKey(kind, newer);
    const merged = { ...older, ...newer };
    for (const field of new Set([...Object.keys(older), ...Object.keys(newer)])) {
      if (!hasValue(newer[field]) && hasValue(older[field])) merged[field] = older[field];
    }
    return merged;
  }

  function validateIndex(index) {
    if (!index || !ARCHIVE_VERSIONS.has(index.schemaVersion) || !Array.isArray(index.days) || index.days.length === 0) {
      throw new Error('中文归档 index 不是有效的 v2 或 v3 数据');
    }
    const seen = new Set();
    let previous = null;
    for (const entry of index.days) {
      if (!DAY_RE.test(entry.day || '') || entry.path !== `data/days/${entry.day}.json`) {
        throw new Error(`中文归档 index 路径无效：${entry.day || '未知日期'}`);
      }
      if (seen.has(entry.day)) throw new Error(`中文归档 index 日期重复：${entry.day}`);
      if (previous && entry.day >= previous) throw new Error('中文归档 index 必须从新到旧排序');
      for (const kind of KINDS) {
        if (!Number.isInteger(entry.counts && entry.counts[kind]) || entry.counts[kind] < 0) {
          throw new Error(`中文归档 index 计数无效：${entry.day} ${kind}`);
        }
      }
      seen.add(entry.day);
      previous = entry.day;
    }
    return index;
  }

  function validateDayFile(file, entry, schemaVersion = null) {
    if (!file || !ARCHIVE_VERSIONS.has(file.schemaVersion)) {
      throw new Error(`${entry.day} 日分片不是有效的 v2 或 v3 数据`);
    }
    if ((schemaVersion !== null && file.schemaVersion !== schemaVersion) || file.day !== entry.day) {
      throw new Error(`${entry.day} 日分片版本不一致`);
    }
    for (const kind of KINDS) {
      if (!Array.isArray(file[kind])) throw new Error(`${entry.day} ${kind} 不是数组`);
      if (file[kind].length !== entry.counts[kind]) throw new Error(`${entry.day} ${kind} 计数不一致`);
      const seen = new Set();
      for (const item of file[kind]) {
        const key = itemKey(kind, item);
        if (seen.has(key)) throw new Error(`${entry.day} ${kind} 条目重复：${key}`);
        seen.add(key);
        if (hasValue(item.url) && !safeURL(item.url)) throw new Error(`${entry.day} ${kind} 包含不安全链接`);
      }
    }
    return file;
  }

  async function allSettledLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
      while (next < items.length) {
        const position = next++;
        try { results[position] = { status: 'fulfilled', value: await worker(items[position]) }; }
        catch (reason) { results[position] = { status: 'rejected', reason }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  async function loadChineseDays({ fetchJSON, repo, depth = 7, ref = 'main', concurrency = 4 }) {
    if (typeof fetchJSON !== 'function') throw new Error('缺少 fetchJSON');
    const index = validateIndex(await fetchJSON('data/index.json', ref, repo));
    const selected = index.days.slice(0, Math.max(1, Number(depth) || 7));
    const results = await allSettledLimit(selected, Math.max(1, concurrency), entry => fetchJSON(entry.path, ref, repo));
    const failures = [];
    const days = [];
    results.forEach((result, position) => {
      const entry = selected[position];
      if (result.status === 'rejected') failures.push({ day: entry.day, message: result.reason && result.reason.message || '网络错误' });
      else {
        try { days.push(validateDayFile(result.value, entry, index.schemaVersion)); }
        catch (error) { failures.push({ day: entry.day, message: error.message }); }
      }
    });
    const latestFailure = failures.find(failure => failure.day === selected[0].day);
    if (latestFailure) throw new Error(`中文归档最新日加载失败：${latestFailure.day}: ${latestFailure.message}`);
    return { index, days, failures };
  }

  async function loadUpstreamSnapshot({ fetchJSON, repo, ref = 'main' }) {
    if (typeof fetchJSON !== 'function') throw new Error('缺少 fetchJSON');
    const entries = Object.entries(UPSTREAM_PATHS);
    const results = await Promise.allSettled(entries.map(([, path]) => fetchJSON(path, ref, repo)));
    const failures = [];
    const feeds = {};
    results.forEach((result, position) => {
      const kind = entries[position][0];
      if (result.status === 'rejected') failures.push(`${LABELS[kind]}：${result.reason && result.reason.message || '网络错误'}`);
      else feeds[kind] = result.value;
    });
    if (failures.length) throw new Error(`上游完整快照加载失败：${failures.join('；')}`);
    return feeds;
  }

  return {
    KINDS,
    UPSTREAM_PATHS,
    safeURL,
    stripLegacyTranslations,
    visibleSummary,
    mirrorKey,
    buildSourceURL,
    mergeRichItem,
    validateIndex,
    validateDayFile,
    loadChineseDays,
    loadUpstreamSnapshot,
  };
}));
