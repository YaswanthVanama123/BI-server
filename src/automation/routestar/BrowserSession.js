'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const selectors = require('./selectors');
const { LoginError, SessionExpiredError, AutomationError } = require('./errors');
const logger = require('../../utils/logger');

class BrowserSession {
  constructor(opts = {}) {
    this.config = { ...config, ...opts };
    this.selectors = selectors;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
    this.isLoggedIn = false;
    this.log = opts.logger || logger.child('routestar:session');
  }

  async init() {
    if (this.isInitialized) return;
    const b = this.config.browser;
    this.log.info(`launching chromium (headless=${b.headless}, timeout=${b.timeout}ms)`);
    this.browser = await chromium.launch({ headless: b.headless, args: b.args, timeout: b.timeout });
    this.context = await this.browser.newContext({ viewport: b.viewport, userAgent: b.userAgent });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(b.timeout);
    this.isInitialized = true;
  }

  async close() {
    const withTimeout = async (label, fn, ms = 10000) => {
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
      } catch (e) { this.log.warn(`close: ${label} error: ${e.message}`); }
    };
    if (this.page) { await withTimeout('page.close', () => this.page.close()); this.page = null; }
    if (this.context) { await withTimeout('context.close', () => this.context.close()); this.context = null; }
    if (this.browser) {
      await withTimeout('browser.close', () => this.browser.close());
      try {
        const proc = typeof this.browser.process === 'function' ? this.browser.process() : null;
        if (proc && !proc.killed) proc.kill('SIGKILL');
      } catch (e) { this.log.warn(`close: force-kill error: ${e.message}`); }
      this.browser = null;
    }
    this.isInitialized = false;
    this.isLoggedIn = false;
  }

  async login() {
    const { credentials, baseUrl, routes } = this.config;
    if (!credentials.username || !credentials.password) {
      throw new LoginError('ROUTESTAR_USERNAME / ROUTESTAR_PASSWORD not set (check .env)');
    }
    const s = this.selectors.login;
    const loginUrl = baseUrl + routes.login;
    const loginTimeout = this.config.browser.timeout * 1.5;
    try {
      this.log.info(`navigating to login: ${loginUrl}`);
      await this.page.goto(loginUrl, { waitUntil: 'load', timeout: loginTimeout });
      await this.page.waitForTimeout(2000);
      try {
        const cookieBtn = await this.page.$(s.cookieAcceptButton);
        if (cookieBtn) { await cookieBtn.click(); await this.page.waitForTimeout(1000); }
      } catch {  }

      await this.page.waitForSelector(s.username, { timeout: 20000, state: 'visible' });
      await this.page.fill(s.username, '');
      await this.page.fill(s.username, credentials.username);
      await this.page.fill(s.password, '');
      await this.page.fill(s.password, credentials.password);

      const submit = await this.page.$(s.submitButton);
      if (!submit) { await this.screenshot('login-button-not-found'); throw new LoginError('login submit button not found'); }
      await submit.click();
      await this.page.waitForTimeout(3000);

      const err = await this.page.$(s.errorMessage);
      if (err) {
        const txt = (await err.textContent() || '').trim();
        if (txt) { await this.screenshot('login-error-message'); throw new LoginError(`login error: ${txt}`); }
      }
      if (this.page.url().includes('/web/login')) {
        await this.screenshot('still-on-login');
        throw new LoginError('still on login page after submit — check credentials');
      }
      await this.page.waitForTimeout(2000);
      this.isLoggedIn = true;
      this.log.info(`login OK -> ${this.page.url()}`);
      return true;
    } catch (e) {
      await this.screenshot('login-error');
      if (e instanceof AutomationError) throw e;
      throw new LoginError(`login failed: ${e.message}`);
    }
  }

  async goto(url) {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {
      await this.page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    }
    if (this.page.url().includes('/web/login')) {
      throw new SessionExpiredError('redirected to /web/login — session expired');
    }
  }

  async openGrid(url, label = 'grid') {
    this.log.info(`opening ${label}: ${url}`);
    await this.goto(url);
    await this.page.waitForTimeout(3000);
    const { renderTimeoutMs, pollIntervalMs, dataSettleMs } = this.config.grid;
    const start = Date.now();
    let rendered = false;
    while (!rendered && Date.now() - start < renderTimeoutMs) {
      if (await this.page.$(this.selectors.grid.anyTable)) { rendered = true; break; }
      await this.page.waitForTimeout(pollIntervalMs);
    }
    if (!rendered) {
      await this.screenshot(`${label}-not-rendered`);
      throw new AutomationError(`${label} grid did not render within ${renderTimeoutMs}ms`);
    }
    await this.page.waitForTimeout(dataSettleMs);
    this.log.info(`${label} grid rendered`);
  }

  async extractGridRows(mapping) {
    const rowHandles = await this.page.$$(this.selectors.grid.rows);
    const out = [];
    for (const row of rowHandles) {
      const rec = {};
      let hasContent = false;
      for (const [field, spec] of Object.entries(mapping)) {
        const value = await extractCell(row, spec);
        rec[field] = value;
        if (value !== null && value !== '' && value !== undefined) hasContent = true;
      }
      if (hasContent) out.push(rec);
    }
    return out;
  }

  async goToNextPage() {
    const p = this.selectors.pagination;
    const nextLi = await this.page.$(p.nextButton);
    if (nextLi) {
      const disabled = await nextLi.evaluate((el) => el.classList.contains('disabled'));
      if (disabled) { this.log.debug('next disabled — last page'); return false; }
    }
    if (!nextLi) { this.log.debug('no next button — single/last page'); return false; }

    const firstBefore = await this.firstRowSignature();
    try {
      const dlg = await this.page.$(p.modalDialog);
      if (dlg) {
        const cancel = await this.page.$(p.modalCancel);
        if (cancel) await cancel.click(); else await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(500);
      }
    } catch {  }

    const link = await nextLi.$('a');
    const target = link || nextLi;
    try { await target.scrollIntoViewIfNeeded(); await this.page.waitForTimeout(300); } catch {  }
    try { await target.click({ timeout: 5000 }); } catch { await target.evaluate((el) => el.click()); }

    for (let i = 0; i < 15; i++) {
      await this.page.waitForTimeout(1000);
      const after = await this.firstRowSignature();
      if (after && after !== firstBefore) { this.log.debug('page advanced'); return true; }
    }
    this.log.warn('page content may not have changed after next-click');
    return true;
  }

  async firstRowSignature() {
    try {
      const cell = await this.page.$(`${this.selectors.grid.table} tbody tr:first-child td:nth-of-type(1)`);
      return cell ? (await cell.textContent() || '').trim() : null;
    } catch { return null; }
  }

  absoluteUrl(href) {
    if (!href) return null;
    try { return new URL(href, this.config.baseUrl).href; } catch { return href; }
  }

  async screenshot(name) {
    try {
      const dir = path.resolve(process.cwd(), this.config.screenshotDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}-${Date.now()}.png`);
      await this.page.screenshot({ path: file, fullPage: true });
      this.log.info(`screenshot: ${file}`);
      return file;
    } catch (e) { this.log.warn(`screenshot failed: ${e.message}`); return null; }
  }

  async withRetry(fn, label = 'op') {
    const { maxAttempts, delay, backoff } = this.config.retry;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        if (e instanceof SessionExpiredError) throw e;
        if (attempt === maxAttempts) break;
        const wait = backoff ? delay * attempt : delay;
        this.log.warn(`${label} attempt ${attempt} failed: ${e.message} — retry in ${wait}ms`);
        if (this.page) await this.page.waitForTimeout(wait);
      }
    }
    throw lastErr;
  }
}

async function extractCell(row, spec) {
  const { sel, attr, checkbox, money } = spec;
  try {
    if (checkbox) return await row.$eval(sel, (el) => !!el.checked).catch(() => false);
    if (attr) return await row.$eval(sel, (el, a) => el.getAttribute(a), attr);
    let text = await row.$eval(sel, (el) => el.textContent.trim());
    if (money && text) text = text.replace(/[$,]/g, '').replace('▼', '').trim();
    return text;
  } catch { return null; }
}

module.exports = BrowserSession;
