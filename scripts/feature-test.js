#!/usr/bin/env node
/* 功能点逐项测试（离线确定性）：
 * 用含中文字段的合成数据播种 localStorage → 断言 → PASS/FAIL
 * 用法: node scripts/feature-test.js [baseURL]
 */
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(candidate => fs.existsSync(candidate));
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
/* v2 窗口按 index 从新到旧精确选取 depth 个日分片。 */
function windowKept(allDays, depth) {
  const selected = [...allDays].sort().reverse().slice(0, depth);
  const kept = selected.length;
  const cutoff = selected[selected.length - 1];
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
const smokeDay = seed.posts[0].batchDay;
const smokeIndex = {
  schemaVersion: 2, generatedAt: new Date().toISOString(),
  days: [{ day: smokeDay, path: `data/days/${smokeDay}.json`, counts: { x: 1, podcasts: 0, blogs: 0 } }],
};
const smokeFile = {
  schemaVersion: 2, day: smokeDay, generatedAt: smokeIndex.generatedAt,
  x: [{
    id: 'v2-smoke', handle: 'smoke', builder: 'V2 Smoke', bio: '',
    text: 'V2 browser smoke', textZh: 'V2 浏览器冒烟', createdAt: new Date().toISOString(),
    url: 'https://x.com/smoke/status/v2-smoke', likes: 0, retweets: 0, replies: 0,
  }],
  podcasts: [], blogs: [],
};
const V2_SMOKE_SCRIPT = `
  window.__allowDataFetch = true;
  window.__fetchPaths = [];
  const smokePayloads = ${JSON.stringify({ 'data/index.json': smokeIndex, [`data/days/${smokeDay}.json`]: smokeFile })};
  window.fetch = (input) => {
    const url = String(input);
    window.__fetchPaths.push(url);
    if (!window.__allowDataFetch) return Promise.reject(new Error('offline test mode'));
    const path = Object.keys(smokePayloads).find(candidate => url.includes(candidate));
    if (!path || !url.includes('WYgao29/zaolangzhe-data')) return Promise.reject(new Error('unexpected request: ' + url));
    return Promise.resolve(new Response(JSON.stringify(smokePayloads[path]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  };
`;

let mainChrome = null;
async function main() {
  if (!CHROME) throw new Error('未找到 Chrome/Chromium；可通过 CHROME_BIN 指定');
  const profile = '/tmp/fb-feature-profile-' + Date.now();
  const chrome = mainChrome = execFile(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=390,844', '--hide-scrollbars', 'about:blank',
  ]);
  let targets = null;
  for (let i = 0; i < 80; i++) { await wait(250); try { targets = await getJSON('/json/list'); break; } catch (e) {} }
  if (!targets || !targets.length) { console.error('❌ CDP 未就绪（Chrome 启动失败或端口占用）'); chrome.kill(); process.exit(1); }
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.error('❌ 未找到页面目标'); chrome.kill(); process.exit(1); }
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: V2_SMOKE_SCRIPT });
  await send('Page.navigate', { url: BASE + '/index.html' });
  await wait(1500);
  const smoke = await evalJS(`({
    source: activeSource,
    posts: DB.posts.size,
    paths: window.__fetchPaths,
    hasChinese: [...DB.posts.values()].some(item => item.textZh === 'V2 浏览器冒烟'),
  })`);
  const results = [];
  const check = (name, pass, detail = '') => { results.push([name, !!pass, detail]); console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };
  check('T0 空缓存首启：只请求 v2 index/day 并启用中文源', smoke && smoke.source === 'zh' && smoke.posts === 1 && smoke.hasChinese && smoke.paths.length === 2 && smoke.paths.some(url => url.includes('data/index.json')) && smoke.paths.some(url => url.includes(`data/days/${smokeDay}.json`)) && smoke.paths.every(url => !url.includes('feed-')), JSON.stringify(smoke));
  // 确定性播种：加载后写入 localStorage（此时页面已就绪，无竞态），再重载生效
  const seeded = await evalJS(`(() => {
    localStorage.clear();
    localStorage.setItem('fb.web.v5', ${JSON.stringify(JSON.stringify({ posts: seed.posts, episodes: seed.episodes, blogs: seed.blogs, doneShas: [], lastRefresh: Date.now() }))});
    localStorage.setItem('fb.web.v5.pref', JSON.stringify({ depth: 7 }));
    return 'seeded';
  })()`);
  console.log('播种:', seeded);
  await send('Page.navigate', { url: BASE + '/index.html' });
  await wait(2500);

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

  // T5 中文模式：每条 = 【AI 简述】+【原文】双段结构
  await evalJS(`document.querySelectorAll('#day-chips .chip')[0].click();`);
  await wait(300);
  v = await evalJS(`(() => {
    const card = [...document.querySelectorAll('.tweet-card')].find(c => c.querySelector('.zh-brief'));
    if (!card) return { found: false };
    return {
      found: true,
      brief: card.querySelector('.zh-brief').textContent,
      orig: card.querySelector('.tweet-orig').textContent,
      briefCount: document.querySelectorAll('.zh-brief').length,
    };
  })()`);
  check('T5 中文模式：简述块 + 原文段同卡展示', v && v.found && /AI 简述/.test(v.brief) && /中文推文·第0天·0/.test(v.brief) && /Day 0 tweet 0-0/.test(v.orig), JSON.stringify(v).slice(0, 160));

  // T5b 顶栏全局切 EN：简述块消失，全部显示英文原文
  await evalJS(`document.querySelector('#btn-lang').click();`);
  await wait(300);
  v = await evalJS(`({briefs: document.querySelectorAll('.zh-brief').length, first: document.querySelector('.tweet-card .tweet-text').textContent, lang: document.querySelector('#btn-lang').textContent})`);
  check('T5b 全局切 EN：仅原文展示', v && v.briefs === 0 && /Day/.test(v.first) && v.lang === '中', JSON.stringify(v).slice(0, 120));

  // T5b2 切回中文
  await evalJS(`document.querySelector('#btn-lang').click();`);
  await wait(300);
  v = await evalJS(`({briefs: document.querySelectorAll('.zh-brief').length, lang: document.querySelector('#btn-lang').textContent})`);
  check('T5b2 切回中文：简述块恢复', v && v.briefs >= 1 && v.lang === 'EN', `briefs=${v && v.briefs}`);

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

  // T9 博客阅读器：默认中文译文（阅读器内也有切换小按钮）
  await evalJS(`[...document.querySelectorAll('.row-card.blog')].find(r => r.textContent.includes('文章中文标题')).click();`);
  await wait(400);
  v = await evalJS(`(() => {
    const body = document.querySelector('#reader-body');
    const zh = body.textContent.includes('中文全文翻译');
    const toggle = body.querySelector('.lang-toggle');
    toggle.click();
    const en = body.textContent.includes('English body') && !body.textContent.includes('中文全文翻译');
    toggle.click();
    return { zh, en, backZh: body.textContent.includes('中文全文翻译') };
  })()`);
  check('T9 博客阅读器：中文默认 + 阅读器内切换英文', v && v.zh === true && v.en === true && v.backZh === true, JSON.stringify(v));
  await evalJS(`document.querySelector('#reader-close').click();`);

  // T10 返回时间线
  await evalJS(`document.querySelector('[data-filter=x]').click();`);
  await wait(200);
  await evalJS(`document.querySelector('.btn-back').click();`);
  await wait(300);
  v = await evalJS(`document.querySelector('#app-title').textContent`);
  check('T10 返回时间线：标题恢复', v === '造浪者', v);

  // T11 全局 EN 模式下播客阅读器：不显示中文要点摘要
  await evalJS(`document.querySelector('#btn-lang').click();`); // → en
  await wait(200);
  await evalJS(`document.querySelector('[data-filter=podcasts]').click();`);
  await wait(300);
  await evalJS(`document.querySelector('.row-card.podcast').click();`);
  await wait(400);
  v = await evalJS(`({hasZhSummary: document.querySelector('#reader-body').textContent.includes('要点摘要'), enTitle: document.querySelector('#reader-title').textContent})`);
  check('T11 EN 模式：播客阅读器仅原文转录', v && v.hasZhSummary === false && /Episode/.test(v.enTitle), JSON.stringify(v));
  await evalJS(`document.querySelector('#reader-close').click();`);
  await evalJS(`document.querySelector('#btn-lang').click();`); // → zh
  await wait(200);
  await evalJS(`document.querySelector('[data-filter=x]').click();`);
  await wait(200);
  await evalJS(`document.querySelector('.btn-back').click();`);
  await wait(200);
  // T12 无客户端 AI 残留
  v = await evalJS(`({callAI: typeof callAI !== 'undefined', AI_CONFIG: typeof AI_CONFIG !== 'undefined', genBtn: !!document.querySelector('.sum-btn')})`);
  check('T12 无客户端 AI 调用残留', v && v.callAI === false && v.AI_CONFIG === false && v.genBtn === false, JSON.stringify(v));

  // T12b 清空缓存：确认数据立即清空（离线不验证后续自动重载，那需要网络）
  await evalJS(`window.__allowDataFetch = false;`);
  await evalJS(`window.confirm = () => true;`);
  await evalJS(`document.querySelector('#btn-settings').click();`);
  await wait(300);
  await evalJS(`document.querySelector('#btn-wipe').click();`);
  await wait(800);
  v = await evalJS(`({posts: DB.posts.size, days: dayKeysCache.length, emptyVisible: !document.querySelector('#empty-state').classList.contains('hidden')})`);
  check('T12b 清空缓存：数据立即清空', v && v.posts === 0 && v.days === 0, JSON.stringify(v));

  // T13 弹层接管焦点，Esc 关闭后把焦点还给触发按钮。
  await evalJS(`document.querySelector('#btn-menu').focus();`);
  await evalJS(`document.querySelector('#btn-menu').click();`);
  await wait(300);
  const opened = await evalJS(`({visible: !document.querySelector('#drawer-mask').classList.contains('hidden'), focus: document.activeElement.id, expanded: document.querySelector('#btn-menu').getAttribute('aria-expanded')})`);
  v = await evalJS(`(() => {
    document.querySelector('#nav-settings').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    return document.activeElement.id;
  })()`);
  check('T13 侧边栏焦点接管并在末端循环', opened && opened.visible && opened.focus === 'nav-home' && opened.expanded === 'true' && v === 'nav-home', JSON.stringify({ opened, wrapped: v }));
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`);
  await wait(300);
  const closed = await evalJS(`({hidden: document.querySelector('#drawer-mask').classList.contains('hidden'), focus: document.activeElement.id, expanded: document.querySelector('#btn-menu').getAttribute('aria-expanded')})`);
  check('T14 Esc 关闭侧边栏并恢复焦点', closed && closed.hidden && closed.focus === 'btn-menu' && closed.expanded === 'false', JSON.stringify(closed));

  const failed = results.filter(r => !r[1]).length;
  console.log(`\n===== 汇总：${results.length - failed}/${results.length} 通过 =====`);
  ws.close(); chrome.kill();
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error('TEST-ERR', e);
  if (mainChrome) { try { mainChrome.kill(); } catch (e2) {} }
  process.exit(1);
});
