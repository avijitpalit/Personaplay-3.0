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

const ACCENTS = ['ember', 'sage', 'rose', 'tide'];

function shortRole(value) {
  const clean = text(value, 'A figure at the edge of the scene', 180);
  const firstClause = clean.split(/[,;—]/)[0].trim();
  let source = firstClause.length >= 8 ? firstClause : clean;

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
    appearance: { type: 'string', description: 'A vivid visual detail and silhouette, 1 to 2 sentences.' },
    personality: { type: 'string', description: 'Contradictions, habits, and emotional weather, 1 to 2 sentences.' },
    voice: { type: 'string', description: 'How they speak: rhythm, vocabulary, tells.' },
    motivation: { type: 'string', description: 'What they want from this scene, 1 sentence.' },
    secret: { type: 'string', description: 'A hidden truth that can surface later, 1 sentence.' },
    openingLine: { type: 'string', description: 'A real first line of dialogue or action from this character, pulling the user in. 1 to 2 sentences. Never "None" or a description of their absence.' }
  },
  required: ['name', 'role', 'age', 'pronouns', 'appearance', 'personality', 'voice', 'motivation', 'secret', 'openingLine']
};

const blueprintSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Evocative story title, 2 to 6 words.' },
    tagline: { type: 'string', description: 'A cinematic one-line hook under 14 words.' },
    genre: { type: 'string', description: 'Specific genre or blend, 2 to 4 words.' },
    era: { type: 'string', description: 'Time and place, compact.' },
    setting: { type: 'string', description: 'A transportive description of the immediate setting, 2 to 3 sentences.' },
    mood: { type: 'string', description: 'Three to five atmospheric words.' },
    premise: { type: 'string', description: 'The live situation and its central tension, 2 to 3 sentences.' },
    yourRole: { type: 'string', description: "The user's role and what is expected of them, 1 to 2 sentences." },
    openingNarration: { type: 'string', description: 'A second-person cinematic opening beat, 2 to 4 sentences, with no dialogue or quoted speech.' },
    visualPrompt: { type: 'string', description: 'A self-contained cinematic image prompt for the opening scene: environment, weather, objects, atmosphere, and any figures kept small in frame. Visual only, no text, no dialogue, no title.' },
    castSize: {
      type: 'integer',
      enum: [1, 2, 3],
      description: 'The minimum number of characters this story needs. Use 1 for a solitary or single-presence premise, 2 for one necessary relationship, and 3 only when a genuinely multi-voice scene requires it.'
    },
    characters: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      description: 'Exactly castSize characters, every member physically present and able to speak in the opening scene.',
      items: characterSchema
    }
  },
  required: ['title', 'tagline', 'genre', 'era', 'setting', 'mood', 'premise', 'yourRole', 'openingNarration', 'visualPrompt', 'castSize', 'characters']
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
          text: { type: 'string', description: 'The character response: dialogue and action only, 2 to 5 sentences.' }
        },
        required: ['characterId', 'text']
      }
    }
  },
  required: ['narration', 'visualPrompt', 'messages']
});

const scenePromptSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    visualPrompt: {
      type: 'string',
      description: 'A concrete portrait-orientation photorealistic image prompt for the exact moment in this turn, 45 to 80 words, with location, lighting, props, present NPCs, and their visible actions. No dialogue, text, or spoilers.'
    }
  },
  required: ['visualPrompt']
};

const visualDirectorPrompt = `You are the visual director for PersonaPlay, an intimate roleplay app. Your only job is to turn the latest story beat into one concrete image prompt for a photorealistic vertical film still.

The image will be rendered in a 9:16 portrait frame for a mobile screen. Write for the camera, not for a synopsis.

Rules:
- Ground the image in the latest beat: the most recent user action plus the characters' latest replies. Do not merely repeat the opening setting or give a generic establishing shot.
- Choose one specific, filmable consequence of this turn: an object being touched, a door opening, a light changing, a figure entering the frame, or a visible reaction. Show where the characters are, what they are holding, and what has just changed.
- Never reproduce, quote, or summarize dialogue. Translate speech into the listener's posture, the state of the room, and physical details. No lines of speech in the prompt.
- The user is the camera and is never visible. Do not describe or show the user's face, body, clothing, or expression. For a voice-only beat, show the empty room, the radio or device, and the environment instead.
- Include only NPCs who are physically present. Use their appearance, role, and clothing. Specify time of day, weather, motivated light sources, and two or three concrete environmental details from the story.
- Compose for a tall 9:16 frame: foreground, midground, background, with a clear vertical subject and negative space.
- Keep NPC faces turned away, obscured by shadow, weather, or framing. No close-up portraits.
- Do not reveal a secret, a hidden identity, or a future event. Do not invent characters who are not present. Do not include any text, letters, signs, captions, logos, watermarks, or UI.
- Avoid repeating the previous image's exact angle or subject. Choose a fresh visual detail from this turn.
- Write one dense paragraph of 45 to 80 words. No bullets, camera brand names, or meta commentary.

Return only a JSON object that matches the supplied schema.`;

