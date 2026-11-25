import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export default function ConfirmDialog({ open, onClose, onConfirm }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="dialog__glow" aria-hidden="true" />
      <button className="dialog__close" type="button" onClick={onClose} aria-label="Close dialog">
        <X size={17} />
      </button>
      <span className="dialog__eyebrow">Turn the page</span>
      <h2>Leave this story behind?</h2>
      <p>
        This scene lives only in your browser. Starting a new story will clear the current cast and
        conversation for good.
      </p>
      <div className="dialog__actions">
        <button className="button button--ghost" type="button" onClick={onClose} autoFocus>
          Keep playing
        </button>
        <button className="button button--warm" type="button" onClick={onConfirm}>
          Begin a new story
        </button>
      </div>
    </dialog>
  );
}
