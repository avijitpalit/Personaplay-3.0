import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import sharp from 'sharp';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const apiKey = process.env.VENICE_API_KEY;
const model = process.env.VENICE_MODEL || 'venice-uncensored';
const languageModelIds = [
  ...new Set([
    model,
    'venice-uncensored',
    'glm-5-3-flash-uncensored',
    'gemma-4-uncensored',
    'venice-uncensored-role-play'
  ])
];
const apiUrl = process.env.VENICE_API_URL || 'https://api.venice.ai/api/v1/chat/completions';
const imageApiUrl =
  process.env.SCENE_IMAGE_URL ||
  'https://avijitpalit3--z-image-turbo-zimageservice-fastapi-app.modal.run/generate';
const veniceImageApiUrl =
  process.env.VENICE_IMAGE_URL || 'https://api.venice.ai/api/v1/images/generations';
const veniceImageModel = process.env.VENICE_IMAGE_MODEL || 'z-image-turbo';
const runpodApiKey = process.env.RUNPOD_API_KEY || '';
const runpodEndpoint = (
  process.env.RUNPOD_ZIMAGE_ENDPOINT || 'https://api.runpod.ai/v2/z-image-turbo'
).replace(/\/+$/, '');
const runpodTimeoutMs = Math.min(
  55_000,
  Math.max(15_000, Number(process.env.RUNPOD_TIMEOUT_MS) || 48_000)
);
const imageModelIds = {
  modal: 'modal-z-image-turbo',
  runpod: 'runpod-z-image-turbo',
  venice: 'venice-z-image-turbo'
};
const sceneCacheDir =
  process.env.SCENE_CACHE_DIR ||
  path.join(process.env.VERCEL ? '/tmp' : process.cwd(), '.cache', 'scene-images');
const sceneImageInflight = new Map();
const maxPromptLength = 1600;
// Z-Image text encoders silently truncate long prompts, which can drop the
// identity locks or the scene description and make the model invent or
// duplicate people. Keep the final composed prompt within a safe budget.
const maxImagePromptLength = 2600;

function imageDimension(value, fallback) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) && parsed >= 256 ? parsed : fallback;
  return Math.max(256, Math.round(base / 16) * 16);
}

const imageWidth = imageDimension(process.env.SCENE_IMAGE_WIDTH, 720);
const imageHeight = imageDimension(process.env.SCENE_IMAGE_HEIGHT, 1280);
const imageSteps = Math.min(20, Math.max(1, Number(process.env.SCENE_IMAGE_STEPS) || 9));

function normalizeImageModel(value) {
  if (value === 'runpod' || value === imageModelIds.runpod) return imageModelIds.runpod;
  if (value === 'venice' || value === imageModelIds.venice) return imageModelIds.venice;
  return imageModelIds.modal;
}

function normalizeLanguageModel(value) {
  return languageModelIds.includes(value) ? value : model;
}

export class AppError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const text = (value, fallback = '', limit = 600) => {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, limit) : fallback;
};

const multiline = (value, fallback = '', limit = 1800) => {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return clean ? clean.slice(0, limit) : fallback;
};

function clipAtWord(value, limit, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 24 ? lastSpace : limit).replace(/[\s,;:.-]+$/, '')}…`;
}

function cleanAppearance(value, fallback = 'They have a distinct, consistent face and build that should not change between images.') {
  let clean = text(value, fallback, 1200);
  const clothingMarker =
    /\b(?:wearing|wears|dressed|outfit|clothing|attire|apparel|shirt|blouse|jacket|coat|dress|jeans|trousers|pants|boots|shoes|uniform|suit|hoodie|leggings|saree|sari|kurta|salwar|kameez|lehenga|dupatta|kimono|hanbok|abaya|thobe|kaftan|dashiki|dirndl|cheongsam|qipao|hanfu|ao dai|necklace|jewelry|watch)\b/i;
  const clothingIndex = clean.search(clothingMarker);
  if (clothingIndex > 80) {
    clean = clean.slice(0, clothingIndex).replace(/[\s,;:—–-]+$/, '').trim();
  }

  clean = clean
    .replace(
      /\b(?:age presentation|presents? as|looks?|appears? to be)\b[^.;,]*\b(?:young(?:er)?|(?:late |early )?(?:20s|30s|40s|50s|60s)|twenties|thirties|forties|fifties|sixties)\b[^.;,]*/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .trim();

  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [];
  if (sentences.length > 0) {
    let selected = '';
    for (const sentence of sentences) {
      const candidate = `${selected} ${sentence}`.trim();
      if (candidate.length > 440) break;
      selected = candidate;
    }
    if (selected.length >= 40) clean = selected;
  }

  return clipAtWord(clean, 460, fallback);
}

const ACCENTS = ['ember', 'sage', 'rose', 'tide'];

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

function shortEmotion(value) {
  const clean = text(value, 'guarded', 160);
  const firstClause = clean.split(/[,;—.?!\n]/)[0].trim();
  const words = firstClause.split(/\s+/).slice(0, 4).join(' ').replace(/[.!?]+$/, '');
  return (words || clean).slice(0, 48);
}

function formatCharacterText(value, fallback = '') {
  const clean = multiline(value, fallback, 1600);
  if (!clean) return clean;

  const speechPattern = /("[^"]*"|“[^”]*”)/g;
  const hasSpeech = /["“]/.test(clean);
  if (!hasSpeech) {
    // Unquoted text is ambiguous: it may be dialogue in the user's chosen
    // style, or an action the model forgot to bracket. Do not turn dialogue
    // into italic action; leave it as speech and let explicit parentheses
    // do the styling.
    return clean;
  }

  const parts = clean.split(speechPattern);
  let output = '';
  for (const part of parts) {
    if (!part) continue;
    if (/^["“]/.test(part)) {
      if (output && !/\s$/.test(output)) output += ' ';
      output += part;
      continue;
    }
    const action = part.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!action) continue;
    if (output && !/\s$/.test(output)) output += ' ';
    output += /[\p{L}\p{N}]/u.test(action) ? `(${action}) ` : `${action} `;
  }
  return output.replace(/\s+/g, ' ').trim() || clean;
}

function shortRole(value) {
  const clean = text(value, 'A figure at the edge of the scene', 180);
  const firstClause = clean.split(/[,;—]/)[0].trim();
  let source = firstClause.length >= 4 ? firstClause : clean;

  const relative = source.match(/^(.+?)\s+(?:who|that)\s+/i);
  if (relative && relative[1].trim().length >= 16) {
    source = relative[1].trim();
  }
  const withPhrase = source.match(/^(.+?)\s+with\s+/i);
  if (withPhrase && withPhrase[1].trim().length >= 16) {
    source = withPhrase[1].trim();
  }

  if (source.length <= 64) return source;
  const cut = source.slice(0, 62);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 30 ? lastSpace : 62).trim()}…`;
}

const characterSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Full name, fitting the setting.' },
    role: { type: 'string', description: 'Their place in the world, 2 to 6 words.' },
    age: { type: 'string', description: 'A concrete age or age range, such as "late 30s" or "early 20s". Use "ageless" only for genuinely non-human characters. Never "unknown".' },
    pronouns: { type: 'string', description: 'Pronouns, such as she/her or they/them.' },
    nationality: { type: 'string', description: 'Nationality inferred from the initial story and setting, for example "Indian" or "Japanese". Never assume a default country.' },
    ethnicity: { type: 'string', description: 'Ethnic or cultural background inferred from the initial story and setting, for example "South Asian" or "West African". Avoid stereotypes.' },
    appearance: { type: 'string', description: 'Immutable visual identity used to keep this character consistent across every image: face shape, skin tone, eye color and shape, hair color/texture/length, build, height, age presentation, and one distinctive feature. 2 to 3 sentences. Never change these traits across the roleplay.' },
    outfit: { type: 'string', description: 'The character clothing in the opening scene, with an explicit color for every visible garment and accessory (for example "ivory blouse, navy skirt, black frames"). May change later only when the story explicitly changes clothes.' },
    emotion: { type: 'string', description: 'The character current emotion in one or two words, with a subtle visible cue. Realistic and specific, not theatrical.' },
    personality: { type: 'string', description: 'Contradictions, habits, and emotional weather, 1 to 2 sentences.' },
    voice: { type: 'string', description: 'How they speak: rhythm, vocabulary, tells.' },
    motivation: { type: 'string', description: 'What they want from this scene, 1 sentence.' },
    secret: { type: 'string', description: 'A hidden truth that can surface later, 1 sentence.' },
    openingLine: { type: 'string', description: 'A real first beat from this character, pulling the user in. Spoken words in double quotation marks stay outside parentheses; physical actions and private thoughts go inside parentheses. 1 to 2 sentences. Never "None" or a description of their absence.' }
  },
  required: ['name', 'role', 'age', 'pronouns', 'nationality', 'ethnicity', 'appearance', 'outfit', 'emotion', 'personality', 'voice', 'motivation', 'secret', 'openingLine']
};

const protagonistSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    age: { type: 'string', description: 'The player age. Default to "22" when the blueprint does not specify it.' },
    gender: { type: 'string', description: 'The player gender. Default to "man" when the blueprint does not specify it.' },
    pronouns: { type: 'string', description: 'The player pronouns. Default to "he/him" when the blueprint does not specify them.' },
    nationality: { type: 'string', description: 'The player nationality, inferred from the story and setting. Never assume a default country.' },
    ethnicity: { type: 'string', description: 'The player ethnic or cultural background, inferred from the story and setting. Avoid stereotypes.' },
    appearance: { type: 'string', description: 'A concise, stable physical identity for the player: face shape, skin tone, eyes, hair, build, and height. If unspecified, default to a 22-year-old man. The player is the camera and is not part of the cast.' }
  },
  required: ['age', 'gender', 'pronouns', 'nationality', 'ethnicity', 'appearance']
};

const blueprintSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Evocative story title, 2 to 6 words.' },
    tagline: { type: 'string', description: 'A cinematic one-line hook under 14 words.' },
    genre: { type: 'string', description: 'Specific genre or blend, 2 to 4 words.' },
    era: { type: 'string', description: 'Time and place, compact.' },
    country: { type: 'string', description: 'The country or region where the story takes place, inferred from the blueprint. Use a fictional region only for a fictional setting. Never assume a generic Western country.' },
    setting: { type: 'string', description: 'A transportive description of the immediate setting, 2 to 3 sentences.' },
    mood: { type: 'string', description: 'Three to five atmospheric words.' },
    premise: { type: 'string', description: 'The live situation and its central tension, 2 to 3 sentences.' },
    yourRole: { type: 'string', description: "The user's role and what is expected of them, 1 to 2 sentences." },
    protagonist: protagonistSchema,
    openingNarration: { type: 'string', description: 'A second-person cinematic opening beat, 2 to 4 sentences, with no dialogue or quoted speech.' },
    visualPrompt: { type: 'string', description: 'A self-contained cinematic image prompt for the opening scene: environment, weather, objects, atmosphere, and any figures kept small in frame. Visual only, no text, no dialogue, no title.' },
    castSize: {
      type: 'integer',
      enum: [1, 2, 3],
      description: 'The minimum number of NPCs this story needs, excluding the player. Use 1 for a solitary or single-presence premise, 2 for one necessary relationship, and 3 only when a genuinely multi-voice scene requires it.'
    },
    characters: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      description: 'Exactly castSize NPC characters, excluding the player. Every member must be physically present and able to speak in the opening scene.',
      items: characterSchema
    }
  },
  required: ['title', 'tagline', 'genre', 'era', 'country', 'setting', 'mood', 'premise', 'yourRole', 'protagonist', 'openingNarration', 'visualPrompt', 'castSize', 'characters']
};

const replySchema = (characterIds) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    narration: { type: 'string', description: 'An optional cinematic beat of 1 to 2 sentences. Use an empty string when not needed.' },
    visualPrompt: { type: 'string', description: 'A self-contained cinematic image prompt for the scene after this reply: environment, weather, objects, atmosphere, and any figures kept small in frame. Visual only, no text, no dialogue, no spoilers.' },
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          characterId: { type: 'string', enum: characterIds },
          text: { type: 'string', description: 'The character response: spoken words in double quotation marks outside parentheses; every action, gesture, and private thought inside parentheses. 2 to 5 sentences.' },
          emotion: { type: 'string', description: 'The character current emotion after this reply, one or two words, with a subtle visible cue. Realistic and grounded, never theatrical.' }
        },
        required: ['characterId', 'text', 'emotion']
      }
    }
  },
  required: ['narration', 'visualPrompt', 'messages']
});

const scenePromptSchema = (characterIds) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    visualPrompt: {
      type: 'string',
      description: 'A concrete portrait-orientation photorealistic image prompt for the exact moment in this turn, 45 to 80 words, with location, lighting, props, present NPCs, their visible actions, and readable realistic emotion. No dialogue, text, or spoilers.'
    },
    presentCharacterIds: {
      type: 'array',
      maxItems: 3,
      description: 'The exact IDs of NPCs physically visible in the image. Empty array when only the environment or a voice is present.',
      items: { type: 'string', enum: characterIds }
    },
    environment: {
      type: 'string',
      description: 'A compact continuity anchor for the place: location, architecture, light source and direction, weather, time of day, and two or three fixed props, 12 to 30 words. Reuse the same environment details as the previous image prompt when the beat stays in the same place. Use an empty string when sceneShift is "new-location".'
    },
    sceneShift: {
      type: 'string',
      enum: ['continue', 'new-location'],
      description: '"continue" when the beat stays in the same place. "new-location" only when the characters clearly move to a different place (go outside, cross into another building, travel by car or train, or the scene cuts elsewhere).'
    }
  },
  required: ['visualPrompt', 'presentCharacterIds', 'environment', 'sceneShift']
});

const visualDirectorPrompt = `You are the visual director for PersonaPlay, an intimate roleplay app. Your only job is to turn the latest story beat into one concrete image prompt for a photorealistic vertical film still.

The image will be rendered in a 9:16 portrait frame for a mobile screen. Write for the camera, not for a synopsis.

Rules:
- Ground the image in the latest beat: the most recent user action plus the characters' latest replies. Do not merely repeat the opening setting or give a generic establishing shot.
- Same-place continuity: the supplied "Previous image prompt" is the frame currently on screen. Unless the latest beat moves the story to a different place, keep that shot's location, architecture, furniture, window positions, light direction, time of day, weather, and color palette, and choose a fresh camera angle within the same space. Do not copy its people, poses, or actions.
- Set sceneShift to "continue" when the beat happens in the same place, even if a character sits, turns, walks to a window, opens a door, or the camera angle changes. Set it to "new-location" only on a real move: they go outside, cross into a different building or a room with a distinct environment, travel somewhere, or the scene cuts to a new place. Long time jumps that change the light or weather are still "continue" and should keep the same architecture while changing the light.
- When sceneShift is "new-location", write the new environment fully in visualPrompt, set environment to an empty string, and do not reuse the previous place.
- When sceneShift is "continue", set environment to a short anchor (12 to 30 words) that repeats the fixed place, light, weather, time and key props, so the next image can keep the same background.
- Choose one specific, filmable consequence of this turn: an object being touched, a door opening, a light changing, a figure entering the frame, or a visible reaction. Show where the characters are, what they are holding, and what has just changed.
- Never reproduce, quote, or summarize dialogue. Translate speech into the listener's posture, the state of the room, physical details, and readable facial expression. No lines of speech in the prompt.
- All people depicted in a sensual or intimate scene are adults (18+); never sexualize minors.
- The player is the camera and is never visible. Do not describe or show the player's face, body, clothing, or expression. Never mention the player, camera, viewer, POV, or framing in the prompt itself; describe only visible people, objects, and light. For a voice-only beat, show the empty room, the radio or device, and the environment instead.
- Include only NPCs who are physically present. Use their current outfit, role, and current emotion. Specify time of day, weather, motivated light sources, and two or three concrete environmental details from the story.
- Preserve each NPC's immutable physical identity exactly as supplied: face shape, skin tone, eyes, hair, build, height, and age must never change between images. You may change their pose and environment to fit this turn, but not their face, body, or age. Do not invent different facial features or a different person.
- Age is absolute, not decorative. A character in her 50s must read as a woman in her 50s: mature facial structure, age-appropriate skin texture, fine lines, and mature body proportions. Never use youth-coded words for an older character, and never de-age, slim, reshape, or beautify them.
- Wardrobe is locked: preserve the exact garment types, colors, and patterns supplied as the current outfit. Do not invent a different dress, saree, shirt, or color unless the latest beat explicitly says the character changed clothes.
- Nationality and ethnicity are part of identity, not decoration. Reflect each character's supplied nationality and ethnicity accurately in facial features, skin tone, hair, clothing, and cultural detail without caricature. Ground the scene in the story's country or region and its social world; never default to a generic Western look.
- Faces should be visible enough to read the character's realistic emotion: subtle microexpressions in the eyes, brow, jaw, and posture. No close-up glamour portrait, no exaggerated theatrical expression.
- Compose for a tall 9:16 frame: foreground, midground, background, with a clear vertical subject and negative space.
- Do not reveal a secret, a hidden identity, or a future event. Do not invent characters who are not present. Do not include any text, letters, signs, captions, logos, watermarks, or UI.
- Name every visible NPC exactly once, using their exact name from the cast sheet, and describe them by that name. Never describe a cast member who is not in presentCharacterIds, even if they appear elsewhere in the cast sheet. Never let one character appear twice in the frame, and never add a twin, double, reflection, portrait, or background figure. If presentCharacterIds has one ID, the prompt describes exactly one person. If it is empty, the prompt describes no people at all.
- Avoid repeating the previous image's exact angle or subject. Choose a fresh visual detail from this turn.
- Set presentCharacterIds to the exact IDs of the NPCs visible in the frame. Use an empty array when only the environment is visible.
- Write one dense paragraph of 45 to 80 words. No bullets, camera brand names, or meta commentary.

Return only a JSON object that matches the supplied schema.`;

