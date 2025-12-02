// server.js
const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ============ CONFIG ============

// Use an environment variable to override broker, otherwise local MQTT on 1883.
// Example to run with remote broker:
//   MQTT_BROKER_URL='mqtt://14.139.122.114:1883' node server.js
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://10.41.232.58:1884';
const PORT = process.env.PORT || 3000;

// Topics your ESP32 or other sensors may publish to
const TOPIC_TEMP = 'esp32/telemetry';
const TOPIC_HUM = 'esp32/state';
const TOPIC_CO2 = 'esp32/control/cmd';

// Object to store the latest readings (shape used by frontend)
let latestAirData = {
    temperature: null,
    humidity: null,
    co2_eq_ppm: null,
    timestamp: null,
    // optional: device status or raw last topic
    device_status: null,
    last_topic: null,
};

// ============ MQTT CLIENT ============

const mqttOptions = {
    connectTimeout: 10 * 1000,
    // you can add username/password here if your broker requires auth
    // username: process.env.MQTT_USER,
    // password: process.env.MQTT_PASS,
};

const mqttClient = mqtt.connect(MQTT_BROKER_URL, mqttOptions);

mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT broker:', MQTT_BROKER_URL);

    // Subscribe to both home/air and esp32 topics so we support both flows
    mqttClient.subscribe(['home/air/#', 'esp32/#'], (err, granted) => {
        if (err) {
            console.error('❌ MQTT subscribe error:', err);
        } else {
            console.log('📡 Subscribed to:', granted.map(g => g.topic).join(', '));
        }
    });
});

mqttClient.on('error', (err) => {
    console.error('❌ MQTT error:', err && err.message ? err.message : err);
});

mqttClient.on('close', () => {
    console.warn('⚠ MQTT connection closed');
});

mqttClient.on('offline', () => {
    console.warn('⚠ MQTT client offline');
});

mqttClient.on('reconnect', () => {
    console.log('🔁 MQTT reconnecting...');
});

// Handle incoming MQTT messages (both numeric home/air and JSON esp32/telemetry)
// Handle incoming MQTT messages (both numeric home/air and JSON esp32/#)
mqttClient.on('message', (topic, messageBuffer) => {
    const payloadStr = String(messageBuffer).trim();
    console.log(`📥 MQTT message | topic=${topic} | payload=${payloadStr}`);

    // 1) If it's an esp32 topic, try to parse JSON generically
    if (topic.startsWith('esp32/')) {
        try {
            const obj = JSON.parse(payloadStr);

            // Map telemetry-style fields if present
            if (typeof obj.temperature !== 'undefined' && obj.temperature !== null) {
                const t = Number(obj.temperature);
                if (!isNaN(t)) latestAirData.temperature = t;
            }
            if (typeof obj.humidity !== 'undefined' && obj.humidity !== null) {
                const h = Number(obj.humidity);
                if (!isNaN(h)) latestAirData.humidity = h;
            }
            if (typeof obj.gas_mq135 !== 'undefined') {
                const g = Number(obj.gas_mq135);
                if (!isNaN(g)) latestAirData.co2_eq_ppm = g;
            } else if (typeof obj.co2_eq_ppm !== 'undefined') {
                const g = Number(obj.co2_eq_ppm);
                if (!isNaN(g)) latestAirData.co2_eq_ppm = g;
            }

            // Relay / actuator state
            if (typeof obj.relay_pin !== 'undefined') {
                // numeric 1/0 or boolean, or string "ON"/"OFF"
                if (obj.relay_pin === 1 || obj.relay_pin === '1' || obj.relay_pin === true) {
                    latestAirData.relay_pin = 1;
                } else if (obj.relay_pin === 0 || obj.relay_pin === '0' || obj.relay_pin === false) {
                    latestAirData.relay_pin = 0;
                } else if (typeof obj.relay_pin === 'string') {
                    latestAirData.relay_pin = (obj.relay_pin.toUpperCase() === 'ON') ? 1 : 0;
                }
            }

            // Generic state/status fields
            if (typeof obj.state !== 'undefined') {
                // e.g. {"state":"OFF"}
                latestAirData.relay_pin = (String(obj.state).toUpperCase() === 'ON') ? 1 : 0;
            }
            if (typeof obj.status !== 'undefined') {
                latestAirData.device_status = String(obj.status);
            }

            // Update last topic + timestamp
            latestAirData.last_topic = topic;
            latestAirData.timestamp = new Date().toISOString();

            console.log('✅ Updated latestAirData from esp32 topic:', latestAirData);
        } catch (err) {
            // Not JSON — try to handle simple numeric payloads if any
            const num = Number(payloadStr);
            if (!isNaN(num)) {
                // fallback: maybe the esp published numeric value directly on esp32/temperature etc.
                if (topic === 'esp32/temperature') latestAirData.temperature = num;
                else if (topic === 'esp32/humidity') latestAirData.humidity = num;
                else if (topic === 'esp32/co2') latestAirData.co2_eq_ppm = num;
                latestAirData.last_topic = topic;
                latestAirData.timestamp = new Date().toISOString();
                console.log('✅ Updated latestAirData from esp32 numeric topic:', latestAirData);
            } else {
                console.warn('⚠ Received non-json payload on esp32 topic; ignoring.', { topic, payload: payloadStr });
            }
        }
        return;
    }

    // 2) If the topic is home/air/* we expect numeric payloads
    const numeric = Number(payloadStr);
    if (!isNaN(numeric)) {
        if (topic === TOPIC_TEMP) {
            latestAirData.temperature = numeric;
        } else if (topic === TOPIC_HUM) {
            latestAirData.humidity = numeric;
        } else if (topic === TOPIC_CO2) {
            latestAirData.co2_eq_ppm = numeric;
        } else {
            // unknown numeric topic; store to help debugging
            latestAirData[topic] = numeric;
        }

        latestAirData.last_topic = topic;
        latestAirData.timestamp = new Date().toISOString();

        console.log('✅ Updated latestAirData from numeric topic:', latestAirData);
        return;
    }

    // 3) If not numeric and not JSON (and not esp32/*), ignore but log
    console.warn('⚠ Received non-numeric, non-json payload; ignoring.', { topic, payload: payloadStr });
});


// ============ HTTP API (for frontend) ============

// Health check
app.get('/', (req, res) => {
    res.send('Air quality backend is running ✅');
});

// Health for MQTT
app.get('/api/air/mqtt-health', (req, res) => {
    res.json({ connected: mqttClient.connected, broker: MQTT_BROKER_URL });
});

// Get the latest sensor values
app.get('/api/air/latest', (req, res) => {
    res.json(latestAirData);
});

// Individual endpoints
app.get('/api/air/temperature', (req, res) => {
    res.json({
        temperature: latestAirData.temperature,
        timestamp: latestAirData.timestamp,
    });
});

app.get('/api/air/humidity', (req, res) => {
    res.json({
        humidity: latestAirData.humidity,
        timestamp: latestAirData.timestamp,
    });
});

app.get('/api/air/co2', (req, res) => {
    res.json({
        co2_eq_ppm: latestAirData.co2_eq_ppm,
        timestamp: latestAirData.timestamp,
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 HTTP API running at http://localhost:${PORT}`);
});
