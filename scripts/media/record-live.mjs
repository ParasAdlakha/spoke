// Records one real session in the Spoke web app against the live Supabase
// project: two trust-gated questions, then the Data health view. Captures
// timestamped screencast frames, marks key moments, and saves screenshots.
//   node record-live.mjs <app url> <work dir> <img dir>
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const [base, work, img] = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(`${work}/frames`, { recursive: true, force: true });
mkdirSync(`${work}/frames`, { recursive: true });
mkdirSync(img, { recursive: true });

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

const frames = [];
const marks = {};
const mark = (name) => { marks[name] = Date.now(); console.log(new Date().toISOString().slice(11, 19), name); };
const cdp = await page.createCDPSession();
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const f = `${work}/frames/${String(frames.length).padStart(6, '0')}.jpg`;
  writeFileSync(f, Buffer.from(data, 'base64'));
  frames.push({ f, ts: metadata.timestamp * 1000 });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
// Chrome only sends frames on repaint: a near-invisible animated pixel keeps them flowing.
const keepAlive = () => page.evaluate(() => {
  const st = document.createElement('style');
  st.textContent = '@keyframes __t{from{opacity:.02}to{opacity:.05}}#__tick{position:fixed;right:0;bottom:0;width:2px;height:2px;background:#888;z-index:99999;animation:__t .2s infinite alternate}';
  const d = document.createElement('div'); d.id = '__tick';
  document.head.append(st); document.body.append(d);
});
const shot = (name) => page.screenshot({ path: `${img}/${name}.png` });
const shotEl = async (name, sel) => { const el = await page.$(sel); if (el) await el.screenshot({ path: `${img}/${name}.png` }); };
const answered = async () => {
  await page.waitForFunction(() => document.querySelector('#result .verdict') || document.querySelector('#result .err'), { timeout: 60_000 });
  if (await page.$('#result .err')) throw new Error(await page.$eval('#result .err', (e) => e.textContent));
};
const ask = async (q) => {
  await page.click('#q', { clickCount: 3 });
  await page.type('#q', q, { delay: 30 });
  await wait(700);
  await page.click('#go');
};

await page.goto(base, { waitUntil: 'networkidle0' });
await keepAlive();
await wait(4000); // stations + tiles
await shot('home');
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1600, maxHeight: 900, everyNthFrame: 2 });
await wait(500);
mark('start');
await wait(5000);

// 1. An e-bike near Bryant Park.
mark('typing');
await ask('Where can I grab an e-bike near here?');
mark('asked');
await answered();
mark('answer');
await wait(1200);
await shot('answer');
await shotEl('answer-card', '#result');
await wait(7000);

// 2. Move to Union Square (click the map) and ask for a free dock.
mark('move');
await page.evaluate(() => { window.spokeMap.setView([40.7359, -73.9911], 16); });
const box = await (await page.$('#map')).boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // the map is centred on Union Square
await wait(2500);
await ask('Where can I dock my bike near here?');
mark('dock_asked');
await answered();
mark('dock_answer');
await wait(1200);
await shot('answer-dock');
await wait(7000);

// 3. The Data health view: trust gate, pulse, ingest runs, quarantine.
mark('health');
await page.click('#tab-health');
await wait(3000);
await shot('health');
await shotEl('trust-gate', '#health .card');
await wait(4000);
mark('runs');
await page.evaluate(() => document.querySelector('#h-runs').scrollIntoView({ behavior: 'smooth', block: 'start' }));
await wait(5000);
await shotEl('ingest-runs', '#h-runs');
mark('quarantine');
await page.evaluate(() => document.querySelector('#h-rejects').scrollIntoView({ behavior: 'smooth', block: 'start' }));
await wait(6000);
await shot('quarantine');
await shotEl('quarantine-table', '#h-rejects');
mark('answers');
await page.evaluate(() => document.querySelector('#h-answers').scrollIntoView({ behavior: 'smooth', block: 'start' }));
await wait(5000);
mark('end');
await wait(800);
await cdp.send('Page.stopScreencast');
await browser.close();

frames.sort((a, b) => a.ts - b.ts);
writeFileSync(`${work}/recording.json`, JSON.stringify({ marks, frames }, null, 1));
console.log('frames', frames.length, 'over', ((marks.end - marks.start) / 1000).toFixed(0), 's');
