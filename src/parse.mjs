/** Pure mappers for Prozis JSON responses (tested offline). */

export const parseEuro = s => {
  if (typeof s === 'number') return s;
  const m = String(s ?? '').replace(/\s/g, '').match(/(\d+(?:[.,]\d{3})*)(?:[.,](\d{1,2}))?/);
  if (!m) return undefined;
  return Number(m[1].replace(/[.,]/g, '') + (m[2] ? '.' + m[2].padEnd(2, '0') : ''));
};
const stripHtml = h => String(h ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const decode = s => String(s ?? '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const clean = s => decode(s).replace(/[\r\n]+/g, ' ').trim();

export function mapSearch(ws) {
  const pg = ws?.pagination ?? {};
  return { total: pg.total ?? 0, page: pg.currentPage ?? 1, totalPages: pg.totalPages ?? 1,
    products: (ws?.results ?? []).map(r => r.product).filter(Boolean).map(p => ({
      groupId: String(p.groupId), name: clean(p.name), url: p.url ? `https://www.prozis.com${p.url}` : undefined,
      price: parseEuro(p.price), regularPrice: parseEuro(p.priceCrossed), promo: stripHtml(p.label?.content) || undefined,
      ...compareFromName(p.name, parseEuro(p.price)) })) };
}

/** Weight-based comparison from the product name (search results have no nutrition data). */
function compareFromName(name, price) {
  const netWeightG = parseNetWeightG(name);
  return netWeightG ? { netWeightG, pricePerKg: price > 0 ? Math.round(price / netWeightG * 100000) / 100 : undefined } : {};
}

/** product/index: one entry per sellable SKU across the related groups (sizes are separate groups). */
export function mapProduct(j) {
  const products = j?.addToCart?.products ?? [];
  if (!products.length) return null;
  const opt = j.addToCart.selectOptions ?? {};
  const variants = products.map(p => ({
    sku: p.sku, groupId: String(p.groupId),
    options: Object.fromEntries([[p.flavorLabelDescription, clean(p.flavorDescription)], [p.optionLabelDescription, clean(p.optionDescription)]].filter(([k, v]) => k && v)),
    price: parseEuro(p.price), regularPrice: typeof p.priceReference === 'number' ? p.priceReference : parseEuro(p.priceReference),
    stock: p.stock, maxAllowed: p.maxAllowed, inStock: p.status === 'AC' && p.stock > 0 && p.isVisible !== false,
    availableFrom: p.activationDate || undefined, points: p.points }));
  const groupNames = {};
  for (const [key, list] of Object.entries(opt)) if (Array.isArray(list) && list[0]) groupNames[key] = list[0][`${key}LabelDescription`] ?? key;
  const options = Object.entries(opt).filter(([, l]) => Array.isArray(l) && l.length).map(([key, list]) => ({
    name: groupNames[key], values: [...new Set(list.map(v => clean(v[`${key}Description`])))] }));
  return { groupId: String(j.groupId), options, variants };
}

/** Finds the variant matching option labels (case/accents-insensitive), e.g. {Gusto:'Vaniglia Francese', Opzione:'907 g'}. */
export function pickVariant(product, wanted = {}) {
  const norm = s => String(s ?? '').toLocaleLowerCase('it').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const alias = { flavour: 'gusto', flavor: 'gusto', size: 'opzione', formato: 'opzione', peso: 'opzione' };
  const req = Object.entries(wanted).map(([k, v]) => [alias[norm(k)] ?? norm(k), norm(v)]);
  const missing = product.options.filter(o => !req.some(([k]) => k === norm(o.name)) && o.values.length > 1);
  if (missing.length) throw Object.assign(new Error('Scegli tutte le opzioni del prodotto'), { code: 'OPTIONS_REQUIRED', details: { missing } });
  const match = product.variants.filter(v => req.every(([k, val]) => {
    const entry = Object.entries(v.options).find(([ok]) => norm(ok) === k);
    return entry && norm(entry[1]) === val;
  }));
  if (!match.length) throw Object.assign(new Error('Combinazione non disponibile'), { code: 'VARIANT_NOT_FOUND', details: { options: product.options } });
  return match[0];
}

export function mapCart(c) {
  return {
    totalQuantity: c?.cartQty ?? 0,
    items: (c?.products ?? []).map(p => ({ itemId: Number(p.cartItemId), sku: p.sku, groupId: String(p.groupId), name: p.name,
      variant: clean(p.variantLabel), quantity: p.qty, maxQuantity: p.maxQty, unitPrice: parseEuro(p.price), canBuy: p.canBuy !== false,
      isGift: Boolean(p.isGift) })),
    coupons: c?.coupons ?? [], total: parseEuro(c?.total), currency: 'EUR',
    alerts: (c?.alerts ?? []).map(a => stripHtml(a?.message ?? a)).filter(Boolean),
    points: c?.pointsInfo?.availableMsg
  };
}

/** Nutrition facts: keeps main nutrients per serving and per 100 g, plus serving size. */
export function mapNutrition(n) {
  if (!n?.table) return null;
  const rows = [];
  const walk = (list, level = 1) => { for (const r of list ?? []) { rows.push({ name: r.name, level, perServing: r.amount?.byServ || undefined, per100g: r.amount?.by100 || undefined }); walk(r.ingredients, level + 1); } };
  if (n.table.energy) rows.push({ name: n.table.energy.name, level: 1, perServing: n.table.energy.amount?.byServ, per100g: n.table.energy.amount?.by100 });
  walk(n.table.nutrients); walk(n.table.vitamins); walk(n.table.complex);
  const protein = rows.find(r => /^protein/i.test(r.name));
  return { serving: n.servings?.size?.value, servingsPerPack: n.servings?.container?.value, netWeight: n.weight?.value,
    proteinPer100g: protein ? parseFloat(String(protein.per100g).replace(',', '.')) : undefined, rows };
}

// ---------------------------------------------------------------- v0.2: compare, filters, menu, checkout, reviews, account

/** Net weight in grams from a label like "907 g", "1814g", "3 x 30 g", "1,5 kg", "500 ml" (ml counted as g). Capsules/tablets return undefined. */
export function parseNetWeightG(label) {
  const s = String(label ?? '').toLowerCase().replace(',', '.');
  const multi = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|ml)\b/);
  if (multi) return Math.round(Number(multi[1]) * Number(multi[2]) * (multi[3] === 'kg' ? 1000 : 1));
  const one = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml)\b/);
  return one ? Math.round(Number(one[1]) * (one[2] === 'kg' ? 1000 : 1)) : undefined;
}

