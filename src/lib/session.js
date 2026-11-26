const STORAGE_KEY = 'personaplay.session.v1';

export const DEFAULT_PROTAGONIST = {
  age: '22',
  gender: 'man',
  pronouns: 'he/him',
  nationality: '',
  ethnicity: '',
  appearance: 'A 22-year-old man with a quiet, watchful presence and a lean build.'
};

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

export function normalizeStory(story) {
  const protagonist = story?.protagonist || {};
  return {
    ...story,
    country: story?.country || '',
    protagonist: {
      age: String(protagonist.age || DEFAULT_PROTAGONIST.age),
      gender: protagonist.gender || DEFAULT_PROTAGONIST.gender,
      pronouns: protagonist.pronouns || DEFAULT_PROTAGONIST.pronouns,
      nationality: protagonist.nationality || DEFAULT_PROTAGONIST.nationality,
      ethnicity: protagonist.ethnicity || DEFAULT_PROTAGONIST.ethnicity,
      appearance: protagonist.appearance || DEFAULT_PROTAGONIST.appearance
    }
  };
}

export function settingContextFor(story) {
  return [story?.country, story?.era]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' · ');
}

export function normalizeCharacter(character) {
  return {
    ...character,
    appearance:
      character.appearance ||
      'They have a distinct, consistent face and build that should not change between images.',
    outfit: character.outfit || 'Practical clothing suited to the scene.',
    emotion: character.emotion || 'guarded',
    nationality: character.nationality || '',
    ethnicity: character.ethnicity || ''
  };
}

export function identityLocksFor(characters, presentCharacterIds) {
  const visible =
    Array.isArray(presentCharacterIds) && presentCharacterIds.length > 0
      ? new Set(presentCharacterIds)
      : new Set(characters.map((character) => character.id));

  return characters
    .filter((character) => visible.has(character.id))
    .map((character) => {
      const background = [...new Set([character.nationality, character.ethnicity].filter(Boolean))].join(', ');
      return `${character.name} — ${character.age}, ${character.pronouns}${background ? `, ${background}` : ''}. Immutable physical identity: ${character.appearance}`;
    })
    .join('\n');
}

export function makeSession(story, characters) {
  const now = Date.now();
  const normalizedStory = normalizeStory(story);
  const normalizedCharacters = characters.map(normalizeCharacter);
  const openingMessages = [
    {
      id: makeId(),
      type: 'narration',
      text: normalizedStory.openingNarration,
      createdAt: now
    },
    ...normalizedCharacters.map((character, index) => ({
      id: makeId(),
      type: 'character',
      characterId: character.id,
      emotion: character.emotion,
      text: character.openingLine,
      createdAt: now + index + 1
    }))
  ];

  return {
    id: makeId(),
    story: normalizedStory,
    characters: normalizedCharacters,
    messages: openingMessages,
    sceneImagePrompt: scenePromptForStory(normalizedStory),
    sceneIdentityLocks: identityLocksFor(normalizedCharacters),
    scenePresentCharacterIds: normalizedCharacters.map((character) => character.id),
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

    const story = normalizeStory(session.story);
    const characters = session.characters.map(normalizeCharacter);
    const characterMap = new Map(characters.map((character) => [character.id, character]));
    const messages = session.messages.map((message) => {
      if (message.type !== 'character') return message;
      const character = characterMap.get(message.characterId);
      return {
        ...message,
        emotion: message.emotion || character?.emotion || 'guarded'
      };
    });

    return {
      ...session,
      story,
      characters,
      messages,
      sceneImagePrompt:
        typeof session.sceneImagePrompt === 'string' && session.sceneImagePrompt.trim()
          ? session.sceneImagePrompt
          : scenePromptForStory(story),
      sceneIdentityLocks:
        typeof session.sceneIdentityLocks === 'string'
          ? session.sceneIdentityLocks
          : identityLocksFor(characters),
      scenePresentCharacterIds: Array.isArray(session.scenePresentCharacterIds)
        ? session.scenePresentCharacterIds
        : characters.map((character) => character.id)
    };
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
