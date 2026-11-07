import { ADG, ProzisError } from './browser.mjs';
import { FREE_SHIPPING_FROM } from './config.mjs';
import {
  compareBlock, headerError, mapCart, mapCheckoutTotals, mapFilters, mapLabel, mapMenu, mapNutrition, mapProduct, mapReviews,
  mapSearch, mapSorts, needsLogin, parseFavoriteGroupIds, parseNetWeightG, parseOrderLines, parseOrderList, parseServingG, pickVariant
} from './parse.mjs';

export { ProzisError };
const stripHtml = h => String(h ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const accountRequired = () => new ProzisError('Serve il login Prozis: ferma il server, esegui `npm run login`, poi riavvialo.', 'ACCOUNT_REQUIRED');

export class ProzisClient {
  constructor(browser) { this.browser = browser; }

  /** Throws ACCOUNT_REQUIRED / SITE_ERROR for {header:{success:0}} payloads. */
  #check(j) {
    if (needsLogin(j)) throw accountRequired();
    const e = headerError(j);
    if (e) throw new ProzisError(e.msg || `Errore Prozis (${e.id})`, 'SITE_ERROR', { id: e.id });
    return j;
  }

  // ---- session
  async sessionStatus() {
    const t = mapCheckoutTotals(await this.browser.xhr('checkout/index'), FREE_SHIPPING_FROM);
    return { account: t.loggedIn ? 'verified' : 'guest', signal: 'checkout/index → urls.loggedIn' };
  }

  // ---- catalog
  #listingQuery({ page, sort, filters }) {
    const q = new URLSearchParams();
    if (page > 1) q.set('page', String(page));
    if (sort) q.set('ls', sort);
    for (const [k, v] of Object.entries(filters ?? {})) if (/^[a-z_]{2,20}$/i.test(k) && /^[\w.,-]{1,40}$/.test(String(v))) q.set(k, String(v));
    return q;
  }
  #listing(j) {
    const ws = j?.catalogData?.wsData;
    if (!ws) throw new ProzisError('Elenco prodotti non disponibile', 'BAD_RESPONSE');
    return { title: ws.title, ...mapSearch(ws), filters: mapFilters(ws), sorts: mapSorts(ws), appliedFilters: (ws.filters?.appliedFilters ?? []).map(f => stripHtml(f.description ?? f.title ?? '')).filter(Boolean) };
  }
  async search(text, opts = {}) {
    const q = this.#listingQuery(opts); q.set('text', text);
    return this.#listing(await this.browser.xhr(`catalog/search?${q}`));
  }
  async categories() { return mapMenu(await this.browser.xhr('menu/desktopMenu')); }
  async categoryProducts(path, opts = {}) {
    const p = String(path).replace(/^https?:\/\/www\.prozis\.com/, '').replace(/^\/it\/it\/?/, '');
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+){0,3}$/.test(p)) throw new ProzisError('Percorso di categoria non valido (usa "path" da prozis_categories)', 'INVALID_ARGUMENT');
    const q = this.#listingQuery(opts);
    return this.#listing(await this.browser.xhr(`${p}${q.size ? `?${q}` : ''}`));
  }
  /** Offer buckets (the site's "Occasioni" filter) for a search or category, optionally the products of one bucket. */
  async offers({ query, path, offer, page } = {}) {
    const base = path ? await this.categoryProducts(path, { page, filters: offer ? { oppo: offer } : {} }) : await this.search(query || 'prozis', { page, filters: offer ? { oppo: offer } : {} });
    const opp = base.filters.find(f => f.id === 'OPPO');
    return { offers: (opp?.options ?? []).map(o => ({ offer: o.param.oppo, description: o.description, products: o.total })),
      ...(offer ? { products: base.products, total: base.total, page: base.page, totalPages: base.totalPages } : {}) };
  }

  async rawProductJson(groupId) {
    if (!/^\d{3,9}$/.test(String(groupId))) throw new ProzisError('groupId non valido (usa quello di prozis_search)', 'INVALID_ARGUMENT');
    return this.browser.xhr(`product/index?_id=${groupId}`, { method: 'POST' });
  }
  async rawProduct(groupId) {
    const p = mapProduct(await this.rawProductJson(groupId));
    if (!p) throw new ProzisError('Prodotto non trovato o non vendibile', 'NOT_FOUND');
    return p;
  }

  async productDetails(groupId, { withNutrition = false } = {}) {
    const j = await this.rawProductJson(groupId);
    const p = mapProduct(j);
    if (!p) throw new ProzisError('Prodotto non trovato o non vendibile', 'NOT_FOUND');
    const protein = {};
    if (withNutrition) for (const g of [...new Set(p.variants.map(v => v.groupId))].slice(0, 4)) {
      try { const n = await this.nutrition(g, p.variants.find(v => v.groupId === g).sku); protein[g] = { per100g: n.proteinPer100g, servingG: parseServingG(n.serving) }; } catch { /* missing table */ }
    }
    const variants = p.variants.map(v => ({ ...v, compare: compareBlock({ price: v.price, netWeightG: parseNetWeightG(v.options.Opzione ?? Object.values(v.options).join(' ')),
      proteinPer100g: protein[v.groupId]?.per100g, servingG: protein[v.groupId]?.servingG }) }));
    const coupons = (j.bestPriceCoupons ?? []).map(c => ({ code: c.coupon, discount: c.discount, groupId: String(c.groupId), endsAt: c.dateEnd, auto: Boolean(c.auto), text: stripHtml(c.phrase) }));
    const rating = (j.tabs?.tabsData ?? []).find(t => t.key === 'COMMENTS')?.blockDetail?.ratingBlock;
    return { ...p, variants, variantCount: variants.length, inStockCount: variants.filter(v => v.inStock).length,
      priceCoupons: coupons, ...(coupons.length ? { priceNote: 'Il prezzo mostrato può dipendere da questi codici promo: nel carrello vale il prezzo pieno finché il codice non viene applicato al checkout.' } : {}),
      rating: rating ? { score: rating.stars, outOf: 10, total: rating.total } : undefined,
      stock: j.basicInfo ? { canAddToCart: j.basicInfo.canAddToCart, message: j.basicInfo.stockMsg, comingSoon: j.basicInfo.isComingSoon } : undefined,
      nutritionIncluded: withNutrition };
  }

  async nutrition(groupId, sku) {
    const p = sku ? null : await this.rawProduct(groupId);
    const s = sku ?? p.variants.find(v => v.groupId === String(groupId))?.sku ?? p.variants[0].sku;
    const q = new URLSearchParams({ cachetag: 'no', sku: s, id: String(groupId), parent: String(groupId) });
    const raw = (await this.browser.xhr(`product/nutrition-table?${q}`))?.nutTable;
    const n = mapNutrition(raw);
    if (!n) throw new ProzisError('Tabella nutrizionale non disponibile per questo prodotto', 'NOT_FOUND');
    return { sku: s, ...n, label: mapLabel(raw) };
  }

  async reviews(groupId, { page = 1, sort } = {}) {
    const q = new URLSearchParams({ productId: String(groupId), page: String(page), loadMore: page > 1 ? 'true' : 'false', ...(sort ? { sort } : {}) });
    const j = await this.browser.xhr(`${ADG}comment/list?${q}`);
    if (j?.hasError || j?.webServiceError) throw new ProzisError('Recensioni non disponibili', 'SITE_ERROR');
    return mapReviews(j);
  }

  async resolveVariant(groupId, options) {
    const p = await this.rawProduct(groupId);
    try { return pickVariant(p, options); }
    catch (e) { throw new ProzisError(e.message, e.code ?? 'INVALID_OPTION', e.details); }
  }

  // ---- cart
  async readCart() { return mapCart(await this.browser.xhr('cart/index')); }
  async checkoutTotals() { return mapCheckoutTotals(await this.browser.xhr('checkout/index'), FREE_SHIPPING_FROM); }
  /** Cart lines plus shipping, free-shipping gap, coupons and points from the (read-only) checkout summary. */
  async fullCart() {
    const cart = await this.readCart();
    const t = await this.checkoutTotals();
    return { ...cart, subtotal: t.subtotal, shipping: t.shipping, shippingLabel: t.shippingLabel, grandTotal: t.grandTotal, freeShipping: t.freeShipping,
      freeShippingFrom: t.freeShippingFrom, missingForFreeShipping: t.missingForFreeShipping, couponDiscount: t.couponDiscount, coupons: t.coupons,
      couponMessage: t.couponMessage, deliveryDate: t.deliveryDate, points: t.points, loggedIn: t.loggedIn };
  }

  async add(sku, qty) {
    const r = await this.browser.xhr('cart/add-pdp', { method: 'POST', json: { sku, skus: null, qty, program: null, price: null, cpn: null, type: null } });
    if (r?.hasError) throw new ProzisError(r.msg || 'Aggiunta rifiutata da Prozis', 'CART_REJECTED');
    return r;
  }
  update(itemId, qty) { return this.browser.xhr(`cart/update?${new URLSearchParams({ lin: String(itemId), qty: String(qty), validate: '1', vueMode: 'true', isMiniCart: '1' })}`); }
  remove(itemId) { return this.browser.xhr(`cart/remove?${new URLSearchParams({ lin: String(itemId), validate: '1', vueMode: 'true', isMiniCart: '1' })}`); }

  /** Coupon codes are applied on checkout/index (the site's own submitCoupon); Prozis requires login for it. */
  async applyCoupon(code) {
    const j = await this.browser.xhr('checkout/index', { method: 'POST', json: { cpn: code } });
    if (needsLogin(j)) throw new ProzisError('Prozis accetta codici sconto solo con l\'account collegato', 'CART_REJECTED', { reason: 'LOGIN_REQUIRED' });
    const e = headerError(j);
    if (e) throw new ProzisError(e.msg || 'Codice rifiutato', 'CART_REJECTED', { id: e.id });
    // A 200 response does not mean the code was accepted: read the summary back and require evidence of the coupon.
    const t = j?.checkoutIndex ? mapCheckoutTotals(j, FREE_SHIPPING_FROM) : await this.checkoutTotals();
    const attached = t.coupons.some(c => String(c.code ?? '').toUpperCase() === code.toUpperCase()) || t.coupons.length > 0 || t.couponDiscount > 0;
    if (!attached) {
      const w = j?.checkoutIndex?.cart?.couponWarnings;
      const msg = t.couponMessage || stripHtml(Array.isArray(w) ? w.map(x => x.msg ?? x).join('; ') : '') || 'codice non accettato (con un account guest Prozis non applica codici)';
      throw new ProzisError(`Codice rifiutato: ${msg}`, 'CART_REJECTED');
    }
    return t;
  }
  async removeCoupon(lineId, code) {
    const j = lineId || code
      ? await this.browser.xhr(`checkout/index?${new URLSearchParams({ 'cpn-rm': String(lineId ?? ''), 'cpn-id': String(code ?? '') })}`)
      : await this.browser.xhr('cart/remove-coupons?validate=1');
    return this.#check(j);
  }

  // ---- favourites ("Preferiti", likes on products)
  async favorites() {
    const j = this.#check(await this.browser.xhr('favorites/products'));
    const ids = parseFavoriteGroupIds(j?.result?.content);
    return { groupIds: ids, verified: false, note: 'Lettura dei preferiti non verificata (sviluppata senza account): controlla anche sul sito.' };
  }
  async favoriteAdd(groupId) { return this.#likes('likes/add', groupId); }
  async favoriteRemove(groupId) { return this.#likes('likes/remove', groupId); }
  async #likes(action, groupId) {
    const j = await this.browser.xhr(`${action}?${new URLSearchParams({ id: String(groupId), type: 'product' })}`);
    if (needsLogin(j)) throw new ProzisError('I preferiti Prozis richiedono l\'account collegato', 'CART_REJECTED', { reason: 'LOGIN_REQUIRED' });
    return this.#check(j);
  }

  // ---- account (unverified: no logged-in session was available during development)
  async orders() {
    const j = this.#check(await this.browser.xhr('order/list'));
    const html = j?.result?.content ?? '';
    const orders = parseOrderList(html);
    if (!orders.length && /order\/detail/.test(html)) throw new ProzisError('Formato della lista ordini non riconosciuto: consultala su prozis.com', 'PARSER_UNVERIFIED');
    return { orders, verified: false };
  }
  async order(orderId) {
    if (!/^[A-Za-z0-9-]{3,30}$/.test(orderId)) throw new ProzisError('orderId non valido', 'INVALID_ARGUMENT');
    const j = this.#check(await this.browser.xhr(`order/detail?${new URLSearchParams({ id: orderId })}`));
    const html = j?.result?.content ?? '';
    const lines = parseOrderLines(html);
    return { orderId, lines, text: stripHtml(html).slice(0, 2500), verified: false };
  }
  async addresses() {
    const j = this.#check(await this.browser.xhr('address/index'));
    const blocks = String(j?.result?.content ?? '').split(/<(?:li|article|div)[^>]*class="[^"]*address[^"]*"[^>]*>/i).slice(1).map(b => stripHtml(b).slice(0, 300)).filter(Boolean);
    return { addresses: blocks.slice(0, 10), verified: false };
  }
}
