/** LOCAL ONLY. Streamable HTTP MCP server for prozis.com/it. Requests run inside a local Chromium window (Cloudflare). */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod/v4';
import { getConfig } from './config.mjs';
import { ProzisBrowser } from './browser.mjs';
import { ProzisClient, ProzisError } from './client.mjs';
import { AgentStore } from './store.mjs';
import { CartPlanner } from './planner.mjs';
import { PREF_DEFAULTS, checkAgainstPrefs, mergePrefs, removePrefs } from './prefs.mjs';
import { compareBlock, parseNetWeightG, parseServingG } from './parse.mjs';

export const VERSION = '0.2.0';
const config = getConfig();
const store = new AgentStore(config.dbPath);
const browser = new ProzisBrowser(config);
const client = new ProzisClient(browser);
const planner = new CartPlanner({ client, store, ttlMs: config.planTtlMs, writesEnabled: config.allowCartWrites });

const textResult = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError });
function safeTool(fn) {
  return async params => {
    try { return textResult(await fn(params ?? {})); }
    catch (e) {
      if (e instanceof ProzisError) return textResult({ error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }, true);
      console.error('Prozis tool error (details suppressed)');
      return textResult({ error: 'INVALID_OPERATION', message: 'Operazione non valida. Nessuna modifica confermata.' }, true);
    }
  };
}
const read = { readOnlyHint: true, openWorldHint: true };
const localRead = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, openWorldHint: true };
const groupId = z.string().regex(/^\d{3,9}$/).describe('groupId da prozis_search');
const filters = z.record(z.string().regex(/^[a-z_]{2,20}$/i), z.string().regex(/^[\w.,-]{1,40}$/)).optional()
  .describe('Filtri del sito come {parametro: valore}, presi da filters[].options[].param di una ricerca precedente (es. {"oppo":"013049"} o {"concepts":"010200091"})');
const sort = z.string().regex(/^[a-z_]{2,30}$/).optional().describe('Valore "sort" da sorts[] di una ricerca precedente (es. popularity)');
const prefs = () => ({ ...PREF_DEFAULTS, ...store.get('preferences', {}) });
const UNVERIFIED = 'Funzione sviluppata senza account Prozis: non verificata sul sito. Se il risultato sembra strano, controlla su prozis.com.';

const cartOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), groupId, quantity: z.number().int().min(1).max(20),
    options: z.record(z.string().max(40), z.string().max(80)).optional().describe('Varianti, es. {"Gusto":"Vaniglia Francese","Opzione":"907 g"} (nomi da prozis_product_details)') }),
  z.object({ op: z.literal('update'), itemId: z.number().int().positive(), quantity: z.number().int().min(0).max(20) }),
  z.object({ op: z.literal('remove'), itemId: z.number().int().positive() }),
  z.object({ op: z.literal('coupon_apply'), code: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/) }),
  z.object({ op: z.literal('coupon_remove'), code: z.string().max(40).optional().describe('Senza codice rimuove tutti i codici') }),
  z.object({ op: z.literal('favorite_add'), groupId }),
  z.object({ op: z.literal('favorite_remove'), groupId }),
  z.object({ op: z.literal('reorder'), orderId: z.string().regex(/^[A-Za-z0-9-]{3,30}$/) })
]);

