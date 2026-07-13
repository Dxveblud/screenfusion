# ScreenFusion Web

Sovrapponi due schermi da due PC in blend "Schermo", **dal browser**, senza
installare nulla. Pensato per overlay da streaming.

- Il video va **peer-to-peer** (WebRTC): non passa dal server.
- Il server serve solo a far incontrare i due browser (signaling) + hosting.
- **STUN + TURN** inclusi: funziona anche tra reti/IP diversi (tu + un amico),
  compreso 4G/5G e NAT simmetrico dove la P2P diretta fallisce.
- Riconnessione automatica del signaling, ICE-restart al primo intoppo, HUD
  con FPS/bitrate/latenza (tasto **S**) e scelta qualita' nel pannello ⚙.

## TURN (relay per reti "difficili")

Di default usa i TURN pubblici gratuiti di OpenRelay: comodi ma condivisi e a
volte lenti. Per un uso serio metti un tuo TURN via variabili d'ambiente su
Render (o dove deployi):

```
TURN_URLS=turn:tuo-turn:3478,turn:tuo-turn:443?transport=tcp
TURN_USERNAME=utente
TURN_CREDENTIAL=password
```

Il client li scarica da `GET /ice`, quindi cambiarli non richiede rebuild.
Un TURN gratuito con chiave si ottiene ad es. su https://www.metered.ca/.

## Come si usa

1. **PC overlay** (tu o un amico): premi **CREA OVERLAY E INVIA IL LINK**,
   scegli lo schermo da inviare (il tuo overlay su nero). Compare un **codice**
   e un **link** da condividere.
2. **PC di gioco**: premi **SCHERMO PRINCIPALE**, scegli lo schermo di gioco,
   incolla il link/codice dell'overlay e premi **Collega**.
3. La fusione parte da sola sul PC di gioco. Tasti: **F** = schermo intero,
   **S** = statistiche, **B** = cambia blend, **ESC** = esci.
4. Vuoi vederla anche dal telefono? Sul PC di gioco premi **📱 Link telefono**
   e apri quel link sul telefono.

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
