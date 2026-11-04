// Assembles the slide PNGs into a 16:9 PDF, one slide per page.
//   node pdf.mjs <slides png dir> <count> <out.pdf>
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const [dir, count, out] = process.argv.slice(2);
const pages = Array.from({ length: Number(count) }, (_, i) =>
  `<img src="data:image/png;base64,${readFileSync(`${dir}/s${i + 1}.png`).toString('base64')}">`).join('');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
await page.setContent(`<style>@page{size:1920px 1080px;margin:0}body{margin:0}img{display:block;width:1920px;height:1080px;page-break-after:always}</style>${pages}`, { waitUntil: 'load' });
await page.pdf({ path: out, width: '1920px', height: '1080px', printBackground: true });
await browser.close();
console.log('wrote', out);
