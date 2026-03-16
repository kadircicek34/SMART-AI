import { config } from '../config.js';
import { buildApp } from './app.js';

const app = buildApp();

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`API running on :${config.port}`);

const stop = async () => {
  await app.close();
  process.exit(0);
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
