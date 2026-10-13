# Heart Monitor Android – R09 HID Gesture Bridge

Prima build Android nativa per il COLMI/RT09 usato con Heart Monitor.

## Obiettivo

Questa app **non apre lo streaming raw X/Y/Z** che sul firmware RT09_3.10.21_251107 mantiene accesi i LED ottici. Usa invece Android come host HID e intercetta gli **eventi tasto nativi** che il ring può inviare quando la funzione "Controllo gestuale" è attiva.

Se il firmware invia eventi HID, i LED ottici non devono essere necessari per il riconoscimento.

## Cosa fa già

- diagnostica degli eventi HID: nome dispositivo, KeyCode, ScanCode, conteggio;
- apprendimento di un gesto con una finestra di 700 ms, quindi supporta anche sequenze di 2–3 tasti;
- più gesti programmabili;
- associazione a:
  - scorrimento su/giù;
  - Indietro, Home, App recenti;
  - pannello notifiche / impostazioni rapide;
  - volume + / -;
  - Play/Pausa, brano successivo/precedente;
  - fotocamera;
  - URL personalizzato;
  - apertura di un'app tramite package Android;
  - vibrazione;
- funziona tramite `AccessibilityService`, quindi le azioni possono essere eseguite anche mentre è aperta un'altra app;
- nessun dato HID viene inviato in rete: le associazioni restano in `SharedPreferences` sul telefono.

## Prima prova sul R09

1. In **QRing**, attiva una volta `Controllo gestuale`.
2. Chiudi QRing completamente.
3. Verifica in Impostazioni Bluetooth che l'R09 sia associato/collegabile come dispositivo di input.
4. Installa e apri Heart Monitor HID.
5. Premi `APRI ACCESSIBILITÀ E ATTIVA IL SERVIZIO` e abilita `Heart Monitor – Gesti R09`.
6. Torna nell'app e fai un gesto con l'anello.

Se il ring sta inviando HID, la sezione **DIAGNOSTICA HID R09** mostrerà subito il nome del tasto ricevuto.

## Registrare un gesto

1. Scegli il nome del gesto.
2. Scegli l'azione.
3. Premi `REGISTRA IL PROSSIMO GESTO HID`.
4. Fai una sola volta il gesto con l'anello.
5. L'app salva l'evento o la breve sequenza HID e da quel momento la riconosce automaticamente.

L'opzione `blocca l'azione HID originale` evita, per esempio, che un gesto che il ring presenta come Volume+ aumenti anche il volume oltre all'azione scelta.

## Build

### Android Studio

Apri questa cartella come progetto Gradle. Requisiti consigliati:

- Android Studio recente;
- JDK 17;
- Android SDK 35.

### GitHub Actions

È incluso `.github/workflows/build-apk.yml`. Caricando il progetto su GitHub, il workflow compila automaticamente:

`app/build/outputs/apk/debug/app-debug.apk`

L'APK viene pubblicato come artifact `HeartMonitor-HID-debug-apk`.

## Perché richiede Accessibilità

Android non offre a una normale app un'API pubblica per intercettare globalmente tutti i tasti provenienti da un dispositivo HID mentre altre app sono in primo piano. `AccessibilityService` con `canRequestFilterKeyEvents` è il meccanismo pubblico che consente di osservare questi eventi e trasformarli in azioni globali.

Il servizio è volutamente limitato agli eventi tasto. Non registra testo, password o contenuto delle schermate.

## Nota sul firmware

Il passaggio HID deve essere verificato fisicamente sul firmware dell'anello. Se la diagnostica resta a zero anche dopo aver attivato `Controllo gestuale` in QRing e aver associato l'R09 come dispositivo di input, significa che quella revisione firmware non espone i gesti come tasti HID al sistema Android oppure richiede un comando di inizializzazione proprietario che dovremo individuare.
