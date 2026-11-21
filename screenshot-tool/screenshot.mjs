import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve(process.env.OUT_DIR || '../public/previews');
const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Number(process.env.HEIGHT || 900);
const SCALE = Number(process.env.SCALE || 1);
const FULL_PAGE = process.env.FULL_PAGE === 'true';
const WAIT_MS = Number(process.env.WAIT_MS || 2500);
const LIST_FILE = process.env.LIST_FILE || 'list.txt';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'screenshot';
}

function normalizeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function loadTargets() {
  const oneUrl = (process.env.ONE_URL || '').trim();
  if (oneUrl) {
    const url = normalizeUrl(oneUrl);
    const name = slugify(process.env.ONE_NAME || new URL(url).hostname);
    return [{ name, url }];
  }

  const lines = fs
    .readFileSync(LIST_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  return lines.map((line) => {
    const [a, b] = line.split(/\s+/);
    if (b) return { name: slugify(a), url: normalizeUrl(b) };
    const url = normalizeUrl(a);
    return { name: slugify(new URL(url).hostname), url };
  });
}

// Scroll down slowly so lazy-loaded images and scroll animations render
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= document.documentElement.scrollHeight || y > 30000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 120);
    });
  });
}

const targets = loadTargets();
if (!targets.length) {
  console.error('No URLs found. Add lines like: name https://example.com to list.txt');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const failed = [];

for (const t of targets) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    userAgent: DESKTOP_UA,
    isMobile: false,
    hasTouch: false,
  });
  const page = await context.newPage();

  try {
    console.log(`> ${t.name}  ${t.url}`);
    const res = await page.goto(t.url, { waitUntil: 'load', timeout: 45000 });
    if (res && res.status() >= 400) {
      console.warn(`  warning: HTTP ${res.status()}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (FULL_PAGE) await autoScroll(page);
    await page.waitForTimeout(WAIT_MS);

    const file = path.join(OUT_DIR, `${t.name}.png`);
    await page.screenshot({ path: file, fullPage: FULL_PAGE, animations: 'disabled' });
    console.log(`  saved ${file}`);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    failed.push(t.name);
  } finally {
    await context.close();
  }
}

await browser.close();

if (failed.length) {
  console.error(`\nFailed: ${failed.join(', ')}`);
  process.exit(1);
}
