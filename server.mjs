import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  createReplyResponse,
  createSceneImageResponse,
  createScenePromptResponse,
  createStoryResponse,
  getHealthPayload,
  toHttpError
} from './lib/personaplay-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json(getHealthPayload());
});

app.post('/api/story', async (req, res, next) => {
  try {
    res.json(await createStoryResponse(req.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/story/reply', async (req, res, next) => {
  try {
    res.json(await createReplyResponse(req.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/scene-prompt', async (req, res, next) => {
  try {
    res.json(await createScenePromptResponse(req.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/scene-image', async (req, res, next) => {
  try {
    const { buffer, headers } = await createSceneImageResponse(req.body);
    res.set(headers);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

if (isProduction) {
  const distDir = path.join(__dirname, 'dist');
  app.use(express.static(distDir, { index: false }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);
}

app.use((error, _req, res, _next) => {
  const { status, body } = toHttpError(error);
  res.status(status).json(body);
});

app.listen(port, host, () => {
  const health = getHealthPayload();
  console.log(`\n  PersonaPlay is live at http://${host}:${port}`);
  console.log(`  Model: ${health.model}${health.connected ? '' : '  ⚠ VENICE_API_KEY is missing'}`);
  console.log(`  Scene images: ${health.image.width}×${health.image.height}, ${health.image.steps} steps\n`);
});
