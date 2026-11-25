import { useCallback, useEffect, useRef, useState } from 'react';
import Landing from './components/Landing.jsx';
import Generating from './components/Generating.jsx';
import Chat from './components/Chat.jsx';
import { createScenePrompt, createStory, continueStory } from './lib/api.js';
import {
  clearSession,
  loadSession,
  makeId,
  makeSession,
  saveSession
} from './lib/session.js';

function errorDetails(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    status: error?.status
  };
}

function countUserTurns(messages) {
  return messages.filter((message) => message.type === 'user').length;
}

export default function App() {
  const [session, setSession] = useState(() => loadSession());
  const [view, setView] = useState(() => (session ? 'chat' : 'home'));
  const [draft, setDraft] = useState('');
  const [createError, setCreateError] = useState('');
  const [chatError, setChatError] = useState('');
  const [isReplying, setIsReplying] = useState(false);
  const [scenePromptBusy, setScenePromptBusy] = useState(false);
  const [logs, setLogs] = useState(() => [
    {
      id: makeId(),
      at: Date.now(),
      level: 'info',
      scope: 'app',
      message: session ? 'Session restored from browser storage' : 'App ready',
      details: session
        ? { sessionId: session.id, title: session.story?.title, messages: session.messages?.length }
        : { view: 'home' }
    }
  ]);
  const createAbortRef = useRef(null);
  const replyAbortRef = useRef(null);
  const scenePromptAbortRef = useRef(null);

  const addLog = useCallback((entry) => {
    setLogs((current) => {
      const at = Date.now();
      const nextEntry = {
        id: makeId(),
        at,
        level: 'info',
        scope: 'app',
        message: '',
        ...entry
      };
      const last = current[current.length - 1];
      const isDuplicate =
        last &&
        at - last.at < 800 &&
        last.scope === nextEntry.scope &&
        last.level === nextEntry.level &&
        last.turn === nextEntry.turn &&
        last.message === nextEntry.message &&
        JSON.stringify(last.details) === JSON.stringify(nextEntry.details);

      if (isDuplicate) return current;

      const next = [...current, nextEntry];
      return next.length > 180 ? next.slice(-180) : next;
    });
  }, []);

  useEffect(() => {
    if (session) saveSession(session);
  }, [session]);

  useEffect(() => {
    document.title = session?.story?.title
      ? `${session.story.title} — PersonaPlay`
      : 'PersonaPlay — A story that answers back';
  }, [session]);

  useEffect(() => () => {
    createAbortRef.current?.abort();
    replyAbortRef.current?.abort();
    scenePromptAbortRef.current?.abort();
  }, []);

  const planScenePrompt = async ({ story, characters, messages, fallbackPrompt, turn, signal }) => {
    const started = performance.now();
    addLog({
      scope: 'scene-prompt',
      level: 'info',
      turn,
      message: 'Planning scene image prompt',
      details: {
        endpoint: '/api/scene-prompt',
        request: { story, characters, messages },
        fallbackPrompt: fallbackPrompt || ''
      }
    });

    try {
      const result = await createScenePrompt({ story, characters, messages }, { signal });
      const visualPrompt = result.visualPrompt?.trim() || fallbackPrompt || '';
      addLog({
        scope: 'scene-prompt',
        level: result.visualPrompt?.trim() ? 'success' : 'warn',
        turn,
        message: result.visualPrompt?.trim() ? 'Scene image prompt ready' : 'Scene planner returned no prompt; fallback used',
        details: {
          durationMs: Math.round(performance.now() - started),
          response: result,
          selectedPrompt: visualPrompt
        }
      });
      return visualPrompt;
    } catch (error) {
      if (error?.name === 'AbortError') {
        addLog({
          scope: 'scene-prompt',
          level: 'info',
          turn,
          message: 'Scene prompt planning cancelled',
          details: { durationMs: Math.round(performance.now() - started) }
        });
        throw error;
      }

      addLog({
        scope: 'scene-prompt',
        level: fallbackPrompt ? 'warn' : 'error',
        turn,
        message: fallbackPrompt ? 'Scene planner failed; using model visual hint' : 'Scene prompt planning failed',
        details: {
          durationMs: Math.round(performance.now() - started),
          error: errorDetails(error),
          fallbackPrompt: fallbackPrompt || ''
        }
      });
      if (fallbackPrompt) return fallbackPrompt;
      throw error;
    }
  };

  const requestScenePromptAfterTurn = async ({
    story,
    characters,
    messages,
    fallbackPrompt,
    turn,
    sessionId
  }) => {
    scenePromptAbortRef.current?.abort();
    const controller = new AbortController();
    scenePromptAbortRef.current = controller;
    setScenePromptBusy(true);

    try {
      const visualPrompt = await planScenePrompt({
        story,
        characters,
        messages,
        fallbackPrompt,
        turn,
        signal: controller.signal
      });
      if (controller.signal.aborted || !visualPrompt) return;

      setSession((current) => {
        if (!current || current.id !== sessionId) return current;
        return {
          ...current,
          story: { ...current.story, visualPrompt },
          sceneImagePrompt: visualPrompt,
          updatedAt: Date.now()
        };
      });
      addLog({
        scope: 'scene-prompt',
        level: 'info',
        turn,
        message: 'Prompt applied to the scene backdrop',
        details: { visualPrompt }
      });
    } catch {
      // The failed request is already represented in the log.
    } finally {
      if (scenePromptAbortRef.current === controller) {
        scenePromptAbortRef.current = null;
        setScenePromptBusy(false);
      }
    }
  };

  const handleCreate = async () => {
    const prompt = draft.trim();
    if (prompt.length < 12) return;

    setCreateError('');
    setLogs([]);
    setView('creating');
    const controller = new AbortController();
    createAbortRef.current = controller;
    const started = performance.now();

    addLog({
      scope: 'story',
      level: 'info',
      turn: 0,
      message: 'Creating story from blueprint',
      details: {
        endpoint: '/api/story',
        request: { prompt }
      }
    });

    try {
      const result = await createStory(prompt, { signal: controller.signal });
      if (controller.signal.aborted) return;

      addLog({
        scope: 'story',
        level: 'success',
        turn: 0,
        message: 'Story and cast generated',
        details: {
          durationMs: Math.round(performance.now() - started),
          response: result
        }
      });

      const nextSession = makeSession(result.story, result.characters);
      let visualPrompt = result.story.visualPrompt || '';

      try {
        visualPrompt = await planScenePrompt({
          story: result.story,
          characters: result.characters,
          messages: nextSession.messages,
          fallbackPrompt: result.story.visualPrompt,
          turn: 0,
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        visualPrompt = result.story.visualPrompt || '';
      }

      if (controller.signal.aborted) return;
      nextSession.sceneImagePrompt = visualPrompt;
      nextSession.story = { ...nextSession.story, visualPrompt };
      setSession(nextSession);
      setDraft('');
      setView('chat');
    } catch (error) {
      if (controller.signal.aborted) return;
      addLog({
        scope: 'story',
        level: 'error',
        turn: 0,
        message: 'Story creation failed',
        details: { durationMs: Math.round(performance.now() - started), error: errorDetails(error) }
      });
      setCreateError(error?.message || 'The story could not begin. Please try again.');
      setView('home');
    } finally {
      if (createAbortRef.current === controller) createAbortRef.current = null;
    }
  };

  const handleCancelCreate = () => {
    addLog({ scope: 'story', level: 'info', message: 'Story creation cancelled' });
    createAbortRef.current?.abort();
    createAbortRef.current = null;
    setView('home');
  };

  const requestReply = async (snapshot) => {
    replyAbortRef.current?.abort();
    const controller = new AbortController();
    replyAbortRef.current = controller;
    setChatError('');
    setIsReplying(true);
    const turn = countUserTurns(snapshot.messages);
    const started = performance.now();

    addLog({
      scope: 'reply',
      level: 'info',
      turn,
      message: 'Requesting character reply',
      details: {
        endpoint: '/api/story/reply',
        request: {
          story: snapshot.story,
          characters: snapshot.characters,
          messages: snapshot.messages
        }
      }
    });

    try {
      const result = await continueStory(
        {
          story: snapshot.story,
          characters: snapshot.characters,
          messages: snapshot.messages
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;

      const additions = [];
      if (result.narration?.trim()) {
        additions.push({
          id: makeId(),
          type: 'narration',
          text: result.narration.trim(),
          createdAt: Date.now()
        });
      }
      for (const reply of result.messages || []) {
        if (!reply?.text?.trim()) continue;
        additions.push({
          id: makeId(),
          type: 'character',
          characterId: reply.characterId,
          text: reply.text.trim(),
          createdAt: Date.now()
        });
      }

      const nextMessages = [...snapshot.messages, ...additions];
      setSession((current) => {
        if (!current || current.id !== snapshot.id) return current;
        return {
          ...current,
          messages: nextMessages,
          updatedAt: Date.now()
        };
      });

      addLog({
        scope: 'reply',
        level: 'success',
        turn,
        message: 'Character reply received',
        details: {
          durationMs: Math.round(performance.now() - started),
          response: result,
          visualHint: result.visualPrompt || '',
          nextMessages
        }
      });

      requestScenePromptAfterTurn({
        story: snapshot.story,
        characters: snapshot.characters,
        messages: nextMessages,
        fallbackPrompt: result.visualPrompt,
        turn,
        sessionId: snapshot.id
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      addLog({
        scope: 'reply',
        level: 'error',
        turn,
        message: 'Character reply failed',
        details: { durationMs: Math.round(performance.now() - started), error: errorDetails(error) }
      });
      setChatError(error?.message || 'The cast missed their cue. Try that beat again.');
    } finally {
      if (replyAbortRef.current === controller) {
        replyAbortRef.current = null;
        setIsReplying(false);
      }
    }
  };

  const handleSend = (body) => {
    if (!session || isReplying) return;
    scenePromptAbortRef.current?.abort();
    scenePromptAbortRef.current = null;
    setScenePromptBusy(false);
    const userMessage = {
      id: makeId(),
      type: 'user',
      text: body,
      createdAt: Date.now()
    };
    const snapshot = {
      ...session,
      messages: [...session.messages, userMessage],
      updatedAt: Date.now()
    };
    setSession(snapshot);
    setChatError('');
    requestReply(snapshot);
  };

  const handleRetry = () => {
    if (!session || isReplying) return;
    const last = session.messages[session.messages.length - 1];
    if (last?.type !== 'user') return;
    requestReply(session);
  };

  const handleNewStory = () => {
    createAbortRef.current?.abort();
    createAbortRef.current = null;
    replyAbortRef.current?.abort();
    replyAbortRef.current = null;
    scenePromptAbortRef.current?.abort();
    scenePromptAbortRef.current = null;
    setIsReplying(false);
    setScenePromptBusy(false);
    setChatError('');
    setCreateError('');
    setLogs([]);
    setSession(null);
    setDraft('');
    clearSession();
    setView('home');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  if (view === 'creating') {
    return <Generating blueprint={draft} onCancel={handleCancelCreate} />;
  }

  if (view === 'chat' && session) {
    return (
      <Chat
        session={session}
        onSend={handleSend}
        onNewStory={handleNewStory}
        isReplying={isReplying}
        scenePromptBusy={scenePromptBusy}
        error={chatError}
        onRetry={handleRetry}
        onDismissError={() => setChatError('')}
        logs={logs}
        onClearLogs={() => setLogs([])}
        onLog={addLog}
      />
    );
  }

  return (
    <Landing
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={handleCreate}
      error={createError}
      autoFocus={false}
    />
  );
}
