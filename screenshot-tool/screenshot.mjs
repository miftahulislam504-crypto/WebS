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
// Keys are a host ("app.example.com") or a host plus folder ("user.github.io/ez-menu").
// { "app.example.com": { "loginUrl": "...", "username": "...", "password": "..." } }
const loginRules = []; // { key, host, path, cfg }
let warning = '';
const notes = [];
if ((process.env.SITE_LOGINS || '').trim()) {
  try {
    const parsed = JSON.parse(process.env.SITE_LOGINS);
    for (const [rawKey, cfg] of Object.entries(parsed)) {
      const key = rawKey.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      const slash = key.indexOf('/');
      const host = (slash === -1 ? key : key.slice(0, slash)).toLowerCase();
      const folder = slash === -1 ? '' : '/' + key.slice(slash + 1).replace(/^\/+/, '');
      loginRules.push({ key: host + folder, host, path: folder, cfg });
    }
    console.log(`Login configured for: ${loginRules.map((r) => r.key).join(', ') || '(none)'}`);
  } catch {
    warning = 'The SITE_LOGINS secret is not valid JSON, so pages were captured without signing in.';
    console.error(warning);
  }
}

// the most specific rule wins: "host/folder" beats "host"
function findLogin(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const p = u.pathname.replace(/\/+$/, '') + '/';
  let best = null;
  for (const r of loginRules) {
    if (r.host !== host) continue;
    if (r.path && !(p === r.path + '/' || p.startsWith(r.path + '/'))) continue;
    if (!best || r.path.length > best.path.length) best = r;
  }
  return best;
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

function checkLogin(rule) {
  const c = rule.cfg;
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
  const h = u.hostname.toLowerCase();
  if (h !== rule.host && !h.endsWith('.' + rule.host)) {
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

  let submit = page.locator(c.submitSelector || DEFAULT_SUBMIT).first();
  if (!(await submit.count()) && !c.submitSelector) {
    // forms built with a plain button (no type="submit"): find it by its label
    submit = page
      .getByRole('button', { name: /sign ?in|log ?in|login|submit|continue|enter|লগ ?ইন|সাইন ইন/i })
      .first();
  }
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
  return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
};

// GitHub Pages answers deep links of single-page apps with HTTP 404 (its 404.html
// fallback) even though the app shows the page fine, so the status means nothing there.
const isGhPages = (host) => host.endsWith('.github.io');

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

// scope: a folder ("/ez-menu") that the crawl must stay inside, or '' for the whole host
function normalizeLink(href, baseUrl, host, scope) {
  let u;
  try {
    u = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname.toLowerCase() !== host) return null;
  if (scope && !(u.pathname === scope || u.pathname.startsWith(scope + '/'))) return null;
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

async function sitemapUrls(context, origin, host, scope) {
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

  const xml = await grab(`${origin}${scope}/sitemap.xml`);
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

async function getHrefs(page) {
  for (let i = 0; i < 3; i++) {
    try {
      return await page.$$eval('a[href]', (as) =>
        as.map((a) => (typeof a.href === 'string' ? a.href : ''))
      );
    } catch {
      // the page was still navigating (for example a client-side redirect): wait and retry
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
  return [];
}

// Sign in once per site/folder and remember the session for later links
async function ensureSignedIn(page, context, rule) {
  if (failedLogins.has(rule.key)) throw new Error(failedLogins.get(rule.key));
  const bad = checkLogin(rule);
  if (bad) {
    failedLogins.set(rule.key, bad);
    throw new Error(bad);
  }
  if (!sessions.has(rule.key)) {
    console.log(`  signing in to ${rule.key}`);
    try {
      await doLogin(page, rule.cfg);
    } catch (e) {
      failedLogins.set(rule.key, e.message.split('\n')[0].slice(0, 200));
      throw e;
    }
    sessions.set(rule.key, await context.storageState());
  }
  return true;
}

// Follow links on a site and take one screenshot of every page found
async function crawl(page, context, t, host, rule) {
  if (rule) {
    const bad = checkLogin(rule);
    if (bad) throw new Error(bad);
  }
  const login = rule ? rule.cfg : null;
  const origin = new URL(t.url).origin;

  // stay inside the app's folder when the host is shared (GitHub Pages) or the rule has a folder
  let scope = rule && rule.path ? rule.path : '';
  if (!scope && isGhPages(host)) {
    const first = new URL(t.url).pathname.split('/').filter(Boolean)[0];
    if (first) scope = '/' + first;
  }
  const norm = (href, base) => normalizeLink(href, base, host, scope);

  const seedUrl = norm(t.url, t.url) || t.url;
  // starting from the login page itself: capture it signed out, then sign in and go on
  const seedIsLogin = Boolean(login) && samePage(seedUrl, login.loginUrl);
  let signedIn = false;
  if (login && !seedIsLogin) signedIn = await ensureSignedIn(page, context, rule);

  const seen = new Set([seedUrl]);
  const queue = [seedUrl];
  const counts = new Map();

  // keeps big sections (product lists, blog posts) from using up the whole limit
  let capped = 0;
  const accept = (u) => {
    const x = new URL(u);
    let rp = routePath(x);
    // count folders from the app folder down, so pages at the top level of an app are not "in a folder"
    if (scope && !/^#!?\//.test(x.hash) && rp.startsWith(scope)) rp = rp.slice(scope.length) || '/';
    const segs = rp.split('/').filter(Boolean);
    const keys = [[`path:${rp}`, 3]];
    if (segs.some(isIdLike)) keys.push([`shape:${segs.map((s) => (isIdLike(s) ? ':id' : s)).join('/')}`, 2]);
    if (segs.length >= 2) keys.push([`folder:${segs.slice(0, -1).join('/')}`, 12]);
    if (keys.some(([k, cap]) => (counts.get(k) || 0) >= cap)) {
      capped++;
      return false;
    }
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
  let firstLinkCount = null;
  const okCount = () => items.filter((i) => i.ok).length;
  const ignoreStatus = isGhPages(host);

  while (queue.length && taken < MAX_PAGES && okCount() < TOTAL_CAP && fails < 5) {
    const url = queue.shift();
    console.log(`  [${taken + 1}/${MAX_PAGES}] ${url}`);
    try {
      const status = await visit(page, url);
      const finalUrl = norm(page.url(), page.url());
      if (!finalUrl) {
        console.log('  skipped (left the site or the app folder)');
        continue;
      }
      if (status >= 400 && !ignoreStatus) {
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
        samePage(finalUrl, login.loginUrl) &&
        !samePage(url, login.loginUrl)
      ) {
        console.log('  skipped (sent to the login page)');
        continue;
      }

      const hrefs = await getHrefs(page);
      if (firstLinkCount === null) firstLinkCount = hrefs.length;
      for (const h of hrefs) enqueue(norm(h, finalUrl));
      if (!sitemapTried) {
        sitemapTried = true;
        for (const u of await sitemapUrls(context, origin, host, scope)) enqueue(norm(u, origin));
      }

      const fx = new URL(finalUrl);
      const name = uniqueName(slugify(host + routePath(fx) + fx.search));
      items.push(await shoot(page, name, finalUrl, signedIn));
      taken++;
      fails = 0;

      if (seedIsLogin && !signedIn && url === seedUrl) {
        signedIn = await ensureSignedIn(page, context, rule);
        const landing = norm(page.url(), page.url());
        if (landing && !seen.has(landing) && accept(landing)) {
          seen.add(landing);
          queue.unshift(landing);
        }
      }
    } catch (err) {
      fails++;
      const msg = err.message.split('\n')[0].slice(0, 200);
      console.error(`  FAILED: ${msg}`);
      items.push({ name: uniqueName(slugify(host + new URL(url).pathname)), url, ok: false, error: msg });
    }
  }

  const left = queue.length;
  if (capped > 0) {
    notes.push(`${host}: ${capped} similar pages were left out (many pages of one kind, like product or blog pages).`);
  }
  if (fails >= 5) {
    notes.push(`${host}: stopped after 5 failures in a row.`);
  } else if (left > 0 && taken >= MAX_PAGES) {
    notes.push(`${host}: captured ${taken} pages, ${left} more were found. Raise the limit to get them.`);
  } else if (left > 0) {
    notes.push(`${host}: stopped at the limit of ${TOTAL_CAP} screenshots per run.`);
  } else if (taken <= 1) {
    const seenLinks = firstLinkCount === null ? 0 : firstLinkCount;
    notes.push(
      signedIn
        ? `${host}: only ${taken} page was found after signing in (the first page had ${seenLinks} links). The menus may work with buttons instead of links.`
        : `${host}: only ${taken} page was found (the first page had ${seenLinks} links). Either the other pages need a sign-in, so add the site to SITE_LOGINS, or the menus work with buttons instead of links.`
    );
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
const sessions = new Map(); // login rule key -> saved session after a successful login
const failedLogins = new Map(); // login rule key -> error (never retried, avoids account lockouts)
const crawled = new Set();

for (const t of targets) {
  if (t.invalid) {
    items.push({ name: t.name, url: t.url, ok: false, error: 'Not a valid link' });
    continue;
  }

  const host = new URL(t.url).hostname.toLowerCase();
  const rule = findLogin(t.url);

  if (items.filter((i) => i.ok).length >= TOTAL_CAP) {
    items.push({
      name: uniqueName(t.base),
      url: t.url,
      ok: false,
      error: `Skipped: this run reached the limit of ${TOTAL_CAP} screenshots.`,
    });
    continue;
  }
  const crawlKey = rule ? rule.key : host + (isGhPages(host) ? '/' + (new URL(t.url).pathname.split('/')[1] || '') : '');
  if (CRAWL && crawled.has(crawlKey)) {
    notes.push(`${crawlKey}: skipped a second link, the site was already crawled in this run.`);
    continue;
  }

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    userAgent: DESKTOP_UA,
    isMobile: false,
    hasTouch: false,
    storageState: rule ? sessions.get(rule.key) : undefined,
  });
  const page = await context.newPage();

  try {
    console.log(`> ${t.base}  ${t.url}${CRAWL ? '  (whole site)' : ''}`);

    if (CRAWL) {
      crawled.add(crawlKey);
      await crawl(page, context, t, host, rule);
    } else {
      // a link to the login page itself is captured signed out
      let signedIn = false;
      if (rule) {
        const bad = checkLogin(rule);
        if (bad) throw new Error(bad);
        if (!samePage(t.url, rule.cfg.loginUrl)) signedIn = await ensureSignedIn(page, context, rule);
      }
      const status = await visit(page, t.url);
      if (status >= 400) console.warn(`  warning: HTTP ${status}`);
      if (signedIn && samePage(page.url(), rule.cfg.loginUrl)) {
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