const storyArchitectPrompt = `You are the story architect for PersonaPlay, an intimate, character-driven text roleplay app.

Turn the user's story blueprint into a playable opening with a small, magnetic cast. You are not writing a synopsis. You are building the first breath of a scene that the user can step into.

Craft rules:
- Honour the user's premise, tone, genre, language, and any named details. Invent around them rather than replacing them.
- Match the blueprint's language mix and register. Hinglish stays Hinglish; regional slang and code-switching stay intact. Never translate the user's voice into neutral English.
- This is adult fiction. Honour the user's stated taste, kinks, power dynamics, and explicitness, including voyeurism, obsession, or morally messy desire. The player does not have to be a good person; follow the blueprint instead of softening it. Do not moralize, add warnings, or fade to black. All sexual content is between adults (18+); never sexualize minors.
- Be specific. Prefer concrete places, textures, and tensions over generic fantasy or chosen-one plotting.
- The user is a participant, not an observer. Give them an active role, a reason to be present, and a little unfinished business.
- Fill protagonist first. If the blueprint specifies the player's age, gender, or pronouns, preserve them. If it does not, the player is a 22-year-old man using he/him. Never change an explicitly stated player identity.
- The player is never one of the NPC characters, even when the opening scene already contains several people and the player is one of them. Count the player as present but do not create an NPC for them, name them, or give them a role such as "The User", "The Player", or "Protagonist".
- First decide castSize: the minimum number of NPCs the story actually needs, excluding the player, from one to three. Default to 1. A one-on-one encounter stays one NPC: the player is the other half of the scene.
- Use 2 only when the blueprint explicitly brings a second distinct NPC into the immediate opening, and 3 only when it explicitly calls for an ensemble. Never add an extra neighbour, witness, rival, or intermediary just to manufacture conflict. Never duplicate the player.
- Then write exactly castSize characters. The array length must match castSize.
- Never create a character who duplicates the player's identity, profession, or role, and never use meta labels such as protagonist, antagonist, ally, or NPC.
- Every character must be physically present in the opening scene and able to interact with the user immediately. Never include a missing, dead, off-screen, or purely referenced character.
- Every character must have a distinct voice and at least one contradiction. Avoid characters who exist only to explain the plot.
- Every character must be a visibly different person from every other character: different age, face shape, hair, build, and (where natural) ethnicity or coloring. Never create a second character who reads as the same person, a twin, a younger/older copy, or the player under another name. Two characters in one cast must never share the same name or look interchangeable.
- Give each character a concrete age or age range and a role that is specific to this world and situation, never a generic archetype such as The Waiter, The Skeptic, or The Believer. "Unknown" is not an age.
- country is the country or region of the story. nationality and ethnicity belong to every character and to the protagonist. Infer them from the blueprint, names, setting, and cultural clues. Never default to a generic Western or Indian identity; if the story is cross-cultural, capture each person accurately.
- appearance is an immutable identity card for image consistency: exact face shape, skin tone, eye color and shape, hair color/texture/length, build, height, age presentation, and one distinctive feature. This must never change across the roleplay. Put clothing in outfit instead.
- outfit must name the exact color of every visible garment and accessory in the opening scene, including the main garment, lower garment, outer layer, and frames/footwear when present. Do not leave the wardrobe as a vague "blouse and skirt" or "dress and blazer" with no colors.
- emotion is a realistic current emotional state with a subtle visible cue. Avoid theatrical labels and emojis.
- Names should feel native to the world and easy to distinguish from one another.
- Make the opening narration cinematic and second-person. Establish one clear, immediate situation with a live question in it. Use no dialogue and no quoted speech of any kind; leave all speech to the cast.
- Each openingLine must be that character's actual first move toward the user: dialogue, a gesture, an offer, a warning. Format it like the ongoing roleplay: spoken words in double quotation marks outside parentheses; every physical action or private thought inside parentheses. It must happen in the present scene. Never write "None", "N/A", or describe why the character is unable to appear.
- In an openingLine, never narrate what the user does, decides, thinks, or feels. "You" may appear only inside dialogue the character speaks to the user. All action in the line belongs to the character.
- Do not put dialogue in the narration and then repeat it in an openingLine.
- Write visualPrompt as a self-contained prompt for a background illustrator. Describe the place, light, weather, objects, and mood, plus the cast's positions or silhouettes if useful. Make it a wide, environment-first establishing image. No text, lettering, captions, dialogue, or UI.
- No emojis. No content warnings, author notes, or questions to the user. Stay inside the fiction.
- Keep all prose polished, sensory, and free of clichés such as "little did they know" or "a chill ran down their spine".

Return only a JSON object that matches the supplied schema.`;

const sceneDirectorPrompt = `You are the scene director and entire cast of PersonaPlay, an immersive text roleplay. Continue the scene from the supplied transcript.

Core rules:
- Write only the characters' dialogue, actions, and interiority. Never decide what the user says, thinks, feels, or does. Leave room for their next move.
- Respond as one or two cast members only, choosing whoever would naturally react first. Never have the entire cast speak in turn.
- Rotate the spotlight. If the user did not address a specific character, favour someone who has not spoken recently instead of giving every turn to the same voice.
- Stay inside the fiction. No author notes, content warnings, summaries, or questions to the user outside the scene.
- Address the user directly when it fits, but do not make every line about them. Let characters have their own agendas.
- Each response should be 2 to 5 sentences, with voice-specific rhythm and concrete physical detail. Advance the scene and end on an open beat.
- Characters may disagree, withhold information, interrupt, or misunderstand. Do not make them uniformly warm or agreeable.
- Use the optional narration only for a short cinematic environment beat or time jump. If it is not essential, return an empty string for narration.
- This is adult fiction. Honour the user's stated taste, kinks, power dynamics, and explicitness, including voyeurism, obsession, or morally messy desire. Do not sanitize, moralize, cut away, or add warnings. All sexual content is between adults (18+); never sexualize minors.
- Match the transcript's language mix and register exactly. Hinglish, regional slang, and code-switching stay intact; never translate into formal English unless the user does.
- Format every character response like a screenplay beat: spoken words in quotation marks outside parentheses; every physical action, gesture, and private thought inside parentheses. Example: (She keeps her eyes on the cup, voice low.) "You should go." Do not put speech inside parentheses, and do not use asterisks for action.
- Do not use markdown headings, bullet lists, emojis, or speaker labels inside character text.
- Never reveal a character's secret unless the scene has earned it.
- For every speaking character, set emotion to their precise current emotional state in one or two words, grounded in this beat. Use realistic, understated reactions, not theatrical labels.
- Keep each NPC's immutable identity exactly as supplied. You may change their outfit, posture, and environment to fit the scene, but never their face shape, skin tone, eyes, hair, build, height, or age.
- Set visualPrompt to a fresh, self-contained image prompt for the moment immediately after your replies: the place, light, weather, objects, mood, the cast's positions, outfits, and readable emotions. Name each visible character once and never describe a cast member twice or invent an extra person. Make it a vertical, environment-first background image. No text, lettering, captions, dialogue, watermarks, or UI.
- Never put secrets or future reveals into visualPrompt.

Return only a JSON object that matches the supplied schema. The characterId must come from the supplied cast.`;

function parseJson(content) {
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string') throw new AppError(502, 'Venice returned an empty scene. Please try again.', 'empty_response');

  let clean = content.trim().replace(/^\uFEFF/, '');
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) clean = fenced[1].trim();

  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last > first) clean = clean.slice(first, last + 1);

  try {
    return JSON.parse(clean);
  } catch {
    throw new AppError(502, 'Venice lost the thread of the scene. Give it another try.', 'invalid_json');
  }
}

async function callVenice({
  system,
  user,
  schemaName,
  schema,
  temperature = 0.9,
  maxTokens = 1800,
  languageModel = model
}) {
  if (!apiKey) {
    throw new AppError(500, 'The Venice API key is missing. Set VENICE_API_KEY in .env.local locally or in your deployment environment variables.', 'missing_api_key');
  }

  const payload = {
    model: normalizeLanguageModel(languageModel),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature,
    top_p: 0.95,
    max_tokens: maxTokens,
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schemaName,
        strict: true,
        schema
      }
    }
  };

  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(75_000)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AppError(504, 'Venice took too long to answer. Try once more.', 'upstream_timeout');
    }
    throw new AppError(502, 'Could not reach Venice. Check your connection and try again.', 'upstream_unreachable');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new AppError(502, 'Venice returned an unreadable response. Please try again.', 'upstream_bad_response');
  }

  if (!response.ok) {
    const upstreamMessage = data?.error?.message || data?.message || data?.error || '';
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, 'Venice rejected the API key. Check the key in .env.local.', 'venice_auth_error');
    }
    if (response.status === 429) {
      throw new AppError(429, 'The story engine is catching its breath. Wait a moment, then try again.', 'venice_rate_limit');
    }
    console.error('Venice API error:', response.status, upstreamMessage);
    throw new AppError(502, 'Venice could not finish the scene. Please try again.', 'venice_error');
  }

  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new AppError(502, 'The scene ran past its final page. Give it another try.', 'truncated_response');
  }
  return parseJson(choice?.message?.content);
}

function isRetryableGenerationError(error) {
  return ['invalid_json', 'truncated_response', 'missing_cast'].includes(error?.code);
}

function slugify(value, fallback) {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
  return slug || fallback;
}

function normalizeCharacter(raw, index, usedIds) {
  const name = text(raw?.name, `Character ${index + 1}`, 80);
  let id = slugify(raw?.id || name, `character-${index + 1}`);
  if (usedIds.has(id)) id = `${id}-${index + 1}`;
  usedIds.add(id);

  return {
    id,
    name,
    role: shortRole(raw?.role),
    age: text(raw?.age, 'Unknown', 40),
    pronouns: text(raw?.pronouns, 'they/them', 30),
    nationality: text(raw?.nationality, '', 60),
    ethnicity: text(raw?.ethnicity, '', 60),
    appearance: cleanAppearance(raw?.appearance),
    outfit: canonicalOutfit(
      clipAtWord(raw?.outfit, 260, 'Practical clothing suited to the scene.'),
      id
    ),
    emotion: shortEmotion(raw?.emotion),
    personality: text(raw?.personality, 'Guarded, observant, and full of contradictions.', 360),
    voice: text(raw?.voice, 'Measured, with a habit of saying more than they mean to.', 240),
    motivation: text(raw?.motivation, 'They want to understand why you are here.', 300),
    secret: text(raw?.secret, 'They know more about this place than they admit.', 300),
    openingLine: formatCharacterText(raw?.openingLine, 'They look up as you enter, and the room goes quiet.'),
    accent: ACCENTS[index % ACCENTS.length]
  };
}

