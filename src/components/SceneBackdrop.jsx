import { useEffect, useRef, useState } from 'react';

const EMPTY_LAYERS = ['', ''];

function headerPrompt(response) {
  try {
    return decodeURIComponent(response.headers.get('x-scene-prompt') || '');
  } catch {
    return '';
  }
}

export default function SceneBackdrop({
  prompt,
  identityLocks = '',
  refreshKey = 0,
  turn,
  onActiveImage,
  onStatusChange,
  onLog
}) {
  const [layers, setLayers] = useState(EMPTY_LAYERS);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState('idle');
  const activeRef = useRef(0);
  const layersRef = useRef(EMPTY_LAYERS);
  const timersRef = useRef(new Set());
  const requestRef = useRef(0);

  const updateStatus = (nextStatus) => {
    setStatus(nextStatus);
    onStatusChange?.(nextStatus);
  };

  useEffect(() => {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      updateStatus('idle');
      return undefined;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const controller = new AbortController();
    const started = performance.now();
    const trigger = layersRef.current.some(Boolean) ? 'refresh' : 'initial';
    let cancelled = false;

    updateStatus(trigger === 'refresh' ? 'refreshing' : 'loading');
    onLog?.({
      scope: 'image',
      level: 'info',
      turn,
      message: trigger === 'refresh' ? 'Repainting scene image' : 'Painting scene image',
      details: {
        endpoint: '/api/scene-image',
        trigger,
        attempt: refreshKey + 1,
        requestPrompt: prompt,
        identityLocks
      }
    });

    (async () => {
      try {
        const response = await fetch('/api/scene-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, identityLocks }),
          signal: controller.signal
        });

        if (!response.ok) {
          let message = `Scene image request failed (${response.status})`;
          try {
            const errorBody = await response.json();
            message = errorBody?.error?.message || message;
          } catch {
            // Keep the status-based message.
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        if (cancelled || requestId !== requestRef.current) return;

        const responseMeta = {
          bytes: blob.size,
          cache: response.headers.get('x-scene-cache') || 'unknown',
          imageId: response.headers.get('x-scene-image-id') || '',
          model: response.headers.get('x-scene-model') || 'z-image-turbo',
          width: Number(response.headers.get('x-scene-width')) || null,
          height: Number(response.headers.get('x-scene-height')) || null,
          steps: Number(response.headers.get('x-scene-steps')) || null,
          serverDurationMs: Number(response.headers.get('x-scene-duration-ms')) || null,
          finalPrompt: headerPrompt(response),
          requestPrompt: prompt,
          durationMs: Math.round(performance.now() - started)
        };

        onLog?.({
          scope: 'image',
          level: 'success',
          turn,
          message: 'Scene image received',
          details: responseMeta
        });

        const url = URL.createObjectURL(blob);
        const loader = new Image();
        loader.onload = () => {
          if (cancelled || requestId !== requestRef.current) {
            URL.revokeObjectURL(url);
            return;
          }

          const next = activeRef.current === 0 ? 1 : 0;
          const oldUrl = layersRef.current[next];
          const nextLayers = [...layersRef.current];
          nextLayers[next] = url;
          layersRef.current = nextLayers;
          setLayers(nextLayers);
          activeRef.current = next;
          setActive(next);
          updateStatus('ready');
          onActiveImage?.(url);
          onLog?.({
            scope: 'image',
            level: 'success',
            turn,
            message: 'Scene image decoded and displayed',
            details: {
              width: loader.naturalWidth,
              height: loader.naturalHeight,
              bytes: blob.size,
              cache: responseMeta.cache,
              imageId: responseMeta.imageId,
              totalDurationMs: Math.round(performance.now() - started)
            }
          });

          if (oldUrl) {
            const timer = window.setTimeout(() => {
              URL.revokeObjectURL(oldUrl);
              timersRef.current.delete(timer);
            }, 1700);
            timersRef.current.add(timer);
          }
        };
        loader.onerror = () => {
          URL.revokeObjectURL(url);
          if (!cancelled) {
            updateStatus('error');
            onLog?.({
              scope: 'image',
              level: 'error',
              turn,
              message: 'Scene image could not be decoded',
              details: { imageId: responseMeta.imageId, bytes: blob.size, cache: responseMeta.cache }
            });
          }
        };
        loader.src = url;
      } catch (error) {
        if (cancelled || error?.name === 'AbortError' || requestId !== requestRef.current) return;
        updateStatus('error');
        onLog?.({
          scope: 'image',
          level: 'error',
          turn,
          message: 'Scene image generation failed',
          details: {
            durationMs: Math.round(performance.now() - started),
            error: { name: error?.name, message: error?.message },
            requestPrompt: prompt
          }
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [prompt, identityLocks, refreshKey]);

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current.clear();
    for (const url of layersRef.current) {
      if (url) URL.revokeObjectURL(url);
    }
  }, []);

  return (
    <div className="scene-backdrop" data-status={status} aria-hidden="true">
      {layers.map((url, index) =>
        url ? (
          <img
            key={`${index}-${url}`}
            className={`scene-backdrop__layer${active === index ? ' is-active' : ''}`}
            src={url}
            alt=""
            draggable={false}
          />
        ) : null
      )}
      <div className="scene-backdrop__wash" />
      <div className="scene-backdrop__vignette" />
    </div>
  );
}
