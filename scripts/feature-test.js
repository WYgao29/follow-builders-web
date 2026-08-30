#!/usr/bin/env node
/* 功能点逐项测试（离线确定性）：
 * 用含中文字段的合成数据播种 localStorage + mock digest 接口 → 断言 → PASS/FAIL
 * 用法: node scripts/feature-test.js [baseURL]
 */
'use strict';
const { execFile } = require('child_process');
const http = require('http');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9225;
const BASE = process.argv[2] || 'http://127.0.0.1:8931';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/* 生成 10 天合成数据：3 位构建者 × 每天 2 条推文（一条带中文译文）+ 播客 + 博客 */
/* 与产品一致的批次窗口计算：expected 批次日 往前推 depth-1 天为截止线 */
function windowKept(allDays, depth) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const now = new Date();
  const snap = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 28, 0, 0));
  const ref = now >= snap ? snap : new Date(snap.getTime() - 86400000);
  const expected = dayKey(ref.getTime());
  const [y, m, d0] = expected.split('-').map(Number);
  const cutoff = dayKey(new Date(y, m - 1, d0, 12).getTime() - (depth - 1) * 86400000);
  const kept = allDays.filter(d => d >= cutoff).length;
  return { kept, cutoff };
}

function seedData() {
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const now = Date.now();
  const DAY = 86400000;
  const posts = [], episodes = [], blogs = [];
  const builders = [
    { handle: 'h1', builder: '甲', bio: '第一号测试构建者' },
    { handle: 'h2', builder: '乙', bio: '' },
    { handle: 'h3', builder: '丙', bio: '第三号' },
  ];
  for (let i = 0; i < 10; i++) {
    const batchDay = dayKey(now - i * DAY);
    const ms = now - i * DAY;
    for (let j = 0; j < builders.length; j++) {
      const b = builders[j];
      for (let k = 0; k < 2; k++) {
        posts.push({
          id: `p${i}-${j}-${k}`, text: `Day ${i} tweet ${j}-${k}`, ms: ms - k * 3600000,
          batchDay, textZh: k === 0 ? `中文推文·第${i}天·${j}` : '',
          url: k === 0 ? `https://x.com/${b.handle}/status/${i}${j}${k}` : '',
          likes: 10, retweets: 5, replies: 3,
          handle: b.handle, builder: b.builder, bio: b.bio,
        });
      }
    }
    if (i === 1 || i === 3) {
      episodes.push({
        guid: `e${i}`, show: '测试播客', title: `Episode ${i}`, titleZh: `单集中文标题 ${i}`,
        url: 'https://example.com/watch', ms, batchDay,
        summaryZh: `要点摘要：第 ${i} 期测试播客的中文要点。`,
        transcript: 'Speaker 1 | 00:00 - 00:05\nHello world\nSpeaker 2 | 00:05 - 00:10\nHi there',
      });
    }
    if (i === 2 || i === 4) {
      const withZh = i === 2;
      blogs.push({
        url: `https://example.com/post/${i}`, source: '测试博客',
        title: `Post ${i}`, titleZh: withZh ? `文章中文标题 ${i}` : '',
        ms, batchDay, author: '作者', summary: 'English summary',
        content: withZh ? `English body of post ${i} with [a link](https://example.com).` : `Plain english body ${i}.`,
        contentZh: withZh ? `这是 **第 ${i} 篇** 的中文全文翻译。` : '',
        summaryZh: withZh ? `这是第 ${i} 篇的中文摘要。` : '',
        publishedText: '',
      });
    }
  }
  return { posts, episodes, blogs };
}

const seed = seedData();
const seedJSON = JSON.stringify({ posts: seed.posts, episodes: seed.episodes, blogs: seed.blogs, doneShas: [], lastRefresh: Date.now() });
const SEED_SCRIPT = `
  const realFetch = window.fetch;
  window.__digestHits = 0;
  window.fetch = (u, o) => String(u).includes('/digest/')
    ? (window.__digestHits++, Promise.resolve(new Response(JSON.stringify({ day: 'x', markdown: '## 今日焦点\\n\\n这是 **模拟日报** 内容。' }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    : realFetch(u, o);
`;

