# Heart Monitor + COLMI R09

Questa versione aggiunge il collegamento Bluetooth diretto al COLMI R09 (es. `R09_D502`) dalla PWA.

## Funzioni incluse in questa prima versione

- ricerca/selezione dell'anello con Web Bluetooth;
- connessione al servizio BLE COLMI;
- lettura batteria e stato di carica;
- avvio/arresto della misurazione del battito;
- visualizzazione BPM in tempo reale;
- copia automatica del BPM nel campo `Battiti al minuto` già presente nell'app;
- disconnessione e gestione della perdita di collegamento.

## Come provarla su Android

1. Pubblica i file via HTTPS (GitHub Pages va bene).
2. Apri la pagina con Chrome/Chromium su Android oppure dalla PWA installata.
3. Chiudi QRing, perché può mantenere occupata la connessione BLE del ring.
4. Premi **Cerca e collega anello**.
5. Seleziona `R09_D502`.
6. Controlla la batteria e premi **Avvia battito**.
7. Tieni l'anello aderente e il dito fermo per 10-30 secondi.

La sessione battito si interrompe automaticamente dopo 60 secondi per limitare il consumo della batteria.

## Protocollo usato

- Service: `6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E`
- Write: `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
- Notify: `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`
- Battery: command `0x03`
- Manual measurement: command `0x69`, HR subtype `0x01`
- Stop measurement: command `0x6A`
- Computed HR poll fallback: command `0x1E`

I dati del ring sono destinati al monitoraggio personale e non costituiscono misurazioni cliniche.
