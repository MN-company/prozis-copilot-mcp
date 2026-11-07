import crypto from 'node:crypto';
import { ProzisError } from './client.mjs';

export const cartFingerprint = cart => crypto.createHash('sha256')
  .update(JSON.stringify((cart?.items ?? []).map(i => [i.itemId, i.sku, i.quantity]).sort()))
  .digest('hex').slice(0, 16);

const WORDS = ['WHEY', 'CREA', 'OATS', 'BCAA', 'GYM', 'EXCEED'];
const newPhrase = () => `${WORDS[crypto.randomInt(WORDS.length)]}-${crypto.randomInt(1000, 9999)}`;
const round = n => Math.round(n * 100) / 100;

/** Expected quantity per SKU after the plan; the read-back, not the response, decides the outcome. */
function expectedBySku(cart, ops) {
  const q = new Map();
  for (const i of cart.items) q.set(i.sku, (q.get(i.sku) ?? 0) + i.quantity);
  for (const o of ops) {
    if (o.op === 'add') q.set(o.sku, (q.get(o.sku) ?? 0) + o.quantity);
    else if (o.op === 'update') q.set(o.sku, (q.get(o.sku) ?? 0) - o.from + o.to);
    else if (o.op === 'remove') q.set(o.sku, (q.get(o.sku) ?? 0) - o.from);
  }
  return q;
}

export class CartPlanner {
  constructor({ client, store, ttlMs = 15 * 60 * 1000, writesEnabled = true }) { Object.assign(this, { client, store, ttlMs, writesEnabled }); }