async function main() {
  const profile = '/tmp/fb-feature-profile-' + Date.now();
  const chrome = execFile(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=390,844', '--hide-scrollbars', 'about:blank',
  ]);
  let targets = null;
  for (let i = 0; i < 40; i++) { await wait(250); try { targets = await getJSON('/json/list'); break; } catch (e) {} }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __error: (r.result.exceptionDetails.exception || {}).description || 'eval error' };
    return r.result && r.result.result && r.result.result.value;
  };

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED_SCRIPT });
  await send('Page.navigate', { url: BASE + '/index.html' });
  await wait(1500);
  // 确定性播种：加载后写入 localStorage（此时页面已就绪，无竞态），再重载生效
  const seeded = await evalJS(`(() => {
    localStorage.clear();
    localStorage.setItem('fb.web.v4', ${JSON.stringify(JSON.stringify({ posts: seed.posts, episodes: seed.episodes, blogs: seed.blogs, doneShas: [], lastRefresh: Date.now() }))});
    localStorage.setItem('fb.web.v4.pref', JSON.stringify({ depth: 7 }));
    return 'seeded';
  })()`);
  console.log('播种:', seeded);
  await send('Page.navigate', { url: BASE + '/index.html' });
  await wait(2500);

  const results = [];
  const check = (name, pass, detail = '') => { results.push([name, !!pass, detail]); console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };

  // T1 单日视图 + 品牌
  let v = await evalJS(`({t: document.querySelector('#app-title').textContent, secs: document.querySelectorAll('.day-section').length})`);
  check('T1 单日视图：标题=造浪者，只渲染 1 天', v && v.t === '造浪者' && v.secs === 1, `secs=${v && v.secs}`);
  // T2 滑动窗口：种子 10 天 → 显式触发修剪 → 窗口外批次被清除（预期按产品公式计算）
  const allDays = [];
  { const pad2 = (n) => String(n).padStart(2, '0'); const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }; for (let i = 0; i < 10; i++) allDays.push(dayKey(Date.now() - i * 86400000)); }
  const wk = windowKept(allDays, 7);
  v = await evalJS(`(() => { pruneOldDays(); render(); return dayKeysCache.length; })()`);
  check('T2 滑动窗口：窗口外批次被清除', v !== undefined && v === wk.kept, `days=${v}, 预期=${wk.kept}（截止 ${wk.cutoff}）`);
  // T3 当前日 = 今天
  v = await evalJS(`document.querySelector('#day-chips .chip.active').textContent`);
  check('T3 当前日=今天（胶囊高亮）', /今天/.test(v || ''), v);

  // T4 下一天
  await evalJS(`document.querySelector('#btn-next-day').click();`);
  await wait(300);
  v = await evalJS(`({t: document.querySelector('.day-section .d-title').textContent, next: !document.querySelector('#btn-next-day').classList.contains('hidden')})`);
  check('T4 下一天按钮：切到昨天且按钮仍在', v && v.t === '昨天' && v.next, `title=${v && v.t}`);

  // T5 中文译文默认展示 + 中/EN 切换
  await evalJS(`document.querySelectorAll('#day-chips .chip')[0].click();`);
  await wait(300);
  v = await evalJS(`(() => {
    const card = [...document.querySelectorAll('.tweet-card')].find(c => c.querySelector('.lang-toggle'));
    if (!card) return { found: false };
    const zh = card.querySelector('.tweet-text').textContent;
    card.querySelector('.lang-toggle').click();
    const en = card.querySelector('.tweet-text').textContent;
    const flipped = card.querySelector('.lang-toggle').textContent;
    card.querySelector('.lang-toggle').click();
    const back = card.querySelector('.tweet-text').textContent;
    return { found: true, zh, en, flipped, back };
  })()`);
  check('T5 中文默认展示，EN 切换双向可用', v && v.found && /中文推文/.test(v.zh) && /Day/.test(v.en) && v.flipped === '中' && /中文推文/.test(v.back), JSON.stringify(v).slice(0, 140));

  // T6 筛选 X 推文（跨天全部）
  await evalJS(`document.querySelector('[data-filter=x]').click();`);
  await wait(300);
  v = await evalJS(`({t: document.querySelector('#app-title').textContent, cards: document.querySelectorAll('.tweet-card').length})`);
  const expectedCards = wk.kept * 6; // 窗口内每天 6 条种子推文
  check('T6 筛选 X 推文：窗口内推文全部展示', v && v.t === 'X 推文' && v.cards === expectedCards, `cards=${v && v.cards}, 预期=${expectedCards}`);

  // T7 筛选播客：摘要块 + 转录
  await evalJS(`document.querySelector('[data-filter=podcasts]').click();`);
  await wait(300);
  await evalJS(`document.querySelector('.row-card.podcast').click();`);
  await wait(400);
  v = await evalJS(`({sub: [...document.querySelectorAll('#reader-body .rb-subhead')].map(x => x.textContent).join('|'), segs: document.querySelectorAll('.seg-item').length})`);
  check('T7 播客阅读器：中文要点 + 转录原文同页', v && /要点摘要/.test(v.sub) && /转录原文/.test(v.sub) && v.segs === 2, JSON.stringify(v));
  await evalJS(`document.querySelector('#reader-close').click();`);

  // T8 筛选博客：有译文的显示中文标题
  await evalJS(`document.querySelector('[data-filter=blogs]').click();`);
  await wait(300);
  v = await evalJS(`[...document.querySelectorAll('.row-card.blog .r-title')].map(x => x.textContent).join('|')`);
  check('T8 筛选博客：有译文的显示中文标题', /文章中文标题/.test(v || '') && /Post 4/.test(v || ''), v);

  // T9 博客阅读器：中文默认 + 切换英文
  await evalJS(`[...document.querySelectorAll('.row-card.blog')].find(r => r.textContent.includes('文章中文标题')).click();`);
  await wait(400);
  v = await evalJS(`(() => {
    const body = document.querySelector('#reader-body');
    const zh = body.textContent.includes('中文全文翻译');
    const toggle = body.querySelector('.lang-toggle');
    toggle.click();
    const en = body.textContent.includes('English body');
    return { zh, en };
  })()`);
  check('T9 博客阅读器：中文默认 + 切换英文原文', v && v.zh === true && v.en === true, JSON.stringify(v));
  await evalJS(`document.querySelector('#reader-close').click();`);

  // T10 返回时间线
  await evalJS(`document.querySelector('[data-filter=x]').click();`);
  await wait(200);
  await evalJS(`document.querySelector('.btn-back').click();`);
  await wait(300);
  v = await evalJS(`document.querySelector('#app-title').textContent`);
  check('T10 返回时间线：标题恢复', v === '造浪者', v);

  // T11 AI 日报卡片（digest 接口已 mock，预生成内容直接展示）
  await evalJS(`document.querySelector('#btn-next-day').click();`);
  await wait(1500);
  v = await evalJS(`({card: !!document.querySelector('.summary-card'), body: (document.querySelector('.summary-card .sum-body') || {}).textContent || '', hits: window.__digestHits})`);
  check('T11 AI 日报卡片：预生成内容直接展示', v && v.card && /模拟日报/.test(v.body) && v.hits >= 1, `hits=${v && v.hits}`);
  // T12 无客户端 AI 残留
  v = await evalJS(`({callAI: typeof callAI !== 'undefined', AI_CONFIG: typeof AI_CONFIG !== 'undefined', genBtn: !!document.querySelector('.sum-btn')})`);
  check('T12 无客户端 AI 调用残留', v && v.callAI === false && v.AI_CONFIG === false && v.genBtn === false, JSON.stringify(v));

  // T13 Esc 关闭抽屉
  await evalJS(`document.querySelector('#btn-menu').click();`);
  await wait(200);
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`);
  await wait(200);
  v = await evalJS(`document.querySelector('#drawer-mask').classList.contains('hidden')`);
  check('T13 Esc 关闭侧边栏', v === true, String(v));

  const failed = results.filter(r => !r[1]).length;
  console.log(`\n===== 汇总：${results.length - failed}/${results.length} 通过 =====`);
  ws.close(); chrome.kill();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST-ERR', e); process.exit(1); });
