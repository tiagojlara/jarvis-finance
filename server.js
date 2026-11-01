const fs = require('fs');
const path = require('path');
const { createApp } = require('./src/app');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const { app } = createApp({ dataDir: process.env.DATA_DIR || path.join(__dirname, 'data') });

const port = Number(process.env.PORT || 3000);
app.listen(port, '127.0.0.1', () => console.log(`Portfolio planner running at http://localhost:${port}`));
