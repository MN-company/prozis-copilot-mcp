import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/store.mjs';
import { CartPlanner } from '../src/planner.mjs';
import { compareBlock, headerError, mapCheckoutTotals, mapFilters, mapLabel, mapMenu, mapReviews, mapSorts, needsLogin, parseNetWeightG, parseOrderLines, parseOrderList, parseServingG } from '../src/parse.mjs';
import { checkAgainstPrefs, mergePrefs, removePrefs, PREF_DEFAULTS } from '../src/prefs.mjs';

test('net weight, serving and compare block', () => {
  assert.equal(parseNetWeightG('907 g'), 907); assert.equal(parseNetWeightG('3 x 30 g'), 90); assert.equal(parseNetWeightG('Whey 1,5 kg'), 1500);
  assert.equal(parseNetWeightG('90 compresse'), undefined);
  assert.equal(parseServingG('3 misurino(i)(30 g)'), 30);
  const c = compareBlock({ price: 34.49, netWeightG: 907, proteinPer100g: 79, servingG: 30 });
  assert.equal(c.pricePerKg, 38.03); assert.equal(c.proteinG, 716.53); assert.equal(c.pricePerGramProtein, 0.0481); assert.equal(c.pricePerServing, 1.14);
  assert.equal(compareBlock({ price: 10 }).pricePerKg, undefined);
});

test('filters, sorts and menu mapping keep the selecting parameter', () => {
  const ws = { filters: { availableFilters: [{ id: 'OPPO', title: 'Occasioni', options: [{ url: 'https://www.prozis.com/it/it/catalog/search?text=proteine&oppo=013049', description: '20%', total: 129 }] }] },
    sorts: { availableSorts: { POPULARITY: { identifier: 'POPULARITY', name: 'Popolarità', url: 'https://www.prozis.com/it/it/catalog/search?text=x&ls=popularity' } } } };
  assert.deepEqual(mapFilters(ws), [{ id: 'OPPO', title: 'Occasioni', options: [{ description: '20%', total: 129, applied: false, param: { oppo: '013049' } }] }]);
  assert.deepEqual(mapSorts(ws), [{ id: 'POPULARITY', name: 'Popolarità', sort: 'popularity' }]);
  assert.deepEqual(mapMenu({ menuItems: [{ id: 'A', name: 'Nutrizione ', url: '/it/it/n', items: [{ name: 'Proteine', url: '/it/it/n/p' }] }] }),
    [{ id: 'A', name: 'Nutrizione', path: '/it/it/n', children: [{ id: undefined, name: 'Proteine', path: '/it/it/n/p' }] }]);
});

test('checkout totals: free shipping gap and login flag', () => {
  const t = mapCheckoutTotals({ checkoutIndex: { urls: { loggedIn: false }, cart: { totals: { subTotalRaw: 20, grandTotalRaw: 24.99, shipping: '€4.99', shippingRaw: 4.99, freeShipping: false }, pointsInfo: { gained: 100, previous: 0, available: 100 } } } }, 29.99);
  assert.equal(t.missingForFreeShipping, 9.99); assert.equal(t.shipping, 4.99); assert.equal(t.loggedIn, false); assert.equal(t.points.gained, 100);
  assert.equal(mapCheckoutTotals({ checkoutIndex: { cart: { totals: { subTotalRaw: 45.99, freeShipping: true, shipping: 'Gratis', shippingRaw: 0 } } } }, 29.99).missingForFreeShipping, 0);
});

test('login-required detection and header errors', () => {
  assert.ok(needsLogin({ header: { success: 0, error: [{ id: 'LOGIN_REQUIRED', msg: '' }] } }));
  assert.ok(needsLogin({ doAuth: true }));
  assert.ok(needsLogin({ header: { success: 1 }, result: { ajaxParams: { redirect: 'https://www.prozis.com/it/it/account/login?loginMessage=kAUT' } } }));
  assert.deepEqual(headerError({ header: { success: 0, error: [{ id: 'X', msg: 'no' }] } }), { id: 'X', msg: 'no' });
  assert.equal(needsLogin({ header: { success: 1, error: [] } }), false);
});

test('label: allergens, may-contain, ingredients', () => {
  const l = mapLabel({ otherIngredients: { value: 'Siero del <span class="allergenic-format">LATTE</span> (49%), Caseinato (<span class="allergenic-format">LATTE</span>), Sale' },
    allergenWarnings: { value: ' Può contenere tracce di soia, uovo e glutine. ' } });
  assert.deepEqual(l.allergens, ['latte']); assert.deepEqual(l.mayContain, ['soia', 'uovo', 'glutine']); assert.match(l.ingredients, /Siero del LATTE/);
});

