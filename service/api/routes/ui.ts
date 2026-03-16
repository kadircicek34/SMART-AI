import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const UI_ROOT = path.resolve(process.cwd(), 'web');

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function sendUiFile(reply: any, relativePath: string): Promise<void> {
  const filePath = path.resolve(UI_ROOT, relativePath);

  if (!isPathInside(UI_ROOT, filePath)) {
    reply.status(404).send({ error: 'Not found' });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    reply.header('content-type', mime);
    reply.header('cache-control', ext === '.html' ? 'no-store' : 'public, max-age=300');
    reply.status(200).send(content);
  } catch {
    reply.status(404).send({ error: 'Not found' });
  }
}

export async function registerUiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ui', async (_request, reply) => {
    reply.redirect('/ui/dashboard');
  });

  app.get('/ui/dashboard', async (_request, reply) => {
    await sendUiFile(reply, 'dashboard.html');
  });

  app.get('/ui/chat', async (_request, reply) => {
    await sendUiFile(reply, 'chat.html');
  });

  app.get('/ui/assets/:assetName', async (request, reply) => {
    const params = request.params as { assetName: string };
    await sendUiFile(reply, path.join('assets', params.assetName));
  });
}
