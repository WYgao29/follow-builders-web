/* Follow Builders Web — 数据与交互逻辑
 * 数据流与 iOS 版一致：GitHub 上的三个公开 feed JSON → 去重合并 → 按本地日历日分组。
 * 镜像策略：GitHub 直连优先，失败自动切 jsDelivr（可手动锁定）。
 */
'use strict';

const REPO = 'zarazhangrui/follow-builders';
const REF_MAIN = 'main';
const PATHS = { x: 'feed-x.json', podcasts: 'feed-podcasts.json', blogs: 'feed-blogs.json' };
const API_COMMITS = 'https://api.github.com/repos/' + REPO + '/commits';
const REFRESH_MIN_INTERVAL = 3600 * 1000;
const BACKFILL_CONCURRENCY = 3;

/* ---------- 小工具 ---------- */
const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const pad2 = (n) => String(n).padStart(2, '0');

function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function dayTitle(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (dayKey(date.getTime()) === dayKey(today.getTime())) return '今天';
  if (dayKey(date.getTime()) === dayKey(yesterday.getTime())) return '昨天';
  const week = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
  return `${m}月${d}日 周${week}`;
}

function daySub(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

function timeHM(ms) {
  const d = new Date(ms);
  const key = dayKey(ms);
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return key === dayKey(Date.now()) ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function countFmt(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

/* 链接白名单：feed 内容是第三方数据，只放行 http(s)，
 * 杜绝 javascript: 等伪协议注入 */
function safeURL(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const url = new URL(u, location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch (e) { /* 非法链接按无链接处理 */ }
  return null;
}

/* ---------- 本地缓存 ---------- */
const Store = {
  KEY: 'fb.web.v3', // v3：日期改为"采集批次"语义（按快照日期分组，条目时间戳仅作展示）
  data: { posts: [], episodes: [], blogs: [], doneShas: [], lastRefresh: 0, summaries: {} },

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) this.data = Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* 缓存损坏则忽略 */ }
  },
  save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); }
    catch (e) { /* 超出容量时静默降级：仅保留内存数据 */ }
  },
  wipe() {
    try { localStorage.removeItem(this.KEY); } catch (e) {}
    this.data = { posts: [], episodes: [], blogs: [], doneShas: [], lastRefresh: 0, summaries: {} };
  },
  get pref() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY + '.pref') || '{}');
    } catch (e) { return {}; }
  },
  setPref(patch) {
    try {
      const next = Object.assign(this.pref, patch);
      localStorage.setItem(this.KEY + '.pref', JSON.stringify(next));
    } catch (e) {}
  },
};

/* ---------- 数据仓库（内存，去重） ---------- */
const DB = {
  posts: new Map(),    // id -> post
  episodes: new Map(), // guid -> episode
  blogs: new Map(),    // url -> blog
  builderName: new Map(), // handle -> {name, bio}

  hydrate() {
    for (const p of Store.data.posts) this.posts.set(p.id, p);
    for (const e of Store.data.episodes) this.episodes.set(e.guid, e);
    for (const b of Store.data.blogs) this.blogs.set(b.url, b);
    for (const p of Store.data.posts) {
      this.builderName.set(p.handle, { name: p.builder, bio: p.bio || '' });
    }
  },

  persist() {
    Store.data.posts = [...this.posts.values()];
    Store.data.episodes = [...this.episodes.values()];
    Store.data.blogs = [...this.blogs.values()];
    Store.save();
  },

  mergeX(feed, batchHintMs) {
    let added = 0;
    // 批次日 = 快照的采集日期（feed.generatedAt，北京日历日）；
    // 更新前看到的整批内容统一归为"前一天"，只有新快照进来才归为当天
    const batchMs = parseDate(feed.generatedAt) ?? batchHintMs ?? null;
    const batch = batchMs != null ? dayKey(batchMs) : null;
    for (const builder of feed.x || []) {
      const handle = (builder.handle || '').trim();
      if (!handle) continue;
      const prev = this.builderName.get(handle);
      this.builderName.set(handle, {
        name: decodeEntities(builder.name || (prev && prev.name) || handle),
        bio: decodeEntities(builder.bio || (prev && prev.bio) || ''),
      });
      for (const t of builder.tweets || []) {
        if (!t.id || this.posts.has(t.id)) continue;
        const ms = parseDate(t.createdAt);
        if (ms == null) continue;
        this.posts.set(t.id, {
          id: t.id, text: decodeEntities(t.text || ''), ms,
          batchDay: batch || dayKey(ms),
          url: t.url || '', likes: t.likes || 0, retweets: t.retweets || 0,
          replies: t.replies || 0, handle,
          builder: decodeEntities(builder.name || handle), bio: decodeEntities(builder.bio || ''),
        });
        added++;
      }
    }
    return added;
  },

  mergePodcasts(feed, batchHintMs) {
    let added = 0;
    const batchMs = parseDate(feed.generatedAt) ?? batchHintMs ?? null;
    const batch = batchMs != null ? dayKey(batchMs) : null;
    for (const p of feed.podcasts || []) {
      if (!p.guid || this.episodes.has(p.guid)) continue;
      const ms = parseDate(p.publishedAt) ?? batchHintMs ?? Date.now();
      this.episodes.set(p.guid, {
        guid: p.guid, show: decodeEntities(p.name || '未知节目'),
        title: decodeEntities(p.title || '未命名单集'),
        url: p.url || '', ms, batchDay: batch || dayKey(ms),
        transcript: decodeEntities(p.transcript || ''),
      });
      added++;
    }
    return added;
  },

  mergeBlogs(feed, batchHintMs) {
    let added = 0;
    const batchMs = parseDate(feed.generatedAt) ?? batchHintMs ?? null;
    const batch = batchMs != null ? dayKey(batchMs) : null;
    for (const b of feed.blogs || []) {
      if (!b.url || this.blogs.has(b.url)) continue;
      const ms = parseDate(b.publishedAt) ?? batchHintMs ?? Date.now();
      this.blogs.set(b.url, {
        url: b.url, source: decodeEntities(b.name || '未知来源'),
        title: decodeEntities((b.title || '未命名文章').trim()),
        ms, batchDay: batch || dayKey(ms),
        author: decodeEntities(b.author || ''), summary: decodeEntities(b.description || ''),
        content: decodeEntities(b.content || ''), publishedText: b.publishedAt || '',
      });
      added++;
    }
    return added;
  },
};

