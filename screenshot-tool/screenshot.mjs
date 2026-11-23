import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const TOOL_VERSION = '4';
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
    const pl = p.toLowerCase();
    const rl = r.path.toLowerCase();
    if (rl && !(pl === rl + '/' || pl.startsWith(rl + '/'))) continue;
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
  for (const k of ['username', 'password']) {
    if (!c[k] || typeof c[k] !== 'string') return `Login settings for this site are missing "${k}".`;
  }
  if (c.loginUrl) {
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
  }
  return '';
}

// where the sign-in form is: the configured loginUrl, or the page where it was found
const loginPageOf = (rule) => (rule.cfg && rule.cfg.loginUrl) || rule.loginPage || '';

const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return x.host + (x.pathname === '/' ? '' : x.pathname);
  } catch {
    return u;
  }
};

// A picture of what the tool sees, saved with the results so a failed sign-in can be understood
let debugCount = 0;
async function debugShot(page, label) {
  if (debugCount >= 4) return;
  try {
    debugCount++;
    const buf = await page.screenshot({ animations: 'disabled' });
    const name = uniqueName(`debug-login-${debugCount}`);
    fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), buf);
    items.push({
      name,
      url: page.url(),
      ok: true,
      debug: label,
      file: `${name}.png`,
      bytes: buf.length,
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    });
  } catch {
    /* a missing debug picture must never break the run */
  }
}

const LOGIN_LABEL = /^\s*(sign ?in|log ?in|login|লগ ?ইন|সাইন ইন)\s*[→›>»]?\s*$/i;
const LOGIN_LIKE =
  /^(?!.*(google|facebook|apple|github|with |using ))(.*\b)?(sign ?in|log ?in|login|get started|open (the )?app|launch|dashboard|লগ ?ইন|সাইন ইন)\b/i;
// common places for a sign-in page, tried after the addresses we were given
const LOGIN_PATHS = ['/login', '/signin', '/sign-in', '/auth/login', '/admin/login', '/#/login'];

// ---- finding the sign-in fields -------------------------------------------------------
// Sites mark their fields in many ways, so the usual ones are tried one after another.
const NOT_TEXT = ['checkbox', 'radio', 'hidden', 'submit', 'button', 'file', 'image', 'reset', 'range', 'color'];
const TEXT_LIKE = `input${NOT_TEXT.map((t) => `:not([type="${t}"])`).join('')}`;
const PASS_WORD = /pass(word|code)?|পাসওয়ার্ড/i;
const USER_WORD = /e-?mail|user ?name|user|login|phone|mobile|account|ইমেইল|ফোন|মোবাইল/i;

async function findPasswordField(page, c, timeout) {
  const lists = () =>
    c.passSelector
      ? [page.locator(c.passSelector)]
      : [
          page.locator(DEFAULT_PASS),
          page.locator('input[autocomplete="current-password"]:visible, input[autocomplete="new-password"]:visible'),
          page.getByLabel(PASS_WORD).and(page.locator('input')),
          page.getByPlaceholder(PASS_WORD).and(page.locator('input')),
          page.locator('input[name*="pass" i]:visible, input[id*="pass" i]:visible'),
        ];
  const deadline = Date.now() + timeout;
  do {
    for (const loc of lists()) {
      const first = loc.first();
      if (await first.isVisible().catch(() => false)) return first;
    }
    if (!c.passSelector) {
      // last resort: a page with exactly two fields and a "Sign in" button is a sign-in form
      const all = page.locator(`${TEXT_LIKE}:visible`);
      if ((await all.count().catch(() => 0)) === 2) {
        const hasButton = await page
          .getByRole('button', { name: /sign ?in|log ?in|login|লগ ?ইন|সাইন ইন/i })
          .count()
          .catch(() => 0);
        if (hasButton) return all.nth(1);
      }
    }
    if (Date.now() < deadline) await page.waitForTimeout(300);
  } while (Date.now() < deadline);
  return null;
}

