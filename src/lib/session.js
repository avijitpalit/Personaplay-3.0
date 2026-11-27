const STORAGE_KEY = 'personaplay.session.v1';

const WARDROBE_COLORS =
  /\b(?:black|white|ivory|cream|navy|blue|teal|green|olive|red|maroon|burgundy|pink|rose|yellow|gold|silver|grey|gray|charcoal|brown|tan|camel|beige|purple|violet|orange|indigo|denim|pastel|dark|light|bright|pale|deep)\b/i;
const WARDROBE_PALETTES = [
  { top: 'ivory', bottom: 'navy', main: 'black', outer: 'charcoal' },
  { top: 'charcoal', bottom: 'black', main: 'burgundy', outer: 'camel' },
  { top: 'white', bottom: 'navy', main: 'white', outer: 'black' },
  { top: 'olive', bottom: 'black', main: 'olive', outer: 'tan' },
  { top: 'dusty rose', bottom: 'charcoal', main: 'dusty rose', outer: 'black' },
  { top: 'black', bottom: 'indigo', main: 'black', outer: 'cream' },
  { top: 'powder blue', bottom: 'navy', main: 'powder blue', outer: 'grey' },
  { top: 'cream', bottom: 'brown', main: 'cream', outer: 'navy' }
];

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function canonicalOutfit(value, seed) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean || WARDROBE_COLORS.test(clean)) return clean;

  const palette = WARDROBE_PALETTES[stableHash(seed) % WARDROBE_PALETTES.length];
  const clauses = [];
  if (/\b(?:blouse|shirt|top|tee|t-shirt|sweater|kurta|kurti|tunic)\b/i.test(clean)) {
    clauses.push(`top ${palette.top}`);
  }
  if (/\b(?:skirt|trousers|pants|jeans|leggings|shorts|salwar|chinos)\b/i.test(clean)) {
    clauses.push(`bottom ${palette.bottom}`);
  }
  if (/\b(?:dress|saree|sari|gown|lehenga|kimono|abaya|kaftan)\b/i.test(clean)) {
    clauses.push(`main garment ${palette.main}`);
  }
  if (/\b(?:blazer|jacket|coat|overcoat|cardigan|hoodie)\b/i.test(clean)) {
    clauses.push(`outer layer ${palette.outer}`);
  }
  if (/\b(?:shoes|boots|sandals|heels|sneakers)\b/i.test(clean)) {
    clauses.push('footwear black');
  }
  if (/\b(?:glasses|spectacles)\b/i.test(clean)) {
    clauses.push('frames black');
  }
  if (clauses.length === 0) {
    clauses.push(`primary garment ${palette.top}`, `secondary garment ${palette.bottom}`);
  }

  return `${clean.replace(/[.\s]+$/, '')}. Fixed color palette (keep these exact colors): ${clauses.join('; ')}.`;
}

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
    outfit: canonicalOutfit(
      character.outfit || 'Practical clothing suited to the scene.',
      character.id || character.name
    ),
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
      const appearance = character.appearance.replace(/[.\s]+$/, '');
      const outfitText = character.outfit.replace(/[.\s]+$/, '');
      const outfit = outfitText
        ? ` WARDROBE LOCK: ${outfitText}. Keep the same garments and exact colors unless the latest beat explicitly changes them.`
        : '';
      return `${character.name} — ${character.age}, ${character.pronouns}${background ? `, ${background}` : ''}. AGE LOCK: must read as ${character.age}, with age-appropriate facial structure, skin texture, and mature proportions; never de-age. Immutable physical identity (same face and body in every image): ${appearance}.${outfit}`;
    })
    .join('\n');
}

export function makeSession(story, characters, initialStory = '') {
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
    initialStory: initialStory.trim(),
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
