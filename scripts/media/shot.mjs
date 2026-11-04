// Full-page screenshot of a URL. node shot.mjs <url> <out.png> [width] [height]
import puppeteer from 'puppeteer-core';
const [url, out, w, h] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: Number(w || 1440), height: Number(h || 900) });
await page.goto(url, { waitUntil: 'networkidle0' });
await page.evaluateHandle('document.fonts.ready');
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: out, fullPage: !h });
await browser.close();
console.log('saved', out);
