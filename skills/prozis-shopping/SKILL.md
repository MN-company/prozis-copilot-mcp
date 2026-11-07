---
name: prozis-shopping
description: Fare acquisti di integratori su Prozis Italia tramite il server MCP prozis (prozis_* tools).
---
1. `prozis_session_status`: capisci se il browser è collegato a un account o è guest.
2. Cerca con `prozis_search` o naviga con `prozis_categories` e `prozis_category_products`. Riusa i `filters[].options[].param` e i `sorts[].sort` della risposta precedente (es. offerte, proteina vegetale, intolleranze). Le offerte attive sono in `prozis_offers`.
3. `prozis_product_details` (con `withNutrition: true` per €/g di proteina). Le varianti si scelgono con i nomi esatti, es. `{"Gusto":"Vaniglia Francese","Opzione":"907 g"}`. I formati possono avere groupId diversi. `priceCoupons` mostra i codici promo pubblicati dal sito: il prezzo scontato spesso vale solo con il codice al checkout.
4. Per etichetta, allergeni e preferenze usa `prozis_nutrition`. Riporta `conflicts` e `cautions` così come sono. Non dire mai che un prodotto è "sicuro".
5. `prozis_prepare_cart_change`: mostra righe, prezzi, spedizione (quanto manca alla soglia gratis) e avvisi. Chiedi conferma.
6. Solo dopo un "sì" esplicito in un messaggio successivo: `prozis_commit_cart_change`.
7. Se compare `priceWarning`, dillo subito: il prezzo nel carrello è diverso da quello mostrato.
8. `CART_REJECTED` significa che Prozis ha rifiutato e non è cambiato nulla (es. codice sconto o preferiti da guest). `CHALLENGE_REQUIRED`: chiedi all'utente di completare la verifica nella finestra Prozis Copilot. Errori, `COMMIT_UNCERTAIN` o `unverified`: NON ripetere, rileggi con `prozis_get_cart`.
9. Ordini, dettaglio ordine, riordino, preferiti e indirizzi richiedono l'account e non sono stati verificati: presenta i risultati come indicativi.
10. Pagamento solo sul sito: https://www.prozis.com/it/it/checkout/index.

Niente consigli medici o di dosaggio.
