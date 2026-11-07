# Prozis Copilot MCP (v0.2.0)

Server MCP locale per fare acquisti su **prozis.com/it**. Fa parte della suite integratori, con Bulk e Tsunami.

Prozis è dietro Cloudflare, che blocca i client non-browser e anche Chromium headless (risponde 429). Per questo il server apre **una finestra Chromium locale, ridotta a icona**, con un profilo dedicato, e fa ogni richiesta come XHR da quella pagina. Il ritmo è di 1 richiesta ogni 2 secondi. Non c'è nessun tentativo di aggirare le verifiche: se Cloudflare ne chiede una, il tool risponde `CHALLENGE_REQUIRED` e la completi tu nella finestra.

## Avvio
```bash
npm ci
npm start            # http://127.0.0.1:3791/mcp — il browser si apre alla prima chiamata
npm run smoke        # controllo live in sola lettura
npm test
```
Se `npx playwright install chromium` non va, usa un Chromium già presente con `BROWSER_EXECUTABLE` (vedi `login-local.ps1`).

Registrazione in Claude Code: `claude mcp add --transport http -s user prozis http://127.0.0.1:3791/mcp`

Docker non è previsto: serve una finestra vera.

## Account (opzionale)
Ferma il server, poi lancia `npm run login`: accedi TU nella finestra e premi INVIO. La sessione resta nel profilo `~/.prozis-copilot/browser-profile`. `prozis_session_status` dice se il browser è collegato (`verified`) o `guest`. Senza account, ordini, preferiti, indirizzi e codici sconto rispondono `ACCOUNT_REQUIRED` o vengono rifiutati da Prozis senza modifiche.

## Tool
| Tool | Tipo | Verificato sul sito |
|---|---|---|
| `prozis_session_status` | lettura | ✅ (guest) |
| `prozis_search`: peso netto e €/kg dal nome, filtri (Occasioni, Per concetto, Intolleranze, Prezzo, ProzisPoints) e ordinamenti | lettura | ✅ |
| `prozis_categories`, `prozis_category_products` (stessi filtri) | lettura | ✅ |
| `prozis_offers`: fasce "Occasioni" (10–50%, 2 per 1, 3 per 2, omaggi) e relativi prodotti | lettura | ✅ |
| `prozis_product_details`: varianti, stock, limiti, `compare` (€/kg; €/g di proteina e €/dose con `withNutrition`), codici promo pubblicati dal sito, valutazione | lettura | ✅ |
| `prozis_nutrition`: etichetta completa (valori, ingredienti, allergeni, tracce, avvertenze), `compare`, controllo preferenze | lettura | ✅ |
| `prozis_reviews` (voto su 10, criteri, paginazione) | lettura | ✅ |
| `prozis_get_cart`: righe, spedizione, soglia gratis (29,99 €) e quanto manca, codici, data di consegna, punti | lettura | ✅ |
| `prozis_points` | lettura | ✅ guest; saldo account non verificato |
| `prozis_prepare_cart_change` → `prozis_commit_cart_change`: add, update, remove | scrittura in due fasi | ✅ |
| stessi tool con coupon_apply / coupon_remove | scrittura in due fasi | ⚠️ da guest Prozis rifiuta (verificato); con account non verificato |
| stessi tool con favorite_add / favorite_remove | scrittura in due fasi | ⚠️ da guest Prozis chiede il login (verificato); con account non verificato |
| stessi tool con reorder (righe di un ordine passato) | scrittura in due fasi | ❌ non verificato |
| `prozis_orders`, `prozis_order_get`, `prozis_favorites`, `prozis_addresses` | lettura, richiedono account | ❌ non verificati: endpoint trovati (`order/list`, `order/detail`, `favorites/products`, `address/index`), parser scritti senza account |
| `prozis_payment_methods` | — | non disponibile: Prozis non espone i metodi salvati fuori dal checkout |
| `prozis_preferences_get/set/remove`: vegan, senza glutine, senza lattosio, ingredienti e gusti | locale | ✅ |
| `prozis_price_history`, `prozis_cart_plan_status`, `prozis_release_info` | locale | ✅ |

Avvisi automatici:
- **Prezzo nel carrello diverso da quello mostrato** prima della conferma: la risposta contiene `priceChanges` e `priceWarning`. Succede con preordini e con promo che richiedono un codice (es. `BNOVEMBER`, elencato in `priceCoupons`).
- **Spedizione:** il riepilogo indica quanto manca alla spedizione gratuita.
- **Preferenze:** riportano conflitti e tracce dichiarate, mai una garanzia di sicurezza.

Il checkout si fa solo sul sito.

## Endpoint usati
Su www.prozis.com/it/it, con header `X-Requested-With: XMLHttpRequest`:
`catalog/search?text=` (+ filtri `oppo`, `concepts`, … e `ls`) · categorie via il loro path · `menu/desktopMenu` · `POST product/index?_id=<groupId>` · `product/nutrition-table` · `cart/index` · `POST cart/add-pdp` · `cart/update` · `cart/remove` · `checkout/index` (GET riepilogo; `POST {cpn}` codice; `?cpn-rm=&cpn-id=` rimozione) · `cart/remove-coupons` · `likes/add|remove` · `order/list` · `order/detail` · `favorites/products` · `address/index`.

Su adg.prozis.com/it/it: `comment/list` (recensioni).
