import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/store.mjs';
import { CartPlanner } from '../src/planner.mjs';
import { mapCart, mapNutrition, mapProduct, mapSearch, parseEuro, pickVariant } from '../src/parse.mjs';

const PRODUCT = { groupId: '187381', addToCart: {
  selectOptions: {
    option: [{ groupId: '187381', optionLabelDescription: 'Opzione', optionId: '3142', optionDescription: '907 g' }, { groupId: '187590', optionLabelDescription: 'Opzione', optionId: '0002', optionDescription: '400 g' }],
    flavor: [{ groupId: '187381', flavorLabelDescription: 'Gusto', flavorDescription: 'Vaniglia Francese ' }, { groupId: '187381', flavorLabelDescription: 'Gusto', flavorDescription: 'Neutro\n\r' }] },
  products: [
    { sku: 'NUT00/1', groupId: '187381', flavorLabelDescription: 'Gusto', flavorDescription: 'Vaniglia Francese ', optionLabelDescription: 'Opzione', optionDescription: '907 g', price: '€34.49', priceReference: 45.99, stock: 20, maxAllowed: 20, status: 'AC', isVisible: true },
    { sku: 'NUT00/2', groupId: '187590', flavorLabelDescription: 'Gusto', flavorDescription: 'Neutro\n\r', optionLabelDescription: 'Opzione', optionDescription: '400 g', price: '€17.99', stock: 0, maxAllowed: 20, status: 'AC' }] } };

test('price parsing handles euro formats', () => {
  assert.equal(parseEuro('€21.74'), 21.74); assert.equal(parseEuro('€1,234.50'), 1234.5); assert.equal(parseEuro('45,99 €'), 45.99); assert.equal(parseEuro(null), undefined);
});

test('product mapping and variant picking (aliases, accents, whitespace)', () => {
  const p = mapProduct(PRODUCT);
  assert.deepEqual(p.options.map(o => o.name), ['Opzione', 'Gusto']);
  assert.equal(p.variants[1].inStock, false);
  assert.equal(pickVariant(p, { flavour: 'vaniglia francese', size: '907 G' }).sku, 'NUT00/1');
  assert.throws(() => pickVariant(p, { Gusto: 'Neutro' }), e => e.code === 'OPTIONS_REQUIRED');
  assert.throws(() => pickVariant(p, { Gusto: 'Neutro', Opzione: '907 g' }), e => e.code === 'VARIANT_NOT_FOUND');
});

test('search, cart and nutrition mappers', () => {
  const s = mapSearch({ pagination: { total: 1, currentPage: 1, totalPages: 1 }, results: [{ product: { groupId: '139138', name: 'Creatina', url: '/it/it/prozis/creatina', price: '€21.74', priceCrossed: '€28.99', label: { content: '<span>25%</span>' } } }] });
  assert.deepEqual(s.products[0], { groupId: '139138', name: 'Creatina', url: 'https://www.prozis.com/it/it/prozis/creatina', price: 21.74, regularPrice: 28.99, promo: '25%' });
  const c = mapCart({ cartQty: 1, total: '€45.99', products: [{ cartItemId: 9, sku: 'NUT00/1', groupId: '187381', name: 'Whey', variantLabel: ' Gusto: Cioccolato', qty: 1, maxQty: 20, price: '€45.99' }] });
  assert.equal(c.items[0].itemId, 9); assert.equal(c.items[0].variant, 'Gusto: Cioccolato'); assert.equal(c.total, 45.99);
  const n = mapNutrition({ servings: { size: { value: '30 g' }, container: { value: 30 } }, weight: { value: '907 g' },
    table: { energy: { name: 'Energia', amount: { byServ: '113 kcal', by100: '378 kcal' } }, nutrients: [{ name: 'Proteine', amount: { byServ: '23.70 g', by100: '79 g' }, ingredients: [] }] } });
  assert.equal(n.proteinPer100g, 79); assert.equal(n.servingsPerPack, 30);
});

function setup({ apply = true } = {}) {
  const store = new AgentStore(':memory:');
  let cart = { items: [], total: 0 };
  const calls = [];
  const client = {
    readCart: async () => cart, fullCart: async () => cart,
    resolveVariant: async () => ({ sku: 'NUT00/1', options: { Gusto: 'Vaniglia' }, price: 34.49, inStock: true, maxAllowed: 20 }),
    add: async (sku, q) => { calls.push(['add', sku, q]); if (apply) cart = { items: [{ itemId: 1, sku, quantity: q, unitPrice: 34.49 }], total: 34.49 * q }; return {}; }
  };
  return { calls, planner: new CartPlanner({ client, store }), touch: () => { cart = { items: [{ itemId: 5, sku: 'X', quantity: 1 }] }; } };
}

test('commit once, verified by read-back', async () => {
  const { planner, calls } = setup();
  const p = await planner.prepare([{ op: 'add', groupId: '187381', quantity: 2, options: { Gusto: 'Vaniglia' } }]);
  assert.equal(calls.length, 0); assert.equal(p.estimatedDelta, 68.98);
  assert.equal((await planner.commit(p.planId, p.confirmationPhrase)).status, 'committed');
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), e => e.code === 'PLAN_ALREADY_USED');
  assert.equal(calls.length, 1);
});

test('silent no-op is reported as unverified; changed cart is refused', async () => {
  const a = setup({ apply: false });
  const p = await a.planner.prepare([{ op: 'add', groupId: '187381', quantity: 1 }]);
  assert.equal((await a.planner.commit(p.planId, p.confirmationPhrase)).status, 'unverified');
  const b = setup();
  const q = await b.planner.prepare([{ op: 'add', groupId: '187381', quantity: 1 }]);
  b.touch();
  await assert.rejects(b.planner.commit(q.planId, q.confirmationPhrase), e => e.code === 'CART_CHANGED');
  assert.equal(b.calls.length, 0);
});

test('a cart price different from the shown one is flagged', async () => {
  const store = new AgentStore(':memory:');
  let cart = { items: [], total: 0 };
  const client = { readCart: async () => cart, fullCart: async () => cart,
    resolveVariant: async () => ({ sku: 'NUT00/1', options: {}, price: 34.49, inStock: true, maxAllowed: 20 }),
    add: async (sku, q) => { cart = { items: [{ itemId: 1, sku, quantity: q, unitPrice: 45.99 }], total: 45.99 }; } };
  const planner = new CartPlanner({ client, store });
  const p = await planner.prepare([{ op: 'add', groupId: '187381', quantity: 1 }]);
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.deepEqual(r.priceChanges, [{ sku: 'NUT00/1', shownPrice: 34.49, cartPrice: 45.99 }]);
});
