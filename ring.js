/*
 * Heart Monitor Ultra — COLMI R09 all-in-one integration (v9)
 * Web Bluetooth, direct local connection. No QRing cloud required.
 *
 * Implemented in this build:
 * - battery + device information
 * - spot heart rate
 * - SpO2 live + stored history fallback
 * - temperature / stress / HRV from the ring history when available
 * - detailed daily activity (steps, calories, distance)
 * - sleep summary through the COLMI big-data service
 * - experimental raw accelerometer / simple gesture hints
 * - one-button "Sync all" workflow
 *
 * Health values from the ring are wellness data, not medical measurements.
 */
(function () {
    'use strict';

    const PRIMARY_SERVICE_UUID = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
    const PRIMARY_WRITE_UUID   = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
    const PRIMARY_NOTIFY_UUID  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

    const BIG_SERVICE_UUID = 'de5bf728-d711-4e47-af26-65e3012a5dc7';
    const BIG_WRITE_UUID   = 'de5bf72a-d711-4e47-af26-65e3012a5dc7';
    const BIG_NOTIFY_UUID  = 'de5bf729-d711-4e47-af26-65e3012a5dc7';

    const DEVICE_INFO_SERVICE = 'device_information';
    const FW_REV_UUID = 'firmware_revision_string';
    const HW_REV_UUID = 'hardware_revision_string';

    const CMD_BATTERY = 0x03;
    const CMD_STEPS = 0x43;
    const CMD_REALTIME_HR_NOTIFY = 0x1e;
    const CMD_MANUAL_MEASUREMENT = 0x69;
    const CMD_STOP_MEASUREMENT = 0x6a;
    const CMD_BIG_DATA = 0xbc;
    const CMD_RAW = 0xa1;
    const BIG_DATA_SLEEP = 0x27;
    const BIG_DATA_SPO2 = 0x2a;
    const CMD_STRESS_HISTORY = 0x37;
    const CMD_HRV_HISTORY = 0x39;

    const SENSOR = {
        hr:          { subtype: 0x01, label: 'Battito', unit: 'bpm', target: 'ringBpm', timeout: 65000, fallback: 33000 },
        spo2:        { subtype: 0x03, label: 'SpO₂', unit: '%', target: 'ringSpo2', timeout: 65000, fallback: 33000 },
        stress:      { subtype: 0x04, label: 'Stress', unit: '', target: 'ringStress', timeout: 45000, fallback: 22000, experimental: true },
        hrv:         { subtype: 0x0a, label: 'HRV', unit: 'ms', target: 'ringHrv', timeout: 55000, fallback: 28000, experimental: true },
        temperature: { subtype: 0x0b, label: 'Temperatura', unit: '°C', target: 'ringTemp', timeout: 45000, fallback: 22000, experimental: true }
    };

    let ringDevice = null;
    let gattServer = null;
    let primaryWrite = null;
    let primaryNotify = null;
    let bigWrite = null;
    let bigNotify = null;

    let batteryWaiter = null;
    let stepsState = null;
    let bigState = null;
    let historyState = null;
    let measureState = null;
    let syncAllRunning = false;
    let gestureMode = false;
    let lastAccel = null;
    let lastGestureAt = 0;
    let gestureProfiles = [];
    let gestureTraining = null;
    let gestureLiveCapture = null;
    let gestureSampleCount = 0;
    let gestureConfidenceThreshold = 65;
    let gestureAutoStart = false;
    let gestureVibrate = true;
    let gestureInputMode = 'accel';
    let gestureActiveMode = null;
    let nativeGestureTraining = null;
    let gestureActionBusy = false;
    let gestureAudioCtx = null;
    let lastRawNotificationAt = 0;
    const GESTURE_PROFILES_KEY = 'heart_ring_gesture_profiles_v5';
    const GESTURE_SETTINGS_KEY = 'heart_ring_gesture_settings_v5';

    const metrics = {
        battery: null,
        charging: false,
        hr: null,
        spo2: null,
        temperature: null,
        stress: null,
        hrv: null,
        steps: null,
        calories: null,
        distance: null,
        sleep: null,
        deep: null,
        light: null,
        rem: null,
        awake: null,
        firmware: null,
        hardware: null,
        lastUpdate: null
    };

    function el(id) { return document.getElementById(id); }
    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    function setRingStatus(message, kind = 'info') {
        const node = el('ringStatus');
        if (!node) return;
        node.textContent = message;
        node.className = `ring-status ${kind}`;
    }

    function setProgress(value, text = '') {
        const bar = el('ringProgressBar');
        const label = el('ringProgressText');
        const wrap = el('ringProgress');
        if (wrap) wrap.style.display = value == null ? 'none' : 'block';
        if (bar && value != null) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
        if (label) label.textContent = text;
    }

    function metricText(id, value) {
        const node = el(id);
        if (node) node.textContent = value;
    }

    function markUpdated() {
        const now = new Date();
        metrics.lastUpdate = now.toISOString();
        metricText('ringLastUpdate', now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        try { localStorage.setItem('heart_ring_metrics_v4', JSON.stringify(metrics)); } catch (_) {}
    }

    function formatMinutes(total) {
        if (!Number.isFinite(total) || total <= 0) return '--';
        const h = Math.floor(total / 60);
        const m = Math.round(total % 60);
        return h ? `${h}h ${m}m` : `${m} min`;
    }

    function renderMetrics() {
        metricText('ringBattery', metrics.battery == null ? '--' : `${metrics.battery}%${metrics.charging ? ' ⚡' : ''}`);
        metricText('ringBpm', metrics.hr == null ? '--' : `${metrics.hr} bpm`);
        metricText('ringSpo2', metrics.spo2 == null ? '--' : `${metrics.spo2}%`);
        metricText('ringTemp', metrics.temperature == null ? '--' : `${metrics.temperature.toFixed(1)} °C`);
        metricText('ringStress', metrics.stress == null ? '--' : `${metrics.stress}`);
        metricText('ringHrv', metrics.hrv == null ? '--' : `${metrics.hrv} ms`);
        metricText('ringSteps', metrics.steps == null ? '--' : Number(metrics.steps).toLocaleString('it-IT'));
        metricText('ringCalories', metrics.calories == null ? '--' : `${metrics.calories < 10 ? metrics.calories.toFixed(1) : Math.round(metrics.calories)} kcal`);
        metricText('ringDistance', metrics.distance == null ? '--' : metrics.distance >= 1000 ? `${(metrics.distance / 1000).toFixed(2)} km` : `${Math.round(metrics.distance)} m`);
        metricText('ringSleep', metrics.sleep == null ? '--' : formatMinutes(metrics.sleep));
        metricText('ringSleepDeep', metrics.deep == null ? '--' : formatMinutes(metrics.deep));
        metricText('ringSleepLight', metrics.light == null ? '--' : formatMinutes(metrics.light));
        metricText('ringSleepRem', metrics.rem == null ? '--' : formatMinutes(metrics.rem));
        metricText('ringSleepAwake', metrics.awake == null ? '--' : formatMinutes(metrics.awake));
        if (metrics.lastUpdate) {
            const d = new Date(metrics.lastUpdate);
            if (!Number.isNaN(d.getTime())) metricText('ringLastUpdate', d.toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit', second:'2-digit'}));
        }
        if (metrics.firmware || metrics.hardware) {
            metricText('ringDeviceInfo', [metrics.hardware, metrics.firmware].filter(Boolean).join(' · '));
        }
    }

    function restoreMetrics() {
        try {
            const saved = JSON.parse(localStorage.getItem('heart_ring_metrics_v4') || localStorage.getItem('heart_ring_metrics_v3') || 'null');
            if (saved && typeof saved === 'object') Object.assign(metrics, saved);
        } catch (_) {}
        renderMetrics();
    }

    function setConnectedUi(connected) {
        const badge = el('ringConnectionBadge');
        if (badge) {
            badge.textContent = connected ? 'Connesso' : 'Non connesso';
            badge.classList.toggle('connected', connected);
        }
        if (el('ringConnectBtn')) el('ringConnectBtn').style.display = connected ? 'none' : 'block';
        if (el('ringDisconnectBtn')) el('ringDisconnectBtn').style.display = connected ? 'block' : 'none';
        document.querySelectorAll('[data-ring-action]').forEach(btn => { btn.disabled = !connected; });
    }

    function setBusyUi(busy) {
        const btn = el('ringSyncAllBtn');
        if (btn) {
            btn.disabled = busy || !ringDevice?.gatt?.connected;
            btn.textContent = busy ? '⏳ Sincronizzazione in corso…' : '✨ Sincronizza tutto';
        }
        document.querySelectorAll('[data-ring-measure]').forEach(btn => { btn.disabled = busy || !ringDevice?.gatt?.connected; });
    }

    function makePacket(command, payload = []) {
        const packet = new Uint8Array(16);
        packet[0] = command & 0xff;
        Array.from(payload).slice(0, 14).forEach((value, i) => { packet[i + 1] = value & 0xff; });
        let sum = 0;
        for (let i = 0; i < 15; i++) sum = (sum + packet[i]) & 0xff;
        packet[15] = sum;
        return packet;
    }

    function validChecksum(bytes) {
        if (bytes.length !== 16) return true;
        let sum = 0;
        for (let i = 0; i < 15; i++) sum = (sum + bytes[i]) & 0xff;
        return sum === bytes[15];
    }

    async function writePrimary(packet) {
        if (!primaryWrite || !ringDevice?.gatt?.connected) throw new Error('Anello non connesso');
        if (typeof primaryWrite.writeValueWithoutResponse === 'function') await primaryWrite.writeValueWithoutResponse(packet);
        else await primaryWrite.writeValue(packet);
    }

    async function writeBig(packet) {
        if (!bigWrite || !ringDevice?.gatt?.connected) throw new Error('Canale sonno non disponibile');
        if (typeof bigWrite.writeValueWithoutResponse === 'function') await bigWrite.writeValueWithoutResponse(packet);
        else await bigWrite.writeValue(packet);
    }

    function bcdToDecimal(b) { return (((b >> 4) & 15) * 10) + (b & 15); }
    function u16le(a, b) { return (a | (b << 8)) >>> 0; }
    function u24be(a, b, c) { return (((a << 16) | (b << 8) | c) >>> 0); }

    function updateBattery(level, charging) {
        if (!Number.isFinite(level) || level < 0 || level > 100) return;
        metrics.battery = level;
        metrics.charging = !!charging;
        renderMetrics();
        markUpdated();
        if (batteryWaiter) {
            clearTimeout(batteryWaiter.timer);
            batteryWaiter.resolve({ level, charging: !!charging });
            batteryWaiter = null;
        }
    }

    function transformSensorValue(key, raw) {
        if (!Number.isFinite(raw) || raw <= 0) return null;
        switch (key) {
            case 'hr': return raw >= 30 && raw <= 220 ? raw : null;
            case 'spo2': return raw >= 70 && raw <= 100 ? raw : null;
            case 'temperature': {
                const t = raw >= 11 ? (raw / 10 + 20) : null;
                return t && t >= 25 && t <= 45 ? Math.round(t * 10) / 10 : null;
            }
            case 'stress': {
                const v = raw >> 1;
                return v >= 1 && v <= 100 ? v : null;
            }
            case 'hrv': return raw >= 1 && raw <= 250 ? raw : null;
            default: return raw;
        }
    }

    function sensorDisplay(key, value) {
        const cfg = SENSOR[key];
        if (!cfg) return;
        if (value == null) metricText(cfg.target, '--');
        else if (key === 'temperature') metricText(cfg.target, `${Number(value).toFixed(1)} °C`);
        else metricText(cfg.target, `${value}${cfg.unit ? ' ' + cfg.unit : ''}`);
    }

    function storeSensor(key, value) {
        if (value == null) return;
        metrics[key] = value;
        sensorDisplay(key, value);
        if (key === 'hr') {
            const bpmInput = el('bpm');
            if (bpmInput) bpmInput.value = value;
        }
        markUpdated();
    }

    async function stopCurrentMeasurement(sendStop = true) {
        const state = measureState;
        if (!state) return;
        measureState = null;
        clearTimeout(state.fallbackTimer);
        clearTimeout(state.timeoutTimer);
        clearTimeout(state.settleTimer);
        if (sendStop && ringDevice?.gatt?.connected) {
            try { await writePrimary(makePacket(CMD_STOP_MEASUREMENT, [state.cfg.subtype, state.lastRaw || 0, 0])); } catch (_) {}
        }
    }

    function finishMeasurement(value, error = null) {
        const state = measureState;
        if (!state) return;
        measureState = null;
        clearTimeout(state.fallbackTimer);
        clearTimeout(state.timeoutTimer);
        clearTimeout(state.settleTimer);
        if (ringDevice?.gatt?.connected) {
            void writePrimary(makePacket(CMD_STOP_MEASUREMENT, [state.cfg.subtype, state.lastRaw || 0, 0])).catch(() => {});
        }
        if (value != null) storeSensor(state.key, value);
        if (error) state.reject(error);
        else state.resolve(value);
    }

    function median(values) {
        if (!values.length) return null;
        const a = [...values].sort((x, y) => x - y);
        const m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    async function measureSensor(key, quiet = false) {
        const cfg = SENSOR[key];
        if (!cfg) throw new Error('Sensore non supportato');
        if (!ringDevice?.gatt?.connected) throw new Error('Anello non connesso');
        if (gestureMode) await stopGestures(true);
        if (measureState) await stopCurrentMeasurement(true);

        sensorDisplay(key, null);
        if (!quiet) setRingStatus(`Misurazione ${cfg.label}… resta fermo e tieni l’anello aderente.`, 'info');

        return new Promise(async (resolve, reject) => {
            const state = {
                key, cfg, resolve, reject,
                samples: [], lastRaw: 0, fallbackUsed: false,
                fallbackTimer: null, timeoutTimer: null, settleTimer: null
            };
            measureState = state;

            try {
                // Simple QRing request first: 69 <type> 00. The R09 HR path was hardware-verified in this app.
                await writePrimary(makePacket(CMD_MANUAL_MEASUREMENT, [cfg.subtype, 0x00]));
            } catch (e) {
                measureState = null;
                reject(e);
                return;
            }

            state.fallbackTimer = setTimeout(async () => {
                if (measureState !== state || state.samples.length) return;
                state.fallbackUsed = true;
                try {
                    await writePrimary(makePacket(CMD_STOP_MEASUREMENT, [cfg.subtype, 0, 0]));
                    await delay(900);
                    await writePrimary(makePacket(CMD_MANUAL_MEASUREMENT, [cfg.subtype, 0x01]));
                } catch (_) {}
            }, cfg.fallback);

            state.timeoutTimer = setTimeout(() => {
                if (measureState !== state) return;
                finishMeasurement(null);
            }, cfg.timeout);
        });
    }

    function onMeasurementPacket(bytes) {
        const state = measureState;
        if (!state || bytes.length < 4 || bytes[1] !== state.cfg.subtype) return;
        const errorCode = bytes[2];
        const raw = bytes[3];
        state.lastRaw = raw;

        if (errorCode !== 0) {
            if (!syncAllRunning && errorCode === 1) setRingStatus('Il sensore non rileva bene il dito. Sistema l’anello e resta fermo.', 'warning');
            return;
        }

        const value = transformSensorValue(state.key, raw);
        if (value == null) return;
        state.samples.push(value);

        // HR/SpO2: collect a few samples so one transient packet does not become the final reading.
        const targetSamples = (state.key === 'hr' || state.key === 'spo2') ? 3 : 1;
        if (state.samples.length >= targetSamples) {
            const finalValue = (state.key === 'hr' || state.key === 'spo2') ? Math.round(median(state.samples)) : state.samples[state.samples.length - 1];
            finishMeasurement(finalValue);
            return;
        }

        if (!state.settleTimer && (state.key === 'hr' || state.key === 'spo2')) {
            state.settleTimer = setTimeout(() => {
                if (measureState !== state || !state.samples.length) return;
                finishMeasurement(Math.round(median(state.samples)));
            }, 5500);
        }
    }

    function resetStepsState() {
        if (stepsState?.timer) clearTimeout(stepsState.timer);
        stepsState = null;
    }

    function onStepsPacket(bytes) {
        const s = stepsState;
        if (!s) return;

        if (s.index === 0 && bytes[1] === 0xff) {
            clearTimeout(s.timer);
            stepsState = null;
            metrics.steps = 0; metrics.calories = 0; metrics.distance = 0;
            renderMetrics(); markUpdated();
            s.resolve({ steps: 0, calories: 0, distance: 0, slots: [] });
            return;
        }

        if (s.index === 0 && bytes[1] === 0xf0) {
            s.newCalorieProtocol = bytes[3] === 1;
            s.index++;
            return;
        }

        const year = bcdToDecimal(bytes[1]) + 2000;
        const month = bcdToDecimal(bytes[2]);
        const day = bcdToDecimal(bytes[3]);
        const timeIndex = bytes[4];
        let calories = u16le(bytes[7], bytes[8]);
        if (s.newCalorieProtocol) calories *= 10;
        const steps = u16le(bytes[9], bytes[10]);
        const distance = u16le(bytes[11], bytes[12]);
        s.details.push({ year, month, day, timeIndex, calories, steps, distance });

        if (bytes[5] === ((bytes[6] - 1) & 0xff)) {
            clearTimeout(s.timer);
            stepsState = null;
            const totals = s.details.reduce((acc, d) => {
                acc.steps += d.steps; acc.calories += d.calories; acc.distance += d.distance; return acc;
            }, { steps: 0, calories: 0, distance: 0 });
            // New calorie protocol: parser multiplies the raw value by 10, while QRing/RingCLI
            // displays the resulting total divided by 1000 (kcal). Example: 2220 -> 2.22 kcal.
            if (s.newCalorieProtocol) totals.calories = totals.calories / 1000;
            metrics.steps = totals.steps;
            metrics.calories = totals.calories;
            metrics.distance = totals.distance;
            renderMetrics(); markUpdated();
            s.resolve({ ...totals, slots: s.details });
        } else {
            s.index++;
        }
    }

    function requestSteps() {
        if (!ringDevice?.gatt?.connected) return Promise.reject(new Error('Anello non connesso'));
        resetStepsState();
        return new Promise(async (resolve, reject) => {
            const state = { index: 0, newCalorieProtocol: false, details: [], resolve, reject, timer: null };
            stepsState = state;
            state.timer = setTimeout(() => {
                if (stepsState === state) stepsState = null;
                reject(new Error('Timeout attività'));
            }, 8000);
            try {
                await writePrimary(makePacket(CMD_STEPS, [0x00, 0x0f, 0x00, 0x5f, 0x01]));
            } catch (e) {
                clearTimeout(state.timer); stepsState = null; reject(e);
            }
        });
    }

    function concatChunks(chunks, total) {
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    }

    function readU16LE(arr, offset) {
        return (arr[offset] | (arr[offset + 1] << 8)) >>> 0;
    }

    function bigDataCommand(dataType) {
        // IMPORTANT: the V2 characteristic does NOT use the 16-byte UART framing.
        // QRing-compatible request: BC <type> 01 00 FF 00 FF (7 raw bytes).
        return new Uint8Array([CMD_BIG_DATA, dataType & 0xff, 0x01, 0x00, 0xff, 0x00, 0xff]);
    }

    function finishBigState(data = null, error = null) {
        const s = bigState;
        if (!s) return;
        bigState = null;
        clearTimeout(s.timer);
        if (error) s.reject(error); else s.resolve(data);
    }

    function onBigNotification(event) {
        const view = event.target.value;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const s = bigState;
        if (!s || !bytes.length) return;
        s.chunks.push(new Uint8Array(bytes));
        s.total += bytes.length;
        if (!Number.isFinite(s.expected) && s.total >= 4) {
            const all = concatChunks(s.chunks, s.total);
            s.expected = readU16LE(all, 2) + 6;
        }
        if (Number.isFinite(s.expected) && s.total >= s.expected) {
            const all = concatChunks(s.chunks, s.total).slice(0, s.expected);
            finishBigState(all);
        }
    }

    function requestBigData(dataType, timeout = 7000) {
        if (!bigWrite || !bigNotify) return Promise.reject(new Error('Canale dati avanzati non disponibile'));
        if (bigState) finishBigState(null, new Error('Nuova richiesta dati avanzati'));
        return new Promise(async (resolve, reject) => {
            const state = { dataType, chunks: [], total: 0, expected: Infinity, resolve, reject, timer: null };
            bigState = state;
            state.timer = setTimeout(() => {
                if (bigState === state) finishBigState(null, new Error(`Timeout dati 0x${dataType.toString(16)}`));
            }, timeout);
            try {
                await writeBig(bigDataCommand(dataType));
            } catch (e) {
                if (bigState === state) finishBigState(null, e);
            }
        });
    }

    function parseSleepResponse(data) {
        if (!data || data.length < 7 || data[0] !== CMD_BIG_DATA || data[1] !== BIG_DATA_SLEEP) return null;
        const packetLength = readU16LE(data, 2);
        if (packetLength < 2 || data[6] === 0) return { totalMinutes: 0, deep: 0, light: 0, rem: 0, awake: 0 };
        const daysInPacket = data[6];
        let idx = 7;
        const sessions = [];

        for (let d = 0; d < daysInPacket; d++) {
            if (idx + 6 > data.length) break;
            const daysAgo = data[idx++];
            const dayBytes = data[idx++];
            const sleepStart = readU16LE(data, idx); idx += 2;
            const sleepEnd = readU16LE(data, idx); idx += 2;
            const numStages = Math.max(0, Math.floor((dayBytes - 4) / 2));
            const periods = [];
            for (let j = 0; j < numStages && idx + 1 < data.length; j++) {
                const type = data[idx++];
                const minutes = data[idx++];
                if (minutes > 0 && [2,3,4,5].includes(type)) periods.push({ type, minutes });
            }
            const sum = type => periods.filter(x => x.type === type).reduce((a, x) => a + x.minutes, 0);
            sessions.push({
                daysAgo, sleepStart, sleepEnd, periods,
                totalMinutes: periods.reduce((a, x) => a + x.minutes, 0),
                light: sum(2), deep: sum(3), rem: sum(4), awake: sum(5)
            });
        }
        return sessions.find(x => x.daysAgo === 0) || sessions.sort((a,b) => a.daysAgo - b.daysAgo)[0] ||
            { totalMinutes: 0, deep: 0, light: 0, rem: 0, awake: 0 };
    }

    async function requestSleep() {
        const data = await requestBigData(BIG_DATA_SLEEP, 10000);
        const result = parseSleepResponse(data);
        if (!result) throw new Error('Formato sonno non riconosciuto');
        metrics.sleep = result.totalMinutes || null;
        metrics.deep = result.deep || null;
        metrics.light = result.light || null;
        metrics.rem = result.rem || null;
        metrics.awake = result.awake || null;
        renderMetrics(); markUpdated();
        return result;
    }

    function parseSpo2History(data) {
        if (!data || data.length < 7 || data[0] !== CMD_BIG_DATA || data[1] !== BIG_DATA_SPO2) return [];
        const length = readU16LE(data, 2);
        const end = Math.min(data.length, 6 + length);
        const rows = [];
        let idx = 6;
        while (idx + 49 <= end) {
            const daysAgo = data[idx++];
            for (let hour = 0; hour < 24; hour++) {
                const min = data[idx++];
                const max = data[idx++];
                if (min > 0 && max > 0) rows.push({ daysAgo, hour, value: Math.round((min + max) / 2) });
            }
        }
        return rows;
    }

    async function requestSpo2HistoryLatest() {
        const data = await requestBigData(BIG_DATA_SPO2, 9000);
        const rows = parseSpo2History(data).filter(x => x.value >= 70 && x.value <= 100);
        if (!rows.length) return null;
        rows.sort((a,b) => (a.daysAgo - b.daysAgo) || (b.hour - a.hour));
        const value = rows[0].value;
        storeSensor('spo2', value);
        return value;
    }

    function parseTemperatureHistory(data) {
        if (!data || data.length < 7 || data[0] !== CMD_BIG_DATA || data[1] !== 0x25) return [];
        const length = readU16LE(data, 2);
        const end = Math.min(data.length, 6 + length);
        const rows = [];
        let idx = 6;
        while (idx + 50 <= end) {
            const daysAgo = data[idx++];
            idx += 1; // observed 0x1e separator
            for (let hour = 0; hour < 24; hour++) {
                const t00 = data[idx++];
                const t30 = data[idx++];
                if (t00 > 0) rows.push({ daysAgo, slot: hour * 2, value: Math.round(((t00 / 10) + 20) * 10) / 10 });
                if (t30 > 0) rows.push({ daysAgo, slot: hour * 2 + 1, value: Math.round(((t30 / 10) + 20) * 10) / 10 });
            }
        }
        return rows.filter(x => x.value >= 25 && x.value <= 45);
    }

    async function requestTemperatureHistoryLatest() {
        const all = [];
        // R09 rotates completed-day temperature blocks across these request IDs.
        for (let type = 0x22; type <= 0x2c; type++) {
            if (type === BIG_DATA_SPO2) continue;
            try {
                const data = await requestBigData(type, 2200);
                all.push(...parseTemperatureHistory(data));
            } catch (_) {}
        }
        if (!all.length) return null;
        all.sort((a,b) => (a.daysAgo - b.daysAgo) || (b.slot - a.slot));
        const value = all[0].value;
        storeSensor('temperature', value);
        return value;
    }

    function finishHistoryState(packets = null, error = null) {
        const s = historyState;
        if (!s) return;
        historyState = null;
        clearTimeout(s.timer);
        clearTimeout(s.idleTimer);
        if (error) s.reject(error); else s.resolve(packets || s.packets);
    }

    function consumeHistoryPacket(bytes) {
        const s = historyState;
        if (!s || !bytes.length) return false;
        const base = bytes[0] & 0x7f;
        if (base !== s.command) return false;
        if ((bytes[0] & 0x80) !== 0) {
            finishHistoryState(null, new Error(`Comando storico 0x${s.command.toString(16)} rifiutato`));
            return true;
        }
        s.packets.push(new Uint8Array(bytes));
        clearTimeout(s.idleTimer);
        const subtype = bytes[1];
        if (subtype === 4 || subtype === 0xff) {
            finishHistoryState(s.packets);
            return true;
        }
        s.idleTimer = setTimeout(() => {
            if (historyState === s && s.packets.length) finishHistoryState(s.packets);
        }, 900);
        return true;
    }

    function requestHistoryPackets(command, payload = [], timeout = 7000) {
        if (!ringDevice?.gatt?.connected) return Promise.reject(new Error('Anello non connesso'));
        if (historyState) finishHistoryState(null, new Error('Nuova richiesta storica'));
        return new Promise(async (resolve, reject) => {
            const state = { command, packets: [], resolve, reject, timer: null, idleTimer: null };
            historyState = state;
            state.timer = setTimeout(() => {
                if (historyState !== state) return;
                if (state.packets.length) finishHistoryState(state.packets);
                else finishHistoryState(null, new Error(`Timeout storico 0x${command.toString(16)}`));
            }, timeout);
            try { await writePrimary(makePacket(command, payload)); }
            catch (e) { if (historyState === state) finishHistoryState(null, e); }
        });
    }

    function parseLatestHalfHourValue(packets, max = 255) {
        const values = [];
        for (const pkt of packets || []) {
            const subtype = pkt[1];
            if (subtype === 0 || subtype === 0xff) continue;
            const start = subtype === 1 ? 3 : 2;
            for (let i = start; i < Math.min(15, pkt.length - 1); i++) {
                const v = pkt[i] & 0xff;
                if (v > 0 && v <= max) values.push(v);
            }
        }
        return values.length ? values[values.length - 1] : null;
    }

    async function requestStressHistoryLatest() {
        const packets = await requestHistoryPackets(CMD_STRESS_HISTORY, []);
        const value = parseLatestHalfHourValue(packets, 99);
        if (value != null) storeSensor('stress', value);
        return value;
    }

    async function requestHrvHistoryLatest() {
        // daysAgo=0 as little-endian uint32; makePacket pads the remaining payload.
        const packets = await requestHistoryPackets(CMD_HRV_HISTORY, [0,0,0,0]);
        const value = parseLatestHalfHourValue(packets, 255);
        if (value != null) storeSensor('hrv', value);
        return value;
    }

    async function getMetricBestEffort(key) {
        if (key === 'hr') return measureSensor('hr', true);
        if (key === 'spo2') {
            try { const v = await requestSpo2HistoryLatest(); if (v != null) return v; } catch (_) {}
            return measureSensor('spo2', true);
        }
        if (key === 'stress') {
            try { const v = await requestStressHistoryLatest(); if (v != null) return v; } catch (_) {}
            return measureSensor('stress', true);
        }
        if (key === 'hrv') {
            try { const v = await requestHrvHistoryLatest(); if (v != null) return v; } catch (_) {}
            return measureSensor('hrv', true);
        }
        if (key === 'temperature') {
            try { const v = await requestTemperatureHistoryLatest(); if (v != null) return v; } catch (_) {}
            return measureSensor('temperature', true);
        }
        return null;
    }

    function gestureActionLabel(action) {
        return ({
            'sync-all': 'Sincronizza tutto',
            'measure-hr': 'Misura battito',
            'measure-spo2': 'Misura SpO₂',
            'scroll-up': 'Scorri su',
            'scroll-down': 'Scorri giù',
            'go-top': 'Vai in alto',
            'new-measurement': 'Vai a Nuova Misurazione',
            'ring-card': 'Vai allo Smart Ring',
            'vibrate': 'Vibra telefono',
            'tone': 'Segnale sonoro',
            'open-url': 'Apri link'
        })[action] || action;
    }

    function loadGestureSettings() {
        try {
            const parsed = JSON.parse(localStorage.getItem(GESTURE_PROFILES_KEY) || '[]');
            if (Array.isArray(parsed)) gestureProfiles = parsed.filter(g => g && g.id && Array.isArray(g.template));
        } catch (_) { gestureProfiles = []; }
        try {
            const settings = JSON.parse(localStorage.getItem(GESTURE_SETTINGS_KEY) || '{}');
            if (Number.isFinite(Number(settings.threshold))) gestureConfidenceThreshold = Math.max(45, Math.min(90, Number(settings.threshold)));
            gestureAutoStart = !!settings.autoStart;
            gestureVibrate = settings.vibrate !== false;
            if (settings.inputMode === 'native') gestureInputMode = 'accel';
            else if (settings.inputMode === 'accel' || settings.inputMode === 'motion') gestureInputMode = settings.inputMode;
        } catch (_) {}
        const threshold = el('ringGestureSensitivity');
        if (threshold) threshold.value = String(gestureConfidenceThreshold);
        const thresholdValue = el('ringGestureSensitivityValue');
        if (thresholdValue) thresholdValue.textContent = `${gestureConfidenceThreshold}%`;
        const auto = el('ringGestureAutoStart');
        if (auto) auto.checked = gestureAutoStart;
        const vib = el('ringGestureVibrate');
        if (vib) vib.checked = gestureVibrate;
        const mode = el('ringGestureMode');
        if (mode) mode.value = gestureInputMode;
        renderGestureProfiles();
    }

    function saveGestureSettings() {
        try { localStorage.setItem(GESTURE_PROFILES_KEY, JSON.stringify(gestureProfiles)); } catch (_) {}
        try {
            localStorage.setItem(GESTURE_SETTINGS_KEY, JSON.stringify({
                threshold: gestureConfidenceThreshold,
                autoStart: gestureAutoStart,
                vibrate: gestureVibrate,
                inputMode: gestureInputMode
            }));
        } catch (_) {}
        renderGestureProfiles();
    }

    const GESTURE_PRESET_NAMES = [
        'Scatto a destra', 'Scatto a sinistra', 'Movimento su', 'Movimento giù',
        'Rotazione oraria', 'Rotazione antioraria', 'Movimento avanti', 'Movimento indietro', 'Doppio movimento'
    ];

    function selectedGestureName() {
        const preset = el('ringGestureNamePreset')?.value || 'Scatto a destra';
        if (preset === '__custom__') return (el('ringGestureCustomName')?.value || '').trim() || `Gesto ${gestureProfiles.length + 1}`;
        return preset;
    }

    function setGestureNameUi(name) {
        const preset = el('ringGestureNamePreset');
        const custom = el('ringGestureCustomName');
        const wrap = el('ringGestureCustomNameWrap');
        if (!preset) return;
        if (GESTURE_PRESET_NAMES.includes(name)) {
            preset.value = name;
            if (custom) custom.value = '';
            if (wrap) wrap.style.display = 'none';
        } else {
            preset.value = '__custom__';
            if (custom) custom.value = name || '';
            if (wrap) wrap.style.display = 'block';
        }
    }

    function renderGestureProfiles() {
        const list = el('ringGestureProfiles');
        const count = el('ringGestureCount');
        if (count) count.textContent = String(gestureProfiles.filter(g => g.enabled !== false).length);
        if (!list) return;
        list.innerHTML = '';
        if (!gestureProfiles.length) {
            const empty = document.createElement('div');
            empty.className = 'gesture-empty';
            empty.textContent = 'Nessun gesto programmato. Scegli nome e azione, poi premi “Registra gesto”.';
            list.appendChild(empty);
            return;
        }
        const actionOptions = [
            ['sync-all','Sincronizza tutto'], ['measure-hr','Misura battito'], ['measure-spo2','Misura SpO₂'],
            ['scroll-up','Scorri su'], ['scroll-down','Scorri giù'], ['go-top','Vai in alto'],
            ['new-measurement','Nuova Misurazione'], ['ring-card','Smart Ring'], ['vibrate','Vibra telefono'],
            ['tone','Segnale sonoro'], ['open-url','Apri link']
        ];
        gestureProfiles.forEach(profile => {
            const row = document.createElement('div');
            row.className = 'gesture-profile-row';

            const top = document.createElement('div');
            top.className = 'gesture-profile-top';
            const label = document.createElement('div');
            label.className = 'gesture-profile-name';
            label.textContent = `${profile.name}${profile.mode === 'accel' ? ' · LED spenti' : ''}`;
            const enabled = document.createElement('input');
            enabled.type = 'checkbox'; enabled.checked = profile.enabled !== false;
            enabled.title = 'Abilita/disabilita gesto';
            enabled.addEventListener('change', () => {
                profile.enabled = enabled.checked;
                saveGestureSettings();
            });
            top.append(label, enabled);

            const controls = document.createElement('div');
            controls.className = 'gesture-profile-controls';
            const select = document.createElement('select');
            actionOptions.forEach(([value, text]) => {
                const o = document.createElement('option'); o.value = value; o.textContent = text;
                if (profile.action === value) o.selected = true;
                select.appendChild(o);
            });
            select.addEventListener('change', () => {
                profile.action = select.value;
                if (select.value === 'open-url' && !profile.url) {
                    const u = window.prompt('Inserisci il link da aprire (https://...)', 'https://');
                    if (u && /^https:\/\//i.test(u.trim())) profile.url = u.trim();
                    else if (!profile.url) profile.action = 'vibrate';
                }
                saveGestureSettings();
            });
            const retrain = document.createElement('button');
            retrain.type = 'button'; retrain.className = 'gesture-mini-btn'; retrain.textContent = '🎯 Riregistra';
            retrain.addEventListener('click', () => {
                const a = el('ringGestureAction'); const u = el('ringGestureUrl'); const mode = el('ringGestureMode');
                setGestureNameUi(profile.name);
                if (a) a.value = profile.action;
                if (u) u.value = profile.url || '';
                if (mode) mode.value = profile.mode === 'accel' ? 'accel' : 'motion';
                gestureInputMode = profile.mode === 'accel' ? 'accel' : 'motion';
                window.ringGestureActionChanged();
                window.ringRecordGesture(profile.id);
            });
            const del = document.createElement('button');
            del.type = 'button'; del.className = 'gesture-mini-btn danger'; del.textContent = '🗑';
            del.addEventListener('click', () => {
                gestureProfiles = gestureProfiles.filter(g => g.id !== profile.id);
                saveGestureSettings();
            });
            controls.append(select, retrain, del);
            row.append(top, controls);
            if (profile.action === 'open-url' && profile.url) {
                const small = document.createElement('div'); small.className='gesture-profile-url'; small.textContent = profile.url;
                row.appendChild(small);
            }
            list.appendChild(row);
        });
    }

    function resampleGesture(samples, points = 18) {
        if (!Array.isArray(samples) || samples.length < 5) return null;
        const clean = samples.filter(s => s && Number.isFinite(s.gX) && Number.isFinite(s.gY) && Number.isFinite(s.gZ));
        if (clean.length < 5) return null;
        const base = clean[0];
        const vectors = clean.map(s => [s.gX - base.gX, s.gY - base.gY, s.gZ - base.gZ]);
        let scale = 0;
        for (const v of vectors) scale = Math.max(scale, Math.hypot(v[0], v[1], v[2]));
        if (scale < 0.18) return null;
        const normalized = vectors.map(v => v.map(x => x / scale));
        const out = [];
        for (let p = 0; p < points; p++) {
            const pos = (p * (normalized.length - 1)) / (points - 1);
            const i = Math.floor(pos), f = pos - i;
            const a = normalized[i], b = normalized[Math.min(i + 1, normalized.length - 1)];
            out.push([
                a[0] + (b[0] - a[0]) * f,
                a[1] + (b[1] - a[1]) * f,
                a[2] + (b[2] - a[2]) * f
            ]);
        }
        return out;
    }

    function gestureDistance(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return Infinity;
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
            const dx = a[i][0] - b[i][0], dy = a[i][1] - b[i][1], dz = a[i][2] - b[i][2];
            sum += dx*dx + dy*dy + dz*dz;
        }
        return Math.sqrt(sum / (a.length * 3));
    }

    function beepGesture() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!gestureAudioCtx) gestureAudioCtx = new AudioCtx();
            const ctx = gestureAudioCtx;
            if (ctx.state === 'suspended') void ctx.resume();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 740; gain.gain.value = 0.04;
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + 0.10);
        } catch (_) {}
    }

    async function executeGestureAction(profile, confidence) {
        if (!profile || profile.enabled === false) return;
        metricText('ringGesture', `${profile.name} · ${confidence}%`);
        metricText('ringGestureLastAction', gestureActionLabel(profile.action));
        if (gestureVibrate && navigator.vibrate) navigator.vibrate(70);
        lastGestureAt = Date.now();
        const action = profile.action;
        if (action === 'scroll-up') { window.scrollBy({ top: -Math.max(350, innerHeight * 0.72), behavior: 'smooth' }); return; }
        if (action === 'scroll-down') { window.scrollBy({ top: Math.max(350, innerHeight * 0.72), behavior: 'smooth' }); return; }
        if (action === 'go-top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
        if (action === 'new-measurement') { el('sis')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
        if (action === 'ring-card') { el('ring-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        if (action === 'vibrate') { if (navigator.vibrate) navigator.vibrate([120, 70, 120]); return; }
        if (action === 'tone') { beepGesture(); return; }
        if (action === 'open-url') {
            if (profile.url && /^https:\/\//i.test(profile.url)) window.location.href = profile.url;
            else setRingStatus(`Il gesto “${profile.name}” non ha un link valido.`, 'warning');
            return;
        }
        if (gestureActionBusy) return;
        gestureActionBusy = true;
        try {
            if (action === 'sync-all' && typeof window.ringSyncAll === 'function') await window.ringSyncAll();
            else if (action === 'measure-hr' && typeof window.ringMeasureMetric === 'function') await window.ringMeasureMetric('hr');
            else if (action === 'measure-spo2' && typeof window.ringMeasureMetric === 'function') await window.ringMeasureMetric('spo2');
        } finally { gestureActionBusy = false; }
    }

    function finishLiveGestureCapture() {
        const capture = gestureLiveCapture;
        if (!capture) return;
        if (capture.timer) clearTimeout(capture.timer);
        gestureLiveCapture = null;
        const seq = resampleGesture(capture.samples);
        if (!seq || !gestureProfiles.length) return;
        let best = null;
        for (const profile of gestureProfiles) {
            if (profile.enabled === false || !Array.isArray(profile.template)) continue;
            const dist = gestureDistance(profile.template, seq);
            // Empirical score: identical trajectory ≈100; ~0.2 RMS difference ≈67.
            const confidence = Math.max(0, Math.min(100, Math.round(100 * Math.exp(-2.0 * dist))));
            if (!best || confidence > best.confidence) best = { profile, confidence, dist };
        }
        if (!best) return;
        metricText('ringGestureConfidence', `${best.confidence}%`);
        if (best.confidence >= gestureConfidenceThreshold) {
            lastGestureAt = Date.now();
            void executeGestureAction(best.profile, best.confidence);
        } else {
            metricText('ringGesture', `Non riconosciuto · ${best.confidence}%`);
        }
    }

    function maybeStartLiveGesture(acc, previous) {
        if (!gestureMode || gestureTraining || gestureLiveCapture || Date.now() - lastGestureAt < 1500) return;
        const enabledProfiles = gestureProfiles.filter(g => g.enabled !== false && Array.isArray(g.template));
        if (!enabledProfiles.length || !previous) return;
        const dx = acc.gX - previous.gX, dy = acc.gY - previous.gY, dz = acc.gZ - previous.gZ;
        const impulse = Math.hypot(dx, dy, dz);
        // Low enough to catch deliberate wrist/finger motion; template matching rejects most noise.
        if (impulse < 0.42) return;
        gestureLiveCapture = { samples: [previous, acc], startedAt: Date.now(), timer: null };
        metricText('ringGesture', 'Rilevamento…');
        gestureLiveCapture.timer = setTimeout(finishLiveGestureCapture, 1550);
    }

    async function recordGestureProfile(replaceId = null) {
        if (!ringDevice?.gatt?.connected) throw new Error('Collega prima l’anello');
        const name = selectedGestureName();
        const action = el('ringGestureAction')?.value || 'vibrate';
        let url = (el('ringGestureUrl')?.value || '').trim();
        if (action === 'open-url' && !/^https:\/\//i.test(url)) throw new Error('Per “Apri link” inserisci un indirizzo https:// valido');
        gestureInputMode = el('ringGestureMode')?.value === 'motion' ? 'motion' : 'accel';
        if (!gestureMode || gestureActiveMode !== gestureInputMode) {
            if (gestureMode) await stopGestures(true);
            await startGestures(true);
        }

        const btn = el('ringGestureRecordBtn');
        if (btn) btn.disabled = true;

        metricText('ringGestureTraining', 'Preparati…');
        setRingStatus(`Registrazione gesto “${name}”: preparati.`, 'info');
        gestureTraining = { samples: [], name, action, url, replaceId, countdown: true };
        try {
            for (const n of [3,2,1]) {
                metricText('ringGestureTraining', String(n));
                if (navigator.vibrate) navigator.vibrate(35);
                await delay(650);
            }
            gestureTraining = { samples: [], name, action, url, replaceId, countdown: false };
            gestureSampleCount = 0;
            metricText('ringGestureTraining', 'MUOVI ORA');
            metricText('ringGesture', 'Registrazione…');
            if (navigator.vibrate) navigator.vibrate(80);
            await delay(1900);
            const training = gestureTraining;
            gestureTraining = null;
            const template = resampleGesture(training.samples);
            if (!template) throw new Error('Movimento non rilevato abbastanza bene. Riprova con un gesto più deciso.');
            const id = replaceId || `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
            const profile = { id, name, action, url, mode: gestureInputMode, template, enabled: true, createdAt: new Date().toISOString() };
            const idx = gestureProfiles.findIndex(g => g.id === id);
            if (idx >= 0) gestureProfiles[idx] = profile; else gestureProfiles.push(profile);
            saveGestureSettings();
            metricText('ringGestureTraining', 'Salvato ✓');
            setRingStatus(`Gesto “${name}” registrato. Ora eseguilo di nuovo per provarlo.`, 'success');
            if (navigator.vibrate) navigator.vibrate([60,50,60]);
        } finally {
            gestureTraining = null;
            if (btn) btn.disabled = false;
            setTimeout(() => metricText('ringGestureTraining', 'Pronto'), 1800);
        }
    }

    function parseAccelerometer(bytes) {
        if (bytes.length < 8 || bytes[1] !== 3) return null;
        const int12 = v => v > 2047 ? v - 4096 : v;
        const rawY = int12((((bytes[2] << 4) | (bytes[3] & 0x0f)) & 0x0fff));
        const rawZ = int12((((bytes[4] << 4) | (bytes[5] & 0x0f)) & 0x0fff));
        const rawX = int12((((bytes[6] << 4) | (bytes[7] & 0x0f)) & 0x0fff));
        const toG = raw => (raw / 2048) * 4;
        const gX = toG(rawX), gY = toG(rawY), gZ = toG(rawZ);
        const rotateX = Math.atan2(gX, Math.sqrt(gY*gY + gZ*gZ)) * 180 / Math.PI;
        const rotateY = Math.atan2(gY, Math.sqrt(gX*gX + gZ*gZ)) * 180 / Math.PI;
        const rotateZ = Math.atan2(gZ, Math.sqrt(gX*gX + gY*gY)) * 180 / Math.PI;
        return { rawX, rawY, rawZ, gX, gY, gZ, rotateX, rotateY, rotateZ, timestamp: Date.now() };
    }

    function handleGesture(acc) {
        metricText('ringAccelX', acc.gX.toFixed(2));
        metricText('ringAccelY', acc.gY.toFixed(2));
        metricText('ringAccelZ', acc.gZ.toFixed(2));
        gestureSampleCount++;
        metricText('ringGestureSamples', String(gestureSampleCount));

        const previous = lastAccel;
        lastAccel = acc;

        if (gestureTraining) {
            gestureTraining.samples.push(acc);
            metricText('ringGestureSamples', String(gestureTraining.samples.length));
            return;
        }

        if (gestureLiveCapture) {
            gestureLiveCapture.samples.push(acc);
            return;
        }

        // Keep the quick diagnostic hints from v4 even with no programmed profiles.
        if (previous && Date.now() - lastGestureAt > 700) {
            const dx = acc.gX - previous.gX;
            const dy = acc.gY - previous.gY;
            const dz = acc.gZ - previous.gZ;
            const impulse = Math.sqrt(dx*dx + dy*dy + dz*dz);
            let hint = null;
            if (impulse > 3.0) hint = 'Movimento rapido';
            else if (dx > 1.8) hint = 'Scatto a destra';
            else if (dx < -1.8) hint = 'Scatto a sinistra';
            else if (dy > 1.8) hint = 'Scatto in alto';
            else if (dy < -1.8) hint = 'Scatto in basso';
            if (hint && !gestureProfiles.length) metricText('ringGesture', hint);
        }
        maybeStartLiveGesture(acc, previous);
    }

    function onPrimaryNotification(event) {
        const view = event.target.value;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (!bytes.length || !validChecksum(bytes)) return;
        const command = bytes[0];

        // 0xA1 has its high bit set but is a legitimate raw-data command, not an error frame.
        if (command === CMD_RAW) {
            lastRawNotificationAt = Date.now();
            const acc = parseAccelerometer(bytes);
            if (acc && gestureMode) handleGesture(acc);
            return;
        }

        // Stress/HRV history are multi-packet command-channel replies.
        if (consumeHistoryPacket(bytes)) return;

        if ((command & 0x80) !== 0) {
            // Do not interrupt an all-in-one sync for an unsupported experimental sensor.
            if (!syncAllRunning) setRingStatus(`Comando non accettato dal firmware (0x${command.toString(16)}).`, 'warning');
            return;
        }

        if (command === CMD_BATTERY && bytes.length >= 3) { updateBattery(bytes[1], bytes[2] === 1); return; }
        if (command === CMD_STEPS) { onStepsPacket(bytes); return; }
        if (command === CMD_MANUAL_MEASUREMENT) { onMeasurementPacket(bytes); return; }

        if (command === CMD_REALTIME_HR_NOTIFY && bytes.length >= 2 && !measureState) {
            let bpm = bytes[1];
            if (bytes.length >= 3 && bytes[1] === 1 && bytes[2] >= 30) bpm = bytes[2];
            if (bpm >= 30 && bpm <= 220) storeSensor('hr', bpm);
            return;
        }

        // Unsolicited live-activity notification seen on some firmware: 73 12 <steps u24be><cal u24be><dist u24be>
        if (command === 0x73 && bytes.length >= 11 && bytes[1] === 0x12) {
            const st = u24be(bytes[2], bytes[3], bytes[4]);
            const calRaw = u24be(bytes[5], bytes[6], bytes[7]);
            const dist = u24be(bytes[8], bytes[9], bytes[10]);
            if (st >= 0) metrics.steps = st;
            metrics.calories = calRaw / 1000;
            metrics.distance = dist;
            renderMetrics(); markUpdated();
        }
    }

    function readBatteryAsync() {
        if (!ringDevice?.gatt?.connected) return Promise.reject(new Error('Anello non connesso'));
        if (batteryWaiter) {
            clearTimeout(batteryWaiter.timer);
            batteryWaiter.reject(new Error('Nuova lettura batteria'));
            batteryWaiter = null;
        }
        return new Promise(async (resolve, reject) => {
            batteryWaiter = {
                resolve, reject,
                timer: setTimeout(() => { batteryWaiter = null; reject(new Error('Timeout batteria')); }, 5000)
            };
            try { await writePrimary(makePacket(CMD_BATTERY)); }
            catch (e) { clearTimeout(batteryWaiter.timer); batteryWaiter = null; reject(e); }
        });
    }

    function nativeKeySignature(event) {
        return `${event.code || ''}|${event.key || ''}`;
    }

    async function handleNativeGestureKey(event) {
        if (!gestureMode || gestureActiveMode !== 'native' || event.repeat) return;
        const sig = nativeKeySignature(event);
        if (!sig || sig === '|') return;
        gestureSampleCount++;
        metricText('ringGestureSamples', String(gestureSampleCount));
        metricText('ringGesture', `Nativo: ${event.key || event.code || 'comando'}`);

        if (nativeGestureTraining) {
            const training = nativeGestureTraining;
            if (training.timer) clearTimeout(training.timer);
            nativeGestureTraining = null;
            const id = training.replaceId || `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
            const profile = { id, name: training.name, action: training.action, url: training.url, mode: 'native', nativeKey: sig, nativeCode: event.code || '', nativeLabel: event.key || event.code || sig, enabled: true, createdAt: new Date().toISOString() };
            const idx = gestureProfiles.findIndex(g => g.id === id);
            if (idx >= 0) gestureProfiles[idx] = profile; else gestureProfiles.push(profile);
            saveGestureSettings();
            metricText('ringGestureTraining', 'Salvato ✓');
            metricText('ringGestureConfidence', '100%');
            if (el('ringGestureRecordBtn')) el('ringGestureRecordBtn').disabled = false;
            setRingStatus(`Gesto nativo “${profile.name}” salvato. Azione: ${gestureActionLabel(profile.action)}.`, 'success');
            return;
        }

        const profile = gestureProfiles.find(g => g.enabled !== false && g.mode === 'native' && g.nativeKey === sig);
        if (!profile) { metricText('ringGestureConfidence', '--'); return; }
        metricText('ringGestureConfidence', '100%');
        if (Date.now() - lastGestureAt < 700) return;
        lastGestureAt = Date.now();
        await executeGestureAction(profile);
    }


    async function quietSensors({ includeRaw = true, verifyRaw = true } = {}) {
        if (!ringDevice?.gatt?.connected) return { rawStopped: true };

        // Raw-motion stop differs across some COLMI firmwares. Most use A1 02,
        // while newer variants have been observed using A1 05. Try the stock
        // command first and only fall back to A1 05 if raw packets keep arriving.
        let rawStopped = true;
        if (includeRaw) {
            const beforeStop = Date.now();
            try { await writePrimary(makePacket(CMD_RAW, [0x02])); } catch (_) {}
            if (verifyRaw) {
                await delay(550);
                rawStopped = lastRawNotificationAt < beforeStop;
                if (!rawStopped) {
                    try { await writePrimary(makePacket(CMD_RAW, [0x05])); } catch (_) {}
                    const beforeFallback = Date.now();
                    await delay(550);
                    rawStopped = lastRawNotificationAt < beforeFallback;
                }
            }
        }

        // A raw/gesture session may coexist with a leftover optical measurement.
        // Explicitly stop the known realtime kinds without disabling background logs.
        const realtimeKinds = [0x01, 0x03, 0x04, 0x05, 0x06, 0x08, 0x0a, 0x0b];
        for (const kind of realtimeKinds) {
            try { await writePrimary(makePacket(CMD_MANUAL_MEASUREMENT, [kind, 0x04])); } catch (_) {}
            try { await writePrimary(makePacket(CMD_STOP_MEASUREMENT, [kind, 0x00, 0x00])); } catch (_) {}
            await delay(18);
        }
        return { rawStopped };
    }

    async function startGestures(quiet = false) {
        if (!ringDevice?.gatt?.connected) throw new Error('Anello non connesso');
        if (measureState) await stopCurrentMeasurement(true);
        gestureInputMode = el('ringGestureMode')?.value === 'motion' ? 'motion' : 'accel';
        await quietSensors({ includeRaw: true, verifyRaw: false });
        gestureMode = true;
        gestureActiveMode = gestureInputMode;
        gestureSampleCount = 0;
        lastAccel = null;
        metricText('ringGestureSamples', '0');
        metricText('ringGestureTraining', 'Pronto');
        if (el('ringGestureBtn')) el('ringGestureBtn').textContent = '⏹️ Ferma gesti';

        // A1 04 03 = accelerometer-only on documented COLMI RF03/R02-family firmware.
        // It streams the same A1 03 XYZ packets without enabling the optical PPG/SpO2 LEDs.
        const sensorMode = gestureActiveMode === 'accel' ? 0x03 : 0x04;
        const beforeStart = lastRawNotificationAt;
        await writePrimary(makePacket(CMD_RAW, [0x04, sensorMode]));
        metricText('ringGesture', gestureProfiles.length ? 'In ascolto…' : 'In ascolto / da programmare');

        if (gestureActiveMode === 'accel') {
            if (!quiet) setRingStatus('Accelerometro LED spenti attivo. Muovi la mano: il contatore Campioni deve aumentare senza accendere i LED ottici.', 'success');
            // Give the firmware a moment and warn if this revision does not implement A1 04 03.
            setTimeout(() => {
                if (gestureMode && gestureActiveMode === 'accel' && lastRawNotificationAt <= beforeStart) {
                    setRingStatus('Nessun campione ricevuto in modalità LED spenti. Questa revisione potrebbe non supportare A1 04 03: prova “Compatibilità · LED accesi”.', 'warning');
                }
            }, 2600);
        } else if (!quiet) {
            setRingStatus('Modalità compatibilità attiva: X/Y/Z funzionano, ma i LED ottici possono restare accesi finché i gesti sono in ascolto.', 'warning');
        }
    }

    async function stopGestures(quiet = false) {
        // Set the UI state first so incoming trailing packets are ignored immediately.
        gestureMode = false;
        gestureActiveMode = null;
        lastAccel = null;
        gestureTraining = null;
        if (nativeGestureTraining?.timer) clearTimeout(nativeGestureTraining.timer);
        nativeGestureTraining = null;
        if (gestureLiveCapture?.timer) clearTimeout(gestureLiveCapture.timer);
        gestureLiveCapture = null;
        if (el('ringGestureBtn')) el('ringGestureBtn').textContent = '🖐️ Attiva gesti';
        metricText('ringGestureTraining', 'Fermo');
        metricText('ringGesture', 'Fermo');
        metricText('ringAccelX', '--'); metricText('ringAccelY', '--'); metricText('ringAccelZ', '--');

        let result = { rawStopped: true };
        if (ringDevice?.gatt?.connected) {
            try { result = await quietSensors({ includeRaw: true, verifyRaw: true }); } catch (_) {}
        }
        if (!quiet) {
            if (result.rawStopped) setRingStatus('Modalità gesti fermata e sensori in tempo reale spenti.', 'success');
            else setRingStatus('Gesti fermati. Il flusso movimento sembra ancora attivo: usa “Spegni sensori” o disconnetti/ricollega l’anello.', 'warning');
        }
    }

    async function readDeviceInfo() {
        try {
            const svc = await gattServer.getPrimaryService(DEVICE_INFO_SERVICE);
            try {
                const c = await svc.getCharacteristic(FW_REV_UUID);
                const v = await c.readValue();
                metrics.firmware = new TextDecoder().decode(v.buffer).replace(/\0/g, '').trim();
            } catch (_) {}
            try {
                const c = await svc.getCharacteristic(HW_REV_UUID);
                const v = await c.readValue();
                metrics.hardware = new TextDecoder().decode(v.buffer).replace(/\0/g, '').trim();
            } catch (_) {}
            renderMetrics();
        } catch (_) {}
    }

    async function syncActivitySleep(quiet = false) {
        const results = {};
        if (!quiet) setRingStatus('Sincronizzo batteria, attività e sonno…', 'info');
        try { results.battery = await readBatteryAsync(); } catch (_) {}
        try { results.activity = await requestSteps(); } catch (e) { results.activityError = e.message || String(e); }
        try { results.sleep = await requestSleep(); } catch (e) { results.sleepError = e.message || String(e); }
        if (!quiet) {
            const missing = [results.activityError ? 'attività' : null, results.sleepError ? 'sonno' : null].filter(Boolean);
            setRingStatus(missing.length ? `Sincronizzazione completata. Non disponibili: ${missing.join(', ')}.` : 'Attività e sonno sincronizzati.', missing.length ? 'warning' : 'success');
        }
        return results;
    }

    async function runSensorStep(key, progress, label) {
        setProgress(progress, label);
        try {
            const value = await getMetricBestEffort(key);
            return value;
        } catch (_) { return null; }
    }

    window.ringSyncAll = async function ringSyncAll() {
        if (!ringDevice?.gatt?.connected || syncAllRunning) return;
        const resumeGestures = gestureMode;
        syncAllRunning = true;
        setBusyUi(true);
        if (resumeGestures) { try { await stopGestures(true); } catch (_) {} }
        setProgress(2, 'Avvio sincronizzazione completa…');
        setRingStatus('Sincronizzazione completa avviata. Tieni l’anello al dito e la mano il più possibile ferma durante le misure.', 'info');

        const unavailable = [];
        try {
            setProgress(6, 'Batteria…');
            try { await readBatteryAsync(); } catch (_) { unavailable.push('batteria'); }

            setProgress(12, 'Attività di oggi…');
            try { await requestSteps(); } catch (_) { unavailable.push('attività'); }

            setProgress(18, 'Sonno…');
            try { await requestSleep(); } catch (_) { unavailable.push('sonno'); }

            const hr = await runSensorStep('hr', 28, 'Battito cardiaco…');
            if (hr == null) unavailable.push('battito');
            await delay(1000);

            const spo2 = await runSensorStep('spo2', 48, 'SpO₂: storico + misura diretta…');
            if (spo2 == null) unavailable.push('SpO₂');

            const stress = await runSensorStep('stress', 64, 'Stress: ultimo dato disponibile…');
            if (stress == null) unavailable.push('stress');

            const hrv = await runSensorStep('hrv', 78, 'HRV: ultimo dato disponibile…');
            if (hrv == null) unavailable.push('HRV');

            const temp = await runSensorStep('temperature', 92, 'Temperatura: storico R09…');
            if (temp == null) unavailable.push('temperatura');

            setProgress(100, 'Completato');
            if (unavailable.length) {
                setRingStatus(`Sincronizzazione completata. Nessun dato disponibile per: ${unavailable.join(', ')}. Gli altri dati sono stati salvati nella schermata.`, 'warning');
            } else {
                setRingStatus('Sincronizzazione completa riuscita.', 'success');
            }
        } finally {
            syncAllRunning = false;
            setBusyUi(false);
            if ((resumeGestures || gestureAutoStart) && ringDevice?.gatt?.connected) { try { await startGestures(true); } catch (_) {} }
            setTimeout(() => setProgress(null), 3000);
        }
    };

    window.ringMeasureMetric = async function ringMeasureMetric(key) {
        if (!ringDevice?.gatt?.connected) { setRingStatus('Collega prima l’anello.', 'warning'); return; }
        const cfg = SENSOR[key];
        if (!cfg) return;
        const resumeGestures = gestureMode;
        setBusyUi(true);
        try {
            if (resumeGestures) await stopGestures(true);
            if (!syncAllRunning) setRingStatus(`${cfg.label}: cerco il dato più affidabile disponibile (storico o misura diretta)…`, 'info');
            const value = await getMetricBestEffort(key);
            if (value == null) setRingStatus(`${cfg.label}: nessun dato disponibile ancora. Indossa l’anello per un po’ e riprova.`, 'warning');
            else setRingStatus(`${cfg.label}: ${key === 'temperature' ? value.toFixed(1) : value}${cfg.unit ? ' ' + cfg.unit : ''}.`, 'success');
        } catch (e) {
            setRingStatus(`Errore ${cfg.label}: ${e.message || e}`, 'error');
        } finally {
            setBusyUi(false);
            if (resumeGestures && ringDevice?.gatt?.connected) { try { await startGestures(true); } catch (_) {} }
        }
    };

    window.ringSyncActivitySleep = async function ringSyncActivitySleep() {
        if (!ringDevice?.gatt?.connected) { setRingStatus('Collega prima l’anello.', 'warning'); return; }
        setBusyUi(true);
        try { await syncActivitySleep(false); } finally { setBusyUi(false); }
    };

    window.ringToggleGestures = async function ringToggleGestures() {
        if (!ringDevice?.gatt?.connected) { setRingStatus('Collega prima l’anello.', 'warning'); return; }
        try {
            if (gestureMode) await stopGestures(false);
            else await startGestures(false);
        } catch (e) { setRingStatus(`Gesti non disponibili su questo firmware: ${e.message || e}`, 'warning'); }
    };

    window.ringQuietSensors = async function ringQuietSensors() {
        if (!ringDevice?.gatt?.connected) { setRingStatus('Collega prima l’anello.', 'warning'); return; }
        setBusyUi(true);
        try {
            gestureMode = false;
            if (el('ringGestureBtn')) el('ringGestureBtn').textContent = '🖐️ Attiva gesti';
            metricText('ringGestureTraining', 'Fermo');
            metricText('ringGesture', 'Fermo');
            metricText('ringAccelX', '--'); metricText('ringAccelY', '--'); metricText('ringAccelZ', '--');
            await stopCurrentMeasurement(true);
            const result = await quietSensors({ includeRaw: true, verifyRaw: true });
            setRingStatus(result.rawStopped ? 'Sensori in tempo reale spenti.' : 'Comandi di arresto inviati; se i LED restano accesi, disconnetti e ricollega una volta.', result.rawStopped ? 'success' : 'warning');
        } catch (e) {
            setRingStatus(`Arresto sensori non completato: ${e.message || e}`, 'warning');
        } finally { setBusyUi(false); }
    };

    window.ringRecordGesture = async function ringRecordGesture(replaceId = null) {
        try { await recordGestureProfile(replaceId); }
        catch (e) { setRingStatus(`Registrazione gesto: ${e.message || e}`, 'warning'); metricText('ringGestureTraining', 'Riprova'); }
    };

    window.ringGestureSettingChanged = function ringGestureSettingChanged() {
        const threshold = Number(el('ringGestureSensitivity')?.value || 65);
        gestureConfidenceThreshold = Math.max(45, Math.min(90, threshold));
        gestureAutoStart = !!el('ringGestureAutoStart')?.checked;
        gestureVibrate = !!el('ringGestureVibrate')?.checked;
        gestureInputMode = el('ringGestureMode')?.value === 'motion' ? 'motion' : 'accel';
        metricText('ringGestureSensitivityValue', `${gestureConfidenceThreshold}%`);
        saveGestureSettings();
    };

    window.ringGestureNameChanged = function ringGestureNameChanged() {
        const custom = el('ringGestureNamePreset')?.value === '__custom__';
        const wrap = el('ringGestureCustomNameWrap');
        if (wrap) wrap.style.display = custom ? 'block' : 'none';
    };

    window.ringGestureModeChanged = async function ringGestureModeChanged() {
        gestureInputMode = el('ringGestureMode')?.value === 'motion' ? 'motion' : 'accel';
        saveGestureSettings();
        if (gestureMode && gestureActiveMode !== gestureInputMode) {
            try { await stopGestures(true); await startGestures(false); }
            catch (e) { setRingStatus(`Cambio modalità gesti non riuscito: ${e.message || e}`, 'warning'); }
        } else if (gestureInputMode === 'accel') {
            setRingStatus('Modalità accelerometro LED spenti selezionata. Usa A1 04 03: X/Y/Z devono muoversi senza accendere i LED ottici.', 'info');
        }
    };

    window.ringGestureActionChanged = function ringGestureActionChanged() {
        const show = el('ringGestureAction')?.value === 'open-url';
        const wrap = el('ringGestureUrlWrap');
        if (wrap) wrap.style.display = show ? 'block' : 'none';
    };

    window.ringClearGestures = function ringClearGestures() {
        if (!gestureProfiles.length) return;
        if (!window.confirm('Eliminare tutti i gesti programmati?')) return;
        gestureProfiles = [];
        saveGestureSettings();
        metricText('ringGesture', 'Da programmare');
        setRingStatus('Gesti programmati eliminati.', 'info');
    };

    window.ringReadBattery = async function ringReadBattery() {
        if (!ringDevice?.gatt?.connected) { setRingStatus('Collega prima l’anello.', 'warning'); return; }
        try {
            setRingStatus('Lettura batteria…', 'info');
            const b = await readBatteryAsync();
            setRingStatus(`Batteria: ${b.level}%${b.charging ? ' (in carica)' : ''}.`, 'success');
        } catch (e) { setRingStatus(`Batteria non letta: ${e.message || e}`, 'error'); }
    };

    const LAST_RING_ID_KEY = 'heartMonitorLastRingId';

    function isColmiName(name = '') {
        return /^(R09|R12|R10|R06|R03|R02|COLMI)/i.test(name || '');
    }

    async function attachRingDevice(device) {
        if (!device?.gatt) throw new Error('Dispositivo Bluetooth non valido');
        ringDevice = device;
        try { ringDevice.removeEventListener('gattserverdisconnected', handleDisconnected); } catch (_) {}
        ringDevice.addEventListener('gattserverdisconnected', handleDisconnected);
        gattServer = ringDevice.gatt.connected ? ringDevice.gatt : await ringDevice.gatt.connect();

        const service = await gattServer.getPrimaryService(PRIMARY_SERVICE_UUID);
        primaryWrite = await service.getCharacteristic(PRIMARY_WRITE_UUID);
        primaryNotify = await service.getCharacteristic(PRIMARY_NOTIFY_UUID);
        await primaryNotify.startNotifications();
        primaryNotify.addEventListener('characteristicvaluechanged', onPrimaryNotification);

        try {
            const bigService = await gattServer.getPrimaryService(BIG_SERVICE_UUID);
            bigWrite = await bigService.getCharacteristic(BIG_WRITE_UUID);
            bigNotify = await bigService.getCharacteristic(BIG_NOTIFY_UUID);
            await bigNotify.startNotifications();
            bigNotify.addEventListener('characteristicvaluechanged', onBigNotification);
        } catch (_) {
            bigWrite = null; bigNotify = null;
        }

        try { localStorage.setItem(LAST_RING_ID_KEY, ringDevice.id || ''); } catch (_) {}
        metricText('ringName', ringDevice.name || 'COLMI');
        setConnectedUi(true);
        setBusyUi(false);
        setRingStatus(`COLMI ${ringDevice.name || ''} collegato.`, 'success');
        void readDeviceInfo();
        try { await readBatteryAsync(); } catch (_) {}
        if (gestureAutoStart && gestureProfiles.length) { try { await startGestures(true); } catch (_) {} }
    }

    window.ringConnect = async function ringConnect() {
        if (!navigator.bluetooth) {
            setRingStatus('Web Bluetooth non disponibile. Usa Chrome/Chromium su Android e una pagina HTTPS.', 'error');
            return;
        }
        setBusyUi(true);
        try {
            // Prima prova a riutilizzare l’autorizzazione già concessa al nostro R09.
            // Così non serve riaprire ogni volta la finestra di accoppiamento Android.
            if (navigator.bluetooth.getDevices) {
                let remembered = [];
                try { remembered = await navigator.bluetooth.getDevices(); } catch (_) {}
                const lastId = (() => { try { return localStorage.getItem(LAST_RING_ID_KEY) || ''; } catch (_) { return ''; } })();
                const candidate = remembered.find(d => d.id === lastId) || remembered.find(d => isColmiName(d.name));
                if (candidate) {
                    setRingStatus(`Ricollegamento a ${candidate.name || 'COLMI'}…`, 'info');
                    try {
                        await attachRingDevice(candidate);
                        return;
                    } catch (e) {
                        setConnectedUi(false);
                        setBusyUi(false);
                        throw new Error(`L’anello è già autorizzato ma al momento non è raggiungibile. Probabilmente è collegato a QRing, a un’altra scheda di Heart Monitor o al controllo gestuale Bluetooth di Android. Chiudi/disconnetti l’altra connessione e riprova. (${e.message || e})`);
                    }
                }
            }

            setRingStatus('Prima associazione: seleziona R09_D502 dall’elenco Bluetooth…', 'info');
            const selected = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'R09' }, { namePrefix: 'R12' }, { namePrefix: 'R10' },
                    { namePrefix: 'R06' }, { namePrefix: 'R03' }, { namePrefix: 'R02' }, { namePrefix: 'COLMI' }
                ],
                optionalServices: [PRIMARY_SERVICE_UUID, BIG_SERVICE_UUID, DEVICE_INFO_SERVICE]
            });
            await attachRingDevice(selected);
        } catch (error) {
            if (error?.name === 'NotFoundError') setRingStatus('Nessun anello trovato/selezionato. Se era già collegato, chiudi QRing e le vecchie schede di Heart Monitor, poi riprova.', 'warning');
            else setRingStatus(`Connessione non riuscita: ${error.message || error}`, 'error');
            setConnectedUi(false);
            setBusyUi(false);
        }
    };

    function clearPending(reason = 'Disconnesso') {
        if (batteryWaiter) { clearTimeout(batteryWaiter.timer); batteryWaiter.reject(new Error(reason)); batteryWaiter = null; }
        if (stepsState) { clearTimeout(stepsState.timer); stepsState.reject(new Error(reason)); stepsState = null; }
        if (bigState) finishBigState(null, new Error(reason));
        if (historyState) finishHistoryState(null, new Error(reason));
        if (measureState) {
            const s = measureState; measureState = null;
            clearTimeout(s.fallbackTimer); clearTimeout(s.timeoutTimer); clearTimeout(s.settleTimer);
            s.resolve(null);
        }
    }

    function handleDisconnected() {
        clearPending('Anello disconnesso');
        syncAllRunning = false;
        gestureMode = false;
        gestureActiveMode = null;
        gestureTraining = null;
        if (nativeGestureTraining?.timer) clearTimeout(nativeGestureTraining.timer);
        nativeGestureTraining = null;
        if (gestureLiveCapture?.timer) clearTimeout(gestureLiveCapture.timer);
        gestureLiveCapture = null;
        primaryWrite = null; primaryNotify = null; bigWrite = null; bigNotify = null; gattServer = null;
        setConnectedUi(false); setBusyUi(false); setProgress(null);
        setRingStatus('Anello disconnesso.', 'warning');
    }

    window.ringDisconnect = async function ringDisconnect() {
        try { if (gestureMode) await stopGestures(true); } catch (_) {}
        try { await stopCurrentMeasurement(true); } catch (_) {}
        try { await quietSensors({ includeRaw: true, verifyRaw: false }); } catch (_) {}
        if (primaryNotify) {
            try { primaryNotify.removeEventListener('characteristicvaluechanged', onPrimaryNotification); } catch (_) {}
            try { await primaryNotify.stopNotifications(); } catch (_) {}
        }
        if (bigNotify) {
            try { bigNotify.removeEventListener('characteristicvaluechanged', onBigNotification); } catch (_) {}
            try { await bigNotify.stopNotifications(); } catch (_) {}
        }
        if (ringDevice?.gatt?.connected) ringDevice.gatt.disconnect();
        handleDisconnected();
    };

    window.addEventListener('pagehide', () => {
        // Web Bluetooth non è affidabile in background: libera subito l'anello
        // per evitare che una vecchia scheda/PWA lo renda invisibile alla ricerca successiva.
        try { if (ringDevice?.gatt?.connected) ringDevice.gatt.disconnect(); } catch (_) {}
    });

    window.addEventListener('load', () => {
        restoreMetrics();
        loadGestureSettings();
        window.ringGestureActionChanged();
        window.ringGestureNameChanged();
        setConnectedUi(false);
        setBusyUi(false);
        if (!navigator.bluetooth) setRingStatus('Bluetooth diretto non disponibile qui. Usa Chrome/Chromium su Android tramite HTTPS.', 'warning');
        else setRingStatus('Pronto. Chiudi QRing, collega l’anello e poi usa “Sincronizza tutto”.', 'info');
    });
})();
