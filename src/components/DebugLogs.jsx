import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Terminal, Trash2, X } from 'lucide-react';

function latestLog(logs, scope, message) {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const entry = logs[index];
    if (entry.scope === scope && (!message || entry.message === message)) return entry;
  }
  return null;
}

function latestError(logs, scope) {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const entry = logs[index];
    if (entry.scope === scope && entry.level === 'error') return entry;
  }
  return null;
}

function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function valueOrDash(value) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function Field({ label, value, wide = false, mono = false }) {
  return (
    <div className={`debug-field${wide ? ' debug-field--wide' : ''}`}>
      <span className="debug-field__label">{label}</span>
      <span className={`debug-field__value${mono ? ' debug-field__value--mono' : ''}`}>
        {valueOrDash(value)}
      </span>
    </div>
  );
}

export default function DebugLogs({
  open,
  logs,
  session,
  scenePromptBusy,
  sceneImageStatus,
  onClose,
  onClear
}) {
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const [copied, setCopied] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [debugNote, setDebugNote] = useState('');
  const [fileName, setFileName] = useState('');
  const copyTimerRef = useRef(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (downloadOpen) {
        setDownloadOpen(false);
      } else {
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, downloadOpen]);

  useEffect(() => () => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
  }, []);

  const snapshot = useMemo(() => {
    if (!session) return null;

    const storyLog = latestLog(logs, 'story', 'Story and cast generated');
    const replyLog = latestLog(logs, 'reply', 'Character reply received');
    const promptLog = latestLog(logs, 'scene-prompt', 'Scene image prompt ready');
    const appliedLog = latestLog(logs, 'scene-prompt', 'Prompt applied to the scene backdrop');
    const imageLog = latestLog(logs, 'image', 'Scene image received');
    const imageStartLog = [...logs]
      .reverse()
      .find((entry) => entry.scope === 'image' && entry.details?.requestedModel);
    const lastImageError = latestError(logs, 'image');
    const imageError =
      lastImageError && (!imageLog || lastImageError.at > imageLog.at) ? lastImageError : null;

    const imageDetails = imageLog?.details || {};
    const latestUserMessage = [...session.messages]
      .reverse()
      .find((message) => message.type === 'user');
    const latestCharacterMessages = session.messages
      .filter((message) => message.type === 'character')
      .slice(-3);
    const scenePrompt =
      appliedLog?.details?.visualPrompt ||
      promptLog?.details?.selectedPrompt ||
      session.sceneImagePrompt ||
      '';
    const identityLocks =
      appliedLog?.details?.identityLocks ||
      promptLog?.details?.identityLocks ||
      session.sceneIdentityLocks ||
      '';
    const presentCharacterIds =
      appliedLog?.details?.presentCharacterIds ||
      promptLog?.details?.presentCharacterIds ||
      session.scenePresentCharacterIds ||
      [];
    const imagePhase = scenePromptBusy
      ? 'writing prompt'
      : sceneImageStatus === 'refreshing'
        ? 'repainting'
        : sceneImageStatus === 'loading'
          ? 'painting'
          : sceneImageStatus === 'error'
            ? 'failed'
            : sceneImageStatus === 'ready'
              ? 'ready'
              : 'idle';

    return {
      turn: session.messages.filter((message) => message.type === 'user').length,
      phase: imagePhase,
      story: session.story,
      protagonist: session.story?.protagonist,
      characters: session.characters,
      initialStory:
        session.initialStory || storyLog?.details?.request?.prompt || '',
      latestUserMessage: latestUserMessage?.text || '',
      latestReply: latestCharacterMessages,
      messageCount: session.messages.length,
      eventCount: logs.length,
      storyGeneration: storyLog?.details || null,
      replyGeneration: replyLog?.details || null,
      scenePrompt: {
        visualPrompt: scenePrompt,
        identityLocks,
        presentCharacterIds,
        planningTimeMs: promptLog?.details?.durationMs || null,
        plannerResponse: promptLog?.details?.response || null,
        sceneShift:
          appliedLog?.details?.sceneShift || promptLog?.details?.sceneShift || session.sceneShift || 'continue',
        environment:
          appliedLog?.details?.environment || promptLog?.details?.environment || session.sceneEnvironment || '',
        previousPrompt:
          appliedLog?.details?.previousPrompt || session.scenePreviousImagePrompt || ''
      },
      image: {
        status: sceneImageStatus,
        phase: imagePhase,
        finalStyledPrompt: imageDetails.finalPrompt || '',
        model: imageDetails.model || null,
        requestedModel: imageDetails.requestedModel || imageStartLog?.details?.requestedModel || null,
        width: imageDetails.width || null,
        height: imageDetails.height || null,
        steps: imageDetails.steps || null,
        cache: imageDetails.cache || null,
        imageId: imageDetails.imageId || null,
        requestPrompt: imageDetails.requestPrompt || scenePrompt,
        settingContext: imageDetails.settingContext || '',
        sceneShift: imageDetails.sceneShift || session.sceneShift || 'continue',
        environment: imageDetails.environment || session.sceneEnvironment || '',
        previousPrompt: imageDetails.previousPrompt || session.scenePreviousImagePrompt || '',
        clientDurationMs: imageDetails.durationMs || null,
        serverDurationMs: imageDetails.serverDurationMs || null,
        bytes: imageDetails.bytes || null,
        error: imageError?.details?.error || null
      }
    };
  }, [logs, session, sceneImageStatus, scenePromptBusy]);

  const copySnapshot = async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(jsonText(snapshot));
      setCopied(true);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const openDownload = () => {
    if (!snapshot) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    setDebugNote('');
    setFileName(`personaplay-turn-${snapshot.turn}-${stamp}.json`);
    setDownloadOpen(true);
  };

  const downloadSnapshot = () => {
    if (!snapshot) return;
    const safeName =
      fileName.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-') ||
      `personaplay-turn-${snapshot.turn}.json`;
    const payload = { ...snapshot, debugNote: debugNote.trim() };
    const blob = new Blob([jsonText(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    setDownloadOpen(false);
  };

  if (!open || !snapshot) return null;

  const image = snapshot.image;
  const story = snapshot.story || {};
  const protagonist = snapshot.protagonist || {};

  return (
    <aside className="debug-panel" id="debug-panel" role="complementary" aria-label="Debug logs">
      <header className="debug-panel__header">
        <div className="debug-panel__identity">
          <span className="debug-panel__eyebrow">
            <Terminal size={12} aria-hidden="true" />
            Dev tools
          </span>
          <div className="debug-panel__title-row">
            <h2>Turn snapshot</h2>
            <span className="debug-panel__count">Turn {snapshot.turn}</span>
          </div>
          <p>All active variables for the current turn, in one view.</p>
        </div>
        <div className="debug-panel__tools">
          <button
            className="debug-panel__tool"
            type="button"
            onClick={copySnapshot}
            aria-label="Copy debug snapshot"
            title="Copy snapshot as JSON"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            className="debug-panel__tool"
            type="button"
            onClick={onClear}
            aria-label="Clear debug logs"
            title="Clear event history"
          >
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
          <button
            className="debug-panel__tool"
            type="button"
            onClick={openDownload}
            aria-label="Download debug snapshot"
            title="Download snapshot with a note"
          >
            <Download size={14} />
            <span>Download</span>
          </button>
          <button
            ref={closeRef}
            className="debug-panel__close"
            type="button"
            onClick={onClose}
            aria-label="Dismiss debug logs"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="debug-panel__scroll">
        <div className="debug-summary">
          <span className={`debug-summary__phase debug-summary__phase--${image.phase.replace(/\s+/g, '-')}`}>
            {image.phase}
          </span>
          <span>{snapshot.messageCount} messages</span>
          <span>{snapshot.eventCount} events</span>
        </div>

        <section className="debug-section">
          <h3>Turn</h3>
          <div className="debug-grid">
            <Field label="Turn" value={snapshot.turn} />
            <Field label="Messages" value={snapshot.messageCount} />
            <Field label="Latest user action" value={snapshot.latestUserMessage} wide />
            <Field
              label="Latest character reply"
              value={
                snapshot.latestReply.length
                  ? snapshot.latestReply
                      .map((message) => `${message.characterId}: ${message.text}`)
                      .join('\n\n')
                  : '—'
              }
              wide
            />
          </div>
        </section>

        <section className="debug-section">
          <h3>Story</h3>
          <div className="debug-grid">
            <Field label="Initial story" value={snapshot.initialStory} wide />
            <Field label="Title" value={story.title} />
            <Field label="Genre" value={story.genre} />
            <Field label="Country / region" value={story.country} />
            <Field
              label="Text model"
              value={snapshot.storyGeneration?.response?.meta?.model || snapshot.replyGeneration?.response?.meta?.model}
            />
            <Field label="Story time" value={snapshot.storyGeneration?.durationMs ? `${snapshot.storyGeneration.durationMs} ms` : '—'} />
            <Field label="Reply time" value={snapshot.replyGeneration?.durationMs ? `${snapshot.replyGeneration.durationMs} ms` : '—'} />
            <Field label="Player role" value={story.yourRole} wide />
            <Field
              label="Protagonist"
              value={`${protagonist.age || '22'} · ${protagonist.gender || 'man'} · ${protagonist.pronouns || 'he/him'}`}
            />
            <Field
              label="Player background"
              value={[...new Set([protagonist.nationality, protagonist.ethnicity].filter(Boolean))].join(' · ')}
            />
            <Field label="Player appearance" value={protagonist.appearance} wide />
          </div>
        </section>

        <section className="debug-section">
          <h3>Cast state</h3>
          <div className="debug-cast">
            {snapshot.characters.map((character) => (
              <article className="debug-cast__item" key={character.id}>
                <div className="debug-cast__head">
                  <strong>{character.name}</strong>
                  <span>{character.role}</span>
                  <em>{character.emotion || 'guarded'}</em>
                </div>
                <Field label="Age / pronouns" value={`${character.age} · ${character.pronouns}`} />
                <Field
                  label="Nationality / ethnicity"
                  value={[...new Set([character.nationality, character.ethnicity].filter(Boolean))].join(' · ')}
                />
                <Field label="Outfit" value={character.outfit} />
                <Field label="Immutable identity" value={character.appearance} />
              </article>
            ))}
          </div>
        </section>

        <section className="debug-section">
          <h3>Image pipeline</h3>
          <div className="debug-grid">
            <Field label="Status" value={image.phase} />
            <Field label="Image model" value={image.model || image.requestedModel} />
            <Field label="Dimensions" value={image.width && image.height ? `${image.width}×${image.height}` : '—'} />
            <Field label="Steps" value={image.steps} />
            <Field label="Cache" value={image.cache} />
            <Field label="Image ID" value={image.imageId} />
            <Field label="Planner time" value={snapshot.scenePrompt.planningTimeMs ? `${snapshot.scenePrompt.planningTimeMs} ms` : '—'} />
            <Field label="Client image time" value={image.clientDurationMs ? `${image.clientDurationMs} ms` : '—'} />
            <Field label="Server image time" value={image.serverDurationMs ? `${image.serverDurationMs} ms` : '—'} />
            <Field label="Image bytes" value={image.bytes} />
            <Field label="Setting context sent" value={image.settingContext} wide />
            <Field label="Background mode" value={image.sceneShift === 'new-location' ? 'new location' : 'continuity'} />
            <Field label="Environment anchor" value={snapshot.scenePrompt.environment} wide />
            <Field label="Visible NPC IDs" value={snapshot.scenePrompt.presentCharacterIds.join(', ')} wide />
            <Field label="Previous frame prompt" value={snapshot.scenePrompt.previousPrompt} wide />
          </div>

          <div className="debug-prompt">
            <span>Scene image prompt</span>
            <p>{snapshot.scenePrompt.visualPrompt || '—'}</p>
          </div>
          <div className="debug-prompt">
            <span>Identity locks</span>
            <p>{snapshot.scenePrompt.identityLocks || '—'}</p>
          </div>
          <div className="debug-prompt">
            <span>Final styled image prompt</span>
            <p>{image.finalStyledPrompt || '—'}</p>
          </div>
          {image.error && (
            <div className="debug-error">
              <span>Image error</span>
              <p>{valueOrDash(image.error.message || image.error)}</p>
            </div>
          )}
        </section>

      </div>

      {downloadOpen && (
        <div className="debug-download-layer">
          <div
            className="debug-download-layer__scrim"
            onClick={() => setDownloadOpen(false)}
            aria-hidden="true"
          />
          <section
            className="debug-download"
            role="dialog"
            aria-modal="true"
            aria-labelledby="debug-download-title"
          >
            <header className="debug-download__header">
              <div>
                <span className="debug-download__eyebrow">Snapshot export</span>
                <h3 id="debug-download-title">Download debug JSON</h3>
              </div>
              <button
                className="debug-download__close"
                type="button"
                onClick={() => setDownloadOpen(false)}
                aria-label="Close download dialog"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div className="debug-download__body">
              <label className="debug-download__field">
                <span>Debug note</span>
                <textarea
                  value={debugNote}
                  onChange={(event) => setDebugNote(event.target.value.slice(0, 1200))}
                  rows={3}
                  placeholder="What were you testing or noticing?"
                />
              </label>
              <label className="debug-download__field">
                <span>File name</span>
                <input
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value.slice(0, 140))}
                  spellCheck="false"
                />
              </label>
              <div className="debug-download__actions">
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setDownloadOpen(false)}
                >
                  Cancel
                </button>
                <button className="button button--warm" type="button" onClick={downloadSnapshot}>
                  <Download size={14} aria-hidden="true" />
                  Download JSON
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
