import { createSceneImageResponse } from '../lib/personaplay-core.mjs';
import { readJsonBody, sendError } from '../lib/serverless.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { message: 'Method not allowed.', code: 'method_not_allowed' } }));
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { buffer, headers } = await createSceneImageResponse(body);
    res.statusCode = 200;
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    res.end(buffer);
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendError(res, {
        status: 400,
        code: 'invalid_json',
        message: 'That request could not be read.'
      });
      return;
    }
    sendError(res, error);
  }
}