const storyArchitectPrompt = `You are the story architect for PersonaPlay, an intimate, character-driven text roleplay app.

Turn the user's story blueprint into a playable opening with a small, magnetic cast. You are not writing a synopsis. You are building the first breath of a scene that the user can step into.

Craft rules:
- Honour the user's premise, tone, genre, and any named details. Invent around them rather than replacing them.
- Be specific. Prefer concrete places, textures, and tensions over generic fantasy or chosen-one plotting.
- The user is a participant, not an observer. Give them an active role, a reason to be present, and a little unfinished business.
- First decide castSize: the minimum number of characters the story actually needs, from one to three. Default to 1. A one-on-one encounter stays one character: the user is the other half of the scene.
- Use 2 only when the blueprint explicitly brings a second distinct person into the immediate opening, and 3 only when it explicitly calls for an ensemble. Never add an extra neighbour, witness, rival, or intermediary just to manufacture conflict. The story can be intimate with one other presence.
- Then write exactly castSize characters. The array length must match castSize.
- The user is the protagonist and is never part of the cast. Do not invent a character for the user, do not name them, and do not create a role such as "The User", "The Player", or "Protagonist".
- Never create a character who duplicates the user's identity, profession, or role, and never use meta labels such as protagonist, antagonist, ally, or NPC.
- Every character must be physically present in the opening scene and able to interact with the user immediately. Never include a missing, dead, off-screen, or purely referenced character.
- Every character must have a distinct voice and at least one contradiction. Avoid characters who exist only to explain the plot.
- Give each character a concrete age or age range and a role that is specific to this world and situation, never a generic archetype such as The Waiter, The Skeptic, or The Believer. "Unknown" is not an age.
- Names should feel native to the world and easy to distinguish from one another.
- Make the opening narration cinematic and second-person. Establish one clear, immediate situation with a live question in it. Use no dialogue and no quoted speech of any kind; leave all speech to the cast.
- Each openingLine must be that character's actual first move toward the user: dialogue, a gesture, an offer, a warning. It must happen in the present scene. Never write "None", "N/A", or describe why the character is unable to appear.
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
- Do not use markdown headings, bullet lists, emojis, or speaker labels inside character text. Italics for action are allowed but use them sparingly.
- Never reveal a character's secret unless the scene has earned it.
- Set visualPrompt to a fresh, self-contained image prompt for the moment immediately after your replies: the place, light, weather, objects, mood, and the cast's positions or silhouettes. Make it a wide, environment-first background image. No text, lettering, captions, dialogue, watermarks, or UI.
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
    appearance: text(raw?.appearance, 'They are difficult to read at a glance.', 360),
    personality: text(raw?.personality, 'Guarded, observant, and full of contradictions.', 360),
    voice: text(raw?.voice, 'Measured, with a habit of saying more than they mean to.', 240),
    motivation: text(raw?.motivation, 'They want to understand why you are here.', 300),
    secret: text(raw?.secret, 'They know more about this place than they admit.', 300),
    openingLine: text(raw?.openingLine, 'They look up as you enter, and the room goes quiet.', 400),
    accent: ACCENTS[index % ACCENTS.length]
  };
}

function characterIsPresent(character) {
  const opening = text(character?.openingLine, '', 400);
  if (!opening) return false;
  if (/^(none|null|n\/a|—|-)\b/i.test(opening)) return false;
  if (/\b(currently missing|not present|absent from the scene|unable to speak|cannot speak)\b/i.test(opening)) return false;
  return true;
}

function characterIsUserStandIn(character) {
  const role = text(character?.role, '', 180).toLowerCase().replace(/[.!]+$/, '').trim();
  if (['the user', 'user', 'the player', 'player', 'the protagonist', 'protagonist', 'you', 'yourself', 'the reader', 'reader'].includes(role)) {
    return true;
  }
  const description = `${character?.role || ''} ${character?.personality || ''} ${character?.motivation || ''}`;
  return /\b(player character|the user's character|stand-in for the user|represents? the user|self-insert)\b/i.test(description);
}

function normalizeBlueprint(raw) {
  const declaredCastSize = [1, 2, 3].includes(raw?.castSize) ? raw.castSize : 3;
  const rawCharacters = Array.isArray(raw?.characters)
    ? raw.characters
        .filter((character) => characterIsPresent(character) && !characterIsUserStandIn(character))
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
    setting: multiline(raw?.setting, 'A place with too many locked doors and not enough answers.', 600),
    mood: text(raw?.mood, 'Hushed, charged, uncertain', 100),
    premise: multiline(raw?.premise, 'Something is about to change, and you have arrived just in time to be part of it.', 700),
    yourRole: multiline(raw?.yourRole, 'You are the newest arrival, and everyone seems to have been expecting you.', 500),
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
    return normalizeBlueprint(await makeRequest(storyArchitectPrompt, 4096));
  } catch (error) {
    if (!isRetryableGenerationError(error)) throw error;
    console.warn(`Retrying story generation after ${error.code}.`);
    const retrySystem = `${storyArchitectPrompt}\n\nIMPORTANT: Your previous response was incomplete or malformed. Return one complete, valid JSON object that matches the schema. Keep every character field concise.`;
    return normalizeBlueprint(await makeRequest(retrySystem, 4096));
  }
}

async function createReply({ story, characters, messages }) {
  const castSheet = characters.map((character) => (
    `### ${character.name} (${character.pronouns}, ${character.age}) — ${character.role}
