/** Opens the Prozis Copilot browser window: the USER signs in (and completes any Cloudflare check) there. Stop the MCP server first: they share the profile. */
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getConfig, SITE, LOCALE_PATH } from './config.mjs';

const config = getConfig();
const { chromium } = await import('playwright');
await fs.mkdir(config.profilePath, { recursive: true, mode: 0o700 });
let context;
try {
  context = await chromium.launchPersistentContext(config.profilePath, { headless: false, locale: 'it-IT',
    ...(config.channel === 'chrome' ? { channel: 'chrome' } : {}), ...(config.browserExecutable ? { executablePath: config.browserExecutable } : {}) });
} catch { console.log('Il profilo è in uso: ferma prima il server Prozis MCP e riprova.'); process.exit(1); }
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${SITE}${LOCALE_PATH}/account/login`, { waitUntil: 'domcontentloaded' });
  console.log('Accedi al tuo account Prozis nella finestra (e completa eventuali verifiche Cloudflare).');
  const rl = createInterface({ input, output });
  try { await rl.question('Quando hai finito, torna qui e premi INVIO: '); } finally { rl.close(); }
  console.log('Sessione salvata nel profilo del browser di Prozis Copilot. Riavvia il server.');
} finally { await context.close(); }
