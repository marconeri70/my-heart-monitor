# Heart Monitor Bridge

Companion Android per importare in Heart Monitor i dati che altre app (per esempio QRing) scrivono in Health Connect.

Flusso:
1. QRing -> Health Connect
2. Heart Monitor Bridge legge i dati autorizzati
3. Esporta un file JSON
4. La PWA Heart Monitor importa il JSON e costruisce trend/statistiche

Dati supportati:
- battito
- SpO2
- HRV
- passi
- distanza
- calorie
- sonno

Nota: "stress" non è un tipo standard Health Connect.
