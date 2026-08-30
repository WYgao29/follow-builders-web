(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FBDataCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const KINDS = ['x', 'podcasts', 'blogs'];
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
    if (!index || index.schemaVersion !== 2 || !Array.isArray(index.days) || index.days.length === 0) {
      throw new Error('中文归档 index 不是有效的 v2 数据');
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

  function validateDayFile(file, entry) {
    if (!file || file.schemaVersion !== 2 || file.day !== entry.day) {
      throw new Error(`${entry.day} 日分片与 index 不一致`);
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

  async function loadChineseDays({ fetchJSON, repo, depth = 7, ref = 'main' }) {
    if (typeof fetchJSON !== 'function') throw new Error('缺少 fetchJSON');
    const index = validateIndex(await fetchJSON('data/index.json', ref, repo));
    const selected = index.days.slice(0, Math.max(1, Number(depth) || 7));
    const results = await Promise.allSettled(selected.map(entry => fetchJSON(entry.path, ref, repo)));
    const failures = [];
    const days = [];
    results.forEach((result, position) => {
      const entry = selected[position];
      if (result.status === 'rejected') failures.push(`${entry.day}: ${result.reason && result.reason.message || '网络错误'}`);
      else {
        try { days.push(validateDayFile(result.value, entry)); }
        catch (error) { failures.push(`${entry.day}: ${error.message}`); }
      }
    });
    if (failures.length) throw new Error(`中文归档加载失败：${failures.join('；')}`);
    return { index, days };
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
    mirrorKey,
    buildSourceURL,
    mergeRichItem,
    validateIndex,
    validateDayFile,
    loadChineseDays,
    loadUpstreamSnapshot,
  };
}));
