// server.js
const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ============ CONFIG ============

// IMPORTANT: set this to the SAME broker IP you used in your Arduino code
// Example: 'mqtt://192.168.1.100:1883'
const MQTT_BROKER_URL = 'mqtt://localhost:1883';

// Topics your ESP32 publishes to
const TOPIC_TEMP = 'home/air/temperature';
const TOPIC_HUM  = 'home/air/humidity';
const TOPIC_CO2  = 'home/air/co2_eq_ppm';

// Object to store the latest readings
let latestAirData = {
  temperature: null,
  humidity: null,
  co2_eq_ppm: null,
  timestamp: null,
};

// ============ MQTT CLIENT ============

const mqttClient = mqtt.connect(MQTT_BROKER_URL);

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT broker:', MQTT_BROKER_URL);

  // Subscribe to all air topics with wildcard
  mqttClient.subscribe('home/air/#', (err) => {
    if (err) {
      console.error('❌ MQTT subscribe error:', err);
    } else {
      console.log('📡 Subscribed to topics: home/air/#');
    }
  });
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT error:', err.message);
});

// Handle incoming MQTT messages
mqttClient.on('message', (topic, messageBuffer) => {
  const payload = messageBuffer.toString();
  console.log(`📥 MQTT message | topic=${topic} | payload=${payload}`);

  const value = Number(payload);
  if (isNaN(value)) {
    console.warn('⚠️ Received non-numeric payload, ignoring.');
    return;
  }

  // Update the right field based on topic
  if (topic === TOPIC_TEMP) {
    latestAirData.temperature = value;
  } else if (topic === TOPIC_HUM) {
    latestAirData.humidity = value;
  } else if (topic === TOPIC_CO2) {
    latestAirData.co2_eq_ppm = value;
  } else {
    // Unknown topic – ignore
    return;
  }

  latestAirData.timestamp = new Date().toISOString();

  console.log('✅ Updated latestAirData:', latestAirData);
});

// ============ HTTP API (for frontend) ============

// Health check
app.get('/', (req, res) => {
  res.send('Air quality backend is running ✅');
});

// Get the latest sensor values
app.get('/api/air/latest', (req, res) => {
  res.json(latestAirData);
});

// Example: extra endpoint if you want each metric separately
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
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 HTTP API running at http://localhost:${PORT}`);
});