/* ---------- 日期解析（多格式容错，与 iOS 版对齐） ---------- */

// 上游内容里偶见 HTML 转义符（如 &#x27;），入库前统一还原为普通字符
const _decoder = document.createElement('textarea');
function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  _decoder.innerHTML = s;
  return _decoder.value;
}

function parseDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = s.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const mon = months[m[1]];
    if (mon !== undefined) return new Date(Date.UTC(+m[3], mon, +m[2], 12)).getTime();
  }
  const dOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dOnly) return new Date(Date.UTC(+dOnly[1], +dOnly[2] - 1, +dOnly[3], 12)).getTime();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/* ---------- 镜像线路 ---------- */
const Mirrors = {
  order: ['github', 'jsdelivr'],
  url(kind, ref, path) {
    if (kind === 'github') return `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;
    return `https://cdn.jsdelivr.net/gh/${REPO}@${ref}/${path}`;
  },
  label(kind) { return kind === 'github' ? 'GitHub 直连' : 'jsDelivr'; },

  async fetchJSON(path, ref) {
    const pref = Store.pref.mirror || 'auto';
    const now = Date.now();
    let cand = pref === 'auto'
      ? (this.active ? [this.active, ...this.order.filter(k => k !== this.active)] : [...this.order])
      : [pref];
    if (pref === 'auto') {
      // 冷却中的线路排到队尾（失败过一次 5 分钟内不再优先尝试）
      cand.sort((a, b) => ((this.coolUntil[a] || 0) < now ? 0 : 1) - ((this.coolUntil[b] || 0) < now ? 0 : 1));
    }
    let lastErr;
    for (const kind of cand) {
      try {
        // 被墙的连接可能无限挂起，12 秒强制超时切下一条线路
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        let res;
        try {
          res = await fetch(this.url(kind, ref || REF_MAIN, path), { cache: 'no-store', signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (pref === 'auto') {
          this.active = kind;
          delete this.coolUntil[kind];
        }
        updateMirrorStatus(`当前走「${this.label(kind)}」`);
        return json;
      } catch (e) {
        lastErr = e;
        if (pref === 'auto') this.coolUntil[kind] = Date.now() + 5 * 60 * 1000;
      }
    }
    updateMirrorStatus('所有线路均失败');
    throw lastErr || new Error('网络失败');
  },
};
Mirrors.active = null;
Mirrors.coolUntil = {};

/* ---------- 转录解析（与 iOS 版同一规则） ---------- */
const SEG_RE = /^(.{1,60}?)\s*\|\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;

function parseTranscript(raw) {
  if (!raw) return null;
  const segments = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(SEG_RE);
    if (m) {
      if (cur && cur.text) segments.push(cur);
      cur = { speaker: m[1], time: `${m[2]} - ${m[3]}`, text: '' };
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + line.trim();
    }
  }
  if (cur && cur.text) segments.push(cur);
  return segments.length >= 2 ? segments : null;
}

/* ---------- 博客正文轻量渲染（安全 DOM，不注入 HTML） ---------- */
function renderBlogContent(container, text) {
  const lines = (text || '').split(/\r?\n/);
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = el('p', 'rb-para');
    for (const piece of para) p.appendChild(piece);
    container.appendChild(p);
    para = [];
  };
  const pushRich = (line) => {
    // 支持 **粗体** 与 [文本](链接) 两种标记
    const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let idx = 0, m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > idx) para.push(document.createTextNode(line.slice(idx, m.index)));
      if (m[1] !== undefined) para.push(el('strong', null, m[1]));
      else {
        const href = safeURL(m[3]);
        if (href) {
          const a = el('a', null, m[2]);
          a.href = href; a.target = '_blank'; a.rel = 'noopener';
          para.push(a);
        } else {
          para.push(document.createTextNode(m[2]));
        }
      }
      idx = m.index + m[0].length;
    }
    if (idx < line.length) para.push(document.createTextNode(line.slice(idx)));
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); container.appendChild(el('p', 'rb-title', h[2])); continue; }
    if (line.trim() === '') { flush(); continue; }
    pushRich(line);
  }
  flush();
}

/* ---------- AI 摘要（智谱 GLM，浏览器直连） ---------- */
const AI_CONFIG = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-5.3-flash',
  key: 'c61238f530ea4e15b6dca32225127ce1.K0wECpOS9hctgN4o',
};

const SUMMARY_SYSTEM = '你是「造浪者」日报编辑。基于用户提供的当天采集内容，用中文输出一份简明日报：先用一句话点出当天最重要的动向；再按【播客】【X 推文】【博客】分节（没有内容的节跳过），每条 1-2 句中文摘要并保留原文链接；只基于给定材料，不编造、不猜测；直接输出 Markdown 正文。';

