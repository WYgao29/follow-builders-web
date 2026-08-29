#!/usr/bin/env node
/* 抓取真实头像到 avatars/{xhandle}.png —— 头像源为 X（通过 unavatar 聚合，不做 GitHub）
 *
 * - 源：https://unavatar.io/twitter/{handle}（返回 X 上的真实头像）
 * - 已存在的本地文件默认跳过（--force 覆盖为 X 源最新版）
 * - 部分网络对 unavatar 限流（HTTP 429）或断连：脚本会如实报告，换网络环境重跑即可；
 *   即使本地缺图，页面运行时也会自动走 unavatar 在线补齐，最终兜底为首字母
 * 用法: node scripts/fetch-avatars.js [--force]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const HANDLES = [
  'karpathy', 'swyx', 'bcherny', 'AmandaAskell', '_catwu', 'trq212',
  'sama', 'thsottiaux', 'joshwoodward', 'amasad', 'rauchg', 'alexalbert__',
  'levie', 'ryolu_', 'garrytan', 'mattturck', 'zarazhangrui', 'nikunj',
  'steipete', 'danshipper', 'adityaag', 'petergyang', 'thenanyu',
  'realmadhuguru',
  // 品牌账号（X 头像为品牌 logo）
  'GoogleLabs', 'claudeai',
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'fb-avatar-fetch' } }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        // Location 可能是相对路径，需基于当前 URL 解析
        const next = new URL(res.headers.location, url).href;
        get(next).then(resolve, reject);
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  const force = process.argv.includes('--force');
  const outDir = path.join(__dirname, '..', 'avatars');
  fs.mkdirSync(outDir, { recursive: true });

  let ok = 0, skip = 0, fail = 0;
  for (const h of HANDLES) {
    const outFile = path.join(outDir, h + '.png');
    if (fs.existsSync(outFile) && !force) { skip++; console.log(`↷ ${h}（已有本地文件）`); continue; }
    try {
      const res = await get(`https://unavatar.io/twitter/${encodeURIComponent(h)}?fallback=false`);
      const isImage = res.status === 200 && res.type.startsWith('image/') && res.body.length > 500;
      if (isImage) {
        fs.writeFileSync(outFile, res.body);
        ok++; console.log(`✓ ${h}（${res.body.length}B, ${res.type}）`);
      } else {
        fail++; console.log(`× ${h}  HTTP ${res.status}（限流或不存在）`);
      }
    } catch (e) {
      fail++; console.log(`× ${h}  ${e.message}`);
    }
  }
  console.log(`\n完成：成功 ${ok}，跳过 ${skip}，失败 ${fail}`);
  if (fail > 0) console.log('失败多为网络对 unavatar 限流——换网络环境重跑，或依赖页面运行时自动在线补齐（最终兜底为首字母）。');
}

main();