Appearance: ${character.appearance}
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
Setting: ${story.setting}
Mood: ${story.mood}
Premise: ${story.premise}
The user's role: ${story.yourRole}
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
      const body = multiline(item?.text, '', 1600);
      if (!character || !body || seen.has(character.id)) return null;
      seen.add(character.id);
      return { characterId: character.id, text: body };
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
    `${character.name} (${character.pronouns}, ${character.age}) — ${character.role}. Appearance: ${character.appearance}`
  )).join('\n');

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
Setting: ${story.setting}
Mood: ${story.mood}
Premise: ${story.premise}
The user's role: ${story.yourRole}
Previous image prompt: ${story.visualPrompt || 'none'}

CAST
${castSheet}

RECENT CONTEXT
${recentContext || '(none)'}

LATEST BEAT
${latestBeat}

Direct a new 9:16 vertical image prompt for the latest beat. Return the JSON object now.`;

  const makeRequest = (system) => callVenice({
    system,
    user: userPrompt,
    schemaName: 'personaplay_scene_prompt',
    schema: scenePromptSchema,
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
    .replace(/\s+/g, ' ')
    .trim();

  if (!visualPrompt) {
    throw new AppError(502, 'The scene director could not frame this moment.', 'empty_visual_prompt');
  }

  const words = visualPrompt.split(/\s+/);
  if (words.length > 85) {
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
    visualPrompt = shortened.replace(/\s+/g, ' ').replace(/[,;:.\s]+$/, '');
    if (!/[.!?]$/.test(visualPrompt)) visualPrompt += '.';
  }

  return visualPrompt;
}

function composeSceneImagePrompt(prompt) {
  const clean = multiline(prompt, '', 1200)
    .replace(
      /\b(painterly|painting|illustration|illustrated|digital art|concept art|watercolor|oil painting|comic|anime|cartoon|cgi|3d render|stylized)\b/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();

  return [
    'Ultra-photorealistic candid photograph of an immersive roleplay scene. This must read as a frame from a live-action film captured on a real location.',
    clean,
    'Vertical 9:16 portrait composition, environment-first, with clear foreground, midground, and background. Shot on 35mm film with a full-frame camera and available light, physically accurate materials, true-to-life textures, realistic human proportions, natural imperfections, deep shadows, shallow depth of field, subtle film grain, restrained color grade. Figures, if present, stay small in the frame or turned away from the camera, with faces obscured by shadow, weather, or framing; no visible facial features and never a close-up portrait. It must look like a real photograph: not a painting, illustration, digital artwork, 3D render, CGI, anime, or stylized image. No plastic skin, beauty retouching, visible camera equipment, text, letters, captions, logos, watermarks, frames, or interface elements.'
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

async function getSceneImage(prompt) {
  const started = Date.now();
  const composed = composeSceneImagePrompt(prompt);
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
    setting: multiline(story.setting, 'An unfamiliar room.', 600),
    mood: text(story.mood, 'Charged', 100),
    premise: multiline(story.premise, 'Something is about to change.', 700),
    yourRole: multiline(story.yourRole, 'You are a newcomer here.', 500),
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
    setting: multiline(story.setting, 'An unfamiliar room.', 600),
    mood: text(story.mood, 'Charged', 100),
    premise: multiline(story.premise, 'Something is about to change.', 700),
    yourRole: multiline(story.yourRole, 'You are a newcomer here.', 500),
    visualPrompt: multiline(story.visualPrompt, '', 900)
  };

  const started = Date.now();
  const visualPrompt = await createScenePromptPlan({ story: safeStory, characters, messages });
  const durationMs = Date.now() - started;
  console.log(`Scene prompt directed in ${(durationMs / 1000).toFixed(1)}s.`);
  return {
    visualPrompt,
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

  const { buffer, cacheKey, cached, composedPrompt, durationMs } = await getSceneImage(prompt);
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