test('preferences flag conflicts and never claim safety', () => {
  const p = mergePrefs(PREF_DEFAULTS, { lactoseFree: true, glutenFree: true, avoidIngredients: ['sucralosio'], preferredFlavours: ['vaniglia'] });
  const label = { ingredients: 'Concentrato di proteine del siero del LATTE, Sucralosio', allergens: ['latte'], mayContain: ['glutine'] };
  const r = checkAgainstPrefs(p, { flavour: 'Vaniglia Francese', label });
  assert.equal(r.conflicts.length, 2); assert.deepEqual(r.cautions, ['può contenere tracce di glutine']); assert.ok(r.preferredFlavour);
  assert.match(r.note, /non è una garanzia/);
  assert.deepEqual(removePrefs(p, { keys: ['lactoseFree'], values: { avoidIngredients: ['SUCRALOSIO'] } }).avoidIngredients, []);
  assert.equal(checkAgainstPrefs(p, { flavour: 'x' }).dataChecked, false);
});

test('reviews and unverified account parsers', () => {
  const r = mapReviews({ currentPage: 1, pageCount: 2, itemCount: 12, comments: [{ title: 'Ok', comment: 'Buona', classification: 10, commentDateIso: '2026-11-05', country: 'Italia', languageIso: 'it', review: { classification: [{ description: 'Gusto', value: '9' }] } }] });
  assert.deepEqual(r.reviews[0].criteria, { Gusto: 9 }); assert.equal(r.totalReviews, 12);
  assert.deepEqual(parseOrderList('<tr><td>01/10/2026</td><td>€45.99</td><td><a href="/it/it/order/detail?id=ABC123">x</a></td></tr>'), [{ orderId: 'ABC123', date: '01/10/2026', total: 45.99 }]);
  assert.deepEqual(parseOrderLines('<div>NUT00/1873810559 Supreme Qtà: 2</div>'), [{ sku: 'NUT00/1873810559', quantity: 2 }]);
});

test('planner: reorder expands lines, coupon rejection is certain, shipping gap in summary', async () => {
  const store = new AgentStore(':memory:');
  let cart = { items: [], total: 0, subtotal: 0, freeShippingFrom: 29.99, coupons: [] };
  const calls = [];
  const variant = { sku: 'NUT00/1873810559', groupId: '187381', options: { Gusto: 'Vaniglia' }, price: 20, inStock: true, maxAllowed: 20 };
  const client = { readCart: async () => cart, fullCart: async () => cart,
    order: async () => ({ lines: [{ sku: 'NUT00/1873810559', quantity: 2 }, { sku: 'NUT00/9999990001', quantity: 1 }] }),
    rawProduct: async g => (g === '187381' ? { variants: [variant], options: [] } : Promise.reject(new Error('nf'))),
    add: async (sku, q) => { calls.push(['add', sku, q]); cart = { ...cart, items: [{ itemId: 1, sku, quantity: q, unitPrice: 20 }] }; },
    applyCoupon: async () => { const e = new Error('solo con account'); e.code = 'CART_REJECTED'; throw e; } };
  const planner = new CartPlanner({ client, store });
  const p = await planner.prepare([{ op: 'reorder', orderId: 'ABC123' }]);
  assert.equal(p.lines.length, 1); assert.ok(p.warnings.some(w => /saltato/.test(w))); assert.equal(p.shipping.missingForFreeShipping, 0);
  assert.equal((await planner.commit(p.planId, p.confirmationPhrase)).status, 'committed');
  assert.deepEqual(calls, [['add', 'NUT00/1873810559', 2]]);
  const c = await planner.prepare([{ op: 'coupon_apply', code: 'ZZINVALID0000' }]);
  await assert.rejects(planner.commit(c.planId, c.confirmationPhrase), e => e.code === 'CART_REJECTED' && /Nessuna modifica/.test(e.message));
  assert.equal(store.getPlan(c.planId).status, 'rejected');
});

test("search names are entity-decoded", async () => {
  const { mapSearch } = await import("../src/parse.mjs");
  assert.equal(mapSearch({ results: [{ product: { groupId: "1", name: "Calendario dell&#39;avvento", price: "€89.99" } }] }).products[0].name, "Calendario dell'avvento");
});
