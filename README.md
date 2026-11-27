# PersonaPlay

A React + Vite roleplay app that turns a story blueprint into a live scene with an original AI cast.

Write a premise on the opening screen, press **Cast my story**, and Venice AI builds the smallest
cast the story needs, an opening narration, and each character's first move. The app then becomes a
roleplay chat where you steer the scene, and a scene illustration is painted into the background as
the conversation moves.

## Run it

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173**.

The Venice key is kept on the Node server — it is never sent to the browser or bundled into the
client. A local `.env.local` is already configured in this workspace. To set it up elsewhere:

```bash
cp .env.example .env.local
# Windows PowerShell: Copy-Item .env.example .env.local
```

Then add your key:

```dotenv
VENICE_API_KEY=your_venice_inference_key
VENICE_MODEL=venice-uncensored
PORT=5173

SCENE_IMAGE_URL=https://avijitpalit3--z-image-turbo-zimageservice-fastapi-app.modal.run/generate
SCENE_IMAGE_WIDTH=720
SCENE_IMAGE_HEIGHT=1280
SCENE_IMAGE_STEPS=9
RUNPOD_API_KEY=your_runpod_api_key
RUNPOD_ZIMAGE_ENDPOINT=https://api.runpod.ai/v2/z-image-turbo
RUNPOD_TIMEOUT_MS=48000
```

`VENICE_MODEL` accepts any Venice chat model. The default is the model from the supplied example,
`venice-uncensored`. Scene image dimensions must be multiples of 16 for the Z-Image pipeline; the
default is a 9:16 portrait frame at 720×1280, optimized for mobile.

### Production build

```bash
npm run build
npm run start
```

`npm run preview` builds first and then serves the production app. The Express server serves the
built `dist/` and the same API routes, so this is a complete local production setup, not just a
static Vite preview.

## Deploy on Vercel

The app is Vercel-ready. Vite builds the frontend under `dist/`, and the same API surface is provided
as Vercel Functions in `api/`, sharing all business logic through `lib/personaplay-core.mjs`:

- `api/story.js`
- `api/story/reply.js`
- `api/scene-prompt.js`
- `api/scene-image.js`
- `api/health.js`

Configure these **Environment Variables** on the Vercel project (Production, Preview, and
Development), then redeploy:

```dotenv
VENICE_API_KEY=your_venice_inference_key
VENICE_MODEL=venice-uncensored
SCENE_IMAGE_URL=https://avijitpalit3--z-image-turbo-zimageservice-fastapi-app.modal.run/generate
SCENE_IMAGE_WIDTH=720
SCENE_IMAGE_HEIGHT=1280
SCENE_IMAGE_STEPS=9
RUNPOD_API_KEY=your_runpod_api_key
RUNPOD_ZIMAGE_ENDPOINT=https://api.runpod.ai/v2/z-image-turbo
RUNPOD_TIMEOUT_MS=48000
```

`vercel.json` raises the function limit to 60 seconds because photoreal scene generation can take
15–45 seconds. On a Vercel plan with a lower function-duration cap, image requests may time out; the
retry button can be used. `server.mjs` is only the local/VPS server and is not used by Vercel.

## What it does

- **Blueprint to cast:** one structured Venice call produces the title, setting, premise, player
  identity, opening narration, an illustration prompt, and the minimum cast the story needs — from
  one to three NPCs. A solitary premise gets one character; extra characters are only added when the
  story itself calls for them. The player is never generated as a separate NPC, even in a
  multi-person opening. If the blueprint does not specify the player, they default to a 22-year-old
  man; an explicitly stated age or gender is preserved.
- **Roleplay format:** character replies keep spoken words outside parentheses and put every
  physical action, gesture, and private thought inside parentheses. The UI renders those
  parenthetical beats as italic, warm-toned action text without showing the brackets; quoted speech
  stays in the normal voice. Dialogue follows the blueprint's language mix and register — Hinglish,
  regional slang, and code-switching are preserved rather than translated. The scene honours the
  blueprint's adult tone and dynamics without sanitising or moralising.
- **Consistent characters:** every NPC gets an immutable identity card — face shape, skin tone,
  nationality, ethnicity, eyes, hair, build, height, age, and a distinctive feature. That identity
  is repeated verbatim in every image prompt. The story's country/region and each character's
  nationality and ethnicity are inferred from the initial blueprint and carried into the image
  prompt. Outfits, poses, emotion, and environment change with the scene, but physical and cultural
  identity does not.
- **Emotional state:** every NPC carries a current, realistic emotion with a subtle visible cue.
  Emotions update after each reply, appear in the cast and message UI, and drive physical
  expression in the generated scene image. The image prompt asks for understated, photorealistic
  microexpressions.
- **A focused visual director:** after the opening and after every character reply, a dedicated
  Venice call reads the latest beat, the cast's current emotion and outfits, and the previous image
  prompt, then writes a specific 9:16 image prompt about what just happened — not a generic
  establishing shot. It also returns a compact `environment` anchor and a `sceneShift` verdict:
  `continue` keeps the previous location, architecture, light and palette while the camera angle
  changes, and `new-location` rebuilds the background when the beat makes a hard move (going
  outside, crossing into another building, travelling). A clear move in the player's latest action
  forces `new-location` even if the director was cautious. The server adds the present NPCs'
  immutable identity locks, an exact "people in frame" count that forbids duplicates, twins and
  reflections, and the Modal **Z-Image-Turbo** endpoint renders a photorealistic vertical film
  still. The PNG is cached and
  crossfaded into the background. A single thumb-friendly **Eye / Eye-off control on the
  middle-right edge** toggles the full-screen image; it stays in the same place and changes icon
  rather than handing off to a separate top-right close button. If generation fails, a **Retry**
  control appears in the same position.
