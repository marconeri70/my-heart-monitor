/*
 * COLMI R09 / QRing BLE integration for Heart Monitor Ultra.
 * Direct Web Bluetooth connection: no QRing cloud is required for these reads.
 * Protocol references: Nordic UART-like service used by COLMI R0x family.
 * This module currently implements connection, battery and live heart-rate.
 */
(function () {
    'use strict';

    const SERVICE_UUID = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
    const WRITE_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
    const NOTIFY_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

    const CMD_BATTERY = 0x03;
    const CMD_REALTIME_COMPUTED_HR = 0x1e;
    const CMD_MANUAL_MEASUREMENT = 0x69;
    const CMD_STOP_MEASUREMENT = 0x6a;
    const HR_SUBTYPE = 0x01;

    let ringDevice = null;
    let gattServer = null;
    let writeCharacteristic = null;
    let notifyCharacteristic = null;
    let hrPollTimer = null;
    let hrKeepAliveTimer = null;
    let hrAutoStopTimer = null;
    let hrRunning = false;

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
        if (el('ringBpm')) el('ringBpm').textContent = `${bpm} bpm`;
        if (el('ringLastUpdate')) el('ringLastUpdate').textContent = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // Porta automaticamente il valore nel campo BPM già presente nell'app.
        const bpmInput = el('bpm');
        if (bpmInput) bpmInput.value = bpm;

        setRingStatus(`Battito rilevato: ${bpm} bpm${source ? ` · ${source}` : ''}. Il valore è stato copiato nella misurazione.`, 'success');
    }

    function onNotification(event) {
        const view = event.target.value;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (!bytes.length) return;

        const command = bytes[0];

        if (command === CMD_BATTERY && bytes.length >= 3) {
            updateBattery(bytes[1], bytes[2] === 1);
            return;
        }

        // R09: risposta alla misura manuale (0x69). byte[1]=tipo, byte[2]=errore, byte[3]=valore.
        if (command === CMD_MANUAL_MEASUREMENT && bytes.length >= 4 && bytes[1] === HR_SUBTYPE) {
            const errorCode = bytes[2];
            if (errorCode === 0) {
                updateHeartRate(bytes[3], 'R09');
            } else if (errorCode === 1) {
                setRingStatus('Misurazione non riuscita. Tieni l’anello aderente al dito e riprova.', 'error');
            } else if (errorCode === 2) {
                setRingStatus('Il sensore non ha ancora dati sufficienti. Attendi qualche secondo.', 'warning');
            }
            return;
        }

        // Alcuni firmware espongono anche il BPM già calcolato con il comando 0x1E.
        if (command === CMD_REALTIME_COMPUTED_HR && bytes.length >= 2) {
            updateHeartRate(bytes[1], 'sensore');
        }
    }

    function localStopHeartRateUi(message) {
        if (hrPollTimer) clearInterval(hrPollTimer);
        if (hrKeepAliveTimer) clearInterval(hrKeepAliveTimer);
        if (hrAutoStopTimer) clearTimeout(hrAutoStopTimer);
        hrPollTimer = null;
        hrKeepAliveTimer = null;
        hrAutoStopTimer = null;
        hrRunning = false;
        const btn = el('ringHrBtn');
        if (btn) btn.textContent = '❤️ Avvia battito';
        if (message) setRingStatus(message, 'info');
    }

    async function stopHeartRate(sendStop = true) {
        if (!hrRunning) return;
        localStopHeartRateUi();
        if (sendStop && ringDevice?.gatt?.connected) {
            try { await writePacket(makePacket(CMD_STOP_MEASUREMENT, [HR_SUBTYPE, 0, 0])); } catch (_) {}
        }
        setRingStatus('Misurazione del battito terminata.', 'info');
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
        const btn = el('ringHrBtn');
        if (btn) btn.textContent = '⏹️ Ferma battito';
        setRingStatus('Misurazione in corso… tieni il dito fermo. Il primo valore può richiedere 10–30 secondi.', 'info');

        try {
            // Avvia la misura manuale HR: 0x69, tipo 0x01, azione START 0x01.
            await writePacket(makePacket(CMD_MANUAL_MEASUREMENT, [HR_SUBTYPE, 0x01]));

            // Poll del valore computato, utile su alcune revisioni firmware.
            const poll = async () => {
                if (!hrRunning || !ringDevice?.gatt?.connected) return;
                try { await writePacket(makePacket(CMD_REALTIME_COMPUTED_HR, [0x03])); } catch (_) {}
            };
            await poll();
            hrPollTimer = setInterval(poll, 2000);

            // Mantiene viva la sessione di misura senza riavviare il sensore.
            hrKeepAliveTimer = setInterval(async () => {
                if (!hrRunning || !ringDevice?.gatt?.connected) return;
                try { await writePacket(makePacket(CMD_MANUAL_MEASUREMENT, [HR_SUBTYPE, 0x03])); } catch (_) {}
            }, 10000);

            // Evita di tenere il sensore acceso indefinitamente.
            hrAutoStopTimer = setTimeout(() => { void stopHeartRate(true); }, 60000);
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
