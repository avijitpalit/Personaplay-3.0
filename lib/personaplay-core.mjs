import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config();

const apiKey = process.env.VENICE_API_KEY;
const model = process.env.VENICE_MODEL || 'venice-uncensored';
const apiUrl = process.env.VENICE_API_URL || 'https://api.venice.ai/api/v1/chat/completions';
const imageApiUrl =
  process.env.SCENE_IMAGE_URL ||
  'https://avijitpalit3--z-image-turbo-zimageservice-fastapi-app.modal.run/generate';
const sceneCacheDir =
  process.env.SCENE_CACHE_DIR ||
  path.join(process.env.VERCEL ? '/tmp' : process.cwd(), '.cache', 'scene-images');
const sceneImageInflight = new Map();
const maxPromptLength = 1600;

function imageDimension(value, fallback) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) && parsed >= 256 ? parsed : fallback;
  return Math.max(256, Math.round(base / 16) * 16);
}

const imageWidth = imageDimension(process.env.SCENE_IMAGE_WIDTH, 720);
const imageHeight = imageDimension(process.env.SCENE_IMAGE_HEIGHT, 1280);
const imageSteps = Math.min(20, Math.max(1, Number(process.env.SCENE_IMAGE_STEPS) || 9));

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
    /\b(?:wearing|wears|dressed|outfit|clothing|attire|apparel|shirt|blouse|jacket|coat|dress|jeans|trousers|pants|boots|shoes|uniform|suit|hoodie|leggings|necklace|jewelry|watch)\b/i;
  const clothingIndex = clean.search(clothingMarker);
  if (clothingIndex > 80) {
    clean = clean.slice(0, clothingIndex).replace(/[\s,;:—–-]+$/, '').trim();
  }

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
    const action = clean.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    return action ? `(${action})` : clean;
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
    outfit: { type: 'string', description: 'The character clothing in the opening scene. May change later with the situation.' },
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
    }
  },
  required: ['visualPrompt', 'presentCharacterIds']
});