- **Structured output:** Venice's JSON Schema response format is used for story creation, scene
  replies, and image prompting, with automatic retries for truncated or malformed responses.
- **Image model picker:** a **Settings** panel is available from the landing page and from the
  chat header (beside **Logs**). It contains a saved dropdown choosing between the Modal and RunPod
  Z-Image-Turbo endpoints. Changing the model repaints the current scene with the same prompt and
  identity locks.
- **Live debug snapshot:** a **Logs** button in the top bar opens a consolidated, variable-first
  drawer instead of an event feed. It shows the turn, latest action/reply, text model and timings,
  player role and identity, full cast state (emotion, outfit, immutable identity), image status,
  scene prompt, identity locks, final styled prompt, dimensions, model, cache, timings, errors, and
  a raw JSON snapshot. Copy the snapshot or clear the event history.
- **Generation status:** a floating status pill shows when the image prompt is being written or the
  scene is being painted/repainted in the background.
- **Group scene:** every character is present and can speak. On each user turn the director picks
  one or two characters to respond, rotates the spotlight, and may add a short narration beat.
- **A real chat UI:** character avatars and roles, narration interludes, user bubbles, typing state,
  error + retry states, auto-scroll, and an auto-growing composer. Enter sends, Shift+Enter adds a
  newline.
- **Story panel:** genre, tagline, era, mood, country, the full cast (with nationality), and the
  user's role. It becomes an off-canvas drawer on smaller screens.
- **Persistence:** the current story, transcript, and latest visual prompt are saved in
  `localStorage`. Refreshing restores the scene and the cached illustration. **New story** clears it
  after a confirmation dialog.
- **Responsive and accessible:** mobile layout, keyboard focus states, native confirmation dialog,
  reduced-motion support, semantic labels, and `aria-live` feedback.

### Image providers

The default Modal endpoint is configured with `SCENE_IMAGE_URL`. The optional RunPod endpoint uses
`RUNPOD_API_KEY` and `RUNPOD_ZIMAGE_ENDPOINT` (default `https://api.runpod.ai/v2/z-image-turbo`).
RunPod is queued, so it polls the job status and can take longer; `RUNPOD_TIMEOUT_MS` caps the
server-side wait (default `48000`). Select it from **Settings**; the choice is stored in the browser
and applies to the opening image and every subsequent repaint.

## Project structure

```text
server.mjs                     local Express/Vite server
api/                           Vercel Functions for production
lib/personaplay-core.mjs       shared Venice/Modal logic and validation
lib/serverless.mjs             Vercel request/response helpers
vercel.json                    function duration configuration
src/App.jsx                    app-level state, creation, reply flow, localStorage persistence
src/components/Landing.jsx     first-screen blueprint form and story preview
src/components/Generating.jsx
src/components/Chat.jsx        cast panel, transcript, composer
src/components/SceneBackdrop.jsx crossfading generated scene art
src/components/SceneViewer.jsx full-screen, text-free image view
src/components/DebugLogs.jsx   per-turn parameter and timing drawer
src/components/SettingsPanel.jsx image model settings
src/lib/imageModels.js         image model options and saved preference
src/lib/api.js                 browser-side API wrapper
src/lib/session.js             session shape and storage
src/styles.css                 visual system and responsive layout
```

## API endpoints

- `GET /api/health` — server, model, and scene-image configuration status.
- `POST /api/story` — body `{ prompt }`; returns `{ story, characters }` including `visualPrompt`.
- `POST /api/story/reply` — body `{ story, characters, messages }`; returns
  `{ narration, visualPrompt, messages }`.
- `POST /api/scene-prompt` — body `{ story, characters, messages }`; returns
  `{ visualPrompt, presentCharacterIds, environment, sceneShift, identityLocks, meta }` from the
  visual director. An explicit `presentCharacterIds: []` means the frame has no people.
- `POST /api/scene-image` — body
  `{ prompt, identityLocks, settingContext, environment, sceneShift, previousPrompt, imageModel }`;
  returns a 720×1280 PNG from Z-Image-Turbo (Modal or RunPod), plus debug headers with the final
  styled prompt, dimensions, cache status, model, scene shift, and timing. `settingContext` carries
  the story's country/region and era into the final prompt. `environment` and `previousPrompt` are
  background continuity references; `sceneShift: 'new-location'` tells the composer to ignore them
  and rebuild the place from the new prompt.

Messages have `type` values of `narration`, `character`, or `user`. Character messages carry a
`characterId` from the cast.

## Notes

- The browser never talks to Venice or Modal directly. All inference is proxied through
  `server.mjs`; the Venice key stays server-side.
- Generated scene images are cached by a hash of the fully composed prompt (including identity
  locks and background continuity) in `.cache/scene-images/`, so refreshes and repeat prompts load
  instantly without spending GPU time. Image prompts are wrapped in a realism-first photographic
  treatment, kept under the provider's prompt budget so identity locks are not truncated, and
  rendered in 9:16 so the scene art reads as a still from a real film.
- Debug logs live only in the current browser tab and are cleared when a new story begins.
- `.env.local`, build output, `.cache/`, and `.screenshots/` are git-ignored.
- The text model can be swapped without touching the frontend, for example
  `VENICE_MODEL=venice-uncensored-role-play`.
