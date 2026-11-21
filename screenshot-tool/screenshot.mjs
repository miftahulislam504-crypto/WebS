import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Math.round((WIDTH * 10) / 16); // 16:10 desktop screen
const SCALE = Number(process.env.SCALE || 1);
const FULL_PAGE = process.env.FULL_PAGE === 'true';
const WAIT_MS = Number(process.env.WAIT_MS || 2500);
const MAX_LINKS = 20;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---- job id -> output folder ------------------------------------------------
let jobId = (process.env.JOB_ID || '').trim();
if (!/^[A-Za-z0-9_-]{1,40}$/.test(jobId)) {
  console.error('Invalid job id. Use letters, numbers, - or _ (max 40).');
  process.exit(1);
}
if (jobId === 'manual') jobId = `manual-${Date.now().toString(36)}`;
const OUT_DIR = path.resolve(process.env.OUT_ROOT || '../out/jobs', jobId);

// ---- helpers ----------------------------------------------------------------
function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'screenshot'
  );
}

// Each entry is either "url" or "name url", separated by new lines or commas
function parseTargets(raw) {
  const used = new Set();
  const targets = [];
  const entries = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

  for (const entry of entries.slice(0, MAX_LINKS)) {
    const parts = entry.split(/\s+/);
    const linkPart = parts[parts.length - 1];
    const label = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';

    let url;
    try {
      url = new URL(/^https?:\/\//i.test(linkPart) ? linkPart : `https://${linkPart}`);
    } catch {
      targets.push({ name: slugify(entry), url: entry, invalid: true });
      continue;
    }

    let base = label
      ? slugify(label)
      : slugify(url.hostname + (url.pathname !== '/' ? url.pathname : ''));
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    targets.push({ name, url: url.href });
  }
  return targets;
}

// Scroll slowly so lazy-loaded images and scroll animations render
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

// ---- main -------------------------------------------------------------------
const targets = parseTargets(process.env.URLS || '');
if (!targets.length) {
  console.error('No links received.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const items = [];

for (const t of targets) {
  if (t.invalid) {
    items.push({ name: t.name, url: t.url, ok: false, error: 'Not a valid link' });
    continue;
  }

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
    if (res && res.status() >= 400) console.warn(`  warning: HTTP ${res.status()}`);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (FULL_PAGE) await autoScroll(page);
    await page.waitForTimeout(WAIT_MS);

    const buf = await page.screenshot({ fullPage: FULL_PAGE, animations: 'disabled' });
    const file = `${t.name}.png`;
    fs.writeFileSync(path.join(OUT_DIR, file), buf);

    items.push({
      name: t.name,
      url: t.url,
      ok: true,
      file,
      bytes: buf.length,
      // PNG header: width at byte 16, height at byte 20
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    });
    console.log(`  saved ${file}`);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    items.push({ name: t.name, url: t.url, ok: false, error: err.message.split('\n')[0].slice(0, 200) });
  } finally {
    await context.close();
  }
}

await browser.close();

fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      job: jobId,
      createdAt: new Date().toISOString(),
      width: WIDTH,
      scale: SCALE,
      fullPage: FULL_PAGE,
      items,
    },
    null,
    2
  )
);

console.log(`\nDone: ${items.filter((i) => i.ok).length} of ${items.length} captured.`);
