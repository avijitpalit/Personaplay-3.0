const STORAGE_KEY = 'personaplay.session.v1';

export function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function scenePromptForStory(story) {
  if (typeof story?.visualPrompt === 'string' && story.visualPrompt.trim()) {
    return story.visualPrompt.trim();
  }
  return [story?.setting, story?.mood, story?.openingNarration]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')
    .trim();
}

export function makeSession(story, characters) {
  const now = Date.now();
  const openingMessages = [
    {
      id: makeId(),
      type: 'narration',
      text: story.openingNarration,
      createdAt: now
    },
    ...characters.map((character, index) => ({
      id: makeId(),
      type: 'character',
      characterId: character.id,
      text: character.openingLine,
      createdAt: now + index + 1
    }))
  ];

  return {
    id: makeId(),
    story,
    characters,
    messages: openingMessages,
    sceneImagePrompt: scenePromptForStory(story),
    createdAt: now,
    updatedAt: now
  };
}

export function loadSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const valid =
      session &&
      typeof session === 'object' &&
      session.story &&
      typeof session.story.title === 'string' &&
      Array.isArray(session.characters) &&
      session.characters.length > 0 &&
      Array.isArray(session.messages) &&
      session.messages.length > 0;
    if (!valid) return null;
    if (typeof session.sceneImagePrompt !== 'string' || !session.sceneImagePrompt.trim()) {
      session.sceneImagePrompt = scenePromptForStory(session.story);
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private browsing and full storage should not interrupt the story.
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do if storage is unavailable.
  }
}
