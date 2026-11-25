import { getHealthPayload } from '../lib/personaplay-core.mjs';
import { sendJson } from '../lib/serverless.mjs';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: { message: 'Method not allowed.', code: 'method_not_allowed' } });
    return;
  }
  sendJson(res, 200, getHealthPayload());
}