const r2 = n => Math.round(n * 100) / 100;
const r4 = n => Math.round(n * 10000) / 10000;
/** Normalized comparison block; fields stay undefined when the data is not there (never guessed). */
export function compareBlock({ price, netWeightG, proteinPer100g, servingG }) {
  const out = { price, netWeightG, proteinPer100g };
  if (price > 0 && netWeightG > 0) out.pricePerKg = r2(price / netWeightG * 1000);
  if (price > 0 && netWeightG > 0 && proteinPer100g > 0) {
    out.proteinG = r2(netWeightG * proteinPer100g / 100);
    out.pricePerGramProtein = r4(price / out.proteinG);
  }
  if (price > 0 && netWeightG > 0 && servingG > 0) out.pricePerServing = r2(price / (netWeightG / servingG));
  return out;
}

/** Serving size in grams from "3 misurino(i)(30 g)" or "1 barretta (55 g)". */
export const parseServingG = s => { const m = String(s ?? '').match(/\((\d+(?:[.,]\d+)?)\s*g\)/i); return m ? Number(m[1].replace(',', '.')) : undefined; };

/** Filter groups from catalog wsData: each option keeps the query parameter that selects it. */
export function mapFilters(ws) {
  return (ws?.filters?.availableFilters ?? []).map(f => ({ id: f.id, title: f.title,
    options: (f.options ?? []).map(o => {
      let param;
      try { const u = new URL(o.url); for (const [k, v] of u.searchParams) if (!['text', 'ls', 'page', 'pp'].includes(k)) param = { [k]: v }; } catch { /* no url */ }
      return { description: clean(o.description), total: o.total, applied: Boolean(o.applied), param };
    }).filter(o => o.param) }));
}
export function mapSorts(ws) {
  return Object.values(ws?.sorts?.availableSorts ?? {}).map(s => {
    let ls; try { ls = new URL(s.url).searchParams.get('ls') ?? undefined; } catch { /* none */ }
    return { id: s.identifier, name: s.name, sort: ls };
  }).filter(s => s.sort);
}

export function mapMenu(menu) {
  const node = m => ({ id: m.id, name: clean(m.name), path: m.url, ...(m.items?.length ? { children: m.items.map(node) } : {}) });
  return (menu?.menuItems ?? []).map(node);
}

