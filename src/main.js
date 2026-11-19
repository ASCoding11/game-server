// Entry point (npm start, PM2, Colyseus Cloud, Docker). Settings come from the environment, or from a .env file.
try { process.loadEnvFile('.env'); } catch (e) { /* no .env file: use the environment as it is */ }
const { start } = await import('./index.js');
start().catch(e => { console.error(e); process.exit(1); });
