export class ApiError extends Error {
  constructor(message, code = 'request_failed', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, body, { signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the story engine. Check your connection and try again.', 'network_error');
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // The error below covers an empty or non-JSON response.
  }

  if (!response.ok) {
    throw new ApiError(
      data?.error?.message || 'The story engine hit a snag. Please try again.',
      data?.error?.code || 'request_failed',
      response.status
    );
  }

  return data;
}

export function createStory(prompt, { signal, languageModel } = {}) {
  return request('/api/story', { prompt, languageModel }, { signal });
}

export function continueStory({ story, characters, messages, languageModel }, { signal } = {}) {
  return request('/api/story/reply', { story, characters, messages, languageModel }, { signal });
}

export function createScenePrompt({ story, characters, messages, languageModel }, { signal } = {}) {
  return request('/api/scene-prompt', { story, characters, messages, languageModel }, { signal });
}
