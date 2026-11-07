# Prozis Copilot MCP — istruzioni per agenti

Server MCP locale per prozis.com/it. Le richieste partono da una finestra Chromium locale perché Cloudflare blocca gli altri client: non aggiungere mai stealth, spoofing o risolutori di CAPTCHA. Endpoint nel README. Funzioni con account (ordini, riordino, preferiti, indirizzi, codici sconto) sono implementate ma non verificate: rispondono ACCOUNT_REQUIRED da guest. Le scritture verificano sempre leggendo di nuovo il carrello o il riepilogo. Leggi `skills/prozis-shopping/SKILL.md` prima di usare i tool.

Regole non negoziabili: le modifiche al carrello passano da prepare → riepilogo all'utente → approvazione esplicita → commit una sola volta. Non ripetere mai una scrittura dall'esito incerto. Mai chiedere la password: il login lo fa l'utente con `npm run login`. Mai definire un prodotto "sicuro" per allergie o salute: le preferenze danno solo conflitti e tracce dichiarate. Nei test, ogni scrittura su carrello o preferiti va annullata. Niente checkout dall'MCP.

Sviluppo: `npm ci`, `npm run check`, `npm test`, `npm run smoke`. Non committare `.env`, `*.sqlite`, la cartella dati.
