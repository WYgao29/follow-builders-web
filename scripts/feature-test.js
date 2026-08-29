#!/usr/bin/env node
/* 功能点逐项测试（离线确定性）：
 * 用合成数据播种 localStorage → 无头 Chrome 加载 → 逐项断言 → 输出 PASS/FAIL
 * 用法: node scripts/feature-test.js [baseURL]
 */
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
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

/* 生成 10 天合成数据：3 位构建者 × 每天 2 条推文 + 2 期播客 + 2 篇博客 */
function seedData() {
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const now = Date.now();
  const DAY = 86400000;
  const posts = [], episodes = [], blogs = [];
  const builders = [
    { handle: 'h1', builder: '甲', bio: '第一号测试构建者' },
    { handle: 'h2', builder: '乙', bio: '第二号测试构建者' },
    { handle: 'h3', builder: '丙', bio: '' },
  ];
  for (let i = 0; i < 10; i++) {
    const batchDay = dayKey(now - i * DAY);
    const ms = now - i * DAY;
    for (let j = 0; j < builders.length; j++) {
      const b = builders[j];
      for (let k = 0; k < 2; k++) {
        posts.push({
          id: `p${i}-${j}-${k}`, text: `第 ${i} 天 推文 ${j}-${k}`, ms: ms - k * 3600000,
          batchDay, url: k === 0 ? `https://x.com/${b.handle}/status/${i}${j}${k}` : '',
          likes: 10 * (i + 1), retweets: 5, replies: 3,
          handle: b.handle, builder: b.builder, bio: b.bio,
        });
      }
    }
    if (i === 1 || i === 3) {
      episodes.push({
        guid: `e${i}`, show: '测试播客', title: `第 ${i} 天的单集`, url: 'https://example.com/watch',
        ms: ms, batchDay, transcript: 'Speaker 1 | 00:00 - 00:05\n你好\nSpeaker 2 | 00:05 - 00:10\n世界',
      });
    }
    if (i === 2 || i === 4) {
      blogs.push({
        url: `https://example.com/post/${i}`, source: '测试博客', title: `第 ${i} 天的文章`,
        ms: ms, batchDay, author: '作者', summary: '',
        content: `这是 **第 ${i} 天** 的文章正文。\n\n[链接](https://example.com)`,
        publishedText: '',
      });
    }
  }
  return { data: { posts, episodes, blogs, doneShas: [], lastRefresh: Date.now() } };
}

// 与产品一致的批次语义：算出 depth=7 修剪后应保留的天数/推文数
function expectedKept() {
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const now = new Date();
  const snap = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 28, 0, 0));
  const ref = now >= snap ? snap : new Date(snap.getTime() - 86400000);
  const expected = dayKey(ref.getTime());
  const [y, m, d0] = expected.split('-').map(Number);
  const cutoff = dayKey(new Date(y, m - 1, d0, 12).getTime() - (7 - 1) * 86400000);
  const DAY = 86400000;
  const days = [];
  for (let i = 0; i < 10; i++) {
    const d = dayKey(Date.now() - i * DAY);
    if (d >= cutoff) days.push(d);
  }
  return { kept: days.length, posts: days.length * 6, cutoff };
}

