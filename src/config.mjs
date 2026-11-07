import os from 'node:os';
import path from 'node:path';

export const SITE = 'https://www.prozis.com';
export const LOCALE_PATH = '/it/it';
/** Free-shipping threshold observed on prozis.com/it (site banner, 2026-11). The cart's own freeShipping flag wins when present. */
export const FREE_SHIPPING_FROM = 29.99;

export function getConfig(env = process.env) {
  const dataDir = env.PROZIS_DATA_DIR || path.join(os.homedir(), '.prozis-copilot');
  return {
    dataDir,
    dbPath: path.join(dataDir, 'agent.sqlite'),
    profilePath: env.PROZIS_PROFILE_DIR || path.join(dataDir, 'browser-profile'),
    channel: env.BROWSER_CHANNEL || '',
    browserExecutable: env.BROWSER_EXECUTABLE || '',
    port: Number(env.PORT || 3791),
    bindHost: env.BIND_HOST || '127.0.0.1',
    allowCartWrites: env.ALLOW_CART_WRITES !== 'false',
    // Prozis is behind Cloudflare: keep traffic slow and human-paced.
    minIntervalMs: Number(env.PROZIS_MIN_INTERVAL_MS || 2000),
    planTtlMs: 15 * 60 * 1000
  };
}
