import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Terminal, Trash2, X } from 'lucide-react';

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const clock = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return `${clock}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function promptExcerpt(details) {
  if (!details || typeof details !== 'object') return '';
  const candidates = [
    details.selectedPrompt,
    details.visualPrompt,
    details.requestPrompt,
    details.finalPrompt,
    details.response?.visualPrompt
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
}

function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function DebugLogs({ open, logs, onClose, onClear }) {
  const closeRef = useRef(null);
  const scrollerRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const onCloseRef = useRef(onClose);
  const [copied, setCopied] = useState('');
  const copyTimerRef = useRef(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      stickToBottomRef.current = true;
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller && stickToBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [logs, open]);

  useEffect(() => () => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
  }, []);

  const copy = async (key, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopied('failed');
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(''), 1500);
    }
  };

  if (!open) return null;

  return (
    <aside className="debug-panel" id="debug-panel" role="complementary" aria-label="Debug logs">
      <header className="debug-panel__header">
        <div className="debug-panel__identity">
          <span className="debug-panel__eyebrow">
            <Terminal size={12} aria-hidden="true" />
            Dev tools
          </span>
          <div className="debug-panel__title-row">
            <h2>Turn log</h2>
            <span className="debug-panel__count">{logs.length} events</span>
          </div>
          <p>Live request parameters, image prompts, timings, cache status, and errors.</p>
        </div>
        <div className="debug-panel__tools">
          <button
            className="debug-panel__tool"
            type="button"
            onClick={() => copy('all', jsonText(logs))}
            title="Copy all logs as JSON"
            aria-label="Copy all debug logs"
          >
            {copied === 'all' ? <Check size={14} /> : copied === 'failed' ? <X size={14} /> : <Copy size={14} />}
            <span>{copied === 'all' ? 'Copied' : 'Copy all'}</span>
          </button>
          <button
            className="debug-panel__tool"
            type="button"
            onClick={onClear}
            title="Clear logs"
            aria-label="Clear debug logs"
          >
            <Trash2 size={14} />
            <span>Clear</span>
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

      <div
        className="debug-panel__scroll"
        ref={scrollerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        }}
      >
        {logs.length === 0 ? (
          <div className="debug-panel__empty">
            <Terminal size={20} aria-hidden="true" />
            <p>No log events yet.</p>
            <span>Create a story or send a turn to inspect the parameter flow.</span>
          </div>
        ) : (
          logs.map((entry) => {
            const excerpt = promptExcerpt(entry.details);
            return (
              <article className={`log-entry log-entry--${entry.level || 'info'}`} key={entry.id}>
                <div className="log-entry__top">
                  <div className="log-entry__meta">
                    <span className="log-entry__level" aria-hidden="true" />
                    <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
                    <span className="log-entry__scope">{entry.scope || 'app'}</span>
                    {typeof entry.turn === 'number' && (
                      <span className="log-entry__turn">turn {entry.turn}</span>
                    )}
                  </div>
                  <button
                    className="log-entry__copy"
                    type="button"
                    onClick={() => copy(entry.id, jsonText(entry))}
                    aria-label="Copy this log entry"
                  >
                    {copied === entry.id ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                <p className="log-entry__message">{entry.message || 'Event'}</p>
                {excerpt && (
                  <p className="log-entry__excerpt" title={excerpt}>
                    <span>Prompt</span>
                    {excerpt}
                  </p>
                )}
                {entry.details && (
                  <details className="log-entry__details">
                    <summary>Parameters</summary>
                    <pre>{jsonText(entry.details)}</pre>
                  </details>
                )}
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}