const visualDirectorPrompt = `You are the visual director for PersonaPlay, an intimate roleplay app. Your only job is to turn the latest story beat into one concrete image prompt for a photorealistic vertical film still.

The image will be rendered in a 9:16 portrait frame for a mobile screen. Write for the camera, not for a synopsis.

Rules:
- Ground the image in the latest beat: the most recent user action plus the characters' latest replies. Do not merely repeat the opening setting or give a generic establishing shot.
- Choose one specific, filmable consequence of this turn: an object being touched, a door opening, a light changing, a figure entering the frame, or a visible reaction. Show where the characters are, what they are holding, and what has just changed.
- Never reproduce, quote, or summarize dialogue. Translate speech into the listener's posture, the state of the room, physical details, and readable facial expression. No lines of speech in the prompt.
- All people depicted in a sensual or intimate scene are adults (18+); never sexualize minors.
- The player is the camera and is never visible. Do not describe or show the player's face, body, clothing, or expression. Never mention the player, camera, viewer, POV, or framing in the prompt itself; describe only visible people, objects, and light. For a voice-only beat, show the empty room, the radio or device, and the environment instead.
- Include only NPCs who are physically present. Use their current outfit, role, and current emotion. Specify time of day, weather, motivated light sources, and two or three concrete environmental details from the story.
- Preserve each NPC's immutable physical identity exactly as supplied: face shape, skin tone, eyes, hair, build, height, and age must never change between images. You may change their outfit, pose, and environment to fit this turn. Do not invent different facial features or a different person.
- Nationality and ethnicity are part of identity, not decoration. Reflect each character's supplied nationality and ethnicity accurately in facial features, skin tone, hair, clothing, and cultural detail without caricature. Ground the scene in the story's country or region and its social world; never default to a generic Western look.
- Faces should be visible enough to read the character's realistic emotion: subtle microexpressions in the eyes, brow, jaw, and posture. No close-up glamour portrait, no exaggerated theatrical expression.
- Compose for a tall 9:16 frame: foreground, midground, background, with a clear vertical subject and negative space.
- Do not reveal a secret, a hidden identity, or a future event. Do not invent characters who are not present. Do not include any text, letters, signs, captions, logos, watermarks, or UI.
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
- Give each character a concrete age or age range and a role that is specific to this world and situation, never a generic archetype such as The Waiter, The Skeptic, or The Believer. "Unknown" is not an age.
- country is the country or region of the story. nationality and ethnicity belong to every character and to the protagonist. Infer them from the blueprint, names, setting, and cultural clues. Never default to a generic Western or Indian identity; if the story is cross-cultural, capture each person accurately.
- appearance is an immutable identity card for image consistency: exact face shape, skin tone, eye color and shape, hair color/texture/length, build, height, age presentation, and one distinctive feature. This must never change across the roleplay. Put clothing in outfit instead.
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
- Set visualPrompt to a fresh, self-contained image prompt for the moment immediately after your replies: the place, light, weather, objects, mood, the cast's positions, outfits, and readable emotions. Make it a vertical, environment-first background image. No text, lettering, captions, dialogue, watermarks, or UI.
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

async function callVenice({ system, user, schemaName, schema, temperature = 0.9, maxTokens = 1800 }) {
  if (!apiKey) {
    throw new AppError(500, 'The Venice API key is missing. Set VENICE_API_KEY in .env.local locally or in your deployment environment variables.', 'missing_api_key');
  }

  const payload = {
    model,
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
    outfit: clipAtWord(raw?.outfit, 200, 'Practical clothing suited to the scene.'),
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
      return `${character.name} — ${character.age}, ${character.pronouns}${background ? `, ${background}` : ''}. Immutable physical identity: ${character.appearance}`;
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
  const declaredCastSize = [1, 2, 3].includes(raw?.castSize) ? raw.castSize : 3;
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

async function createStory(prompt) {
  const userPrompt = `The user's story blueprint:\n"""\n${prompt}\n"""\n\nBuild the world and cast from this brief. Return the complete JSON object now.`;
  const makeRequest = (system, maxTokens) => callVenice({
    system,
    user: userPrompt,
    schemaName: 'personaplay_blueprint',
    schema: blueprintSchema,
    temperature: 0.92,
    maxTokens
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

async function createReply({ story, characters, messages }) {
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

Continue from the latest beat. Decide who reacts first and write 1 or 2 character responses. Only use characterId values from this list: ${characters.map((character) => character.id).join(', ')}. Return the JSON object now.`;

  const schema = replySchema(characters.map((character) => character.id));
  const makeRequest = (system) => callVenice({
    system,
    user: userPrompt,
    schemaName: 'personaplay_reply',
    schema,
    temperature: 0.94,
    maxTokens: 1800
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

async function createScenePromptPlan({ story, characters, messages }) {
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

Direct a new 9:16 vertical image prompt for the latest beat, and list the NPC IDs that are physically visible. Return the JSON object now.`;

  const makeRequest = (system) => callVenice({
    system,
    user: userPrompt,
    schemaName: 'personaplay_scene_prompt',
    schema: scenePromptSchema(characters.map((character) => character.id)),
    temperature: 0.72,
    maxTokens: 700
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

  return { visualPrompt, presentCharacterIds };
}

function composeSceneImagePrompt(prompt, identityLocks = '', settingContext = '') {
  const clean = multiline(prompt, '', 1200)
    .replace(
      /\b(painterly|painting|illustration|illustrated|digital art|concept art|watercolor|oil painting|comic|anime|cartoon|cgi|3d render|stylized)\b/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
  const locks = multiline(identityLocks, '', 3600);
  const setting = multiline(settingContext, '', 300);

  return [
    'Ultra-photorealistic candid photograph of an immersive roleplay scene. This must read as a frame from a live-action film captured on a real location, not artwork.',
    setting ? `SETTING / CULTURAL CONTEXT:\n${setting}` : '',
    locks
      ? `CHARACTER IDENTITY LOCKS — preserve these exact recurring people in every image (same face shape, skin tone, nationality, ethnicity, eye color and shape, hair color/texture/length, build, height, and age):\n${locks}`
      : '',
    `SCENE:\n${clean}`,
    'Character continuity is mandatory: every recurring character must look like the same real person across turns. Outfits and the environment may change for the current situation, but immutable facial structure, skin, eyes, hair, body shape, nationality, ethnicity, and age must not. Use natural, realistic microexpressions that show specific emotion through eyes, brow, jaw, and posture; emotion must be readable but understated. Only the recurring characters named in the identity locks and any people explicitly described in the scene may appear. Never include the player, a camera, a visible viewpoint, or invented bystanders. Realistic human anatomy and skin texture, natural asymmetry and imperfections, believable eyes and hands.',
    'Vertical 9:16 portrait composition, environment-first, with clear foreground, midground, and background. Shot on 35mm film with a full-frame camera and available light, physically accurate materials, true-to-life textures, realistic human proportions, deep shadows, shallow depth of field, subtle film grain, restrained color grade. Faces may be visible when the scene needs emotion, but no glamour portrait. It must look like a real photograph: not a painting, illustration, digital artwork, 3D render, CGI, anime, or stylized image. No plastic skin, beauty retouching, visible camera equipment, text, letters, captions, logos, watermarks, frames, or interface elements.'
  ].filter(Boolean).join('\n');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateSceneImage(prompt) {
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

async function getSceneImage(prompt, identityLocks = '', settingContext = '') {
  const started = Date.now();
  const composed = composeSceneImagePrompt(prompt, identityLocks, settingContext);
  const cacheKey = createHash('sha256')
    .update(`${imageWidth}x${imageHeight}:${imageSteps}:${composed}`)
    .digest('hex');
  const cachePath = path.join(sceneCacheDir, `${cacheKey}.png`);

  try {
    const buffer = await readFile(cachePath);
    return {
      buffer,
      cacheKey,
      cached: true,
      composedPrompt: composed,
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
      durationMs: Date.now() - started
    };
  }

  const generation = (async () => {
    const buffer = await generateSceneImage(composed);
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
    image: { width: imageWidth, height: imageHeight, steps: imageSteps }
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

  const result = await createStory(prompt);
  return { ...result, meta: { model } };
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

  const result = await createReply({ story: safeStory, characters, messages });
  return { ...result, meta: { model } };
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

  const started = Date.now();
  const plan = await createScenePromptPlan({ story: safeStory, characters, messages });
  const durationMs = Date.now() - started;
  const identityLocks = buildIdentityLocks(characters, plan.presentCharacterIds);
  console.log(`Scene prompt directed in ${(durationMs / 1000).toFixed(1)}s.`);
  return {
    visualPrompt: plan.visualPrompt,
    presentCharacterIds: plan.presentCharacterIds,
    identityLocks,
    meta: {
      model,
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

  const { buffer, cacheKey, cached, composedPrompt, durationMs } = await getSceneImage(prompt, identityLocks, settingContext);
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
      'X-Scene-Model': 'z-image-turbo',
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