const SEED_SCRIPT = `
  const seed = ${JSON.stringify(seedData())};
  localStorage.setItem('fb.web.v3', JSON.stringify(seed.data));
  localStorage.setItem('fb.web.v3.pref', JSON.stringify({ depth: 7 }));
  window.__seedRan = Date.now();
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
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __error: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description };
    return r.result && r.result.result && r.result.result.value;
  };

  // 播种脚本：每次新文档创建前写入 localStorage
  await send('Page.enable');
  await send('Runtime.enable');
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || JSON.stringify(m.params.exceptionDetails).slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      pageErrors.push(m.params.entry.text.slice(0, 200));
  });
  await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED_SCRIPT });
  await send('Page.navigate', { url: BASE + '/index.html' });
  await wait(2500);

  const results = [];
  const check = (name, pass, detail = '') => { results.push([name, !!pass, detail]); console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };

  // T1 品牌与单日视图 + 滑动窗口修剪（种子 10 天 → depth 7 应剩 7）
  await evalJS(`pruneOldDays(); render();`);
  let v = await evalJS(`({t: document.querySelector('#app-title').textContent, secs: document.querySelectorAll('.day-section').length, chips: document.querySelectorAll('#day-chips .chip').length})`);
  check('T1 单日视图：标题=造浪者，只渲染 1 天', v && v.t === '造浪者' && v.secs === 1, `secs=${v && v.secs}`);
  if (!v || v.secs === 0 || v.t !== '造浪者') {
    const diag = await evalJS(`JSON.stringify({ seedRan: !!window.__seedRan, posts: typeof DB !== 'undefined' ? DB.posts.size : -1, lsLen: (localStorage.getItem('fb.web.v3') || '').length, syncText: document.querySelector('#sync-text').textContent, emptyHidden: document.querySelector('#empty-state').classList.contains('hidden'), res: performance.getEntriesByType('resource').map(r => r.name.split('/').pop() + ':' + (r.responseStatus ?? r.transferSize)) })`);
    console.log('   诊断:', diag);
    console.log('   页面错误:', JSON.stringify(pageErrors).slice(0, 500));
  }
  const kept = expectedKept();
  // T2 滑动窗口：depth 7 → 超窗旧日期被修剪（保留数按批次日动态计算）
  check('T2 滑动窗口：种子 10 天按窗口修剪', v && v.chips === kept.kept, `chips=${v && v.chips}, 预期=${kept.kept}`);
  // T3 当前日 = 今天
  v = await evalJS(`document.querySelector('#day-chips .chip.active').textContent`);
  check('T3 当前日=今天（胶囊高亮）', /今天/.test(v || ''), v);

  // T4 下一天
  await evalJS(`document.querySelector('#btn-next-day').click();`);
  v = await evalJS(`({t: document.querySelector('.day-section .d-title').textContent, next: !document.querySelector('#btn-next-day').classList.contains('hidden')})`);
  check('T4 下一天按钮：切到昨天且按钮仍在', v && v.t === '昨天' && v.next, `title=${v && v.t}`);

  // T5 筛选 X：跨天全部推文
  await evalJS(`document.querySelector('[data-filter=x]').click();`);
  await wait(300);
  v = await evalJS(`({t: document.querySelector('#app-title').textContent, cards: document.querySelectorAll('.tweet-card').length, secs: document.querySelectorAll('.day-section').length})`);
  check('T5 筛选 X 推文：窗口内推文全部展示', v && v.t === 'X 推文' && v.cards === kept.posts && v.secs === kept.kept, `cards=${v && v.cards}, secs=${v && v.secs}, 预期=${kept.posts}/${kept.kept}`);

  // T6 筛选播客
  await evalJS(`document.querySelector('[data-filter=podcasts]').click();`);
  await wait(300);
  v = await evalJS(`({t: document.querySelector('#app-title').textContent, rows: document.querySelectorAll('.row-card.podcast').length})`);
  check('T6 筛选播客：2 期全部展示', v && v.t === '播客' && v.rows === 2, `rows=${v && v.rows}`);

  // T7 筛选博客
  await evalJS(`document.querySelector('[data-filter=blogs]').click();`);
  await wait(300);
  v = await evalJS(`({t: document.querySelector('#app-title').textContent, rows: document.querySelectorAll('.row-card.blog').length})`);
  check('T7 筛选博客：2 篇全部展示', v && v.t === '博客' && v.rows === 2, `rows=${v && v.rows}`);

  // T8 返回时间线
  await evalJS(`document.querySelector('.btn-back').click();`);
  await wait(300);
  v = await evalJS(`({t: document.querySelector('#app-title').textContent, chips: document.querySelectorAll('#day-chips .chip').length})`);
  check('T8 返回时间线：标题恢复、日期条可见', v && v.t === '造浪者' && v.chips === kept.kept, `chips=${v && v.chips}`);

  // T9 阅读器（转录分段）
  await evalJS(`document.querySelector('[data-filter=podcasts]').click();`);
  await wait(300);
  await evalJS(`document.querySelector('.row-card.podcast').click();`);
  await wait(400);
  v = await evalJS(`({open: !document.querySelector('#reader').classList.contains('hidden'), segs: document.querySelectorAll('.seg-item').length})`);
  check('T9 播客转录阅读器：打开且分段渲染', v && v.open && v.segs === 2, `segs=${v && v.segs}`);
  await evalJS(`document.querySelector('#reader-close').click();`);

  // T10 链接白名单：javascript: 链接不得渲染为可点击 <a>
  const su = await evalJS(`({ js: safeURL('javascript:alert(1)'), jsSpaces: safeURL('  javascript:alert(1)'), data: safeURL('data:text/html,x'), ok: safeURL('https://x.com/a'), rel: safeURL('about.html') })`);
  const jsDom = await evalJS(`document.querySelectorAll('a[href^="javascript:"]').length`);
  check('T10 安全：safeURL 拦截伪协议、放行 https', su && su.js === null && su.jsSpaces === null && su.data === null && su.ok === 'https://x.com/a' && jsDom === 0, JSON.stringify(su) + ' jsDom=' + jsDom);

  // T11 Esc 关闭抽屉
  await evalJS(`document.querySelector('#btn-menu').click();`);
  await wait(200);
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`);
  await wait(200);
  v = await evalJS(`document.querySelector('#drawer-mask').classList.contains('hidden')`);
  check('T11 Esc 关闭侧边栏', v === true, String(v));

  // T12 清空缓存 → 自动重新加载（离线环境验证"自动回填流程被触发"）
  await evalJS(`window.confirm = () => true;`);
  await evalJS(`document.querySelector('#btn-settings').click();`);
  await wait(200);
  await evalJS(`document.querySelector('#btn-wipe').click();`);
  await wait(3500);
  v = await evalJS(`({txt: document.querySelector('#sync-text').textContent, vis: !document.querySelector('#sync-banner').classList.contains('hidden'), err: document.querySelector('#empty-text') ? document.querySelector('#empty-text').textContent : ''})`);
  const attempted = (v && (/(查询|回填|刷新|加载)/.test(v.txt) || /加载失败/.test(v.err)));
  check('T12 清空缓存后自动重新加载+回填（离线验证流程被触发）', attempted, JSON.stringify(v));

  const failed = results.filter(r => !r[1]).length;
  console.log(`\n===== 汇总：${results.length - failed}/${results.length} 通过 =====`);
  ws.close(); chrome.kill();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
