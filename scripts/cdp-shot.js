#!/usr/bin/env node
/* 用 Chrome DevTools Protocol 驱动无头 Chrome：
 * 打开页面 → 等待数据渲染 → 截图（支持滚动到指定位置 / 打开阅读器）
 * 用法: node cdp-shot.js <url> <out.png> [waitSelector] [scrollY] [extraWaitMs]
 */
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const [, , url, out, waitSel = '.day-section', scrollY = '0', extraWait = '1200', preShotJS = ''] = process.argv;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const profile = '/tmp/fb-cdp-profile-' + Date.now();
  const chrome = execFile(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--window-size=390,844', '--hide-scrollbars',
    'about:blank',
  ]);
  const sleep = wait;

  // 等 CDP 就绪
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { targets = await getJSON('/json/list'); break; } catch (e) {}
  }
  if (!targets) { console.error('CDP 未就绪'); process.exit(1); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result && r.result.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(((m.params.exceptionDetails.exception || {}).description || JSON.stringify(m.params.exceptionDetails)).slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      pageErrors.push(m.params.entry.text.slice(0, 160));
  });
  await send('Page.navigate', { url });
  await sleep(1500);

  // 等待数据渲染（最多 90 秒）
  let rendered = false;
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    const n = await evalJS(`document.querySelectorAll('${waitSel}').length`);
    if (n > 0) { rendered = true; break; }
    const err = await evalJS(`document.querySelector('#empty-text') && !document.querySelector('#empty-state').classList.contains('hidden') ? document.querySelector('#empty-text').textContent : null`);
    if (err && /失败/.test(err)) { console.error('页面报错: ' + err); }
  }
  console.log('rendered:', rendered);
  if (pageErrors.length) console.log('PAGE-ERRORS:', JSON.stringify(pageErrors).slice(0, 800));

  if (Number(scrollY) > 0) {
    await evalJS(`window.scrollTo(0, ${Number(scrollY)})`);
  }
  if (preShotJS) {
    await evalJS(preShotJS);
  }
  await sleep(Number(extraWait));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('saved:', out);

  // 顺便输出页面上的诊断信息
  let diag = null;
  try {
    diag = await evalJS(`JSON.stringify({
    days: document.querySelectorAll('.day-section').length,
    chips: document.querySelectorAll('.chip').length,
    tweets: document.querySelectorAll('.tweet-card').length,
    podcasts: document.querySelectorAll('.row-card.podcast').length,
    blogs: document.querySelectorAll('.row-card.blog').length,
    backfillBtnVisible: !document.querySelector('#btn-backfill').classList.contains('hidden'),
    syncVisible: !document.querySelector('#sync-banner').classList.contains('hidden'),
    syncText: document.querySelector('#sync-text').textContent,
    errors: pageErrors.length ? pageErrors : null,
  })`);
  } catch (e) { diag = 'DIAG-EVAL-ERR: ' + e.message; }
  console.log('DIAG:', diag);

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
