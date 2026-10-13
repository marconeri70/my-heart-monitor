# Heart Monitor Ultra + COLMI R09 — v3 All-in-One

Questa versione collega direttamente la PWA al COLMI R09 via Web Bluetooth e aggiunge un flusso unico **Sincronizza tutto**.

## Dati integrati

- batteria e stato di carica;
- hardware/firmware quando il servizio Device Information è disponibile;
- battito cardiaco (hardware verificato sul R09_D502);
- SpO₂;
- passi di oggi, calorie e distanza dai blocchi attività COLMI;
- riepilogo sonno: totale, profondo, leggero, REM e sveglio, se il firmware espone il servizio Big Data;
- temperatura, stress e HRV come funzioni sperimentali dipendenti dal firmware;
- accelerometro grezzo e semplici indicazioni di movimento/gesto sperimentali.

## Uso rapido

1. Chiudi QRing, perché può occupare la connessione BLE dell'anello.
2. Apri la PWA con Chrome/Chromium Android su HTTPS.
3. Premi **Cerca e collega anello** e scegli `R09_D502`.
4. Premi **Sincronizza tutto** e lascia l'anello al dito. L'app esegue automaticamente letture e misure in sequenza.

Le singole funzioni restano disponibili come pulsanti per ripetere solo una misura.

## Canali BLE

Primary UART-style:
- Service `6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E`
- Write `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
- Notify `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`

Big Data (sonno):
- Service `DE5BF728-D711-4E47-AF26-65E3012A5DC7`
- Write `DE5BF72A-D711-4E47-AF26-65E3012A5DC7`
- Notify `DE5BF729-D711-4E47-AF26-65E3012A5DC7`

## Nota importante

I valori dell'anello sono dati wellness e non misure cliniche. La pressione arteriosa e la glicemia “stimate” dall'anello non sono importate nella app perché non sono considerate misurazioni affidabili. La pressione resta inserita manualmente da uno strumento dedicato.


## v4 protocol fix
- Corrected V2 big-data requests: the secondary characteristic receives raw 7-byte commands, not 16-byte UART frames.
- Sleep, SpO2 history and R09 temperature history now use the V2 channel.
- Stress and HRV use their history commands (0x37/0x39) before falling back to spot reads.
- New-calorie-protocol activity values are converted to kcal correctly (e.g. 2220 protocol units = 2.22 kcal).