async function callAI(system, user) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(AI_CONFIG.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_CONFIG.key },
      body: JSON.stringify({ model: AI_CONFIG.model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  } finally {
    clearTimeout(timer);
  }
}

function buildDayPrompt(g) {
  const cap = (s, n) => (s || '').slice(0, n);
  const L = [];
  if (g.posts.length) {
    L.push('【X 推文】');
    const by = new Map();
    for (const p of g.posts) { if (!by.has(p.handle)) by.set(p.handle, []); by.get(p.handle).push(p); }
    for (const [h, ps] of by) {
      L.push('@' + h + ' (' + (ps[0].builder || h) + '):');
      for (const p of ps) L.push('- ' + cap(p.text, 300) + (p.url ? ' 链接: ' + p.url : ''));
    }
  }
  if (g.episodes.length) {
    L.push('【播客】');
    for (const e of g.episodes) L.push('- ' + e.show + '《' + e.title + '》 链接: ' + e.url + ' 转录节选: ' + cap(e.transcript, 1500));
  }
  if (g.blogs.length) {
    L.push('【博客】');
    for (const b of g.blogs) L.push('- ' + b.source + '《' + b.title + '》 链接: ' + b.url + ' 正文节选: ' + cap(b.content, 2000));
  }
  return L.join('\n').slice(0, 30000);
}

/* ---------- 状态与渲染 ---------- */
let syncBusy = false;
let currentDayKey = null;   // 当前展示的日（null = 最新一天）
let dayKeysCache = [];      // 最近一次渲染的全部日键（新→旧）
let contentFilter = null;   // null | 'x' | 'podcasts' | 'blogs'（分类筛选视图）
let pendingBackfill = false; // 回填进行中又调大了深度 → 完成后自动续跑

const FILTER_META = {
  x: {
    title: 'X 推文', head: '𝕏 全部推文',
    sub: () => `共 ${DB.posts.size} 条 · ${DB.builderName.size} 位构建者 · 覆盖 ${dayKeysCache.length} 天`,
  },
  podcasts: {
    title: '播客', head: '🎙 全部播客单集',
    sub: () => {
      const shows = new Set([...DB.episodes.values()].map(e => e.show));
      return `共 ${DB.episodes.size} 期 · ${shows.size} 档节目`;
    },
  },
  blogs: {
    title: '博客', head: '📄 全部博客文章',
    sub: () => {
      const srcs = new Set([...DB.blogs.values()].map(b => b.source));
      return `共 ${DB.blogs.size} 篇 · ${srcs.size} 个来源`;
    },
  },
};

function setSync(text) {
  if (text) {
    $('#sync-text').textContent = text;
    $('#sync-banner').classList.remove('hidden');
  } else {
    $('#sync-banner').classList.add('hidden');
  }
}

/* 已有缓存时的轻量错误提示：不覆盖页面，几秒后自动消失 */
function showTransientNote(msg) {
  setSync(msg);
  setTimeout(() => { if (!syncBusy) setSync(null); }, 5000);
}

function updateMirrorStatus(text) {
  const node = $('#mirror-status');
  if (node) node.textContent = text;
}

/* ---------- 单日内容渲染（时间线与筛选视图共用） ---------- */
function appendTweets(section, posts) {
  posts.sort((a, b) => b.ms - a.ms);
  const byBuilder = new Map();
  for (const p of posts) {
    if (!byBuilder.has(p.handle)) byBuilder.set(p.handle, []);
    byBuilder.get(p.handle).push(p);
  }
  for (const [handle, plist] of byBuilder) {
    const info = DB.builderName.get(handle) || { name: plist[0].builder || handle, bio: '' };
    const bh = el('div', 'builder-head');
    bh.appendChild(avatarEl(handle, info.name));
    const main = el('div', 'b-main');
    const line1 = el('div', 'b-line1');
    line1.appendChild(el('span', 'b-name', info.name || handle));
    line1.appendChild(el('span', 'b-handle', '@' + handle));
    main.appendChild(line1);
    if (info.bio) main.appendChild(el('div', 'b-bio', info.bio));
    bh.appendChild(main);
    bh.appendChild(el('div', 'b-count', plist.length + ' 条'));
    section.appendChild(bh);

    for (const p of plist) section.appendChild(tweetCard(p));
  }
}

function appendEpisodes(section, episodes) {
  episodes.sort((a, b) => b.ms - a.ms);
  for (const e of episodes) {
    const row = el('button', 'row-card podcast');
    const d = el('div', 'r-main');
    d.appendChild(el('div', 'r-kicker', '🎙 ' + e.show));
    d.appendChild(el('div', 'r-title', e.title));
    row.appendChild(d);
    row.appendChild(el('span', 'r-go', '转录 ›'));
    row.addEventListener('click', () => openReader({
      kicker: '🎙 ' + e.show + ' · ' + timeHM(e.ms),
      title: e.title,
      url: e.url || null,
      linkTitle: '收听 / 观看',
      build(body) {
        const segs = parseTranscript(e.transcript);
        if (!segs) { body.appendChild(el('p', 'rb-para', e.transcript || '（无转录内容）')); return; }
        body.appendChild(el('p', 'rb-meta', `转录共 ${segs.length} 段`));
        for (const s of segs) {
          const item = el('div', 'seg-item');
          const chipRow = el('div', 'seg-chip-row');
          chipRow.appendChild(el('span', 'seg-speaker', s.speaker));
          chipRow.appendChild(el('span', 'seg-time', s.time));
          item.appendChild(chipRow);
          item.appendChild(el('div', 'seg-text', s.text));
          body.appendChild(item);
        }
      },
    }));
    section.appendChild(row);
  }
}

