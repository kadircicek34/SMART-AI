import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  process.env.APP_API_KEYS = 'test-api-key';
  process.env.KEY_STORE_FILE = '/tmp/smart-ai-test-keys-ui.json';
  process.env.MASTER_KEY_BASE64 = Buffer.alloc(32, 6).toString('base64');

  const mod = await import('../../api/app.js');
  app = mod.buildApp();
});

after(async () => {
  await app.close();
});

test('GET /ui/dashboard serves control dashboard HTML', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/dashboard' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /SMART-AI Control Dashboard/);
});

test('GET /ui/chat serves chatbot UI HTML', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/chat' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /SMART-AI Chat UI/);
});

test('GET /ui/assets/app.css serves static css asset', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/assets/app.css' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/css/);
  assert.match(res.body, /:root/);
});

test('GET /ui/assets path traversal is blocked', async () => {
  const res = await app.inject({ method: 'GET', url: '/ui/assets/..%2F..%2Fserver.ts' });

  assert.equal(res.statusCode, 404);
});
