# ScreenFusion Web

Sovrapponi due schermi da due PC in blend "Schermo", **dal browser**, senza
installare nulla. Pensato per overlay da streaming.

- Il video va **peer-to-peer** (WebRTC): non passa dal server.
- Il server serve solo a far incontrare i due browser (signaling) + hosting.
- STUN incluso: funziona anche tra reti/IP diversi (tu + un amico).

## Come si usa

1. **PC di gioco**: apri il sito, premi **PC di GIOCO**, scegli lo schermo.
   Compare un **codice stanza** e un **link**.
2. **PC overlay** (tu o un amico): apri il link (o inserisci il codice),
   premi **PC OVERLAY**, scegli lo schermo da inviare (il tuo overlay su nero).
3. La fusione parte da sola sul sito del PC di gioco. Tasto **F** = schermo
   intero, **ESC** = esci.

Il blend "Schermo" fa sparire i neri dell'overlay: resta solo la grafica sopra.

## Avvio in locale (test)

```
npm install
npm start
```
Poi apri http://localhost:3000 (per la cattura schermo serve https o localhost).

## Deploy su Render

1. Metti questa cartella in un repo GitHub.
2. Su https://render.com  ->  New  ->  Web Service  ->  collega il repo.
3. Render legge `render.yaml` da solo: build `npm install`, start `node server.js`.
4. Ottieni un URL https pubblico (es. https://screenfusion.onrender.com):
   quello e' il sito da aprire sui due PC.

Nota: la cattura schermo del browser richiede **https** (Render ce l'ha di suo)
oppure localhost. Su http semplice non funziona.