function appendBlogs(section, blogs) {
  blogs.sort((a, b) => b.ms - a.ms);
  for (const b of blogs) {
    const row = el('button', 'row-card blog');
    const d = el('div', 'r-main');
    d.appendChild(el('div', 'r-kicker', '📄 ' + b.source));
    d.appendChild(el('div', 'r-title', b.title));
    row.appendChild(d);
    row.appendChild(el('span', 'r-go', '阅读 ›'));
    row.addEventListener('click', () => openReader({
      kicker: '📄 ' + b.source,
      title: b.title,
      url: b.url || null,
      linkTitle: '访问原文',
      build(body) {
        body.appendChild(el('p', 'rb-meta',
          (b.publishedText || timeHM(b.ms)) + (b.author ? ' · ' + b.author : '')));
        if (b.summary) body.appendChild(el('p', 'rb-para', b.summary));
        renderBlogContent(body, b.content);
      },
    }));
    section.appendChild(row);
  }
}

/* ---------- 批次新鲜度 ----------
 * 上游每天约北京时间 14:28（06:28 UTC）提交一次快照。
 * 用本地时钟算出"此刻应该已存在哪一天的批次"，与已加载的最新批次日对比，
 * 落后了就自动静默刷新——不依赖 cookies，也不需要额外的服务器时间接口。 */
function expectedBatchDayLocal(now = new Date()) {
  const snap = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 28, 0, 0));
  const ref = now >= snap ? snap : new Date(snap.getTime() - 86400000);
  return dayKey(ref.getTime());
}

/* ---------- 保留窗口（滑动窗口） ----------
 * depth 同时是保留窗口：出现更新的批次后，超出窗口的旧日期自动清除；
 * 对应的回填记录一并移除（之后调大深度可重新拉回）。 */
function keyToMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

function pruneOldDays() {
  if (!DB.posts.size && !DB.episodes.size && !DB.blogs.size) return;
  const depth = Store.pref.depth || 7;
  const cutoffKey = dayKey(keyToMs(expectedBatchDayLocal()) - (depth - 1) * 86400000);
  let removed = false;
  const drop = (map) => {
    for (const [k, it] of [...map]) {
      if ((it.batchDay || dayKey(it.ms)) < cutoffKey) { map.delete(k); removed = true; }
    }
  };
  drop(DB.posts); drop(DB.episodes); drop(DB.blogs);
  if (!removed) return;

  // 移除被清理日期的回填记录（旧格式无日期的条目保留，按未知日期处理）
  Store.data.doneShas = (Store.data.doneShas || []).filter((e) => {
    const day = e.split(':').slice(2).join(':');
    return !day || day >= cutoffKey;
  });
  // 重算最老批次时间
  let minDay = null;
  const scan = (it) => { const d = it.batchDay || dayKey(it.ms); if (minDay === null || d < minDay) minDay = d; };
  for (const p of DB.posts.values()) scan(p);
  for (const e of DB.episodes.values()) scan(e);
  for (const b of DB.blogs.values()) scan(b);
  Store.data.oldestDay = minDay ? keyToMs(minDay) : undefined;
  DB.persist();
}

function newestLoadedBatchDay() {
  let newest = null;
  const scan = (it) => {
    const d = it.batchDay || dayKey(it.ms);
    if (newest === null || d > newest) newest = d;
  };
  for (const p of DB.posts.values()) scan(p);
  for (const e of DB.episodes.values()) scan(e);
  for (const b of DB.blogs.values()) scan(b);
  return newest;
}

let lastBatchCheck = 0;
async function ensureFreshBatch() {
  if (!DB.posts.size || syncBusy) return;
  const expected = expectedBatchDayLocal();
  const have = newestLoadedBatchDay();
  const due = have === null || have < expected;                       // 该有新批次了
  const stale = Date.now() - (Store.data.lastRefresh || 0) > REFRESH_MIN_INTERVAL; // 兜底：超 1 小时
  if (!due && !stale) return;
  // 设备时钟偏差可能导致"以为有新批次"反复空拉：批次检查 10 分钟内最多尝试一次
  if (due && !stale && Date.now() - lastBatchCheck < 10 * 60 * 1000) return;
  lastBatchCheck = Date.now();
  await refreshCurrent({ silent: true });
}