function buildIdentityLocks(characters, presentCharacterIds) {
  const visible = new Set(Array.isArray(presentCharacterIds) ? presentCharacterIds : []);
  return characters
    .filter((character) => visible.has(character.id))
    .map((character) => {
      const background = [...new Set([character.nationality, character.ethnicity].filter(Boolean))].join(', ');
      const appearance = character.appearance.replace(/[.\s]+$/, '');
      const outfitText = character.outfit.replace(/[.\s]+$/, '');
      const outfit = outfitText ? ` WARDROBE LOCK: ${outfitText}. Keep the same garments and exact colors unless the latest beat explicitly changes them.` : '';
      return `${character.name} — ${character.age}, ${character.pronouns}${background ? `, ${background}` : ''}. AGE LOCK: must read as ${character.age}, with age-appropriate facial structure, skin texture, and mature proportions; never de-age. Immutable physical identity (same face and body in every image): ${appearance}.${outfit}`;
    })
    .join('\n');
}

function characterIsPresent(character) {
  const opening = text(character?.openingLine, '', 400);
  if (!opening) return false;
  if (/^(none|null|n\/a|—|-)\b/i.test(opening)) return false;
  if (/\b(currently missing|not present|absent from the scene|unable to speak|cannot speak)\b/i.test(opening)) return false;
  return true;
}

function characterIsUserStandIn(character, rawStory) {
  const name = text(character?.name, '', 80).toLowerCase().replace(/[.!]+$/, '').trim();
  const role = text(character?.role, '', 180).toLowerCase().replace(/[.!]+$/, '').trim();
  const exactLabels = ['the user', 'user', 'the player', 'player', 'the protagonist', 'protagonist', 'you', 'yourself', 'me', 'the reader', 'reader'];
  if (exactLabels.includes(name) || exactLabels.includes(role)) {
    return true;
  }

  const description = `${character?.role || ''} ${character?.personality || ''} ${character?.motivation || ''}`;
  if (/\b(player character|the user's character|stand-in for the user|represents? the user|self-insert)\b/i.test(description)) {
    return true;
  }

  const playerDescription = [
    rawStory?.yourRole,
    rawStory?.protagonist?.appearance,
    rawStory?.protagonist?.gender
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const stopWords = new Set(['the', 'a', 'an', 'with', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'their', 'her', 'his', 'she', 'he', 'they', 'you', 'your']);
  const roleTokens = role
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !stopWords.has(token));
  const overlap = roleTokens.filter((token) => playerDescription.includes(token));
  return roleTokens.length > 0 && overlap.length >= 2;
}

function normalizeBlueprint(raw) {
  // Trust an explicit castSize. If it is missing, keep the cast the model
  // actually wrote (capped at 3) instead of silently padding to a full trio.
  const declaredCastSize = [1, 2, 3].includes(raw?.castSize)
    ? raw.castSize
    : Math.min(3, Math.max(1, Array.isArray(raw?.characters) ? raw.characters.length : 1));
  const seenNames = new Set();
  const rawCharacters = Array.isArray(raw?.characters)
    ? raw.characters
        .filter((character) => characterIsPresent(character) && !characterIsUserStandIn(character, raw))
        .filter((character) => {
          const nameKey = text(character?.name, '', 80).toLowerCase();
          if (!nameKey) return true;
          if (seenNames.has(nameKey)) return false;
          seenNames.add(nameKey);
          return true;
        })
        .slice(0, declaredCastSize)
    : [];
  if (rawCharacters.length === 0) {
    throw new AppError(502, 'Venice forgot to cast the characters. Please try again.', 'missing_cast');
  }

  const usedIds = new Set();
  const characters = rawCharacters.map((character, index) => normalizeCharacter(character, index, usedIds));

  const story = {
    title: text(raw?.title, 'An Untitled Story', 90),
    tagline: text(raw?.tagline, 'A scene is waiting to be entered.', 140),
    genre: text(raw?.genre, 'Speculative drama', 50),
    era: text(raw?.era, 'Somewhere out of time', 80),
    country: text(raw?.country, '', 90),
    setting: multiline(raw?.setting, 'A place with too many locked doors and not enough answers.', 600),
    mood: text(raw?.mood, 'Hushed, charged, uncertain', 100),
    premise: multiline(raw?.premise, 'Something is about to change, and you have arrived just in time to be part of it.', 700),
    yourRole: multiline(raw?.yourRole, 'You are the newest arrival, and everyone seems to have been expecting you.', 500),
    protagonist: {
      age: text(raw?.protagonist?.age, '22', 30),
      gender: text(raw?.protagonist?.gender, 'man', 40),
      pronouns: text(raw?.protagonist?.pronouns, 'he/him', 30),
      nationality: text(raw?.protagonist?.nationality, '', 60),
      ethnicity: text(raw?.protagonist?.ethnicity, '', 60),
      appearance: cleanAppearance(
        raw?.protagonist?.appearance,
        'A 22-year-old man with a quiet, watchful presence and a lean build.'
      )
    },
    openingNarration: multiline(raw?.openingNarration, 'The door closes behind you. Somewhere deeper in the building, a conversation stops.', 900)
  };

  story.visualPrompt = multiline(
    raw?.visualPrompt,
    `${story.setting} ${story.mood}. Cinematic, atmospheric, environment-first.`,
    900
  );

  return { story, characters };
}

function validateCharacterPayload(characters) {
  if (!Array.isArray(characters) || characters.length === 0 || characters.length > 6) {
    throw new AppError(400, 'This story is missing its cast.', 'invalid_cast');
  }
  const usedIds = new Set();
  return characters.map((character, index) => normalizeCharacter(character, index, usedIds));
}

function validateMessages(messages, characters) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError(400, 'There is no scene to continue yet.', 'invalid_messages');
  }
  const knownCharacters = new Map(characters.map((character) => [character.id, character.name]));
  return messages.slice(-32).map((message) => {
    if (!message || typeof message !== 'object') return null;
    const type = ['user', 'character', 'narration'].includes(message.type) ? message.type : null;
    if (!type) return null;
    const body = multiline(message.text, '', 4000);
    if (!body) return null;
    if (type === 'character') {
      const characterId = text(message.characterId, '', 60);
      if (!knownCharacters.has(characterId)) return null;
      return { type, characterId, text: body };
    }
    return { type, text: body };
  }).filter(Boolean);
}

