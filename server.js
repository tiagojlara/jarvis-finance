// Before anything is required: CopilotKit sends usage telemetry unless these are set, and
// src/assistant/copilotRuntime.js sets the same defaults — here as well because .env is loaded below,
// after src/app is already in memory, so a value that only lives in .env arrives too late for anything
// that reads it at require time. `??=` so an operator can still set either variable to turn it back on.
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= '1';
process.env.DO_NOT_TRACK ??= '1';

const fs = require('fs');
const path = require('path');
const { createApp } = require('./src/app');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const { app } = createApp({ dataDir: process.env.DATA_DIR || path.join(__dirname, 'data') });

const port = Number(process.env.PORT || 3000);
app.listen(port, '127.0.0.1', () => console.log(`Portfolio planner running at http://localhost:${port}`));
