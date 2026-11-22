import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Math.round((WIDTH * 10) / 16); // 16:10 desktop screen
const SCALE = Number(process.env.SCALE || 1);
const FULL_PAGE = process.env.FULL_PAGE === 'true';
const WAIT_MS = Number(process.env.WAIT_MS || 2500);
const CRAWL = process.env.CRAWL === 'true';
const MAX_PAGES = Math.min(40, Math.max(1, Number(process.env.MAX_PAGES || 10)));
const TOTAL_CAP = 80; // screenshots per run, all links together
const MAX_LINKS = CRAWL ? 5 : 20;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---- job id -> output folder ------------------------------------------------
let jobId = (process.env.JOB_ID || '').trim();
if (!/^[A-Za-z0-9_-]{1,40}$/.test(jobId)) {
  console.error('Invalid job id. Use letters, numbers, - or _ (max 40).');
  process.exit(1);
}
if (jobId === 'manual') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  jobId = `${stamp}-manual`;
}
const OUT_DIR = path.resolve(process.env.OUT_ROOT || '../out/jobs', jobId);

// ---- site logins (from the SITE_LOGINS repository secret) ---------------------
// { "app.example.com": { "loginUrl": "...", "username": "...", "password": "..." } }
const logins = {};
let warning = '';
const notes = [];
if ((process.env.SITE_LOGINS || '').trim()) {
  try {
    const parsed = JSON.parse(process.env.SITE_LOGINS);
    for (const [host, cfg] of Object.entries(parsed)) logins[host.trim().toLowerCase()] = cfg;
    console.log(`Login configured for: ${Object.keys(logins).join(', ') || '(none)'}`);
  } catch {
    warning = 'The SITE_LOGINS secret is not valid JSON, so pages were captured without signing in.';
    console.error(warning);
  }
}

const DEFAULT_USER = [
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[type="text"]',
]
  .map((s) => `${s}:visible`)
  .join(', ');
const DEFAULT_PASS = 'input[type="password"]:visible';
const DEFAULT_SUBMIT = 'button[type="submit"]:visible, input[type="submit"]:visible';

function checkLogin(host, c) {
  if (!c || typeof c !== 'object') return 'Login settings for this site are not an object.';
  for (const k of ['loginUrl', 'username', 'password']) {
    if (!c[k] || typeof c[k] !== 'string') return `Login settings for this site are missing "${k}".`;
  }
  let u;
  try {
    u = new URL(c.loginUrl);
  } catch {
    return 'Login settings: loginUrl is not a valid link.';
  }
  // never send credentials to a different site than the one they belong to
  if (u.hostname.toLowerCase() !== host && !u.hostname.toLowerCase().endsWith('.' + host)) {
    return 'Login settings: loginUrl must be on the same site as its key.';
  }
  return '';
}

async function doLogin(page, c) {
  await page.goto(c.loginUrl, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const user = page.locator(c.userSelector || DEFAULT_USER).first();
  const pass = page.locator(c.passSelector || DEFAULT_PASS).first();
  await user.waitFor({ state: 'visible', timeout: 15000 });
  await user.fill(c.username);
  await pass.fill(c.password);

  const submit = page.locator(c.submitSelector || DEFAULT_SUBMIT).first();
  if (await submit.count()) await submit.click();
  else await pass.press('Enter');

  // the login form should go away once we are signed in
  await pass.waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const stillThere = await page
    .locator(c.passSelector || DEFAULT_PASS)
    .first()
    .isVisible()
    .catch(() => false);
  if (stillThere) {
    throw new Error(
      'Login failed: the login form is still showing. Check the username, the password and the selectors.'
    );
  }
}

// ---- helpers ----------------------------------------------------------------
const usedNames = new Set();

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'screenshot'
  );
}

function uniqueName(base) {
  let name = base;
  for (let n = 2; usedNames.has(name); n++) name = `${base}-${n}`;
  usedNames.add(name);
  return name;
}

const samePage = (a, b) => {
  const x = new URL(a);
  const y = new URL(b);
  return x.origin === y.origin && x.pathname === y.pathname;
};

// Each entry is either "url" or "name url", separated by new lines or commas
function parseTargets(raw) {
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
      targets.push({ name: uniqueName(slugify(entry)), url: entry, invalid: true });
      continue;
    }

    const base = label
      ? slugify(label)
      : slugify(url.hostname + (url.pathname !== '/' ? url.pathname : ''));
    targets.push({ label, base, url: url.href });
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

// Open a page and wait until it looks finished. Returns the HTTP status (0 if unknown).
async function visit(page, url) {
  const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  if (FULL_PAGE) await autoScroll(page);
  await page.waitForTimeout(WAIT_MS);
  return res ? res.status() : 0;
}

