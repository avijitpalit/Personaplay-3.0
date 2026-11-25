import { createReplyResponse } from '../../lib/personaplay-core.mjs';
import { jsonEndpoint } from '../../lib/serverless.mjs';

export default jsonEndpoint(createReplyResponse);