function render() {
  const groups = new Map(); // dayKey -> {posts:[], episodes:[], blogs:[]}
  const bucket = (key) => {
    if (!groups.has(key)) groups.set(key, { posts: [], episodes: [], blogs: [] });
    return groups.get(key);
  };
  for (const p of DB.posts.values()) bucket(p.batchDay || dayKey(p.ms)).posts.push(p);
  for (const e of DB.episodes.values()) bucket(e.batchDay || dayKey(e.ms)).episodes.push(e);
  for (const b of DB.blogs.values()) bucket(b.batchDay || dayKey(b.ms)).blogs.push(b);

  const keys = [...groups.keys()].sort().reverse(); // 新→旧
  dayKeysCache = keys;
  const chips = $('#day-chips');
  const timeline = $('#timeline');
  chips.textContent = '';
  timeline.textContent = '';

  if (!keys.length) {
    $('#empty-state').classList.remove('hidden');
    currentDayKey = null;
    $('#btn-next-day').classList.add('hidden');
    updateBackfillButton();
    return;
  }
  $('#empty-state').classList.add('hidden');

  // 分类筛选视图：跨天汇总某一类内容
  if (contentFilter) {
    chips.style.display = 'none';
    document.body.classList.add('filter-mode');
    $('#app-title').textContent = FILTER_META[contentFilter].title;

    const fhead = el('div', 'filter-head');
    const back = el('button', 'btn-back', '‹ 返回时间线');
    back.addEventListener('click', () => { contentFilter = null; render(); window.scrollTo({ top: 0 }); });
    fhead.appendChild(back);
    fhead.appendChild(el('div', 'filter-title', FILTER_META[contentFilter].head));
    fhead.appendChild(el('div', 'filter-sub', FILTER_META[contentFilter].sub()));
    timeline.appendChild(fhead);

    const items = contentFilter === 'x' ? [...DB.posts.values()]
      : contentFilter === 'podcasts' ? [...DB.episodes.values()]
      : [...DB.blogs.values()];
    items.sort((a, b) => b.ms - a.ms);

    if (!items.length) {
      timeline.appendChild(el('p', 'rb-para', '还没有加载到相关内容。'));
    } else {
      const byDay = new Map();
      for (const it of items) {
        const k = it.batchDay || dayKey(it.ms);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(it);
      }
      for (const [k, arr] of [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
        const sec = el('section', 'day-section');
        const dh = el('div', 'day-head');
        dh.appendChild(el('span', 'd-title', dayTitle(k)));
        dh.appendChild(el('span', 'd-sub', daySub(k)));
        dh.appendChild(el('span', 'd-stats', arr.length + (contentFilter === 'x' ? ' 条' : contentFilter === 'podcasts' ? ' 期' : ' 篇')));
        sec.appendChild(dh);
        if (contentFilter === 'x') appendTweets(sec, arr);
        else if (contentFilter === 'podcasts') appendEpisodes(sec, arr);
        else appendBlogs(sec, arr);
        timeline.appendChild(sec);
      }
    }

    $('#btn-next-day').classList.add('hidden');
    $('#btn-backfill').classList.add('hidden');
    return;
  }
  chips.style.display = '';
  document.body.classList.remove('filter-mode');
  $('#app-title').textContent = '造浪者';

  // 单日视图：只渲染当前日（默认最新一天）
  if (!currentDayKey || !keys.includes(currentDayKey)) currentDayKey = keys[0];
  const current = currentDayKey;
  const g = groups.get(current);
  g.posts.sort((a, b) => b.ms - a.ms);
  g.episodes.sort((a, b) => b.ms - a.ms);
  g.blogs.sort((a, b) => b.ms - a.ms);

  // 日期快捷条：点击直接切到该日，当前位置高亮
  for (const key of keys) {
    const chip = el('button', 'chip' + (key === current ? ' active' : ''));
    const title = dayTitle(key);
    if (title === '今天' || title === '昨天') {
      chip.appendChild(el('b', null, title));
      chip.appendChild(document.createTextNode(' ' + key.slice(5).replace('-', '/')));
    } else {
      chip.textContent = title;
    }
    chip.addEventListener('click', () => {
      currentDayKey = key;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    chips.appendChild(chip);
  }
  // 让当前激活的胶囊滚入视野
  const activeChip = chips.querySelector('.chip.active');
  if (activeChip) activeChip.scrollIntoView({ block: 'nearest', inline: 'center' });

  // 只渲染当天
  const section = el('section', 'day-section');

  const head = el('div', 'day-head');
  head.appendChild(el('span', 'd-title', dayTitle(current)));
  head.appendChild(el('span', 'd-sub', daySub(current)));
  const bits = [];
  if (g.posts.length) bits.push(g.posts.length + ' 推文');
  if (g.episodes.length) bits.push(g.episodes.length + ' 播客');
  if (g.blogs.length) bits.push(g.blogs.length + ' 博客');
  head.appendChild(el('span', 'd-stats', bits.join(' · ')));
  section.appendChild(head);

  appendSummary(section, current, g);

  // 推文（按构建者分组）
  if (g.posts.length) appendTweets(section, g.posts);
  appendEpisodes(section, g.episodes);
  appendBlogs(section, g.blogs);

  timeline.appendChild(section);

  // 底部导航：有更早的一天 → "下一天"；已是最后一天 → 交给"加载更早"按钮
  const idx = keys.indexOf(current);
  const older = keys[idx + 1];
  const nextBtn = $('#btn-next-day');
  if (older) {
    nextBtn.textContent = '';
    nextBtn.appendChild(el('span', 'arr', '↓'));
    nextBtn.appendChild(document.createTextNode(' 下一天 · ' + dayTitle(older)));
    nextBtn.classList.remove('hidden');
  } else {
    nextBtn.classList.add('hidden');
  }
  updateBackfillButton();
}

/* ---------- AI 摘要卡片 ---------- */
function appendSummary(section, batchDay, g) {
  const saved = (Store.data.summaries || {})[batchDay];
  const card = el('div', 'summary-card');
  const head = el('div', 'sum-head');
  head.appendChild(el('span', 'sum-label', '✨ AI 摘要'));
  const actions = el('div', 'sum-actions');
  const btn = el('button', 'sum-btn', saved ? '重新生成' : '生成 AI 摘要');
  actions.appendChild(btn);
  if (saved) {
    const del = el('button', 'sum-btn', '删除');
    del.addEventListener('click', () => {
      if ((Store.data.summaries || {})[batchDay]) { delete Store.data.summaries[batchDay]; Store.save(); render(); }
    });
    actions.appendChild(del);
  }
  head.appendChild(actions);
  card.appendChild(head);

  const body = el('div', 'sum-body');
  if (saved) renderBlogContent(body, saved);
  card.appendChild(body);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    body.textContent = '';
    body.appendChild(el('p', 'sum-hint', '正在生成摘要…（GLM-5.3-Flash，通常 30-90 秒）'));
    try {
      const text = await callAI(SUMMARY_SYSTEM, buildDayPrompt(g));
      if (!text.trim()) throw new Error('AI 返回为空');
      (Store.data.summaries || {})[batchDay] = text;
      Store.save();
      render();
    } catch (e) {
      body.textContent = '';
      body.appendChild(el('p', 'sum-err', '生成失败：' + (e && e.message ? e.message : '网络异常')));
      btn.disabled = false;
    }
  });
  section.appendChild(card);
}

function svgIcon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor'); p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

/* 真实头像三层兜底：unavatar.io（源为 X）→ 本地 avatars/{handle}.png（构建期核验缓存）
 * → 首字母圆标。unavatar 对部分网络限流（429），失败自动落到下一层 */
function avatarEl(handle, name) {
  const av = el('div', 'avatar', (name || '?').trim().charAt(0).toUpperCase());
  if (handle) {
    const img = document.createElement('img');
    img.className = 'avatar-img';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = (name || handle) + ' 的头像';
    const remote = 'https://unavatar.io/twitter/' + encodeURIComponent(handle) + '?fallback=false';
    const local = 'avatars/' + encodeURIComponent(handle) + '.png';
    img.src = remote;
    img.addEventListener('error', () => {
      if (img.src.indexOf('unavatar') !== -1) img.src = local;
      else img.remove();
    });
    av.appendChild(img);
  }
  return av;
}

function tweetCard(p) {
  const card = el('div', 'tweet-card');
  card.appendChild(el('div', 'tweet-text', p.text));
  const meta = el('div', 'tweet-meta');
  const stat = (path, n) => { const s = el('span'); s.appendChild(svgIcon(path)); s.appendChild(document.createTextNode(countFmt(n))); return s; };
  meta.appendChild(stat('M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 8V4c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z', p.replies));
  meta.appendChild(stat('M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z', p.retweets));
  meta.appendChild(stat('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z', p.likes));
  meta.appendChild(el('span', 'grow'));
  meta.appendChild(el('span', null, timeHM(p.ms)));
  card.appendChild(meta);
  if (p.url) {
    const href = safeURL(p.url);
    if (href) {
      const a = el('a', 'tweet-link', '查看原文');
      a.href = href; a.target = '_blank'; a.rel = 'noopener';
      a.insertBefore(xLogo(), a.firstChild);
      card.appendChild(a);
    }
  }
  return card;
}

/* X 官方 logo */
function xLogo() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '13'); svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z');
  svg.appendChild(p);
  return svg;
}