function promptMentionsPlayerAge(prompt) {
  return [
    /\b(?:i am|i'm|i’m|im)\s+(?:a|an)?\s*(?:1[8-9]|[2-9]\d|10\d)(?:[-\s]years?[-\s]old)?\b/i,
    /\b(?:i am|i'm|i’m|im)\s+(?:in my|in her|in his|in their)\s+(?:twenties|thirties|forties|fifties|sixties|seventies)\b/i,
    /\b(?:my character|the protagonist|the player)\b[^.!?\n]{0,35}\b(?:1[8-9]|[2-9]\d|10\d)(?:[-\s]years?[-\s]old)?\b/i,
    /\b(?:playing as|as a|as an)\s+(?:a|an)?\s*(?:1[8-9]|[2-9]\d|10\d)(?:[-\s]years?[-\s]old)?\b/i,
    /\b(?:i am|i'm|i’m|im)\s+(?:a|an)?\s*(?:\d{2}[-\s]year[-\s]old|teen(?:ager|aged)?|young adult|middle-aged|elderly)\b/i
  ].some((pattern) => pattern.test(prompt));
}

function promptMentionsPlayerGender(prompt) {
  const identity =
    '(?:man|woman|male|female|nonbinary|non-binary|boy|girl|trans|transgender|genderfluid|genderqueer)';
  return [
    new RegExp(`\\b(?:i am|i'm|i’m|im)\\s+(?:a|an)?\\s*(?:\\d{1,2}[-\\s]year[-\\s]old\\s+)?${identity}\\b`, 'i'),
    new RegExp(`\\b(?:my character|the protagonist|the player)\\b[^.!?\\n]{0,35}\\b${identity}\\b`, 'i'),
    new RegExp(`\\b(?:playing as|as a|as an)\\s+(?:a|an)?\\s*(?:\\d{1,2}[-\\s]year[-\\s]old\\s+)?${identity}\\b`, 'i'),
    /\b(?:i use|my pronouns are)\s+(?:he\/him|she\/her|they\/them)\b/i,
    /\b(?:i am|i'm|i’m|im)\s+(?:he\/him|she\/her|they\/them)\b/i
  ].some((pattern) => pattern.test(prompt));
}

function applyProtagonistDefaults(blueprint, prompt) {
  const ageMentioned = promptMentionsPlayerAge(prompt);
  const genderMentioned = promptMentionsPlayerGender(prompt);
  if (ageMentioned && genderMentioned) return blueprint;

  const protagonist = { ...blueprint.story.protagonist };
  if (!ageMentioned) protagonist.age = '22';
  if (!genderMentioned) {
    protagonist.gender = 'man';
    protagonist.pronouns = 'he/him';
  }
  if (!ageMentioned && !genderMentioned) {
    protagonist.appearance =
      'A 22-year-old man with a lean build, short dark hair, dark eyes, a defined jaw, and a quiet, watchful presence.';
  }

  return {
    ...blueprint,
    story: {
      ...blueprint.story,
      protagonist
    }
  };
}

async function createStory(prompt, languageModel = model) {
  const userPrompt = `The user's story blueprint:\n"""\n${prompt}\n"""\n\nBuild the world and cast from this brief. Return the complete JSON object now.`;
  const makeRequest = (system, maxTokens) => callVenice({
    system,
    user: userPrompt,
    schemaName: 'personaplay_blueprint',
    schema: blueprintSchema,
    temperature: 0.92,
    maxTokens,
    languageModel
  });

  try {
    const result = normalizeBlueprint(await makeRequest(storyArchitectPrompt, 4096));
    return applyProtagonistDefaults(result, prompt);
  } catch (error) {
    if (!isRetryableGenerationError(error)) throw error;
    console.warn(`Retrying story generation after ${error.code}.`);
    const retrySystem = `${storyArchitectPrompt}\n\nIMPORTANT: Your previous response was incomplete or malformed. Return one complete, valid JSON object that matches the schema. Keep every character field concise. The player is 22, male, he/him unless the blueprint explicitly states otherwise.`;
    const result = normalizeBlueprint(await makeRequest(retrySystem, 4096));
    return applyProtagonistDefaults(result, prompt);
  }
}

async function createReply({ story, characters, messages, languageModel = model }) {
  const castSheet = characters.map((character) => (
    `### ${character.name} (${character.pronouns}, ${character.age}) — ${character.role}
Nationality: ${character.nationality || 'infer from the setting'} · Ethnicity: ${character.ethnicity || 'infer from the setting'}
Immutable visual identity: ${character.appearance}
Current outfit: ${character.outfit}
Current emotion: ${character.emotion}
Personality: ${character.personality}
Voice: ${character.voice}
Wants: ${character.motivation}
Secret (do not reveal casually): ${character.secret}`
  )).join('\n\n');

  const transcript = messages.map((message) => {
    if (message.type === 'user') return `[You]: ${message.text}`;
    if (message.type === 'narration') return `[Narration]: ${message.text}`;
    const character = characters.find((item) => item.id === message.characterId);
    return `[${character?.name || 'Unknown'}]: ${message.text}`;
  }).join('\n\n');

  const latestUser = [...messages].reverse().find((message) => message.type === 'user');
  const isContinuation = /^\.+$/.test((latestUser?.text || '').trim());
  const recentCharacterLines = messages
    .filter((message) => message.type === 'character')
    .slice(-3)
    .map((message) => clipAtWord(message.text, 240))
    .filter(Boolean);
  const continuationCue = isContinuation
    ? `\nCONTINUATION CUE: The player's latest message is only punctuation. They are asking the scene to continue without adding a new action. Advance the moment with new material. Do not repeat or closely paraphrase any previous line, gesture, or opening beat.`
    : '';
  const noRepeatCue = recentCharacterLines.length
    ? `\nDO NOT REPEAT OR PARAPHRASE THESE RECENT LINES:\n${recentCharacterLines.map((line) => `- ${line}`).join('\n')}`
    : '';

  const userPrompt = `STORY
Title: ${story.title}
Genre: ${story.genre}
Era: ${story.era}
Country / region: ${story.country || 'infer from the setting'}
Setting: ${story.setting}
Mood: ${story.mood}
Premise: ${story.premise}
The player's role: ${story.yourRole}
Player identity: ${story.protagonist?.age || '22'} year old ${story.protagonist?.gender || 'man'}, pronouns ${story.protagonist?.pronouns || 'he/him'}, nationality ${story.protagonist?.nationality || 'infer'}, ethnicity ${story.protagonist?.ethnicity || 'infer'}. The player is never part of the cast.
Current scene visual: ${story.visualPrompt || story.setting}

CAST
${castSheet}

SCENE SO FAR
${transcript}
${continuationCue}
${noRepeatCue}

Continue from the latest beat. Decide who reacts first and write 1 or 2 character responses. Only use characterId values from this list: ${characters.map((character) => character.id).join(', ')}. Return the JSON object now.`;

  const schema = replySchema(characters.map((character) => character.id));
  const makeRequest = (system) => callVenice({
    system,
    user: userPrompt,
    schemaName: 'personaplay_reply',
    schema,
    temperature: 0.94,
    maxTokens: 1800,
    languageModel
  });

  let raw;
  try {
    raw = await makeRequest(sceneDirectorPrompt);
  } catch (error) {
    if (!isRetryableGenerationError(error)) throw error;
    console.warn(`Retrying reply generation after ${error.code}.`);
    raw = await makeRequest(
      `${sceneDirectorPrompt}\n\nIMPORTANT: Your previous response was incomplete or malformed. Return one complete, valid JSON object that matches the schema.`
    );
  }

  const byId = new Map(characters.map((character) => [character.id, character]));
  const seen = new Set();
  const replies = (Array.isArray(raw?.messages) ? raw.messages : [])
    .slice(0, 2)
    .map((item) => {
      const character = byId.get(item?.characterId);
      const body = formatCharacterText(item?.text, '');
      if (!character || !body || seen.has(character.id)) return null;
      seen.add(character.id);
      return {
        characterId: character.id,
        text: body,
        emotion: shortEmotion(item?.emotion || character.emotion)
      };
    })
    .filter(Boolean);

  if (replies.length === 0) {
    throw new AppError(502, 'The cast missed their cue. Try that beat again.', 'empty_reply');
  }

  const visualPrompt = multiline(
    raw?.visualPrompt,
    `${story.setting} ${story.mood}. Cinematic, atmospheric, environment-first.`,
    900
  );

  return {
    narration: multiline(raw?.narration, '', 600),
    visualPrompt,
    messages: replies
  };
}

const LOCATION_CHANGE_CUE =
  /\b(?:go(?:es)?|went|walk(?:s|ed)?|step(?:s|ped)?|march(?:es|ed)?|head(?:s|ed)?|leaves?|left|exit(?:s|ed)?|storm(?:s|ed)?|run(?:s|ran)?|drive|drives|drove|travel(?:s|ed)?|arriv(?:e|es|ed)|enter(?:s|ed)?|move(?:s|d)?|cuts? to)\b[^.!?]{0,48}\b(?:outside|outdoors|street|garden|balcony|roof|driveway|car|train|plane|ferry|boat|forest|woods|beach|shore|cliff|another room|next room|hallway|kitchen|bedroom|bathroom|office|building|house|apartment|city|village|town|market|station|airport|bar|club|restaurant|caf[eé]|church|temple|school|hospital)\b/i;

function inferSceneShift(rawShift, messages) {
  const latestUser = [...messages].reverse().find((message) => message.type === 'user');
  const explicitMove = LOCATION_CHANGE_CUE.test(latestUser?.text || '');

  if (rawShift === 'new-location') return 'new-location';
  // A clear "I go outside / we drive to the station" beat always rebuilds the
  // background, even if the director was conservative and said "continue".
  if (explicitMove) return 'new-location';
  if (rawShift === 'continue') return 'continue';
  return 'continue';
}

async function createScenePromptPlan({ story, characters, messages, languageModel = model }) {
  const castSheet = characters.map((character) => (
    `ID: ${character.id}
Name: ${character.name} (${character.pronouns}, ${character.age}) — ${character.role}
Nationality: ${character.nationality || 'infer from the setting'} · Ethnicity: ${character.ethnicity || 'infer from the setting'}
Immutable visual identity: ${character.appearance}
Current outfit: ${character.outfit}
Current emotion: ${character.emotion}`
  )).join('\n\n');

  const formatMessage = (message) => {
    if (message.type === 'user') return `[You]: ${message.text}`;
    if (message.type === 'narration') return `[Narration]: ${message.text}`;
    const character = characters.find((item) => item.id === message.characterId);
    return `[${character?.name || 'Character'}]: ${message.text}`;
  };

  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  const beatStart = lastUserIndex === -1 ? Math.max(0, messages.length - 8) : lastUserIndex;
  const latestBeat = messages.slice(beatStart).map(formatMessage).join('\n\n');
  const recentContext = messages.slice(Math.max(0, beatStart - 6), beatStart).map(formatMessage).join('\n\n');
  const isContinuation =
    lastUserIndex >= 0 && /^\.+$/.test((messages[lastUserIndex].text || '').trim());
  const continuationCue = isContinuation
    ? '\nThe player only sent punctuation: show the next visual moment. Do not repeat the previous image composition or the same pose.'
    : '';

  const userPrompt = `STORY
Title: ${story.title}
Genre: ${story.genre}
Era: ${story.era}
Country / region: ${story.country || 'infer from the setting'}
Setting: ${story.setting}
Mood: ${story.mood}
Premise: ${story.premise}
The player's role: ${story.yourRole}
Player identity: ${story.protagonist?.age || '22'} year old ${story.protagonist?.gender || 'man'}, pronouns ${story.protagonist?.pronouns || 'he/him'}, nationality ${story.protagonist?.nationality || 'infer'}, ethnicity ${story.protagonist?.ethnicity || 'infer'}. The player is the camera and is never visible.
Previous image prompt: ${story.visualPrompt || 'none'}

CAST
${castSheet}

RECENT CONTEXT
${recentContext || '(none)'}

LATEST BEAT
${latestBeat}
${continuationCue}

Direct a new 9:16 vertical image prompt for the latest beat, and list the NPC IDs that are physically visible. Return the JSON object now.`;

  const makeRequest = (system) => callVenice({
    system,
    user: userPrompt,
    schemaName: 'personaplay_scene_prompt',
    schema: scenePromptSchema(characters.map((character) => character.id)),
    temperature: 0.72,
    maxTokens: 700,
    languageModel
  });

  let raw;
  try {
    raw = await makeRequest(visualDirectorPrompt);
  } catch (error) {
    if (!isRetryableGenerationError(error)) throw error;
    console.warn(`Retrying scene prompt after ${error.code}.`);
    raw = await makeRequest(
      `${visualDirectorPrompt}\n\nIMPORTANT: Your previous response was incomplete or malformed. Return one complete, valid JSON object.`
    );
  }

  let visualPrompt = multiline(raw?.visualPrompt, '', 900)
    .replace(/["“][^"”]{20,}["”]/g, ' ')
    .replace(/(?:^|\s)['‘][^'’]{25,}['’](?=\s|$)/g, ' ')
    .replace(/([,;:])\s*\./g, '.')
    .replace(/\bthe player,?\s+as the camera,?\s*/gi, 'the frame ')
    .replace(/\bthe player's hand\b/gi, 'a hand')
    .replace(/\bthe player's\b/gi, 'the')
    .replace(/\bthe player\b/gi, 'the frame')
    .replace(/\bviewer\b/gi, 'frame')
    .replace(/\bcamera\b/gi, 'view')
    .replace(/\s+/g, ' ')
    .trim();

  if (!visualPrompt) {
    throw new AppError(502, 'The scene director could not frame this moment.', 'empty_visual_prompt');
  }

  const validIds = new Set(characters.map((character) => character.id));
  const presentCharacterIds = Array.isArray(raw?.presentCharacterIds)
    ? [...new Set(raw.presentCharacterIds.filter((id) => validIds.has(id)))].slice(0, 3)
    : [];

  const words = visualPrompt.split(/\s+/);
  const sentences = visualPrompt.match(/[^.!?]+[.!?]+/g) || [];
  let shortened = '';
  for (const sentence of sentences) {
    const candidate = `${shortened} ${sentence}`.trim();
    if (candidate.split(/\s+/).length > 85) break;
    shortened = candidate;
  }
  if (!shortened) {
    shortened = words
      .slice(0, 78)
      .join(' ')
      .replace(/\b(?:the|a|an|of|to|in|on|at|with|and|or|from|into|onto|over|under|near|as|while|that|which|who|whose|his|her|their|its|your|my|our)\s*$/i, '')
      .trim();
  }

  const finalSentences = shortened.split(/(?<=[.!?])\s+/).filter(Boolean);
  while (finalSentences.length > 1) {
    const lastSentence = finalSentences[finalSentences.length - 1].replace(/[.!?]+$/, '').trim();
    if (lastSentence.split(/\s+/).filter(Boolean).length < 4) {
      finalSentences.pop();
    } else {
      break;
    }
  }
  visualPrompt = finalSentences.join(' ').trim().replace(/([,;:])\s*\.$/,'.');
  visualPrompt = visualPrompt.replace(/\s+(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)\.$/, '');
  if (!/[.!?]$/.test(visualPrompt)) visualPrompt += '.';

  const sceneShift = inferSceneShift(raw?.sceneShift, messages);
  const environment =
    sceneShift === 'new-location' ? '' : multiline(raw?.environment, '', 320);

  return { visualPrompt, presentCharacterIds, environment, sceneShift };
}

function identityLockNames(identityLocks) {
  const names = String(identityLocks || '')
    .split(/\n+/)
    .map((line) => line.split(' — ')[0].replace(/[.:\s]+$/, '').trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function peopleInFrameClause(identityLocks) {
  const names = identityLockNames(identityLocks);
  if (names.length === 0) {
    return 'PEOPLE IN FRAME: none. Show only the environment, light, and objects — no people, no faces, no silhouettes.';
  }
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const count = names.length === 1 ? 'one person' : `${names.length} distinct people`;
  return `PEOPLE IN FRAME: exactly ${count} — ${list}. Each named person appears exactly once. Do not duplicate a character, draw a twin or double, mirror them in a reflection, or add any other person, face, or background figure.`;
}

function compactLockLines(identityLocks, limit = 220) {
  return multiline(identityLocks, '', 3600)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const head = line.split('. AGE LOCK')[0] || line;
      const appearance =
        line.match(/identity \(same face and body in every image\):\s*(.*?)\.\s*WARDROBE LOCK:/i)?.[1] || '';
      const outfit = line.match(/WARDROBE LOCK:\s*(.*?)\.\s*Keep/i)?.[1] || '';
      return clipAtWord([head, appearance, outfit].filter(Boolean).join('. '), limit, '');
    })
    .filter(Boolean)
    .join('\n');
}

function composeSceneImagePrompt(prompt, identityLocks = '', settingContext = '', continuity = {}) {
  const clean = multiline(prompt, '', 1200)
    .replace(
      /\b(painterly|painting|illustration|illustrated|digital art|concept art|watercolor|oil painting|comic|anime|cartoon|cgi|3d render|stylized)\b/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
  const locks = multiline(identityLocks, '', 3600);
  const setting = multiline(settingContext, '', 300);

  const environment = multiline(continuity?.environment, '', 320);
  const previousPrompt = multiline(continuity?.previousPrompt, '', 600);
  const newLocation = continuity?.sceneShift === 'new-location';
  const backgroundBlock = newLocation
    ? 'BACKGROUND: new location. Build the environment only from the SCENE; do not reuse the previous room, view, or set dressing.'
    : environment
      ? `BACKGROUND CONTINUITY: same place as the previous frame. Keep this location, architecture, light direction, weather, time of day and palette, but choose a fresh camera angle: ${environment}`
      : previousPrompt
        ? `BACKGROUND CONTINUITY: same place as the previous frame. Keep the architecture, light direction, weather, time of day and palette from this reference; ignore its people, poses and actions: ${clipAtWord(previousPrompt, 280, '')}`
        : '';

  const style =
    'Ultra-photorealistic candid photograph from a live-action film on a real location, not artwork.';
  const continuityRules =
    'Continuity is mandatory: same face, skin, eyes, hair, body, age and wardrobe in every frame; never de-age, slim, reshape or recolor. Only the people in the identity locks appear — omit anyone else, never duplicate a character, and never add a twin, double, reflection, portrait or extra bystander. Never place one person in two outfits in the same frame; if this beat changes clothes, dress the character once in the new garment. Natural anatomy, realistic microexpressions, believable eyes and hands. Never show the player or a camera.';
  const tail =
    'Vertical 9:16 film still, environment-first, foreground/midground/background, 35mm, available light, true-to-life texture, shallow depth of field, subtle grain, restrained grade. Looks like a real photograph, not painting, illustration, CGI, anime or 3D render. No text, letters, logos, watermarks, frames or UI.';

  const build = (sceneText, lockText) => [
    style,
    setting ? `SETTING / CULTURAL CONTEXT: ${setting}` : '',
    peopleInFrameClause(lockText),
    lockText
      ? `IDENTITY LOCKS — preserve these exact recurring people (same face shape, skin tone, nationality, ethnicity, eyes, hair, build, height, age and wardrobe colors):\n${lockText}`
      : '',
    backgroundBlock,
    sceneText ? `SCENE:\n${sceneText}` : '',
    continuityRules,
    tail
  ].filter(Boolean).join('\n');

  let lockText = locks;
  let text = build(clean, lockText);
  if (text.length > maxImagePromptLength && locks) {
    lockText = compactLockLines(locks, 320);
    text = build(clean, lockText);
  }
  if (text.length > maxImagePromptLength) {
    const fixed = build('', lockText);
    const room = Math.max(200, maxImagePromptLength - fixed.length);
    text = build(clipAtWord(clean, room, ''), lockText);
  }
  return text;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPngBuffer(buffer) {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG'
  );
}

function findRunPodImageValue(value, depth = 0) {
  if (!value || depth > 5) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRunPodImageValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['image', 'images', 'image_url', 'url', 'base64', 'data', 'output', 'result']) {
      if (value[key] !== undefined) {
        const found = findRunPodImageValue(value[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

async function imageValueToBuffer(value) {
  if (!value) return null;
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (/^https?:\/\//i.test(clean)) {
    const response = await fetch(clean, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new AppError(502, 'RunPod returned an image link that could not be downloaded.', 'runpod_image_download');
    }
    return Buffer.from(await response.arrayBuffer());
  }
  if (clean.startsWith('data:image/')) {
    const base64 = clean.slice(clean.indexOf(',') + 1);
    return Buffer.from(base64, 'base64');
  }
  if (clean.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(clean)) {
    return Buffer.from(clean, 'base64');
  }
  return null;
}

async function generateRunPodImage(prompt) {
  if (!runpodApiKey) {
    throw new AppError(
      503,
      'The RunPod image model is not configured. Set RUNPOD_API_KEY on the server.',
      'runpod_not_configured'
    );
  }

  const started = Date.now();
  let runResponse;
  try {
    runResponse = await fetch(`${runpodEndpoint}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runpodApiKey}`
      },
      body: JSON.stringify({
        input: {
          prompt,
          size: `${imageWidth}*${imageHeight}`,
          strength: 0.8,
          seed: -1,
          output_format: 'png',
          enable_safety_checker: false
        }
      }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AppError(504, 'RunPod did not answer in time. Try again.', 'runpod_timeout');
    }
    throw new AppError(502, 'Could not reach RunPod. Try again.', 'runpod_unreachable');
  }

  if (!runResponse.ok) {
    let detail = '';
    try {
      const body = await runResponse.json();
      detail = body?.detail || body?.title || body?.error || '';
    } catch {
      detail = await runResponse.text().catch(() => '');
    }
    console.error('RunPod image API error:', runResponse.status, String(detail).slice(0, 300));
    if (runResponse.status === 401 || runResponse.status === 403) {
      throw new AppError(
        502,
        'RunPod rejected the API key or endpoint permissions. Check RUNPOD_API_KEY and access to the z-image-turbo endpoint.',
        'runpod_auth_error'
      );
    }
    throw new AppError(502, 'RunPod could not start the scene illustration.', 'runpod_start_failed');
  }

  const runData = await runResponse.json().catch(() => null);
  const jobId = runData?.id;
  if (!jobId) {
    throw new AppError(502, 'RunPod did not return a job id.', 'runpod_no_job');
  }

  while (Date.now() - started < runpodTimeoutMs) {
    await wait(1_200);
    let statusResponse;
    const remainingMs = Math.max(2_000, runpodTimeoutMs - (Date.now() - started));
    try {
      statusResponse = await fetch(`${runpodEndpoint}/status/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${runpodApiKey}` },
        signal: AbortSignal.timeout(Math.min(15_000, remainingMs))
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') continue;
      throw new AppError(502, 'Lost contact with RunPod while painting.', 'runpod_unreachable');
    }

    if (!statusResponse.ok) {
      if (statusResponse.status === 404) continue;
      throw new AppError(502, 'RunPod could not report the image status.', 'runpod_status_failed');
    }

    const statusData = await statusResponse.json().catch(() => null);
    const state = String(statusData?.status || '').toUpperCase();
    if (state === 'COMPLETED') {
      const imageValue = findRunPodImageValue(statusData?.output);
      const buffer = await imageValueToBuffer(imageValue);
      if (!buffer || !isPngBuffer(buffer)) {
        throw new AppError(502, 'RunPod returned an unreadable image.', 'runpod_bad_image');
      }
      console.log(
        `RunPod scene image painted in ${((Date.now() - started) / 1000).toFixed(1)}s (${Math.round(buffer.length / 1024)} KB)`
      );
      return buffer;
    }
    if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state)) {
      const reason = statusData?.error || statusData?.output?.error || 'the worker stopped';
      throw new AppError(502, `RunPod could not paint the scene: ${String(reason).slice(0, 200)}`, 'runpod_failed');
    }
  }

  throw new AppError(
    504,
    'RunPod is still working on this frame. Try again in a moment.',
    'runpod_timeout'
  );
}

function composeVeniceImagePrompt(prompt, identityLocks = '', settingContext = '', continuity = {}) {
  const clean = multiline(prompt, '', 1200)
    .replace(
      /\b(painterly|painting|illustration|illustrated|digital art|concept art|watercolor|oil painting|comic|anime|cartoon|cgi|3d render|stylized)\b/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
  const setting = multiline(settingContext, '', 200);
  const style =
    'Ultra-photorealistic 9:16 vertical film still, real photograph, natural skin texture and anatomy, no text or watermark.';

  const environment = multiline(continuity?.environment, '', 320);
  const previousPrompt = multiline(continuity?.previousPrompt, '', 600);
  const newLocation = continuity?.sceneShift === 'new-location';
  const backgroundBlock = newLocation
    ? 'Background: new location. Build the environment only from the scene.'
    : environment
      ? `Background continuity: same place, architecture, light direction, weather, time of day and palette as the previous frame; new camera angle: ${environment}`
      : previousPrompt
        ? `Background continuity: keep the place, architecture, light and palette from this reference; ignore its people and actions: ${clipAtWord(previousPrompt, 240, '')}`
        : '';

  const lockLines = multiline(identityLocks, '', 3600)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const name = line.split('. AGE LOCK')[0] || line;
      const appearance =
        line.match(/identity \(same face and body in every image\): (.*?)\. WARDROBE LOCK:/i)?.[1] || '';
      const outfit = line.match(/WARDROBE LOCK: (.*?)\. Keep/i)?.[1] || '';
      return clipAtWord([name, appearance, outfit].filter(Boolean).join('. '), 230, '');
    })
    .filter(Boolean);

  const build = (lockLimit) => {
    const locks = lockLines.map((line) => clipAtWord(line, lockLimit, '')).filter(Boolean).join(' | ');
    const parts = [
      style,
      setting ? `Setting: ${setting}` : '',
      peopleInFrameClause(identityLocks),
      locks ? `Subjects (exact identity, age and wardrobe): ${locks}` : '',
      backgroundBlock,
      `Scene: ${clean}`
    ];
    let text = parts.filter(Boolean).join('\n');
    if (text.length > 1480) {
      const fixedLength = text.length - clean.length;
      const room = Math.max(280, 1470 - fixedLength);
      text = [
        style,
        setting ? `Setting: ${setting}` : '',
        peopleInFrameClause(identityLocks),
        locks ? `Subjects (exact identity, age and wardrobe): ${locks}` : '',
        backgroundBlock,
        `Scene: ${clipAtWord(clean, room, '')}`
      ]
        .filter(Boolean)
        .join('\n');
    }
    return text;
  };

  let text = build(230);
  if (text.length > 1500) text = build(160);
  return text.slice(0, 1500);
}

async function generateVeniceImage(prompt) {
  if (!apiKey) {
    throw new AppError(
      500,
      'The Venice API key is missing. Set VENICE_API_KEY in .env.local locally or in your deployment environment variables.',
      'missing_api_key'
    );
  }

  const started = Date.now();
  let response;
  try {
    response = await fetch(veniceImageApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: veniceImageModel,
        prompt,
        // Venice exposes a fixed size enum. 1024x1792 is the closest portrait
        // source; we crop/scale it to the app's exact 9:16 frame below.
        size: '1024x1792',
        response_format: 'b64_json'
      }),
      signal: AbortSignal.timeout(55_000)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AppError(504, 'Venice took too long to paint the scene. Try again.', 'venice_image_timeout');
    }
    throw new AppError(502, 'Could not reach the Venice image service. Try again.', 'venice_image_unreachable');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new AppError(502, 'Venice returned an unreadable image response.', 'venice_image_bad_response');
  }

  if (!response.ok) {
    const detail = data?.error?.message || data?.error || data?.details || '';
    console.error('Venice image API error:', response.status, String(detail).slice(0, 300));
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, 'Venice rejected the API key for image generation.', 'venice_image_auth_error');
    }
    throw new AppError(502, 'Venice could not paint the scene.', 'venice_image_failed');
  }

  const first = data?.data?.[0] || data?.images?.[0] || null;
  const b64 = first?.b64_json || data?.b64_json || '';
  if (!b64) {
    throw new AppError(502, 'Venice returned no image data.', 'venice_image_empty');
  }

  const source = Buffer.from(b64, 'base64');
  if (!isPngBuffer(source)) {
    throw new AppError(502, 'Venice returned an unreadable image.', 'venice_image_bad_image');
  }

  let buffer;
  try {
    // The API only accepts a 4:7 portrait size. Resize with a center crop to
    // the exact 9:16 720x1280 frame used everywhere else in PersonaPlay.
    buffer = await sharp(source)
      .resize(imageWidth, imageHeight, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('Venice image resize failed:', error?.message || error);
    throw new AppError(502, 'Venice returned an image that could not be framed.', 'venice_image_transform');
  }

  if (!isPngBuffer(buffer)) {
    throw new AppError(502, 'Venice returned an unreadable image.', 'venice_image_bad_image');
  }

  console.log(
    `Venice scene image painted in ${((Date.now() - started) / 1000).toFixed(1)}s (${Math.round(buffer.length / 1024)} KB)`
  );
  return buffer;
}

async function generateModalImage(prompt) {
  const body = JSON.stringify({
    prompt,
    width: imageWidth,
    height: imageHeight,
    steps: imageSteps
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = Date.now();
    let response;

    try {
      response = await fetch(imageApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(150_000)
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new AppError(504, 'The scene illustration took too long to paint.', 'image_timeout');
      }
      if (attempt === 0) {
        console.warn('Scene image service unreachable; retrying once.');
        await wait(900);
        continue;
      }
      throw new AppError(502, 'Could not reach the scene illustrator.', 'image_unreachable');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('Scene image API error:', response.status, detail.slice(0, 300));
      if (response.status >= 500 && attempt === 0) {
        await wait(900);
        continue;
      }
      throw new AppError(502, 'The scene illustration could not be painted.', 'image_generation_failed');
    }

    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const hasPngSignature =
      buffer.length > 8 &&
      buffer[0] === 0x89 &&
      buffer.subarray(1, 4).toString('ascii') === 'PNG';

    if (!contentType.startsWith('image/') || !hasPngSignature) {
      console.error('Scene image API returned unexpected content:', contentType, buffer.length);
      throw new AppError(502, 'The scene illustrator returned an unreadable image.', 'image_bad_response');
    }

    console.log(
      `Scene image painted in ${((Date.now() - started) / 1000).toFixed(1)}s (${Math.round(buffer.length / 1024)} KB)`
    );
    return buffer;
  }

  throw new AppError(502, 'The scene illustration could not be painted.', 'image_generation_failed');
}

async function getSceneImage(
  prompt,
  identityLocks = '',
  settingContext = '',
  imageModel = imageModelIds.modal,
  continuity = {}
) {
  const started = Date.now();
  const composed =
    imageModel === imageModelIds.venice
      ? composeVeniceImagePrompt(prompt, identityLocks, settingContext, continuity)
      : composeSceneImagePrompt(prompt, identityLocks, settingContext, continuity);
  const cacheKey = createHash('sha256')
    .update(`${imageModel}:${imageWidth}x${imageHeight}:${imageSteps}:${composed}`)
    .digest('hex');
  const cachePath = path.join(sceneCacheDir, `${cacheKey}.png`);

  try {
    const buffer = await readFile(cachePath);
    return {
      buffer,
      cacheKey,
      cached: true,
      composedPrompt: composed,
      imageModel,
      durationMs: Date.now() - started
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('Could not read scene image cache:', error?.message || error);
    }
  }

  const inflight = sceneImageInflight.get(cacheKey);
  if (inflight) {
    return {
      buffer: await inflight,
      cacheKey,
      cached: false,
      composedPrompt: composed,
      imageModel,
      durationMs: Date.now() - started
    };
  }

  const generation = (async () => {
    const buffer =
      imageModel === imageModelIds.runpod
        ? await generateRunPodImage(composed)
        : imageModel === imageModelIds.venice
          ? await generateVeniceImage(composed)
          : await generateModalImage(composed);
    try {
      await mkdir(sceneCacheDir, { recursive: true });
      await writeFile(cachePath, buffer);
    } catch (error) {
      console.warn('Could not cache scene image:', error?.message || error);
    }
    return buffer;
  })();

  sceneImageInflight.set(cacheKey, generation);
  try {
    return {
      buffer: await generation,
      cacheKey,
      cached: false,
      composedPrompt: composed,
      imageModel,
      durationMs: Date.now() - started
    };
  } finally {
    sceneImageInflight.delete(cacheKey);
  }
}

export function getHealthPayload() {
  return {
    ok: true,
    model,
    connected: Boolean(apiKey),
    languageModels: languageModelIds,
    image: {
      width: imageWidth,
      height: imageHeight,
      steps: imageSteps,
      models: [imageModelIds.modal, imageModelIds.runpod, imageModelIds.venice],
      runpodConfigured: Boolean(runpodApiKey)
    }
  };
}

export async function createStoryResponse(body) {
  if (typeof body?.prompt !== 'string') {
    throw new AppError(400, 'Tell us a little about the story first.', 'missing_prompt');
  }
  const prompt = body.prompt.trim();
  if (prompt.length < 12) {
    throw new AppError(400, 'Give the story a little more to go on — at least a sentence.', 'prompt_too_short');
  }
  if (prompt.length > maxPromptLength) {
    throw new AppError(400, `Keep the blueprint under ${maxPromptLength} characters.`, 'prompt_too_long');
  }

  const languageModel = normalizeLanguageModel(body?.languageModel);
  const result = await createStory(prompt, languageModel);
  return { ...result, meta: { model: languageModel } };
}

export async function createReplyResponse(body) {
  const story = body?.story;
  if (!story || typeof story !== 'object') {
    throw new AppError(400, 'The story context is missing.', 'invalid_story');
  }
  if (!Array.isArray(body?.messages) || typeof story.premise !== 'string') {
    throw new AppError(400, 'The story context is malformed.', 'invalid_story');
  }

  const characters = validateCharacterPayload(body.characters);
  const messages = validateMessages(body.messages, characters);
  if (messages.length === 0 || messages[messages.length - 1]?.type !== 'user') {
    throw new AppError(400, 'Your latest message is missing.', 'invalid_messages');
  }

  const safeStory = {
    title: text(story.title, 'An Untitled Story', 90),
    genre: text(story.genre, 'Speculative drama', 50),
    era: text(story.era, 'Somewhere out of time', 80),
    country: text(story.country, '', 90),
    setting: multiline(story.setting, 'An unfamiliar room.', 600),
    mood: text(story.mood, 'Charged', 100),
    premise: multiline(story.premise, 'Something is about to change.', 700),
    yourRole: multiline(story.yourRole, 'You are a newcomer here.', 500),
    protagonist: {
      age: text(story.protagonist?.age, '22', 30),
      gender: text(story.protagonist?.gender, 'man', 40),
      pronouns: text(story.protagonist?.pronouns, 'he/him', 30),
      nationality: text(story.protagonist?.nationality, '', 60),
      ethnicity: text(story.protagonist?.ethnicity, '', 60),
      appearance: text(story.protagonist?.appearance, 'A 22-year-old man with a quiet, watchful presence.', 500)
    },
    visualPrompt: multiline(story.visualPrompt, '', 900)
  };

  const languageModel = normalizeLanguageModel(body?.languageModel);
  const result = await createReply({ story: safeStory, characters, messages, languageModel });
  return { ...result, meta: { model: languageModel } };
}

export async function createScenePromptResponse(body) {
  const story = body?.story;
  if (!story || typeof story !== 'object') {
    throw new AppError(400, 'The story context is missing.', 'invalid_story');
  }
  if (!Array.isArray(body?.messages) || typeof story.premise !== 'string') {
    throw new AppError(400, 'The scene context is malformed.', 'invalid_scene_context');
  }

  const characters = validateCharacterPayload(body.characters);
  const messages = validateMessages(body.messages, characters);
  if (messages.length === 0) {
    throw new AppError(400, 'There is no scene to illustrate yet.', 'invalid_messages');
  }

  const safeStory = {
    title: text(story.title, 'An Untitled Story', 90),
    genre: text(story.genre, 'Speculative drama', 50),
    era: text(story.era, 'Somewhere out of time', 80),
    country: text(story.country, '', 90),
    setting: multiline(story.setting, 'An unfamiliar room.', 600),
    mood: text(story.mood, 'Charged', 100),
    premise: multiline(story.premise, 'Something is about to change.', 700),
    yourRole: multiline(story.yourRole, 'You are a newcomer here.', 500),
    protagonist: {
      age: text(story.protagonist?.age, '22', 30),
      gender: text(story.protagonist?.gender, 'man', 40),
      pronouns: text(story.protagonist?.pronouns, 'he/him', 30),
      nationality: text(story.protagonist?.nationality, '', 60),
      ethnicity: text(story.protagonist?.ethnicity, '', 60),
      appearance: text(story.protagonist?.appearance, 'A 22-year-old man with a quiet, watchful presence.', 500)
    },
    visualPrompt: multiline(story.visualPrompt, '', 900)
  };

  const languageModel = normalizeLanguageModel(body?.languageModel);
  const started = Date.now();
  const plan = await createScenePromptPlan({ story: safeStory, characters, messages, languageModel });
  const durationMs = Date.now() - started;
  const identityLocks = buildIdentityLocks(characters, plan.presentCharacterIds);
  console.log(`Scene prompt directed in ${(durationMs / 1000).toFixed(1)}s.`);
  return {
    visualPrompt: plan.visualPrompt,
    presentCharacterIds: plan.presentCharacterIds,
    environment: plan.environment,
    sceneShift: plan.sceneShift,
    identityLocks,
    meta: {
      model: languageModel,
      durationMs
    }
  };
}

export async function createSceneImageResponse(body) {
  if (typeof body?.prompt !== 'string') {
    throw new AppError(400, 'A scene description is required.', 'missing_image_prompt');
  }
  const prompt = body.prompt.trim();
  if (prompt.length < 8) {
    throw new AppError(400, 'The scene description is too short to paint.', 'image_prompt_too_short');
  }
  if (prompt.length > 1600) {
    throw new AppError(400, 'The scene description is too long.', 'image_prompt_too_long');
  }

  const identityLocks =
    typeof body?.identityLocks === 'string'
      ? body.identityLocks.trim().slice(0, 3600)
      : Array.isArray(body?.identityLocks)
        ? body.identityLocks.filter((value) => typeof value === 'string').join('\n').slice(0, 3600)
        : '';
  const settingContext = multiline(body?.settingContext, '', 300);
  const imageModel = normalizeImageModel(body?.imageModel);
  const sceneShift = body?.sceneShift === 'new-location' ? 'new-location' : 'continue';
  const continuity = {
    sceneShift,
    environment: sceneShift === 'new-location' ? '' : multiline(body?.environment, '', 320),
    previousPrompt: multiline(body?.previousPrompt, '', 600)
  };

  const { buffer, cacheKey, cached, composedPrompt, durationMs } = await getSceneImage(
    prompt,
    identityLocks,
    settingContext,
    imageModel,
    continuity
  );
  return {
    buffer,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, max-age=86400',
      'X-Scene-Cache': cached ? 'hit' : 'miss',
      'X-Scene-Image-Id': cacheKey.slice(0, 16),
      'X-Scene-Width': String(imageWidth),
      'X-Scene-Height': String(imageHeight),
      'X-Scene-Steps': String(imageSteps),
      'X-Scene-Duration-Ms': String(durationMs),
      'X-Scene-Model': imageModel,
      'X-Scene-Shift': sceneShift,
      'X-Scene-Prompt': encodeURIComponent(composedPrompt)
    }
  };
}

export function toHttpError(error) {
  if (error?.type === 'entity.parse.failed') {
    return {
      status: 400,
      body: { error: { message: 'That request could not be read.', code: 'invalid_json' } }
    };
  }

  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    console.error(error);
  }
  return {
    status,
    body: {
      error: {
        message: error?.message || 'Something went wrong. Please try again.',
        code: error?.code || 'server_error'
      }
    }
  };
}
