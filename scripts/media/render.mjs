// Renders each .frame in an HTML file to a PNG. node render.mjs <file.html> <outdir> [scale]
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const [file, out, scale] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 2600, height: 2200, deviceScaleFactor: Number(scale || 1) });
await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle0' });
await page.evaluateHandle('document.fonts.ready');
for (const id of await page.$$eval('.frame', (els) => els.map((e) => e.id))) {
  await (await page.$(`#${id}`)).screenshot({ path: `${out}/${id}.png` });
  console.log('saved', id);
}
await browser.close();
