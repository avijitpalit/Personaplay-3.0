import { useRef } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Feather,
  ShieldCheck,
  Sparkles,
  Users
} from 'lucide-react';
import Logo from './Logo.jsx';
import CharacterAvatar from './CharacterAvatar.jsx';

const SEEDS = [
  {
    label: 'Rain-soaked noir',
    text: 'A rain-soaked noir in a city that never quite dries out. I am a missing-persons detective, and a dead woman’s address book has just led me to a door with my own name on it. The person who answers is not surprised to see me.'
  },
  {
    label: 'A ship in deep space',
    text: 'A generation ship wakes me forty years too early. The corridors are empty, the stars are wrong, and the only other person awake has clearly been waiting a very long time for me. They say the ship has started dreaming.'
  },
  {
    label: 'Coastal gothic',
    text: 'A small coastal town where everyone remembers a different version of my childhood. I have come back for my sister’s funeral, but the woman in the casket is wearing my old coat, and the tide is already coming in.'
  },
  {
    label: 'A faerie debt',
    text: 'The faerie court beneath the botanical gardens has summoned me to settle a debt I do not remember making. The queen offers me a single night to find the truth. Her champion has been assigned to make sure I do not survive it.'
  }
];

const PREVIEW_CAST = [
  { name: 'Mara Vale', accent: 'ember' },
  { name: 'Ivo Sayer', accent: 'tide' }
];

export default function Landing({ draft, onDraftChange, onSubmit, error, autoFocus = false }) {
  const textareaRef = useRef(null);
  const canSubmit = draft.trim().length >= 12;

  const fillSeed = (seed) => {
    onDraftChange(seed);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(seed.length, seed.length);
    });
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };

  const handleKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="home">
      <header className="home__header">
        <Logo />
        <div className="home__header-right">
          <span className="live-chip">
            <span className="pulse-dot" aria-hidden="true" />
            Casting live worlds
          </span>
          <span className="engine-chip">Venice AI</span>
        </div>
      </header>

      <main className="home__main" id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="eyebrow hero__eyebrow">
            <span className="eyebrow__line" aria-hidden="true" />
            A story engine with a pulse
          </div>

          <h1 className="hero__title" id="hero-title">
            Step inside.
            <br />
            <em>The cast is waiting.</em>
          </h1>

          <p className="hero__lede">
            Describe a world, a moment, or a dangerous what-if. PersonaPlay reads your blueprint,
            gives it a cast with secrets of their own, and hands you the first line.
          </p>

          <form className="blueprint" onSubmit={handleSubmit}>
            <div className="blueprint__head">
              <label className="field-label" htmlFor="story-blueprint">
                <Feather size={13} aria-hidden="true" />
                Your story blueprint
              </label>
              <span className="field-count">{draft.length.toLocaleString()} / 1,600</span>
            </div>

            <textarea
              ref={textareaRef}
              id="story-blueprint"
              className="blueprint__input"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value.slice(0, 1600))}
              onKeyDown={handleKeyDown}
              placeholder="Somewhere it has been raining for three days. I arrive at a lighthouse with a letter for the keeper, who vanished without a trace. The woman waiting at the door says she has been expecting me…"
              rows={5}
              maxLength={1600}
              autoFocus={autoFocus}
              spellCheck="true"
            />

            <div className="seed-row" aria-label="Story starting points">
              <span className="seed-row__label">Try a seed</span>
              {SEEDS.map((seed) => (
                <button
                  className="seed"
                  type="button"
                  key={seed.label}
                  onClick={() => fillSeed(seed.text)}
                  title={seed.text}
                >
                  {seed.label}
                </button>
              ))}
            </div>

            <div className="blueprint__action">
              <button className="button button--warm button--cast" type="submit" disabled={!canSubmit}>
                <Sparkles size={16} aria-hidden="true" />
                Cast my story
                <ArrowUpRight size={16} aria-hidden="true" />
              </button>
              <span className="blueprint__privacy">
                <ShieldCheck size={13} aria-hidden="true" />
                Your key stays on the server
              </span>
            </div>
          </form>

          {error && (
            <div className="alert alert--home" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          <div className="home__footnotes" aria-label="How it works">
            <span>
              <Users size={13} aria-hidden="true" />
              Only the characters the story needs
            </span>
            <span>
              <BookOpen size={13} aria-hidden="true" />
              An opening scene, written live
            </span>
            <span>
              <Sparkles size={13} aria-hidden="true" />
              No two stories alike
            </span>
          </div>
        </section>

        <aside className="preview-stage" aria-label="Example story preview">
          <div className="preview-stage__orbit preview-stage__orbit--one" aria-hidden="true" />
          <div className="preview-stage__orbit preview-stage__orbit--two" aria-hidden="true" />
          <div className="preview-stage__orbit-dot" aria-hidden="true" />

          <div className="story-preview">
            <div className="story-preview__top">
              <span className="story-preview__live">
                <span className="pulse-dot" aria-hidden="true" />
                Story preview
              </span>
              <span className="story-preview__number">No. 01</span>
            </div>

            <div className="story-preview__identity">
              <span className="story-preview__genre">Gothic mystery · The coast</span>
              <h2>The Salt House</h2>
              <p className="story-preview__tagline">The lighthouse has been dark for three nights.</p>
            </div>

            <blockquote className="story-preview__quote">
              <span aria-hidden="true">“</span>
              The sea has been taking things from this town for years. Tonight, it has sent something
              back.
            </blockquote>

            <div className="story-preview__cast">
              <div className="avatar-stack" aria-hidden="true">
                {PREVIEW_CAST.map((character) => (
                  <CharacterAvatar key={character.name} character={character} size="sm" />
                ))}
              </div>
              <span>Mara Vale &amp; Ivo Sayer</span>
              <span className="story-preview__cast-count">Cast of 2</span>
            </div>

            <div className="preview-message">
              <CharacterAvatar character={PREVIEW_CAST[0]} size="md" />
              <div>
                <div className="preview-message__name">
                  Mara Vale <span>Keeper of the light</span>
                </div>
                <p>“You’re late. The tide already took the others.”</p>
              </div>
            </div>

            <div className="preview-composer" aria-hidden="true">
              <span>Your next line</span>
              <span className="preview-composer__caret" />
            </div>
          </div>

          <p className="preview-stage__caption">
            <Sparkles size={12} aria-hidden="true" />
            An example of the worlds waiting to be made
          </p>
        </aside>
      </main>

      <footer className="home__footer">
        <span>Stories, improvised live</span>
        <span className="home__footer-dot" aria-hidden="true" />
        <span>Your words steer. The cast listens.</span>
        <span className="home__footer-right">PersonaPlay · 2026</span>
      </footer>
    </div>
  );
}
