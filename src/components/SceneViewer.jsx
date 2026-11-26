import { useEffect, useRef } from 'react';

export default function SceneViewer({ open, imageUrl, onClose }) {
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open || !imageUrl) return null;

  return (
    <div className="scene-viewer" role="dialog" aria-label="Full scene image">
      <div
        className="scene-viewer__backdrop"
        style={{ backgroundImage: `url("${imageUrl}")` }}
        aria-hidden="true"
      />
      <img
        className="scene-viewer__image"
        src={imageUrl}
        alt="Full-size photorealistic illustration of the current scene"
        draggable={false}
      />
    </div>
  );
}
