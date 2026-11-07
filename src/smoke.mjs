/** Read-only live check: opens the Prozis window, searches, reads a product, its nutrition and the cart. Adds nothing. */
import { getConfig } from './config.mjs';
import { ProzisBrowser } from './browser.mjs';
import { ProzisClient } from './client.mjs';
const browser = new ProzisBrowser(getConfig());
const c = new ProzisClient(browser);
try {
  const s = await c.search('whey');
  console.log('search:', s.total, s.products.slice(0, 3).map(p => `${p.groupId} ${p.name} €${p.price}`).join(' | '));
  const d = await c.productDetails(s.products[0].groupId);
  console.log('details:', JSON.stringify(d.options), 'variants:', d.variantCount, 'in stock:', d.inStockCount);
  const n = await c.nutrition(s.products[0].groupId);
  console.log('nutrition:', n.serving, 'protein/100g:', n.proteinPer100g, 'net:', n.netWeight);
  console.log('cart items:', (await c.readCart()).totalQuantity);
} finally { await browser.close(); }