  async prepare(operations) {
    if (!operations?.length) throw new ProzisError('Nessuna operazione', 'INVALID_ARGUMENT');
    const cart = await this.client.fullCart();
    const ops = [], lines = [], warnings = [];
    let delta = 0;
    const expanded = [];
    for (const op of operations) {
      if (op.op !== 'reorder') { expanded.push(op); continue; }
      // Reorder: expand the lines of a past order into add operations (account required, parser unverified).
      const order = await this.client.order(op.orderId);
      if (!order.lines.length) throw new ProzisError("Nessuna riga leggibile nell'ordine: riordino non disponibile", 'PARSER_UNVERIFIED');
      for (const l of order.lines) expanded.push({ op: 'add_sku', sku: l.sku, quantity: Math.min(20, l.quantity || 1) });
      warnings.push(`Riordino dell'ordine ${op.orderId}: righe lette con un parser non verificato, controlla il riepilogo.`);
    }
    for (const op of expanded) {
      if (op.op === 'add_sku') {
        const groupId = String(op.sku).split('/')[1]?.slice(0, 6);
        const p = groupId ? await this.client.rawProduct(groupId).catch(() => null) : null;
        const v = p?.variants.find(x => x.sku === op.sku);
        if (!v) { warnings.push(`${op.sku}: non più in vendita o non trovato, saltato.`); continue; }
        if (!v.inStock) { warnings.push(`${op.sku}: esaurito, saltato.`); continue; }
        this.store.recordPrice(v.sku, v.price);
        ops.push({ op: 'add', sku: v.sku, quantity: op.quantity });
        lines.push({ action: 'aggiungi', sku: v.sku, options: v.options, quantity: op.quantity, unitPrice: v.price, estimatedTotal: round(v.price * op.quantity) });
        delta += v.price * op.quantity;
      } else if (op.op === 'coupon_apply') {
        ops.push({ op: 'coupon_apply', code: op.code });
        lines.push({ action: 'applica codice sconto', code: op.code, note: "validità e sconto si vedono solo dopo l'applicazione; Prozis richiede l'account collegato" });
      } else if (op.op === 'coupon_remove') {
        const c = op.code ? cart.coupons.find(x => String(x.code).toUpperCase() === op.code.toUpperCase()) : null;
        if (op.code && !c) throw new ProzisError('Codice non presente nel carrello', 'INVALID_ARGUMENT');
        ops.push({ op: 'coupon_remove', lineId: c?.lineId, code: c?.code });
        lines.push({ action: op.code ? 'rimuovi codice sconto' : 'rimuovi tutti i codici sconto', code: op.code });
      } else if (op.op === 'favorite_add' || op.op === 'favorite_remove') {
        const p = await this.client.rawProduct(op.groupId);
        ops.push({ op: op.op, groupId: String(op.groupId) });
        lines.push({ action: op.op === 'favorite_add' ? 'aggiungi ai preferiti' : 'togli dai preferiti', groupId: String(op.groupId), sku: p.variants[0]?.sku });
      } else if (op.op === 'add') {
        const v = await this.client.resolveVariant(op.groupId, op.options ?? {});
        if (!v.inStock) throw new ProzisError(`Variante ${Object.values(v.options).join(' ')} non disponibile`, 'OUT_OF_STOCK');
        if (v.maxAllowed && op.quantity > v.maxAllowed) throw new ProzisError(`Massimo ${v.maxAllowed} pezzi per ordine`, 'INVALID_QUANTITY');
        if (v.availableFrom && Date.parse(v.availableFrom) > Date.now()) warnings.push(`${Object.values(v.options).join(' ')}: disponibile dal ${v.availableFrom} (preordine).`);
        this.store.recordPrice(v.sku, v.price);
        ops.push({ op: 'add', sku: v.sku, quantity: op.quantity });
        lines.push({ action: 'aggiungi', sku: v.sku, options: v.options, quantity: op.quantity, unitPrice: v.price, estimatedTotal: round(v.price * op.quantity) });
        delta += v.price * op.quantity;
      } else if (op.op === 'update' || op.op === 'remove') {
        const item = cart.items.find(i => i.itemId === op.itemId);
        if (!item) throw new ProzisError('Articolo non presente nel carrello: rileggi il carrello', 'ITEM_NOT_IN_CART');
        const to = op.op === 'remove' ? 0 : op.quantity;
        if (to === item.quantity) throw new ProzisError('La quantità è già quella richiesta', 'NO_CHANGE');
        if (item.maxQuantity && to > item.maxQuantity) throw new ProzisError(`Massimo ${item.maxQuantity} pezzi`, 'INVALID_QUANTITY');
        ops.push(to === 0 ? { op: 'remove', itemId: item.itemId, sku: item.sku, from: item.quantity } : { op: 'update', itemId: item.itemId, sku: item.sku, from: item.quantity, to });
        lines.push({ action: to === 0 ? 'rimuovi' : 'modifica quantità', name: item.name, variant: item.variant, from: item.quantity, to });
        delta += (to - item.quantity) * (item.unitPrice ?? 0);
      } else throw new ProzisError(`Operazione sconosciuta: ${op.op}`, 'INVALID_ARGUMENT');
    }
    const newSubtotal = round((cart.subtotal ?? cart.total ?? 0) + delta);
    const freeFrom = cart.freeShippingFrom ?? 29.99;
    const shippingEstimate = { currentShipping: cart.shipping, freeShippingFrom: freeFrom, estimatedNewSubtotal: newSubtotal,
      missingForFreeShipping: newSubtotal >= freeFrom ? 0 : round(freeFrom - newSubtotal) };
    if (shippingEstimate.missingForFreeShipping > 0 && newSubtotal > 0) warnings.push(`Mancano ${shippingEstimate.missingForFreeShipping.toFixed(2)} € alla spedizione gratuita (da ${freeFrom} €).`);
    warnings.push('Su Prozis il prezzo nel carrello può differire da quello della scheda (promo a tempo, preordini): il totale vero si legge dopo il commit.');
    const plan = { id: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, phrase: newPhrase(), cartFingerprint: cartFingerprint(cart), ops,
      summary: { lines, currentTotal: cart.total, estimatedDelta: round(delta), shipping: shippingEstimate, warnings } };
    this.store.savePlan(plan);
    this.store.audit('cart_prepare', { planId: plan.id, ops: ops.length });
    return { planId: plan.id, confirmationPhrase: plan.phrase, expiresAt: new Date(plan.expiresAt).toISOString(), ...plan.summary, writesEnabled: this.writesEnabled,
      instructions: 'Mostra questo riepilogo all\'utente. Esegui prozis_commit_cart_change solo dopo un suo esplicito OK in un messaggio successivo.' };
  }

