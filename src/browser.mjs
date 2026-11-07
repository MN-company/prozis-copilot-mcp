import fs from 'node:fs/promises';
import { SITE, LOCALE_PATH } from './config.mjs';

export const ADG = 'https://adg.prozis.com/it/it/';

export class ProzisError extends Error {
  constructor(message, code = 'PROZIS_ERROR', details) { super(message); this.code = code; this.details = details; }
}

/**
 * Prozis sits behind Cloudflare, which refuses non-browser and headless clients. Every request
 * is therefore an XHR issued from inside a normal (windowed, minimized) Chromium page on
 * www.prozis.com, with the user's own profile. We never try to solve or bypass a challenge:
 * if one appears, the user is asked to open the window and complete it.
 */
export class ProzisBrowser {
  #context; #page; #opening; #last = 0; #queue = Promise.resolve();
  constructor(config, { launcher } = {}) { this.config = config; this.launcher = launcher; }

  async #open() {
    if (this.#page && !this.#page.isClosed()) return this.#page;
    if (!this.#opening) this.#opening = (async () => {
      const launcher = this.launcher ?? (await import('playwright')).chromium;
      await fs.mkdir(this.config.profilePath, { recursive: true, mode: 0o700 });
      this.#context = await launcher.launchPersistentContext(this.config.profilePath, {
        headless: false, locale: 'it-IT', args: ['--start-minimized'],
        ...(this.config.channel === 'chrome' ? { channel: 'chrome' } : {}),
        ...(this.config.browserExecutable ? { executablePath: this.config.browserExecutable } : {}) });
      this.#page = this.#context.pages()[0] ?? await this.#context.newPage();
      const res = await this.#page.goto(`${SITE}${LOCALE_PATH}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (res && [403, 429, 503].includes(res.status())) throw challenge();
      return this.#page;
    })().finally(() => { this.#opening = undefined; });
    return this.#opening;
  }

  /** Serialized, rate-limited XHR from the page. Returns parsed JSON. Never retried automatically. */
  xhr(path, { method = 'GET', json } = {}) {
    const run = async () => {
      const wait = this.#last + this.config.minIntervalMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.#last = Date.now();
      const page = await this.#open();
      const r = await page.evaluate(({ url, method, body }) => new Promise(res => {
        const q = new XMLHttpRequest();
        q.open(method, url);
        // adg.prozis.com is Prozis' own content host (reviews, product tabs); the page itself calls it with credentials.
        q.withCredentials = url.startsWith('https://adg.prozis.com/');
        q.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        if (body) q.setRequestHeader('Content-Type', 'application/json');
        q.timeout = 25000;
        q.onload = () => res({ status: q.status, type: q.getResponseHeader('content-type') ?? '', text: q.responseText });
        q.onerror = q.ontimeout = () => res({ status: 0, type: '', text: '' });
        q.send(body ?? null);
      }), { url: path.startsWith(ADG) ? path : `${LOCALE_PATH}/${path}`, method, body: json ? JSON.stringify(json) : null }).catch(() => ({ status: 0, text: '' }));
      if ([403, 429, 503].includes(r.status)) throw challenge();
      if (r.status === 0) throw new ProzisError('Prozis non raggiungibile', 'NETWORK_ERROR');
      if (r.status === 404 || r.status === 410) throw new ProzisError('Non trovato su Prozis', 'NOT_FOUND');
      if (r.status >= 400) throw new ProzisError(`HTTP ${r.status} da Prozis`, 'HTTP_ERROR');
      if (!/json/.test(r.type)) throw new ProzisError('Risposta inattesa da Prozis (non JSON)', 'BAD_RESPONSE');
      try { return JSON.parse(r.text); } catch { throw new ProzisError('JSON non valido da Prozis', 'BAD_RESPONSE'); }
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }

  async close() { await this.#context?.close().catch(() => {}); this.#context = this.#page = undefined; }
}

const challenge = () => new ProzisError('Prozis/Cloudflare chiede una verifica: apri la finestra del browser di Prozis Copilot, completa la verifica e riprova.', 'CHALLENGE_REQUIRED');