/* ---------- 全屏阅读器 ---------- */
function openReader({ kicker, title, url, linkTitle, build }) {
  $('#reader-title').textContent = title;
  const link = $('#reader-link');
  if (url) {
    link.href = url;
    link.title = linkTitle || '打开原文';
    link.classList.remove('hidden');
  } else link.classList.add('hidden');
  const body = $('#reader-body');
  body.textContent = '';
  body.scrollTop = 0;
  if (kicker) body.appendChild(el('p', 'rb-kicker', kicker));
  body.appendChild(el('div', 'rb-title', title));
  build(body);
  $('#reader').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeReader() {
  $('#reader').classList.add('hidden');
  document.body.style.overflow = '';
}

/* ---------- 拉取与合并 ---------- */
async function fetchAllFeeds(fallbackMs) {
  const [x, podcasts, blogs] = await Promise.all([
    Mirrors.fetchJSON(PATHS.x).catch(() => null),
    Mirrors.fetchJSON(PATHS.podcasts).catch(() => null),
    Mirrors.fetchJSON(PATHS.blogs).catch(() => null),
  ]);
  let added = 0;
  if (x) added += DB.mergeX(x, fallbackMs);
  if (podcasts) added += DB.mergePodcasts(podcasts, fallbackMs);
  if (blogs) added += DB.mergeBlogs(blogs, fallbackMs);
  return added;
}

async function refreshCurrent({ silent } = {}) {
  if (syncBusy) return;
  syncBusy = true;
  $('#btn-refresh').disabled = true;
  if (!silent) setSync('正在加载最新数据…');
  try {
    const beforeNewest = newestLoadedBatchDay();
    const added = await fetchAllFeeds(Date.now());
    pruneOldDays(); // 滑动窗口：新批次到来后清除超窗旧日期
    Store.data.lastRefresh = Date.now();
    DB.persist();
    render();
    const afterNewest = newestLoadedBatchDay();
    if (afterNewest && afterNewest !== beforeNewest) {
      showTransientNote(`已更新「${dayTitle(afterNewest)}」的内容`);
    } else if (!silent || added) {
      setSync(null);
    }
  } catch (e) {
    const msg = '刷新失败：' + (e && e.message ? e.message : '网络异常') + '，可尝试切换数据线路';
    if (DB.posts.size) {
      // 已有缓存内容：轻提示即可，不打断阅读
      showTransientNote(msg);
    } else {
      setSync(null);
      const empty = $('#empty-state');
      empty.classList.remove('hidden');
      $('#empty-text').textContent = msg;
      $('#btn-retry').classList.remove('hidden');
    }
  } finally {
    syncBusy = false;
    $('#btn-refresh').disabled = false;
  }
}

/* ---------- 历史回填 ---------- */
function pickSnapshots(dayShas, limitDays, everyN) {
  // dayShas: 新→旧 [{day:'YYYY-MM-DD', sha}]
  const window_ = dayShas.slice(0, limitDays);
  const picked = window_.filter((_, i) => i % everyN === 0);
  return picked.reverse(); // 旧→新
}

async function listCommitDays(path, limitDays) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(`${API_COMMITS}?path=${encodeURIComponent(path)}&per_page=100`, {
      headers: { 'Accept': 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403 || res.status === 429) throw new Error('GitHub API 限流，请稍后再试');
  if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
  const commits = await res.json();
  const seen = new Set();
  const days = []; // 新→旧
  for (const c of commits) {
    if (!c.sha) continue;
    const ms = parseDate(c.commit && c.commit.author && c.commit.author.date);
    if (ms == null) continue;
    const d = new Date(ms);
    const key = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    if (seen.has(key)) continue;
    seen.add(key);
    days.push({ day: key, sha: c.sha, ms });
  }
  return days.slice(0, limitDays + 5);
}

async function backfill() {
  if (syncBusy) return;
  syncBusy = true;
  const btn = $('#btn-backfill');
  const prog = $('#backfill-progress');
  btn.disabled = true;
  btn.classList.add('hidden');

  const depth = Store.pref.depth || 7;
  const doneMap = new Map(); // 'kind:sha' -> 'kind:sha:day'
  for (const e of (Store.data.doneShas || [])) {
    const key = e.split(':').slice(0, 2).join(':');
    doneMap.set(key, e);
  }

  try {
    setSync('正在查询历史快照…');
    const [xDays, blogDays, podDays] = await Promise.all([
      listCommitDays(PATHS.x, depth),
      listCommitDays(PATHS.blogs, depth),
      listCommitDays(PATHS.podcasts, depth),
    ]);

    // 与 iOS 版一致的选取策略：X 每天一份、博客隔天、播客每 7 天
    const jobs = [
      ...pickSnapshots(xDays, depth, 1).map(s => ({ kind: 'x', sha: s.sha, ms: s.ms })),
      ...pickSnapshots(blogDays, depth, 2).map(s => ({ kind: 'blogs', sha: s.sha, ms: s.ms })),
      ...pickSnapshots(podDays, depth, 7).map(s => ({ kind: 'podcasts', sha: s.sha, ms: s.ms })),
    ].filter(j => !doneMap.has(j.kind + ':' + j.sha));

    const total = jobs.length;
    let done = 0;
    setSync(total ? `正在回填历史 0/${total}` : null);
    let oldestJobMs = Infinity;
    for (let i = 0; i < jobs.length; i += BACKFILL_CONCURRENCY) {
      const chunk = jobs.slice(i, i + BACKFILL_CONCURRENCY);
      const results = await Promise.all(chunk.map(async (job) => {
        try {
          const feed = await Mirrors.fetchJSON(PATHS[job.kind], job.sha);
          return { job, feed };
        } catch (e) { return null; } // 单个快照失败跳过
      }));
      for (const r of results) {
        if (!r) continue;
        if (r.job.kind === 'x') DB.mergeX(r.feed, r.job.ms);
        else if (r.job.kind === 'podcasts') DB.mergePodcasts(r.feed, r.job.ms);
        else DB.mergeBlogs(r.feed, r.job.ms);
        doneMap.set(r.job.kind + ':' + r.job.sha, r.job.kind + ':' + r.job.sha + ':' + dayKey(r.job.ms));
        oldestJobMs = Math.min(oldestJobMs, r.job.ms);
      }
      done += chunk.length;
      setSync(`正在回填历史 ${Math.min(done, total)}/${total}`);
      prog.textContent = `已回填 ${done}/${total} 份历史快照`;
      prog.classList.remove('hidden');
      Store.data.doneShas = [...doneMap.values()]; // 中断也不丢已完成进度
      DB.persist();
      // 注意：循环内不做全量渲染，避免用户阅读时页面反复跳动；结束后统一渲染
    }

    Store.data.doneShas = [...doneMap.values()];
    if (Number.isFinite(oldestJobMs)) {
      Store.data.oldestDay = Math.min(Store.data.oldestDay || Infinity, oldestJobMs);
    }
    Store.data.lastRefresh = Date.now();
    pruneOldDays(); // 滑动窗口修剪
    DB.persist();
    setSync(null);
    prog.classList.add('hidden');
    render();
  } catch (e) {
    setSync(null);
    prog.textContent = '回填失败：' + (e && e.message ? e.message : '网络异常') + '（稍后可重试）';
    prog.classList.remove('hidden');
  } finally {
    syncBusy = false;
    btn.disabled = false;
    updateBackfillButton();
    // 回填期间又调大了深度 → 自动续跑补齐新区间（一次）
    if (pendingBackfill) {
      pendingBackfill = false;
      backfill();
    }
  }
}

function updateBackfillButton() {
  const btn = $('#btn-backfill');
  const depth = Store.pref.depth || 7;
  // 最老快照已覆盖到回填深度之外 → 没有更早的历史可拉了
  const covered = Store.data.oldestDay &&
    (Date.now() - Store.data.oldestDay) >= depth * 86400000;
  // 只在时间线视图、浏览"最早的一天"时才出现（与"下一天"按钮互斥）
  const atOldest = !contentFilter && dayKeysCache.length > 0 &&
    currentDayKey === dayKeysCache[dayKeysCache.length - 1];
  btn.classList.toggle('hidden', !DB.posts.size || syncBusy || covered || !atOldest);
}

/* ---------- 侧边栏抽屉 ---------- */
function openDrawer() { $('#drawer-mask').classList.remove('hidden'); }
function closeDrawer() { $('#drawer-mask').classList.add('hidden'); }

/* ---------- 设置面板 ---------- */
function openSettings() {
  $('#settings-mask').classList.remove('hidden');
  const mirror = Store.pref.mirror || 'auto';
  for (const b of document.querySelectorAll('#mirror-seg button'))
    b.classList.toggle('active', b.dataset.mirror === mirror);
  const depth = String(Store.pref.depth || 7);
  for (const b of document.querySelectorAll('#depth-seg button'))
    b.classList.toggle('active', b.dataset.depth === depth);
}
function closeSettings() { $('#settings-mask').classList.add('hidden'); }

/* ---------- 事件绑定 ---------- */
function bind() {
  $('#btn-menu').addEventListener('click', openDrawer);
  $('#drawer-mask').addEventListener('click', (e) => {
    if (e.target === $('#drawer-mask')) closeDrawer();
  });
  $('#nav-home').addEventListener('click', () => {
    contentFilter = null;
    currentDayKey = null;
    closeDrawer();
    render();
    window.scrollTo({ top: 0 });
  });
  document.querySelectorAll('.drawer-item[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      contentFilter = b.dataset.filter;
      closeDrawer();
      render();
      window.scrollTo({ top: 0 });
    });
  });
  $('#nav-settings').addEventListener('click', () => {
    closeDrawer();
    openSettings();
  });
  $('#btn-next-day').addEventListener('click', () => {
    const idx = dayKeysCache.indexOf(currentDayKey);
    const older = dayKeysCache[idx + 1];
    if (!older) return;
    currentDayKey = older;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#btn-refresh').addEventListener('click', () => refreshCurrent());
  $('#btn-retry').addEventListener('click', () => {
    $('#btn-retry').classList.add('hidden');
    $('#empty-text').textContent = '正在加载…';
    refreshCurrent();
  });
  $('#btn-backfill').addEventListener('click', backfill);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-close').addEventListener('click', closeSettings);
  $('#settings-mask').addEventListener('click', (e) => {
    if (e.target === $('#settings-mask')) closeSettings();
  });
  $('#reader-close').addEventListener('click', closeReader);

  $('#mirror-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mirror]');
    if (!b) return;
    Store.setPref({ mirror: b.dataset.mirror });
    Mirrors.active = null;
    for (const x of document.querySelectorAll('#mirror-seg button'))
      x.classList.toggle('active', x === b);
    refreshCurrent();
  });

  $('#depth-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-depth]');
    if (!b) return;
    const prev = Store.pref.depth || 7;
    Store.setPref({ depth: Number(b.dataset.depth) });
    for (const x of document.querySelectorAll('#depth-seg button'))
      x.classList.toggle('active', x === b);
    updateBackfillButton();
    // 深度调大 → 自动补拉新增区间；回填进行中则排队，结束后自动续跑
    if (Number(b.dataset.depth) > prev) {
      if (!syncBusy) backfill();
      else pendingBackfill = true;
    } else if (Number(b.dataset.depth) < prev) {
      pruneOldDays(); // 深度调小 → 立即按新窗口修剪
      render();
    }
  });

  $('#btn-wipe').addEventListener('click', () => {
    if (!confirm('清空本地缓存的数据？下次打开将重新加载。')) return;
    Store.wipe();
    DB.posts.clear(); DB.episodes.clear(); DB.blogs.clear(); DB.builderName.clear();
    // 同步重置视图与线路状态
    contentFilter = null; currentDayKey = null; pendingBackfill = false;
    Mirrors.active = null; Mirrors.coolUntil = {};
    $('#backfill-progress').classList.add('hidden');
    document.body.classList.remove('filter-mode');
    closeSettings();
    render();
    // 清空后等同首次启动：拉当前批次 + 自动回填历史
    (async () => {
      await refreshCurrent();
      if (DB.posts.size) await backfill();
    })();
  });

  // 批次新鲜度：回到前台或每 5 分钟检查一次是否该拉新批次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureFreshBatch();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') ensureFreshBatch();
  }, 5 * 60 * 1000);

  // Esc 依次关闭阅读器 / 设置 / 侧边栏
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#reader').classList.contains('hidden')) closeReader();
    else if (!$('#settings-mask').classList.contains('hidden')) closeSettings();
    else if (!$('#drawer-mask').classList.contains('hidden')) closeDrawer();
  });
}

/* 测试钩子：?open=first-podcast | first-blog（验证阅读器渲染用） */
function testHook() {
  const open = new URLSearchParams(location.search).get('open');
  if (!open) return;
  const wait = setInterval(() => {
    if (syncBusy) return;
    clearInterval(wait);
    if (open === 'first-podcast') {
      const eps = [...DB.episodes.values()].sort((a, b) => b.ms - a.ms);
      if (eps.length) document.querySelectorAll('.row-card.podcast')[0]?.click();
    } else if (open === 'first-blog') {
      const blogs = [...DB.blogs.values()].sort((a, b) => b.ms - a.ms);
      if (blogs.length) document.querySelectorAll('.row-card.blog')[0]?.click();
    }
  }, 500);
  setTimeout(() => clearInterval(wait), 120000); // 首启回填可能超过一分钟
}

/* ---------- 启动 ---------- */
async function start() {
  Store.load();
  DB.hydrate();
  bind();
  render();
  updateBackfillButton();

  if (!DB.posts.size) {
    await refreshCurrent();
    if (DB.posts.size) await backfill(); // 首次使用：拉历史
  } else {
    await ensureFreshBatch(); // 上游出了新批次（或超 1 小时）→ 自动静默刷新
  }
  testHook();
}

start();
