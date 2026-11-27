import { useCallback, useEffect, useRef, useState } from 'react';
import Landing from './components/Landing.jsx';
import Generating from './components/Generating.jsx';
import Chat from './components/Chat.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import { createScenePrompt, createStory, continueStory } from './lib/api.js';
import { loadImageModel, saveImageModel } from './lib/imageModels.js';
import { loadLanguageModel, saveLanguageModel } from './lib/languageModels.js';
import {
  clearSession,
  identityLocksFor,
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
  const [imageModel, setImageModel] = useState(loadImageModel);
  const [languageModel, setLanguageModel] = useState(loadLanguageModel);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const planScenePrompt = async ({
    story,
    characters,
    messages,
    fallbackPrompt,
    previousPrompt = '',
    turn,
    signal
  }) => {
    const started = performance.now();
    addLog({
      scope: 'scene-prompt',
      level: 'info',
      turn,
      message: 'Planning scene image prompt',
      details: {
        endpoint: '/api/scene-prompt',
        request: { story, characters, messages },
        fallbackPrompt: fallbackPrompt || '',
        previousPrompt: previousPrompt || ''
      }
    });

    try {
      const result = await createScenePrompt(
        { story, characters, messages, languageModel },
        { signal }
      );
      const visualPrompt = result.visualPrompt?.trim() || fallbackPrompt || '';
      const presentCharacterIds = Array.isArray(result.presentCharacterIds)
        ? result.presentCharacterIds
        : characters.map((character) => character.id);
      const identityLocks =
        typeof result.identityLocks === 'string' && result.identityLocks.trim()
          ? result.identityLocks
          : identityLocksFor(characters, presentCharacterIds);
      const sceneShift = result.sceneShift === 'new-location' ? 'new-location' : 'continue';
      const environment =
        sceneShift === 'new-location' ? '' : result.environment?.trim() || '';
      addLog({
        scope: 'scene-prompt',
        level: result.visualPrompt?.trim() ? 'success' : 'warn',
        turn,
        message: result.visualPrompt?.trim() ? 'Scene image prompt ready' : 'Scene planner returned no prompt; fallback used',
        details: {
          durationMs: Math.round(performance.now() - started),
          response: result,
          selectedPrompt: visualPrompt,
          presentCharacterIds,
          identityLocks,
          sceneShift,
          environment,
          previousPrompt: previousPrompt || ''
        }
      });
      return { visualPrompt, identityLocks, presentCharacterIds, sceneShift, environment };
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

      const fallbackLocks = identityLocksFor(characters);
      addLog({
        scope: 'scene-prompt',
        level: fallbackPrompt ? 'warn' : 'error',
        turn,
        message: fallbackPrompt ? 'Scene planner failed; using model visual hint' : 'Scene prompt planning failed',
        details: {
          durationMs: Math.round(performance.now() - started),
          error: errorDetails(error),
          fallbackPrompt: fallbackPrompt || '',
          identityLocks: fallbackLocks
        }
      });
      if (fallbackPrompt) {
        return {
          visualPrompt: fallbackPrompt,
          identityLocks: fallbackLocks,
          presentCharacterIds: characters.map((character) => character.id),
          sceneShift: 'continue',
          environment: ''
        };
      }
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
    // The frame currently on screen is the continuity reference for this turn.
    const previousPrompt = story.visualPrompt?.trim() || '';

    try {
      const plan = await planScenePrompt({
        story,
        characters,
        messages,
        fallbackPrompt,
        previousPrompt,
        turn,
        signal: controller.signal
      });
      if (controller.signal.aborted || !plan.visualPrompt) return;

      setSession((current) => {
        if (!current || current.id !== sessionId) return current;
        return {
          ...current,
          story: { ...current.story, visualPrompt: plan.visualPrompt },
          sceneImagePrompt: plan.visualPrompt,
          sceneIdentityLocks: plan.identityLocks,
          scenePresentCharacterIds: plan.presentCharacterIds,
          sceneEnvironment: plan.environment || '',
          sceneShift: plan.sceneShift,
          scenePreviousImagePrompt: previousPrompt,
          updatedAt: Date.now()
        };
      });
      addLog({
        scope: 'scene-prompt',
        level: 'info',
        turn,
        message: 'Prompt applied to the scene backdrop',
        details: {
          visualPrompt: plan.visualPrompt,
          identityLocks: plan.identityLocks,
          presentCharacterIds: plan.presentCharacterIds,
          sceneShift: plan.sceneShift,
          environment: plan.environment || '',
          previousPrompt
        }
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

    setSettingsOpen(false);
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
      const result = await createStory(prompt, {
        signal: controller.signal,
        languageModel
      });
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

      const nextSession = makeSession(result.story, result.characters, prompt);
      let plan = {
        visualPrompt: result.story.visualPrompt || '',
        identityLocks: identityLocksFor(nextSession.characters),
        presentCharacterIds: nextSession.characters.map((character) => character.id),
        sceneShift: 'continue',
        environment: ''
      };

      try {
        plan = await planScenePrompt({
          story: nextSession.story,
          characters: nextSession.characters,
          messages: nextSession.messages,
          fallbackPrompt: result.story.visualPrompt,
          previousPrompt: '',
          turn: 0,
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        plan = {
          visualPrompt: result.story.visualPrompt || '',
          identityLocks: identityLocksFor(nextSession.characters),
          presentCharacterIds: nextSession.characters.map((character) => character.id),
          sceneShift: 'continue',
          environment: ''
        };
      }

      if (controller.signal.aborted) return;
      nextSession.sceneImagePrompt = plan.visualPrompt;
      nextSession.sceneIdentityLocks = plan.identityLocks;
      nextSession.scenePresentCharacterIds = plan.presentCharacterIds;
      nextSession.sceneEnvironment = plan.environment || '';
      nextSession.sceneShift = plan.sceneShift || 'continue';
      nextSession.scenePreviousImagePrompt = '';
      nextSession.story = { ...nextSession.story, visualPrompt: plan.visualPrompt };
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
          messages: snapshot.messages,
          languageModel
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
      const emotionByCharacter = new Map();
      for (const reply of result.messages || []) {
        if (!reply?.text?.trim()) continue;
        const previousCharacter = snapshot.characters.find(
          (character) => character.id === reply.characterId
        );
        const emotion = reply.emotion?.trim() || previousCharacter?.emotion || 'guarded';
        emotionByCharacter.set(reply.characterId, emotion);
        additions.push({
          id: makeId(),
          type: 'character',
          characterId: reply.characterId,
          emotion,
          text: reply.text.trim(),
          createdAt: Date.now()
        });
      }

      const nextCharacters = snapshot.characters.map((character) =>
        emotionByCharacter.has(character.id)
          ? { ...character, emotion: emotionByCharacter.get(character.id) }
          : character
      );
      const nextMessages = [...snapshot.messages, ...additions];
      setSession((current) => {
        if (!current || current.id !== snapshot.id) return current;
        return {
          ...current,
          characters: nextCharacters,
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
          nextCharacters,
          nextMessages
        }
      });

      requestScenePromptAfterTurn({
        story: snapshot.story,
        characters: nextCharacters,
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
    setSettingsOpen(false);
    clearSession();
    setView('home');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleImageModelChange = (nextModel) => {
    setImageModel(nextModel);
    saveImageModel(nextModel);
    addLog({
      scope: 'settings',
      level: 'info',
      message: 'Image generation model changed',
      details: { imageModel: nextModel }
    });
  };

  const handleLanguageModelChange = (nextModel) => {
    setLanguageModel(nextModel);
    saveLanguageModel(nextModel);
    addLog({
      scope: 'settings',
      level: 'info',
      message: 'Language model changed',
      details: { languageModel: nextModel }
    });
  };

  const settingsPanel = (
    <SettingsPanel
      open={settingsOpen}
      imageModel={imageModel}
      onImageModelChange={handleImageModelChange}
      languageModel={languageModel}
      onLanguageModelChange={handleLanguageModelChange}
      onClose={() => setSettingsOpen(false)}
    />
  );

  if (view === 'creating') {
    return <Generating blueprint={draft} onCancel={handleCancelCreate} />;
  }

  if (view === 'chat' && session) {
    return (
      <>
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
          imageModel={imageModel}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsPanel}
      </>
    );
  }

  return (
    <>
      <Landing
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={handleCreate}
        error={createError}
        autoFocus={false}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsPanel}
    </>
  );
}
