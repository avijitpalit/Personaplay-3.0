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
```

`vercel.json` raises the function limit to 60 seconds because photoreal scene generation can take
15–45 seconds. On a Vercel plan with a lower function-duration cap, image requests may time out; the
retry button can be used. `server.mjs` is only the local/VPS server and is not used by Vercel.

## What it does

- **Blueprint to cast:** one structured Venice call produces the title, setting, premise, user role,
  opening narration, an illustration prompt, and the minimum cast the story needs — from one to
  three characters. A solitary premise gets one character; extra characters are only added when the
  story itself calls for them.
- **A focused visual director:** after the opening and after every character reply, a dedicated
  Venice call reads the latest beat, the cast's appearances, and the previous image prompt, then
  writes a specific 9:16 image prompt about what just happened — not a generic establishing shot.
  The Modal **Z-Image-Turbo** endpoint renders it as a photorealistic vertical film still, the
  server caches the PNG, and the chat crossfades it into the background. **Full image** opens the
  current image alone, full-screen, with all chat text hidden.
- **Structured output:** Venice's JSON Schema response format is used for story creation, scene
  replies, and image prompting, with automatic retries for truncated or malformed responses.
- **Live debug log:** a **Logs** button in the composer opens a drawer showing each turn's request
  payload, model response, selected image prompt, final styled image prompt, dimensions, timings,
  cache status, and errors. Copy a single entry or export the whole log as JSON.
- **Generation status:** a floating status pill shows when the image prompt is being written or the
  scene is being painted/repainted in the background.
- **Group scene:** every character is present and can speak. On each user turn the director picks
  one or two characters to respond, rotates the spotlight, and may add a short narration beat.
- **A real chat UI:** character avatars and roles, narration interludes, user bubbles, typing state,
  error + retry states, auto-scroll, and an auto-growing composer. Enter sends, Shift+Enter adds a
  newline.
- **Story panel:** genre, tagline, era, mood, the full cast, and the user's role. It becomes an
  off-canvas drawer on smaller screens.
- **Persistence:** the current story, transcript, and latest visual prompt are saved in
  `localStorage`. Refreshing restores the scene and the cached illustration. **New story** clears it
  after a confirmation dialog.
- **Responsive and accessible:** mobile layout, keyboard focus states, native confirmation dialog,
  reduced-motion support, semantic labels, and `aria-live` feedback.

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
  `{ visualPrompt, meta }` from the dedicated visual director.
- `POST /api/scene-image` — body `{ prompt }`; returns a 720×1280 PNG from Z-Image-Turbo, plus
  debug headers with the final styled prompt, dimensions, cache status, and timing.

Messages have `type` values of `narration`, `character`, or `user`. Character messages carry a
`characterId` from the cast.

## Notes

- The browser never talks to Venice or Modal directly. All inference is proxied through
  `server.mjs`; the Venice key stays server-side.
- Generated scene images are cached by prompt hash in `.cache/scene-images/`, so refreshes and
  repeat prompts load instantly without spending GPU time. Image prompts are wrapped in a
  realism-first photographic treatment and rendered in 9:16 so the scene art reads as a still from
  a real film.
- Debug logs live only in the current browser tab and are cleared when a new story begins.
- `.env.local`, build output, `.cache/`, and `.screenshots/` are git-ignored.
- The text model can be swapped without touching the frontend, for example
  `VENICE_MODEL=venice-uncensored-role-play`.