async function shoot(page, name, url, signedIn) {
  const buf = await page.screenshot({ fullPage: FULL_PAGE, animations: 'disabled' });
  const file = `${name}.png`;
  fs.writeFileSync(path.join(OUT_DIR, file), buf);
  console.log(`  saved ${file}${signedIn ? ' (signed in)' : ''}`);
  return {
    name,
    url,
    ok: true,
    file,
    bytes: buf.length,
    // PNG header: width at byte 16, height at byte 20
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    ...(signedIn ? { signedIn: true } : {}),
  };
}

// ---- crawl helpers ------------------------------------------------------------
const SKIP_EXT =
  /\.(pdf|zip|rar|7z|gz|tar|apk|ipa|exe|dmg|jpe?g|png|gif|webp|svg|ico|bmp|avif|mp4|webm|mov|mp3|wav|css|m?js|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|map)$/i;
// links that could end the session or change data when merely opened
const SKIP_PATH = /(^|[/_=&?-])(log-?out|sign-?out|signoff|delete|remove|destroy|unsubscribe)([/_.=&?-]|$)/i;

const routePath = (u) => (/^#!?\//.test(u.hash) ? u.hash.replace(/^#!?/, '') : u.pathname);

function normalizeLink(href, baseUrl, host) {
  let u;
  try {
    u = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname.toLowerCase() !== host) return null;
  // keep only hash *routes* (#/orders), drop in-page anchors (#section)
  if (!/^#!?\//.test(u.hash)) u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|ref$)/i.test(k)) u.searchParams.delete(k);
  }
  if (SKIP_EXT.test(u.pathname)) return null;
  if (SKIP_PATH.test(u.pathname + u.search)) return null;
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.href;
}

const isIdLike = (s) =>
  /^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(s);

async function sitemapUrls(context, origin, host) {
  const grab = async (u) => {
    try {
      const r = await context.request.get(u, { timeout: 10000 });
      return r.ok() ? await r.text() : '';
    } catch {
      return '';
    }
  };
  const locs = (xml) =>
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));

  const xml = await grab(`${origin}/sitemap.xml`);
  if (!xml) return [];
  let out = [];
  if (/<sitemapindex/i.test(xml)) {
    for (const sm of locs(xml).slice(0, 3)) {
      try {
        if (new URL(sm).hostname.toLowerCase() === host) out = out.concat(locs(await grab(sm)));
      } catch {
        /* ignore bad sitemap link */
      }
    }
  } else {
    out = locs(xml);
  }
  return out.slice(0, 500);
}