/** Totals from checkout/index (reachable as guest, read-only). */
export function mapCheckoutTotals(ci, freeFrom) {
  const c = ci?.checkoutIndex?.cart, t = c?.totals ?? {};
  const subtotal = t.subTotalRaw ?? parseEuro(t.subTotal) ?? 0;
  const freeShipping = typeof t.freeShipping === 'boolean' ? t.freeShipping : subtotal >= freeFrom;
  return {
    loggedIn: Boolean(ci?.checkoutIndex?.urls?.loggedIn),
    subtotal, grandTotal: t.grandTotalRaw ?? parseEuro(t.grandTotal),
    shipping: typeof t.shippingRaw === 'number' ? t.shippingRaw : (t.shipping === 'Gratis' ? 0 : parseEuro(t.shipping)),
    shippingLabel: t.shipping, freeShipping, freeShippingFrom: freeFrom,
    missingForFreeShipping: freeShipping || !subtotal ? 0 : r2(Math.max(0, freeFrom - subtotal)),
    couponDiscount: t.couponDiscountRaw ?? undefined,
    coupons: (Array.isArray(c?.coupons) ? c.coupons : []).map(k => ({ lineId: k.lineId ?? k.id ?? k.couponLineId, code: k.code ?? k.couponId ?? k.coupon, description: stripHtml(k.description ?? k.name ?? k.label ?? '') || undefined })),
    couponMessage: stripHtml(c?.couponMsg ?? '') || undefined, canApplyCoupon: c?.canApplyCoupon,
    deliveryDate: stripHtml(typeof c?.deliveryDate === 'string' ? c.deliveryDate : c?.deliveryDate?.date ?? c?.deliveryDate?.label ?? '') || undefined,
    points: { gained: c?.pointsInfo?.gained, previousBalance: c?.pointsInfo?.previous, availableAfterOrder: c?.pointsInfo?.available, message: c?.pointsInfo?.availableMsg }
  };
}

/** Server-side errors come back as {header:{success:0,error:[{id,msg}]}}. */
export function headerError(j) {
  const e = j?.header && j.header.success === 0 ? (j.header.error ?? [])[0] : null;
  return e ? { id: e.id, msg: e.msg } : null;
}
export const needsLogin = j => headerError(j)?.id === 'LOGIN_REQUIRED' || Boolean(j?.doAuth) || /loginMessage=kAUT/.test(j?.result?.ajaxParams?.redirect ?? '');

export function mapReviews(j, ratingBlock) {
  return { rating: ratingBlock ? { score: ratingBlock.stars, outOf: 10, total: ratingBlock.total } : undefined,
    page: j?.currentPage, pageCount: j?.pageCount, totalReviews: j?.itemCount,
    reviews: (j?.comments ?? []).map(c => ({ title: clean(c.title), text: clean(c.comment), score: c.classification, outOf: 10, date: c.commentDateIso,
      country: c.country, language: c.languageIso, criteria: Object.fromEntries((c.review?.classification ?? []).map(k => [k.description, Number(k.value)])) })) };
}

/** Ingredients, allergens (bold "allergenic-format" words) and "may contain" from the nutrition-table payload. */
export function mapLabel(n) {
  const ing = n?.otherIngredients?.value ?? '';
  const allergens = [...new Set([...String(ing).matchAll(/allergenic-format">([^<]+)</g)].map(m => m[1].trim().toLowerCase()))];
  const may = stripHtml(n?.allergenWarnings?.value ?? '');
  const mayContain = (may.match(/tracce di ([^.]+)/i)?.[1] ?? '').split(/,| e /).map(s => s.trim().toLowerCase()).filter(Boolean);
  return { ingredients: stripHtml(ing) || undefined, allergens, mayContain, mayContainText: may || undefined,
    instructions: stripHtml(n?.instructions?.value ?? '').slice(0, 600) || undefined, warnings: stripHtml(n?.warnings?.value ?? '').slice(0, 600) || undefined };
}

/** Best-effort parsing of account HTML fragments (orders, addresses): unverified, the user was never logged in during development. */
export function parseOrderList(html) {
  const s = String(html ?? ''), orders = [], seen = new Set();
  for (const m of s.matchAll(/order\/detail[^"']*?[?&](?:id|order|orderId|ord)=([A-Za-z0-9-]+)/g)) {
    if (seen.has(m[1])) continue; seen.add(m[1]);
    const around = stripHtml(s.slice(Math.max(0, m.index - 600), m.index + 400));
    orders.push({ orderId: m[1], date: around.match(/\b\d{2}[/-]\d{2}[/-]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/)?.[0], total: parseEuro(around.match(/€\s?[\d.,]+/)?.[0] ?? around.match(/[\d.,]+\s?€/)?.[0]) });
  }
  return orders;
}
export function parseOrderLines(html) {
  const s = String(html ?? ''), lines = [];
  for (const m of s.matchAll(/([A-Z]{3}\d{2}\/\d{6,})/g)) {
    const around = stripHtml(s.slice(m.index, m.index + 500));
    const qty = Number(around.match(/(?:qt[àa]|quantit[àa]|x)\s*:?\s*(\d{1,2})\b/i)?.[1] ?? 1);
    if (!lines.some(l => l.sku === m[1])) lines.push({ sku: m[1], quantity: qty });
  }
  return lines;
}
export const parseFavoriteGroupIds = html => [...new Set([...String(html ?? '').matchAll(/data-(?:group-?id|groupid|id)="(\d{5,7})"/gi)].map(m => m[1]))];
