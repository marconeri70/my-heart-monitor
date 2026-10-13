/*
 * COLMI R09 / QRing BLE integration for Heart Monitor Ultra.
 * Direct Web Bluetooth connection: no QRing cloud is required for these reads.
 *
 * R09 note: the QRing-compatible spot HR flow uses command 0x69 and the ring
 * returns repeated 0x69 packets with type/error/value in bytes 1/2/3.
 */
(function () {
    'use strict';

    const SERVICE_UUID = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
    const WRITE_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
    const NOTIFY_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

    const CMD_BATTERY = 0x03;
    const CMD_REALTIME_HR_NOTIFY = 0x1e; // receive-only on many R09 firmwares
    const CMD_MANUAL_MEASUREMENT = 0x69;
    const CMD_STOP_MEASUREMENT = 0x6a;
    const HR_SUBTYPE = 0x01;

    let ringDevice = null;
    let gattServer = null;
    let writeCharacteristic = null;
    let notifyCharacteristic = null;

    let hrFallbackTimer = null;
    let hrAutoStopTimer = null;
    let hrSuccessStopTimer = null;
    let hrRunning = false;
    let hrMode = 'qring';
    let lastBpm = 0;
    let validHrPackets = 0;

    function el(id) { return document.getElementById(id); }

    function setRingStatus(message, kind = 'info') {
        const node = el('ringStatus');
        if (!node) return;
        node.textContent = message;
        node.className = `ring-status ${kind}`;
    }

    function setConnectedUi(connected) {
        const badge = el('ringConnectionBadge');
        const connectBtn = el('ringConnectBtn');
        const batteryBtn = el('ringBatteryBtn');
        const hrBtn = el('ringHrBtn');
        const disconnectBtn = el('ringDisconnectBtn');

        if (badge) {
            badge.textContent = connected ? 'Connesso' : 'Non connesso';
            badge.classList.toggle('connected', connected);
        }
        if (connectBtn) connectBtn.style.display = connected ? 'none' : 'block';
        if (batteryBtn) batteryBtn.disabled = !connected;
        if (hrBtn) hrBtn.disabled = !connected;
        if (disconnectBtn) disconnectBtn.style.display = connected ? 'block' : 'none';
    }

    function makePacket(command, payload = []) {
        const packet = new Uint8Array(16);
        packet[0] = command & 0xff;
        payload.slice(0, 14).forEach((value, index) => { packet[index + 1] = value & 0xff; });
        let sum = 0;
        for (let i = 0; i < 15; i++) sum = (sum + packet[i]) & 0xff;
        packet[15] = sum;
        return packet;
    }

    function hasValidChecksum(bytes) {
        if (bytes.length !== 16) return true; // tolerate non-standard notifications
        let sum = 0;
        for (let i = 0; i < 15; i++) sum = (sum + bytes[i]) & 0xff;
        return sum === bytes[15];
    }

    async function writePacket(packet) {
        if (!writeCharacteristic || !ringDevice?.gatt?.connected) {
            throw new Error('Anello non connesso');
        }
        if (typeof writeCharacteristic.writeValueWithoutResponse === 'function') {
            await writeCharacteristic.writeValueWithoutResponse(packet);
        } else {
            await writeCharacteristic.writeValue(packet);
        }
    }

    function updateBattery(level, charging) {
        if (el('ringBattery')) el('ringBattery').textContent = `${level}%${charging ? ' ⚡' : ''}`;
        setRingStatus(`Batteria aggiornata: ${level}%${charging ? ' (in carica)' : ''}.`, 'success');
    }

    function updateHeartRate(bpm, source) {
        if (!Number.isFinite(bpm) || bpm < 30 || bpm > 220) return;

        lastBpm = bpm;
        validHrPackets += 1;

        if (el('ringBpm')) el('ringBpm').textContent = `${bpm} bpm`;
        if (el('ringLastUpdate')) {
            el('ringLastUpdate').textContent = new Date().toLocaleTimeString('it-IT', {
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        }

        // Porta automaticamente il valore nel campo BPM già presente nell'app.
        const bpmInput = el('bpm');
        if (bpmInput) bpmInput.value = bpm;

        setRingStatus(`Battito rilevato: ${bpm} bpm${source ? ` · ${source}` : ''}. Attendo qualche secondo per stabilizzare il valore.`, 'success');

        // Dopo il primo valore valido lasciamo arrivare alcuni campioni e poi fermiamo
        // automaticamente il sensore, così non resta acceso inutilmente.
        if (!hrSuccessStopTimer) {
            hrSuccessStopTimer = setTimeout(() => {
                if (hrRunning) {
                    void stopHeartRate(true, `Misurazione completata. Ultimo valore: ${lastBpm} bpm.`);
                }
            }, 7000);
        }
    }

    function onNotification(event) {
        const view = event.target.value;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (!bytes.length) return;
        if (!hasValidChecksum(bytes)) return;

        const command = bytes[0];
        const baseCommand = command & 0x7f;
        const isError = (command & 0x80) !== 0;

        if (isError) {
            // 0x9E is commonly the R09 rejection of a phone-initiated 0x1E request.
            // We no longer send that request, but surface any protocol error for diagnostics.
            setRingStatus(`L’anello ha rifiutato il comando 0x${baseCommand.toString(16).padStart(2, '0')}.`, 'warning');
            return;
        }

        if (command === CMD_BATTERY && bytes.length >= 3) {
            updateBattery(bytes[1], bytes[2] === 1);
            return;
        }

        // QRing/R09: [0x69, type, errCode, value, ...]
        if (command === CMD_MANUAL_MEASUREMENT && bytes.length >= 4 && bytes[1] === HR_SUBTYPE) {
            const errorCode = bytes[2];
            const value = bytes[3];

            if (errorCode === 0) {
                if (value >= 30) {
                    updateHeartRate(value, hrMode === 'qring' ? 'R09/QRing' : 'R09 fallback');
                } else {
                    setRingStatus('Sensore in acquisizione… tieni il dito fermo. Il R09 può impiegare 20–30 secondi.', 'info');
                }
            } else if (errorCode === 1) {
                setRingStatus('L’anello non rileva bene il dito. Sistemalo più aderente e resta fermo.', 'warning');
            } else if (errorCode === 2) {
                setRingStatus('Dati ancora insufficienti. Continuo ad attendere il sensore…', 'info');
            } else {
                setRingStatus(`Risposta sensore non prevista (codice ${errorCode}).`, 'warning');
            }
            return;
        }

        // Alcuni firmware inviano spontaneamente 0x1E. Non lo richiediamo dal telefono.
        if (command === CMD_REALTIME_HR_NOTIFY && bytes.length >= 2) {
            let candidate = bytes[1];
            if (bytes.length >= 3 && bytes[1] === HR_SUBTYPE && bytes[2] >= 30) candidate = bytes[2];
            updateHeartRate(candidate, 'R09 realtime');
        }
    }

    function clearHrTimers() {
        if (hrFallbackTimer) clearTimeout(hrFallbackTimer);
        if (hrAutoStopTimer) clearTimeout(hrAutoStopTimer);
        if (hrSuccessStopTimer) clearTimeout(hrSuccessStopTimer);
        hrFallbackTimer = null;
        hrAutoStopTimer = null;
        hrSuccessStopTimer = null;
    }

    function localStopHeartRateUi() {
        clearHrTimers();
        hrRunning = false;
        const btn = el('ringHrBtn');
        if (btn) btn.textContent = '❤️ Avvia battito';
    }

    async function sendHrStop() {
        if (!ringDevice?.gatt?.connected) return;
        // QRing stop: 6A 01 <ultimo_bpm> 00. Se non c'è ancora un valore usa 0.
        try {
            await writePacket(makePacket(CMD_STOP_MEASUREMENT, [HR_SUBTYPE, lastBpm || 0, 0]));
        } catch (_) {}
    }

    async function stopHeartRate(sendStop = true, message = 'Misurazione del battito terminata.') {
        if (!hrRunning) return;
        if (sendStop) await sendHrStop();
        localStopHeartRateUi();
        setRingStatus(message, lastBpm ? 'success' : 'info');
    }

    async function startHeartRate() {
        if (!ringDevice?.gatt?.connected) {
            setRingStatus('Collega prima il COLMI R09.', 'warning');
            return;
        }
        if (hrRunning) {
            await stopHeartRate(true);
            return;
        }

        hrRunning = true;
        hrMode = 'qring';
        lastBpm = 0;
        validHrPackets = 0;
        clearHrTimers();

        if (el('ringBpm')) el('ringBpm').textContent = '--';
        const btn = el('ringHrBtn');
        if (btn) btn.textContent = '⏹️ Ferma battito';
        setRingStatus('Avvio misurazione R09… resta fermo. Il primo valore può richiedere 20–30 secondi.', 'info');

        try {
            // Sequenza usata dalla famiglia QRing per la misura spot HR.
            // 69 01 00 = tipo HR, richiesta semplice.
            await writePacket(makePacket(CMD_MANUAL_MEASUREMENT, [HR_SUBTYPE, 0x00]));

            // Alcune revisioni accettano invece la variante action=START (69 01 01).
            // Se dopo 40 secondi non è arrivato un BPM valido, la proviamo una sola volta.
            hrFallbackTimer = setTimeout(async () => {
                if (!hrRunning || lastBpm > 0 || !ringDevice?.gatt?.connected) return;
                try {
                    await sendHrStop();
                    await new Promise(resolve => setTimeout(resolve, 1200));
                    hrMode = 'fallback';
                    setRingStatus('Nessun BPM dalla prima modalità. Provo la modalità compatibile alternativa…', 'info');
                    await writePacket(makePacket(CMD_MANUAL_MEASUREMENT, [HR_SUBTYPE, 0x01]));
                } catch (error) {
                    setRingStatus(`Errore nel secondo tentativo: ${error.message || error}`, 'error');
                }
            }, 40000);

            // Tempo sufficiente anche per il secondo tentativo e il warm-up ottico.
            hrAutoStopTimer = setTimeout(() => {
                if (hrRunning) {
                    void stopHeartRate(true, lastBpm
                        ? `Misurazione completata. Ultimo valore: ${lastBpm} bpm.`
                        : 'Nessun battito valido ricevuto. Riprova tenendo l’anello ben aderente al dito.');
                }
            }, 100000);
        } catch (error) {
            localStopHeartRateUi();
            setRingStatus(`Errore durante la misurazione: ${error.message || error}`, 'error');
        }
    }

    function handleDisconnected() {
        localStopHeartRateUi();
        writeCharacteristic = null;
        notifyCharacteristic = null;
        gattServer = null;
        setConnectedUi(false);
        if (el('ringBattery')) el('ringBattery').textContent = '--';
        setRingStatus('Anello disconnesso.', 'warning');
    }

    window.ringConnect = async function ringConnect() {
        if (!navigator.bluetooth) {
            setRingStatus('Web Bluetooth non è disponibile in questo browser. Su Android apri l’app con Chrome/Chromium e usa una pagina HTTPS.', 'error');
            return;
        }

        try {
            setRingStatus('Seleziona R09_D502 dall’elenco Bluetooth…', 'info');
            ringDevice = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'R09' },
                    { namePrefix: 'R12' },
                    { namePrefix: 'R10' },
                    { namePrefix: 'R02' }
                ],
                optionalServices: [SERVICE_UUID]
            });

            ringDevice.addEventListener('gattserverdisconnected', handleDisconnected);
            gattServer = await ringDevice.gatt.connect();
            const service = await gattServer.getPrimaryService(SERVICE_UUID);
            writeCharacteristic = await service.getCharacteristic(WRITE_CHAR_UUID);
            notifyCharacteristic = await service.getCharacteristic(NOTIFY_CHAR_UUID);
            await notifyCharacteristic.startNotifications();
            notifyCharacteristic.addEventListener('characteristicvaluechanged', onNotification);

            if (el('ringName')) el('ringName').textContent = ringDevice.name || 'COLMI R09';
            setConnectedUi(true);
            setRingStatus('COLMI collegato. Lettura batteria in corso…', 'success');
            await window.ringReadBattery();
        } catch (error) {
            if (error?.name === 'NotFoundError') {
                setRingStatus('Nessun anello selezionato.', 'warning');
            } else {
                setRingStatus(`Connessione non riuscita: ${error.message || error}. Chiudi QRing se è collegata all’anello e riprova.`, 'error');
            }
            setConnectedUi(false);
        }
    };

    window.ringReadBattery = async function ringReadBattery() {
        if (!ringDevice?.gatt?.connected) {
            setRingStatus('Collega prima l’anello.', 'warning');
            return;
        }
        try {
            setRingStatus('Lettura batteria…', 'info');
            await writePacket(makePacket(CMD_BATTERY));
        } catch (error) {
            setRingStatus(`Impossibile leggere la batteria: ${error.message || error}`, 'error');
        }
    };

    window.ringToggleHeartRate = async function ringToggleHeartRate() {
        await startHeartRate();
    };

    window.ringDisconnect = async function ringDisconnect() {
        try { await stopHeartRate(true); } catch (_) {}
        if (notifyCharacteristic) {
            try { notifyCharacteristic.removeEventListener('characteristicvaluechanged', onNotification); } catch (_) {}
            try { await notifyCharacteristic.stopNotifications(); } catch (_) {}
        }
        if (ringDevice?.gatt?.connected) ringDevice.gatt.disconnect();
        handleDisconnected();
    };

    window.addEventListener('load', () => {
        setConnectedUi(false);
        if (!navigator.bluetooth) {
            setRingStatus('Bluetooth diretto non disponibile qui. Per collegare il COLMI usa Chrome/Chromium su Android tramite HTTPS.', 'warning');
        } else {
            setRingStatus('Pronto. Chiudi QRing, poi premi “Cerca e collega anello”.', 'info');
        }
    });
})();