  async commit(planId, phrase) {
    if (!this.writesEnabled) throw new ProzisError('Scritture sul carrello disattivate (ALLOW_CART_WRITES=false)', 'WRITES_DISABLED');
    const plan = this.store.getPlan(planId);
    if (!plan) throw new ProzisError('Piano non trovato', 'PLAN_NOT_FOUND');
    if (plan.status !== 'prepared') throw new ProzisError(`Piano già usato (stato: ${plan.status}). Non ripetere: leggi il carrello.`, 'PLAN_ALREADY_USED', { status: plan.status });
    if (Date.now() > plan.expiresAt) { this.store.finishPlan(planId, 'expired'); throw new ProzisError('Piano scaduto: preparane uno nuovo', 'PLAN_EXPIRED'); }
    if (phrase !== plan.phrase) throw new ProzisError('Frase di conferma errata', 'CONFIRMATION_MISMATCH');
    const before = await this.client.readCart();
    if (cartFingerprint(before) !== plan.cartFingerprint) { this.store.finishPlan(planId, 'stale'); throw new ProzisError('Il carrello è cambiato dopo la preparazione: preparane uno nuovo', 'CART_CHANGED'); }
    if (!this.store.claimPlan(planId)) throw new ProzisError('Piano già in esecuzione', 'PLAN_ALREADY_USED');
    let done = 0;
    try {
      for (const o of plan.ops) {
        if (o.op === 'add') await this.client.add(o.sku, o.quantity);
        else if (o.op === 'update') await this.client.update(o.itemId, o.to);
        else if (o.op === 'remove') await this.client.remove(o.itemId);
        else if (o.op === 'coupon_apply') await this.client.applyCoupon(o.code);
        else if (o.op === 'coupon_remove') await this.client.removeCoupon(o.lineId, o.code);
        else if (o.op === 'favorite_add') await this.client.favoriteAdd(o.groupId);
        else if (o.op === 'favorite_remove') await this.client.favoriteRemove(o.groupId);
        done++;
      }
    } catch (e) {
      const result = { completed: done, total: plan.ops.length, failedAt: plan.ops[done]?.op, error: e.code, message: e.message };
      const rejected = e.code === 'CART_REJECTED' && done === 0;
      this.store.finishPlan(planId, rejected ? 'rejected' : done ? 'partial' : 'failed_or_unknown', result);
      this.store.audit('cart_commit_error', { planId, ...result });
      if (rejected) throw new ProzisError(`Prozis ha rifiutato l'operazione: ${e.message}. Nessuna modifica applicata.`, 'CART_REJECTED', result);
      throw new ProzisError(`${e.message.replace(/\.$/, '')}. Esito incerto: NON ripetere, rileggi il carrello con prozis_get_cart.`, 'COMMIT_UNCERTAIN', result);
    }
    const after = await this.client.fullCart();
    const expected = expectedBySku(before, plan.ops);
    const actual = new Map();
    for (const i of after.items) actual.set(i.sku, (actual.get(i.sku) ?? 0) + i.quantity);
    const mismatches = [...new Set([...expected.keys(), ...actual.keys()])]
      .map(sku => ({ sku, expected: expected.get(sku) ?? 0, actual: actual.get(sku) ?? 0 })).filter(m => m.expected !== m.actual);
    // Prozis can charge a different price in the cart than on the product page (presales, timed promos).
    const priceChanges = plan.summary.lines.filter(l => l.action === 'aggiungi')
      .map(l => ({ sku: l.sku, shownPrice: l.unitPrice, cartPrice: after.items.find(i => i.sku === l.sku)?.unitPrice }))
      .filter(p => p.cartPrice !== undefined && Math.abs(p.cartPrice - p.shownPrice) >= 0.01);
    const status = mismatches.length ? 'unverified' : 'committed';
    if (priceChanges.length) {
      this.store.audit('cart_price_change', { planId, priceChanges });
      const result = { status, operations: done, cart: after, priceChanges,
        priceWarning: 'ATTENZIONE: nel carrello il prezzo è diverso da quello mostrato prima della conferma. Dillo subito all\'utente; può rimuovere l\'articolo con un nuovo piano.' };
      this.store.finishPlan(planId, status, { operations: done, mismatches, priceChanges });
      return { ...result, ...(mismatches.length ? { mismatches } : {}), checkout: 'Il pagamento si fa sul sito: https://www.prozis.com/it/it/checkout/index' };
    }
    this.store.finishPlan(planId, status, { operations: done, mismatches });
    this.store.audit('cart_commit', { planId, operations: done, mismatches: mismatches.length });
    return { status, operations: done, ...(mismatches.length ? { mismatches, warning: 'Prozis non ha applicato tutto come previsto. NON ripetere: mostra il carrello all\'utente.' } : {}),
      cart: after, checkout: 'Il pagamento si fa sul sito: https://www.prozis.com/it/it/checkout/index' };
  }

  status(planId) {
    const p = this.store.getPlan(planId);
    if (!p) throw new ProzisError('Piano non trovato', 'PLAN_NOT_FOUND');
    return { planId, status: p.status, summary: p.summary, result: p.result };
  }
}
