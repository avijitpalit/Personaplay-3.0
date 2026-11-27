import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Eye,
  EyeOff,
  LoaderCircle,
  Menu,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  X
} from 'lucide-react';
import Logo from './Logo.jsx';
import CharacterAvatar from './CharacterAvatar.jsx';
import MessageText from './MessageText.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import SceneBackdrop from './SceneBackdrop.jsx';
import SceneViewer from './SceneViewer.jsx';
import DebugLogs from './DebugLogs.jsx';
import { settingContextFor, scenePromptForStory } from '../lib/session.js';

function CastPanel({ session, onNewStory, onClose, isOpen }) {
  const { story, characters } = session;
  return (
    <aside
      className={`cast-panel${isOpen ? ' is-open' : ''}`}
      id="cast-panel"
      aria-label="Story and cast"
    >
      <div className="cast-panel__top">
        <Logo compact />
        <button className="icon-button cast-panel__close" type="button" onClick={onClose} aria-label="Close cast panel">
          <X size={18} />
        </button>
      </div>

      <div className="story-identity">
        <span className="genre-pill">{story.genre}</span>
        <h1>{story.title}</h1>
        <p className="story-identity__tagline">{story.tagline}</p>
        <div className="story-facts">
          {story.country && (
            <>
              <span>{story.country}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>{story.era}</span>
          <span aria-hidden="true">·</span>
          <span>{story.mood}</span>
        </div>
      </div>

      <div className="panel-divider" />

      <div className="cast-heading">
        <span>
          <Users size={13} aria-hidden="true" />
          The cast
        </span>
        <span className="cast-heading__count">{String(characters.length).padStart(2, '0')}</span>
      </div>

      <div className="cast-list">
        {characters.map((character) => (
          <article className="cast-card" key={character.id}>
            <CharacterAvatar character={character} size="md" />
            <div className="cast-card__copy">
              <div className="cast-card__name">
                {character.name}
                {character.age && !/^unknown$/i.test(character.age) ? <span>{character.age}</span> : null}
              </div>
              <p>{[character.nationality, character.role].filter(Boolean).join(' · ')}</p>
              {character.emotion && (
                <span className="cast-card__emotion">
                  <span aria-hidden="true" />
                  {character.emotion}
                </span>
              )}
            </div>
            <span className={`cast-card__accent cast-card__accent--${character.accent}`} aria-hidden="true" />
          </article>
        ))}
      </div>

      <div className="your-role">
        <span className="your-role__label">
          <BookOpen size={12} aria-hidden="true" />
          You are
        </span>
        <p>{story.yourRole}</p>
        {story.protagonist && (
          <div className="your-role__identity">
            <span>{story.protagonist.age}</span>
            <span>{story.protagonist.gender}</span>
            <span>{story.protagonist.pronouns}</span>
            {[...new Set([story.protagonist.nationality, story.protagonist.ethnicity].filter(Boolean))].map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
      </div>

      <div className="cast-panel__footer">
        <button className="button button--ghost button--full" type="button" onClick={onNewStory}>
          <RotateCcw size={15} aria-hidden="true" />
          Begin a new story
        </button>
        <p>
          <ShieldCheck size={12} aria-hidden="true" />
          Venice AI · private inference
        </p>
      </div>
    </aside>
  );
}

function ChapterOpening({ story }) {
  return (
    <section className="chapter-opening" aria-label="Chapter one">
      <div className="chapter-opening__rule">
        <span />
        <em>Chapter one</em>
        <span />
      </div>
      <h2>{story.tagline}</h2>
    </section>
  );
}

function NarrationMessage({ message }) {
  return (
    <div className="narration-message">
      <span className="narration-message__mark" aria-hidden="true">
        <Sparkles size={12} />
      </span>
      <p>
        <MessageText text={message.text} />
      </p>
    </div>
  );
}

function legacySpeech(text) {
  const match = text.trim().match(/^\(([\s\S]*)\)$/);
  if (!match) return text;
  const inner = match[1].trim();
  if (!inner || inner.includes('(') || inner.includes(')')) return text;

  const starter = inner.split(/\s+/)[0]?.toLowerCase() || '';
  const dialogueStarters = new Set([
    'ah', 'oh', 'you', 'i', 'we', 'what', 'why', 'how', 'no', 'yes', 'just',
    'so', 'well', 'come', 'don’t', "don't", 'stop', 'please', 'thank', 'sorry',
    'tell', 'look', 'listen', 'wait'
  ]);
  const hasDialoguePunctuation = /[?!]/.test(inner);
  const hasFirstPerson = /\b(?:i|you|we|my|your|our|me|us)\b/i.test(inner);
  return dialogueStarters.has(starter) || (hasDialoguePunctuation && hasFirstPerson)
    ? inner
    : text;
}

function CharacterMessage({ message, character }) {
  if (!character) return null;
  return (
    <article className={`character-message character-message--${character.accent}`}>
      <CharacterAvatar character={character} size="md" />
      <div className="character-message__content">
        <header className="character-message__meta">
          <span className="character-message__name">{character.name}</span>
          <span className="character-message__role">{character.role}</span>
          {(message.emotion || character.emotion) && (
            <span className="character-message__emotion">{message.emotion || character.emotion}</span>
          )}
        </header>
        <p className="character-message__text">
          <MessageText text={legacySpeech(message.text)} />
        </p>
      </div>
    </article>
  );
}

function UserMessage({ message }) {
  if (/^\.+$/.test(message.text.trim())) {
    return (
      <div className="user-message user-message--continue">
        <span className="user-message__label">You</span>
        <span className="user-message__continue">
          <span aria-hidden="true">↳</span>
          Continue
        </span>
      </div>
    );
  }

  return (
    <div className="user-message">
      <span className="user-message__label">You</span>
      <div className="user-message__bubble">
        <MessageText text={message.text} />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="typing-message">
      <span className="typing-message__mark" aria-hidden="true">
        <Sparkles size={15} />
      </span>
      <div>
        <span className="typing-message__label">The scene is turning</span>
        <div className="typing-dots" aria-label="The cast is writing the next beat">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

export default function Chat({
  session,
  onSend,
  onNewStory,
  isReplying,
  scenePromptBusy,
  error,
  onRetry,
  onDismissError,
  logs = [],
  onClearLogs,
  onLog,
  imageModel,
  onOpenSettings
}) {
  const { story, characters, messages } = session;
  const [draft, setDraft] = useState('');
  const [castOpen, setCastOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sceneImageUrl, setSceneImageUrl] = useState('');
  const [sceneImageStatus, setSceneImageStatus] = useState('idle');
  const [sceneImageRefreshKey, setSceneImageRefreshKey] = useState(0);
  const [sceneViewerOpen, setSceneViewerOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const scrollAreaRef = useRef(null);
  const endRef = useRef(null);
  const textareaRef = useRef(null);
  const characterMap = new Map(characters.map((character) => [character.id, character]));
  const sceneImagePrompt = session.sceneImagePrompt || scenePromptForStory(story);
  const sceneSettingContext = settingContextFor(story);
  const sceneTurn = messages.filter((message) => message.type === 'user').length;

  useEffect(() => {
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    endRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, [messages.length, isReplying, error]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
  }, [draft]);

  useEffect(() => {
    if (!castOpen) return undefined;
    const close = (event) => {
      if (event.key === 'Escape') setCastOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [castOpen]);

  const submit = () => {
    const body = draft.trim();
    if (!body || isReplying) return;
    setDraft('');
    setCastOpen(false);
    onSend(body);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const openNewStory = () => setConfirmOpen(true);

  return (
    <div className="chat">
      <CastPanel
        session={session}
        onNewStory={openNewStory}
        onClose={() => setCastOpen(false)}
        isOpen={castOpen}
      />
      <button
        className={`cast-scrim${castOpen ? ' is-visible' : ''}`}
        type="button"
        aria-label="Close cast panel"
        onClick={() => setCastOpen(false)}
        tabIndex={castOpen ? 0 : -1}
      />

      <main className="chat-main" id="main">
        <SceneBackdrop
          prompt={sceneImagePrompt}
          identityLocks={session.sceneIdentityLocks || ''}
          settingContext={sceneSettingContext}
          imageModel={imageModel}
          refreshKey={sceneImageRefreshKey}
          turn={sceneTurn}
          onActiveImage={setSceneImageUrl}
          onStatusChange={setSceneImageStatus}
          onLog={onLog}
        />

        {(scenePromptBusy || sceneImageStatus === 'loading' || sceneImageStatus === 'refreshing') && (
          <div className="scene-status" role="status" aria-live="polite">
            <LoaderCircle className="scene-status__spinner" size={13} aria-hidden="true" />
            <span>
              {scenePromptBusy
                ? 'Writing the image prompt'
                : sceneImageStatus === 'refreshing'
                  ? 'Repainting the scene'
                  : 'Painting the scene'}
            </span>
          </div>
        )}

        <header className="chat-header">
          <div className="chat-header__left">
            <button
              className="icon-button chat-header__menu"
              type="button"
              onClick={() => setCastOpen(true)}
              aria-label="Open story and cast panel"
              aria-expanded={castOpen}
              aria-controls="cast-panel"
            >
              <Menu size={19} />
            </button>
            <div className="chat-header__title">
              <span className="chapter-label">{story.genre} · Chapter one</span>
              <h1>{story.title}</h1>
            </div>
          </div>

          <div className="chat-header__actions">
            <div className="header-cast" aria-label={`${characters.length} characters in this scene`}>
              <div className="avatar-stack" aria-hidden="true">
                {characters.slice(0, 4).map((character) => (
                  <CharacterAvatar key={character.id} character={character} size="sm" />
                ))}
              </div>
              <span>{characters.length} in the scene</span>
            </div>
            <button
              className={`button button--quiet chat-header__logs${logsOpen ? ' is-active' : ''}`}
              type="button"
              onClick={() => setLogsOpen((current) => !current)}
              aria-expanded={logsOpen}
              aria-controls="debug-panel"
              aria-label={logsOpen ? 'Close debug logs' : 'Open debug logs'}
            >
              <Terminal size={14} aria-hidden="true" />
              <span aria-hidden="true">Logs</span>
              {logs.length > 0 && <span className="chat-header__logs-count">{logs.length}</span>}
            </button>
            <button
              className="button button--quiet chat-header__settings"
              type="button"
              onClick={onOpenSettings}
              aria-label="Open settings"
            >
              <Settings size={14} aria-hidden="true" />
              <span aria-hidden="true">Settings</span>
            </button>
          </div>
        </header>

        <div
          className="chat-scroll"
          ref={scrollAreaRef}
          role="log"
          aria-label="Scene transcript"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={isReplying}
        >
          <div className="message-column">
            <ChapterOpening story={story} />

            {messages.map((message) => {
              if (message.type === 'narration') {
                return <NarrationMessage message={message} key={message.id} />;
              }
              if (message.type === 'user') {
                return <UserMessage message={message} key={message.id} />;
              }
              return (
                <CharacterMessage
                  message={message}
                  character={characterMap.get(message.characterId)}
                  key={message.id}
                />
              );
            })}

            {isReplying && <TypingIndicator />}
            <div className="scroll-anchor" ref={endRef} />
          </div>
        </div>

        <div className="composer-area">
          <div className="composer-inner">
            {error && (
              <div className="alert alert--composer" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
                <p>{error}</p>
                <button className="alert__retry" type="button" onClick={onRetry} disabled={isReplying}>
                  Retry
                </button>
                <button className="alert__dismiss" type="button" onClick={onDismissError} aria-label="Dismiss error">
                  <X size={15} />
                </button>
              </div>
            )}

            <div className="composer-meta">
              <span className="composer-meta__live">
                <span className={`pulse-dot${isReplying ? ' pulse-dot--busy' : ''}`} aria-hidden="true" />
                {isReplying ? 'The cast is responding' : 'Scene in progress'}
              </span>
              <div className="composer-meta__right">
                <span className="composer-meta__cast">
                  <Users size={12} aria-hidden="true" />
                  {characters.length} {characters.length === 1 ? 'character' : 'characters'} listening
                </span>
              </div>
            </div>

            <form className="composer" onSubmit={handleSubmit}>
              <label className="sr-only" htmlFor="scene-input">
                What do you do?
              </label>
              <textarea
                ref={textareaRef}
                id="scene-input"
                className="composer__input"
                value={draft}
                onChange={(event) => setDraft(event.target.value.slice(0, 1200))}
                onKeyDown={handleKeyDown}
                placeholder={isReplying ? 'Let the scene unfold…' : 'What do you do?'}
                rows={1}
                maxLength={1200}
                spellCheck="true"
              />
              <div className="composer__footer">
                <span className="composer__hint">Enter to send · Shift + Enter for a new line</span>
                <button
                  className="composer__send"
                  type="submit"
                  disabled={!draft.trim() || isReplying}
                  aria-label="Send your move"
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </form>
            <p className="composer-note">Your words steer the scene. The cast will take it from there.</p>
          </div>
        </div>
      </main>

      {(sceneImageUrl || sceneImageStatus === 'error') && (
        <div className="scene-controls">
          {sceneImageUrl && (
            <button
              className={`scene-controls__button${sceneViewerOpen ? ' is-active' : ''}`}
              type="button"
              onClick={() => setSceneViewerOpen((current) => !current)}
              aria-label={sceneViewerOpen ? 'Hide the full scene image' : 'Show the full scene image'}
              aria-pressed={sceneViewerOpen}
              title={sceneViewerOpen ? 'Hide full image' : 'Show full image'}
            >
              {sceneViewerOpen ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
            </button>
          )}
          {sceneImageStatus === 'error' && (
            <button
              className="scene-controls__retry"
              type="button"
              onClick={() => setSceneImageRefreshKey((current) => current + 1)}
              aria-label="Regenerate scene image"
              title="Regenerate scene image"
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>Retry</span>
            </button>
          )}
        </div>
      )}

      <DebugLogs
        open={logsOpen}
        logs={logs}
        session={session}
        scenePromptBusy={scenePromptBusy}
        sceneImageStatus={sceneImageStatus}
        onClose={() => setLogsOpen(false)}
        onClear={onClearLogs}
      />

      <SceneViewer
        open={sceneViewerOpen}
        imageUrl={sceneImageUrl}
        onClose={() => setSceneViewerOpen(false)}
      />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          onNewStory();
        }}
      />
    </div>
  );
}
