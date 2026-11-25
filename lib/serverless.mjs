import { toHttpError } from './personaplay-core.mjs';

export async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) {
      const text = req.body.toString('utf8');
      return text ? JSON.parse(text) : {};
    }
    if (typeof req.body === 'string') {
      return req.body ? JSON.parse(req.body) : {};
    }
    if (req.body && typeof req.body === 'object') {
      return req.body;
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function sendError(res, error) {
  const parsed = toHttpError(error);
  sendJson(res, parsed.status, parsed.body);
}

export function jsonEndpoint(handler) {
  return async function endpoint(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, {
        error: { message: 'Method not allowed.', code: 'method_not_allowed' }
      });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await handler(body);
      sendJson(res, 200, result);
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
  };
}