async function findUserField(page, c, pass) {
  const lists = c.userSelector
    ? [page.locator(c.userSelector)]
    : [
        page.locator(DEFAULT_USER),
        page.getByLabel(USER_WORD).and(page.locator('input')),
        page.getByPlaceholder(USER_WORD).and(page.locator('input')),
      ];
  for (const loc of lists) {
    const first = loc.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  if (c.userSelector) return null;
  // the text field that comes right before the password field
  const handle = await pass.elementHandle().catch(() => null);
  if (!handle) return null;
  const prev = await page.evaluateHandle(
    (el, skip) => {
      const all = [...document.querySelectorAll('input')].filter(
        (i) => !skip.includes(i.type) && i.getClientRects().length > 0
      );
      const idx = all.indexOf(el);
      return idx > 0 ? all[idx - 1] : null;
    },
    handle,
    NOT_TEXT
  );
  return prev.asElement();
}

// what fields a page has (no values), to explain a failed sign-in
async function describeInputs(page) {
  try {
    return await page.evaluate(() =>
      [...document.querySelectorAll('input,textarea')]
        .filter((i) => i.getClientRects().length > 0 && !['hidden', 'checkbox', 'radio'].includes(i.type))
        .slice(0, 5)
        .map((i) =>
          [
            i.type || 'text',
            i.name && `name=${i.name}`,
            i.id && `id=${i.id}`,
            i.placeholder && `placeholder=${i.placeholder.slice(0, 16)}`,
            i.getAttribute('aria-label') && `aria=${i.getAttribute('aria-label').slice(0, 16)}`,
          ]
            .filter(Boolean)
            .join(' ')
        )
    );
  } catch {
    return [];
  }
}

// landing pages often only have a "Sign in" link or button: follow it
async function openLoginFromPage(page, c) {
  // already looking at a form with fields: pressing its own Sign in button would not help
  if ((await page.locator(`${TEXT_LIKE}:visible`).count().catch(() => 0)) >= 2) return null;
  for (const name of [LOGIN_LABEL, LOGIN_LIKE]) {
    for (const role of ['link', 'button']) {
      const el = page.getByRole(role, { name }).first();
      if (await el.count()) {
        await el.click({ timeout: 5000 }).catch(() => {});
        const pass = await findPasswordField(page, c, 8000);
        if (pass) return pass;
      }
    }
  }
  return null;
}

// Opens the login page, fills the form and submits. Returns the address where the form was found.
async function doLogin(page, c, fallbackUrls = []) {
  const candidates = [c.loginUrl, ...fallbackUrls].filter((u, i, a) => u && a.indexOf(u) === i);
  const tried = [];
  let loginPage = '';
  let pass = null;

  for (const [idx, u] of candidates.entries()) {
    const res = await gotoSpa(page, u, { waitUntil: 'load', timeout: 45000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    // the first addresses get more time: single-page apps need a moment to draw the form
    pass = await findPasswordField(page, c, idx < 2 ? 12000 : 6000);
    if (!pass && res && res.status() < 400) pass = await openLoginFromPage(page, c);
    if (pass) {
      loginPage = page.url();
      break;
    }
    tried.push({
      text: `${shortUrl(u)} (${res ? 'HTTP ' + res.status() : 'could not be opened'})`,
      status: res ? res.status() : 0,
      fields: await describeInputs(page),
    });
    if (tried.length <= 3) await debugShot(page, `Looked for the sign-in form here: ${shortUrl(u)}`);
  }
  if (!pass) {
    const shown = tried.slice(0, 3).map((t) => t.text).join(', ');
    const withFields = tried.find((t) => t.fields.length);
    throw new Error(
      `Password field not found on ${tried.length} addresses (${shown}).` +
        (withFields
          ? ` Fields seen at ${withFields.text}: ${withFields.fields.map((f) => `[${f}]`).join(' ')}. Add "passSelector" and "userSelector" for these fields.`
          : ' No input fields were visible on those pages. Add "loginUrl" with the exact address of the sign-in page.') +
        (tried.some((t) => t.status === 404) ? ' Addresses on GitHub Pages are case-sensitive.' : '')
    );
  }

  const user = await findUserField(page, c, pass);
  if (!user) {
    throw new Error(
      'The password field was found but the username field was not recognised. Add "userSelector" to the login settings.'
    );
  }
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
  const stillThere = await findPasswordField(page, c, 1500);
  if (stillThere) {
    await debugShot(page, 'The page right after pressing Sign in');
    throw new Error(
      'Login failed: the login form is still showing. Check the username, the password and the selectors.'
    );
  }
  return loginPage;
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
  const res = await gotoSpa(page, url, { waitUntil: 'load', timeout: 45000 });
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

// GitHub Pages has no "always serve index.html" setting, so deep links of single-page apps
// answer 404 for real visitors too, unless the app ships a 404.html trick. Do what a proper
// SPA host does: when an app route answers 404, load it again with the app's own index page.
// Only that one address is touched, so redirects and form submissions behave normally.
const spaRoots = new Map();
async function gotoSpa(page, url, options) {
  const res = await page.goto(url, options);
  const u = new URL(url);
  if (!res || res.status() !== 404 || !isGhPages(u.hostname.toLowerCase())) return res;
  const first = u.pathname.split('/').filter(Boolean)[0];
  if (!first) return res;
  const rootUrl = `${u.origin}/${first}/`;
  if (!spaRoots.has(rootUrl)) {
    const r = await page.context().request.get(rootUrl).catch(() => null);
    spaRoots.set(rootUrl, r && r.ok() ? await r.text() : '');
  }
  const html = spaRoots.get(rootUrl);
  if (!html) return res;
  await page.route(
    (x) => x.href === u.href,
    (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
    { times: 1 }
  );
  return page.goto(url, options);
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
async function ensureSignedIn(page, context, rule, fallbackUrls = []) {
  if (failedLogins.has(rule.key)) throw new Error(failedLogins.get(rule.key));
  const bad = checkLogin(rule);
  if (bad) {
    failedLogins.set(rule.key, bad);
    throw new Error(bad);
  }
  if (!sessions.has(rule.key)) {
    console.log(`  signing in to ${rule.key}`);
    try {
      rule.loginPage = await doLogin(page, rule.cfg, fallbackUrls);
    } catch (e) {
      failedLogins.set(rule.key, e.message.split('\n')[0].slice(0, 600));
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
  const urlSegs = new URL(t.url).pathname.split('/').filter(Boolean);
  let scope = '';
  if (rule && rule.path) scope = '/' + urlSegs.slice(0, rule.path.split('/').filter(Boolean).length).join('/');
  else if (isGhPages(host) && urlSegs[0]) scope = '/' + urlSegs[0];
  const norm = (href, base) => normalizeLink(href, base, host, scope);

  const seedUrl = norm(t.url, t.url) || t.url;
  // starting from the login page itself: capture it signed out, then sign in and go on
  const seedIsLogin = Boolean(login && login.loginUrl) && samePage(seedUrl, login.loginUrl);
  const fallbacks = [seedUrl, `${origin}${scope}/`, ...LOGIN_PATHS.map((x) => `${origin}${scope}${x}`)];
  let signedIn = false;
  let landing = null; // the page the app shows right after signing in (often the dashboard)
  if (login && !seedIsLogin) {
    signedIn = await ensureSignedIn(page, context, rule, fallbacks);
    landing = norm(page.url(), page.url());
  }

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

  if (landing) enqueue(landing);

  let taken = 0;
  let fails = 0;
  let sitemapTried = false;
  let firstLinkCount = null;
  const okCount = () => items.filter((i) => i.ok && !i.debug).length;
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
      const lp = rule ? loginPageOf(rule) : '';
      if (lp && samePage(finalUrl, lp) && !samePage(url, lp)) {
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
        signedIn = await ensureSignedIn(page, context, rule, fallbacks);
        const after = norm(page.url(), page.url());
        if (after && !seen.has(after) && accept(after)) {
          seen.add(after);
          queue.unshift(after);
        }
      }
    } catch (err) {
      fails++;
      const msg = err.message.split('\n')[0].slice(0, 600);
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
  } else if (taken === 1) {
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

  if (items.filter((i) => i.ok && !i.debug).length >= TOTAL_CAP) {
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
        const isLoginPage = Boolean(rule.cfg.loginUrl) && samePage(t.url, rule.cfg.loginUrl);
        if (!isLoginPage) {
          const sUrls = new URL(t.url).pathname.split('/').filter(Boolean);
          const sScope = rule.path ? '/' + sUrls.slice(0, rule.path.split('/').filter(Boolean).length).join('/') : '';
          const sOrigin = new URL(t.url).origin;
          signedIn = await ensureSignedIn(page, context, rule, [
            t.url,
            `${sOrigin}${sScope}/`,
            ...LOGIN_PATHS.map((x) => `${sOrigin}${sScope}${x}`),
          ]);
        }
      }
      const status = await visit(page, t.url);
      if (status >= 400) console.warn(`  warning: HTTP ${status}`);
      if (signedIn && loginPageOf(rule) && samePage(page.url(), loginPageOf(rule))) {
        throw new Error('Sent back to the login page. The sign-in was not accepted for this link.');
      }
      items.push(await shoot(page, uniqueName(t.base), t.url, signedIn));
    }
  } catch (err) {
    const msg = err.message.split('\n')[0].slice(0, 600);
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
      version: TOOL_VERSION,
      ...(warning ? { warning } : {}),
      ...(notes.length ? { notes } : {}),
      items,
    },
    null,
    2
  )
);

const realItems = items.filter((i) => !i.debug);
console.log(`\nDone: ${realItems.filter((i) => i.ok).length} of ${realItems.length} captured.`);
