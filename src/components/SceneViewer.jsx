import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export default function SceneViewer({ open, imageUrl, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && imageUrl) {
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => closeRef.current?.focus());
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, imageUrl]);

  return (
    <dialog
      ref={dialogRef}
      className="scene-viewer"
      aria-label="Full scene illustration"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      {imageUrl && (
        <div
          className="scene-viewer__backdrop"
          style={{ backgroundImage: `url("${imageUrl}")` }}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      {imageUrl && (
        <img
          className="scene-viewer__image"
          src={imageUrl}
          alt="Full-size photorealistic illustration of the current scene"
          draggable={false}
        />
      )}
      <button ref={closeRef} className="scene-viewer__close" type="button" onClick={onClose}>
        <X size={17} aria-hidden="true" />
        Back to story
      </button>
    </dialog>
  );
}