function makeServer() {
  const server = new McpServer({ name: 'prozis-copilot', version: VERSION });

  server.registerTool('prozis_search', { description: 'Ricerca live nel catalogo Prozis Italia (48 risultati per pagina): prezzo, prezzo barrato, promo, peso netto e €/kg quando ricavabili dal nome. Restituisce anche i filtri disponibili (Occasioni, Per concetto, Esigenze dietetiche, prezzo…) e gli ordinamenti, da riusare in filters/sort.',
    inputSchema: { query: z.string().min(1).max(150), page: z.number().int().min(1).max(30).optional(), sort, filters }, annotations: read },
    safeTool(async ({ query, page, sort, filters }) => {
      const r = await client.search(query, { page, sort, filters });
      for (const p of r.products) store.recordPrice(`group:${p.groupId}`, p.price);
      return { ...r, source: 'live_prozis' };
    }));

  server.registerTool('prozis_product_details', { description: 'Opzioni (gusto, formato) e tutte le varianti vendibili con SKU, prezzo, stock, massimo per ordine, data di disponibilità e blocco compare (peso netto, €/kg; €/g di proteina con withNutrition). Include i codici promo pubblicati dal sito (priceCoupons), la valutazione e i gusti preferiti o da evitare secondo le preferenze locali. I formati diversi possono avere groupId diversi.',
    inputSchema: { groupId, withNutrition: z.boolean().optional().describe('Aggiunge proteine/100 g e €/g di proteina per ogni variante (più lento)') }, annotations: read },
    safeTool(async ({ groupId, withNutrition }) => {
      const p = await client.productDetails(groupId, { withNutrition });
      const pr = prefs();
      for (const v of p.variants) { const f = checkAgainstPrefs(pr, { flavour: Object.values(v.options).join(' ') }); if (f.preferredFlavour) v.preferredFlavour = true; if (f.conflicts.length) v.preferenceConflicts = f.conflicts; }
      for (const v of p.variants) store.recordPrice(v.sku, v.price);
      return { ...p, note: 'Allergeni e ingredienti vanno verificati sull\'etichetta: non dichiarare mai un prodotto "sicuro".' };
    }));

  server.registerTool('prozis_nutrition', { description: 'Etichetta di una variante: dose, dosi per confezione, peso netto, valori per dose e per 100 g, ingredienti, allergeni dichiarati, tracce possibili, avvertenze. Calcola €/kg, €/g di proteina e €/dose e segnala i conflitti con le preferenze locali (mai una garanzia di sicurezza).',
    inputSchema: { groupId, sku: z.string().regex(/^[A-Z0-9]+\/\d+$/).optional() }, annotations: read },
    safeTool(async ({ groupId, sku }) => {
      const n = await client.nutrition(groupId, sku);
      const p = await client.rawProduct(groupId).catch(() => null);
      const v = p?.variants.find(x => x.sku === n.sku);
      const netWeightG = parseNetWeightG(n.netWeight) ?? parseNetWeightG(v?.options?.Opzione);
      return { ...n, compare: v ? compareBlock({ price: v.price, netWeightG, proteinPer100g: n.proteinPer100g, servingG: parseServingG(n.serving) }) : undefined,
        preferences: checkAgainstPrefs(prefs(), { flavour: Object.values(v?.options ?? {}).join(' '), label: n.label }) };
    }));

  server.registerTool('prozis_get_cart', { description: 'Legge il carrello Prozis con spedizione, soglia di spedizione gratuita e quanto manca, codici sconto, data di consegna stimata e ProzisPoints. itemId serve per modificare o rimuovere righe.', annotations: read },
    safeTool(async () => client.fullCart()));

  server.registerTool('prozis_prepare_cart_change', { description: 'SOLA LETTURA. Prepara modifiche (add, update, remove, coupon_apply, coupon_remove, favorite_add, favorite_remove, reorder da un ordine passato), verifica variante, stock e limiti, stima la spedizione e restituisce riepilogo e confirmationPhrase. Codici sconto, preferiti e riordino richiedono l\'account. Mostra il riepilogo e attendi l\'approvazione esplicita dell\'utente in un messaggio successivo.',
    inputSchema: { operations: z.array(cartOp).min(1).max(10) }, annotations: read },
    safeTool(async ({ operations }) => planner.prepare(operations)));

  server.registerTool('prozis_commit_cart_change', { description: 'ESEGUE UNA SOLA VOLTA un piano preparato, solo dopo approvazione esplicita dell\'utente, poi rilegge il carrello per verificare. In caso di errore, CHALLENGE_REQUIRED o stato "unverified" non ripetere. Non effettua ordini né pagamenti.',
    inputSchema: { planId: z.string().uuid(), confirmationPhrase: z.string().min(1).max(30), userExplicitlyApproved: z.literal(true) }, annotations: write },
    safeTool(async ({ planId, confirmationPhrase }) => planner.commit(planId, confirmationPhrase)));

  server.registerTool('prozis_cart_plan_status', { description: 'Stato ed esito di un piano carrello, senza rieseguirlo.',
    inputSchema: { planId: z.string().uuid() }, annotations: localRead }, safeTool(async ({ planId }) => planner.status(planId)));

  server.registerTool('prozis_price_history', { description: 'Storico prezzi osservato da questo MCP per uno SKU (es. NUT00/1873810344) o per "group:<groupId>".',
    inputSchema: { key: z.string().min(3).max(60) }, annotations: localRead },
    safeTool(async ({ key }) => {
      const h = store.priceHistory(key), p = h.map(x => x.price);
      return { key, observations: h.length, min: p.length ? Math.min(...p) : null, max: p.length ? Math.max(...p) : null, history: h.slice(-30) };
    }));

  server.registerTool('prozis_session_status', { description: 'Dice se il browser di Prozis Copilot è collegato a un account (verified) o è guest. Nessun dato personale.', annotations: read },
    safeTool(async () => {
      const s = await client.sessionStatus();
      return { ...s, cartWritesEnabled: config.allowCartWrites,
        ...(s.account === 'guest' ? { hint: 'Per ordini, preferiti, indirizzi e codici sconto: ferma il server, esegui npm run login, riavvialo.' } : {}) };
    }));

  server.registerTool('prozis_categories', { description: 'Albero delle categorie del negozio (menu del sito). Usa path con prozis_category_products.', annotations: read },
    safeTool(async () => ({ categories: await client.categories() })));

  server.registerTool('prozis_category_products', { description: 'Prodotti di una categoria con filtri e ordinamenti del sito, come prozis_search.',
    inputSchema: { path: z.string().min(3).max(200), page: z.number().int().min(1).max(30).optional(), sort, filters }, annotations: read },
    safeTool(async ({ path, page, sort, filters }) => client.categoryProducts(path, { page, sort, filters })));

  server.registerTool('prozis_offers', { description: 'Offerte attive: le fasce "Occasioni" del sito (es. 25%, 2 per 1, omaggio a scelta) con il numero di prodotti, per una ricerca (query) o una categoria (path). Con offer elenca i prodotti di quella fascia.',
    inputSchema: { query: z.string().max(100).optional(), path: z.string().max(200).optional(), offer: z.string().regex(/^\d{3,10}$/).optional(), page: z.number().int().min(1).max(30).optional() }, annotations: read },
    safeTool(async args => client.offers(args)));

  server.registerTool('prozis_reviews', { description: 'Recensioni di un prodotto: voto su 10, criteri (gusto, consistenza, scioglimento…), data, paese. Paginate.',
    inputSchema: { groupId, page: z.number().int().min(1).max(100).optional() }, annotations: read },
    safeTool(async ({ groupId, page }) => client.reviews(groupId, { page })));

  server.registerTool('prozis_points', { description: 'ProzisPoints: punti che il carrello attuale fa guadagnare, saldo precedente (solo con account) e punti disponibili dopo l\'ordine.', annotations: read },
    safeTool(async () => { const c = await client.fullCart(); return { ...c.points, loggedIn: c.loggedIn, perProduct: 'vedi variants[].points in prozis_product_details' }; }));

  server.registerTool('prozis_orders', { description: 'Storico ordini (richiede account). ' + UNVERIFIED, annotations: read },
    safeTool(async () => ({ ...(await client.orders()), note: UNVERIFIED })));

  server.registerTool('prozis_order_get', { description: 'Dettaglio di un ordine con le righe (SKU, quantità) per il riordino (richiede account). ' + UNVERIFIED,
    inputSchema: { orderId: z.string().regex(/^[A-Za-z0-9-]{3,30}$/) }, annotations: read },
    safeTool(async ({ orderId }) => ({ ...(await client.order(orderId)), note: UNVERIFIED })));

  server.registerTool('prozis_favorites', { description: 'Prodotti nei Preferiti (richiede account). Per aggiungere o togliere usa prozis_prepare_cart_change con favorite_add/favorite_remove. ' + UNVERIFIED, annotations: read },
    safeTool(async () => client.favorites()));

  server.registerTool('prozis_addresses', { description: 'Indirizzi salvati in forma testuale breve (richiede account). ' + UNVERIFIED, annotations: read },
    safeTool(async () => ({ ...(await client.addresses()), note: UNVERIFIED })));

  server.registerTool('prozis_payment_methods', { description: 'Metodi di pagamento salvati: Prozis non espone un endpoint per leggerli fuori dal checkout, e il tool lo dichiara invece di inventare.', annotations: localRead },
    safeTool(async () => ({ available: false, reason: 'Nessun endpoint Prozis per i metodi di pagamento salvati fuori dal checkout. Questo MCP non entra nel checkout e non legge mai dati di carte.' })));

  server.registerTool('prozis_preferences_get', { description: 'Preferenze alimentari locali: vegan, senza glutine, senza lattosio, ingredienti da evitare, gusti preferiti o da evitare.', annotations: localRead },
    safeTool(async () => prefs()));

  server.registerTool('prozis_preferences_set', { description: 'Aggiorna le preferenze locali (le liste vengono unite, non sostituite). Servono solo come segnalazioni, mai come garanzia.',
    inputSchema: { vegan: z.boolean().optional(), glutenFree: z.boolean().optional(), lactoseFree: z.boolean().optional(),
      avoidIngredients: z.array(z.string().min(2).max(40)).max(30).optional(), preferredFlavours: z.array(z.string().min(2).max(40)).max(30).optional(),
      avoidFlavours: z.array(z.string().min(2).max(40)).max(30).optional(), userExplicitlyRequested: z.literal(true) }, annotations: { readOnlyHint: false, openWorldHint: false } },
    safeTool(async ({ userExplicitlyRequested, ...patch }) => { const p = mergePrefs(prefs(), patch); store.set('preferences', p); store.audit('preferences_set', Object.keys(patch)); return p; }));

  server.registerTool('prozis_preferences_remove', { description: 'Toglie preferenze: keys le riporta al valore iniziale, values toglie singoli elementi dalle liste.',
    inputSchema: { keys: z.array(z.enum(Object.keys(PREF_DEFAULTS))).optional(),
      values: z.record(z.enum(['avoidIngredients', 'preferredFlavours', 'avoidFlavours']), z.array(z.string().max(40))).optional(),
      userExplicitlyRequested: z.literal(true) }, annotations: { readOnlyHint: false, openWorldHint: false } },
    safeTool(async ({ keys, values }) => { const p = removePrefs(prefs(), { keys, values }); store.set('preferences', p); store.audit('preferences_remove', { keys }); return p; }));

  server.registerTool('prozis_release_info', { description: 'Versione del server e impostazioni attive.', annotations: localRead },
    safeTool(async () => ({ service: 'prozis-copilot', version: VERSION, site: 'https://www.prozis.com/it/it', cartWritesEnabled: config.allowCartWrites,
      transport: 'XHR da una finestra Chromium locale (Cloudflare blocca i client non-browser)', checkout: 'solo sul sito, mai dall\'MCP', freeShippingFrom: 29.99,
      verifiedLive: ['search + filtri + ordinamenti', 'categorie', 'prodotti per categoria', 'offerte', 'dettaglio prodotto + compare', 'etichetta e valori nutrizionali', 'recensioni', 'carrello + spedizione', 'punti (guest)', 'stato sessione', 'add/update/remove', 'coupon_apply da guest → rifiuto LOGIN_REQUIRED', 'favorite_add da guest → richiesta login'],
      unverified: { reason: 'nessun account Prozis collegato durante lo sviluppo', items: ['prozis_orders', 'prozis_order_get', 'reorder', 'prozis_favorites', 'prozis_addresses', 'coupon_apply/remove con account', 'favorite_add/remove con account', 'saldo punti con account'] },
      notAvailable: ['metodi di pagamento salvati (nessun endpoint fuori dal checkout)'] })));

  return server;
}

const app = createMcpExpressApp({ host: config.bindHost });
app.use(express.json({ limit: '128kb' }));
app.get('/health', (_req, res) => res.json({ service: 'prozis-copilot', ok: true, version: VERSION }));
app.post('/mcp', async (req, res) => {
  const server = makeServer(), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP error' }, id: null }); }
  finally {
    if (res.writableFinished) { await transport.close(); await server.close(); }
    else res.on('close', async () => { await transport.close(); await server.close(); });
  }
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());
const instance = app.listen(config.port, config.bindHost, () =>
  console.log(`Prozis MCP v${VERSION} on http://${config.bindHost}:${config.port}/mcp — cart writes: ${config.allowCartWrites ? 'enabled' : 'disabled'}`));
async function stop() { instance.close(); await browser.close(); store.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