// Follow links on a site and take one screenshot of every page found
async function crawl(page, context, t, host, login, signedIn) {
  const origin = new URL(t.url).origin;
  const seedUrl = normalizeLink(t.url, t.url, host) || t.url;
  const seen = new Set([seedUrl]);
  const queue = [seedUrl];
  const counts = new Map();

  // keeps big sections (product lists, blog posts) from using up the whole limit
  const accept = (u) => {
    const x = new URL(u);
    const rp = routePath(x);
    const segs = rp.split('/').filter(Boolean);
    const keys = [[`path:${rp}`, 3]];
    if (segs.some(isIdLike)) keys.push([`shape:${segs.map((s) => (isIdLike(s) ? ':id' : s)).join('/')}`, 2]);
    if (segs.length >= 2) keys.push([`folder:${segs.slice(0, -1).join('/')}`, 5]);
    if (keys.some(([k, cap]) => (counts.get(k) || 0) >= cap)) return false;
    for (const [k] of keys) counts.set(k, (counts.get(k) || 0) + 1);
    return true;
  };
  accept(seedUrl);

  const enqueue = (u) => {
    if (!u || seen.has(u) || !accept(u)) return;
    seen.add(u);
    queue.push(u);
  };

  let taken = 0;
  let fails = 0;
  let sitemapTried = false;
  const okCount = () => items.filter((i) => i.ok).length;

  while (queue.length && taken < MAX_PAGES && okCount() < TOTAL_CAP && fails < 5) {
    const url = queue.shift();
    console.log(`  [${taken + 1}/${MAX_PAGES}] ${url}`);
    try {
      const status = await visit(page, url);
      const finalUrl = normalizeLink(page.url(), page.url(), host);
      if (!finalUrl) {
        console.log('  skipped (left the site)');
        continue;
      }
      if (status >= 400) {
        if (url === seedUrl) throw new Error(`The page answered with HTTP ${status}`);
        console.log(`  skipped (HTTP ${status})`);
        continue;
      }
      if (finalUrl !== url) {
        if (seen.has(finalUrl)) {
          console.log('  skipped (same page as one already found)');
          continue;
        }
        seen.add(finalUrl);
      }
      if (
        login &&
        typeof login.loginUrl === 'string' &&
        samePage(finalUrl, login.loginUrl) &&
        !samePage(url, login.loginUrl)
      ) {
        console.log('  skipped (sent to the login page)');
        continue;
      }

      const hrefs = await page.$$eval('a[href]', (as) =>
        as.map((a) => (typeof a.href === 'string' ? a.href : ''))
      );
      for (const h of hrefs) enqueue(normalizeLink(h, finalUrl, host));
      if (!sitemapTried) {
        sitemapTried = true;
        for (const u of await sitemapUrls(context, origin, host)) enqueue(normalizeLink(u, origin, host));
      }

      const fx = new URL(finalUrl);
      const name = uniqueName(slugify(host + routePath(fx) + fx.search));
      items.push(await shoot(page, name, finalUrl, signedIn));
      taken++;
      fails = 0;
    } catch (err) {
      fails++;
      const msg = err.message.split('\n')[0].slice(0, 200);
      console.error(`  FAILED: ${msg}`);
      items.push({ name: uniqueName(slugify(host + new URL(url).pathname)), url, ok: false, error: msg });
    }
  }

  const left = queue.length;
  if (fails >= 5) notes.push(`${host}: stopped after 5 failures in a row.`);
  else if (left > 0 && taken >= MAX_PAGES) {
    notes.push(`${host}: captured ${taken} pages, ${left} more were found. Raise the limit to get them.`);
  } else if (left > 0) {
    notes.push(`${host}: stopped at the limit of ${TOTAL_CAP} screenshots per run.`);
  }
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
const sessions = new Map(); // host -> saved session after a successful login
const failedLogins = new Map(); // host -> error (never retried, avoids account lockouts)
const crawled = new Set();

for (const t of targets) {
  if (t.invalid) {
    items.push({ name: t.name, url: t.url, ok: false, error: 'Not a valid link' });
    continue;
  }

  const host = new URL(t.url).hostname.toLowerCase();

  if (items.filter((i) => i.ok).length >= TOTAL_CAP) {
    items.push({
      name: uniqueName(t.base),
      url: t.url,
      ok: false,
      error: `Skipped: this run reached the limit of ${TOTAL_CAP} screenshots.`,
    });
    continue;
  }
  if (CRAWL && crawled.has(host)) {
    notes.push(`${host}: skipped a second link, the site was already crawled in this run.`);
    continue;
  }

  const login = logins[host];
  let signedIn = false;

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    userAgent: DESKTOP_UA,
    isMobile: false,
    hasTouch: false,
    storageState: sessions.get(host),
  });
  const page = await context.newPage();

  try {
    console.log(`> ${t.base}  ${t.url}${CRAWL ? '  (whole site)' : ''}`);

    // a link to the login page itself is captured signed out
    const isLoginPage =
      Boolean(login) && typeof login.loginUrl === 'string' && samePage(t.url, login.loginUrl);
    if (login && !isLoginPage) {
      if (failedLogins.has(host)) throw new Error(failedLogins.get(host));
      const bad = checkLogin(host, login);
      if (bad) {
        failedLogins.set(host, bad);
        throw new Error(bad);
      }
      if (!sessions.has(host)) {
        console.log(`  signing in to ${host}`);
        try {
          await doLogin(page, login);
        } catch (e) {
          failedLogins.set(host, e.message.split('\n')[0].slice(0, 200));
          throw e;
        }
        sessions.set(host, await context.storageState());
      }
      signedIn = true;
    }

    if (CRAWL) {
      crawled.add(host);
      await crawl(page, context, t, host, login, signedIn);
    } else {
      const status = await visit(page, t.url);
      if (status >= 400) console.warn(`  warning: HTTP ${status}`);
      if (signedIn && samePage(page.url(), login.loginUrl)) {
        throw new Error('Sent back to the login page. The sign-in was not accepted for this link.');
      }
      items.push(await shoot(page, uniqueName(t.base), t.url, signedIn));
    }
  } catch (err) {
    const msg = err.message.split('\n')[0].slice(0, 200);
    console.error(`  FAILED: ${msg}`);
    items.push({ name: uniqueName(t.base), url: t.url, ok: false, error: msg });
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
      crawl: CRAWL,
      ...(warning ? { warning } : {}),
      ...(notes.length ? { notes } : {}),
      items,
    },
    null,
    2
  )
);

console.log(`\nDone: ${items.filter((i) => i.ok).length} of ${items.length} captured.`);
