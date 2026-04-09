import { config } from '../config.js';
import { buildApp } from './app.js';

const app = buildApp();

await app.listen({ port: config.port, host: config.host });
app.log.info(`API running on ${config.host}:${config.port}`);

const stop = async () => {
  await app.close();
  process.exit(0);
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
