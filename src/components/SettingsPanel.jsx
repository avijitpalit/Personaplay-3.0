import { useEffect, useRef } from 'react';
import { Bot, Image, Settings, X } from 'lucide-react';
import { IMAGE_MODELS, getImageModel } from '../lib/imageModels.js';
import { LANGUAGE_MODELS, getLanguageModel } from '../lib/languageModels.js';

export default function SettingsPanel({
  open,
  imageModel,
  onImageModelChange,
  languageModel,
  onLanguageModelChange,
  onClose
}) {
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const selected = getImageModel(imageModel);
  const selectedLanguage = getLanguageModel(languageModel);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => closeRef.current?.focus(), 40);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="settings-layer">
      <div className="settings-layer__scrim" onClick={onClose} aria-hidden="true" />
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-panel__header">
          <div>
            <span className="settings-panel__eyebrow">
              <Settings size={13} aria-hidden="true" />
              Preferences
            </span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button ref={closeRef} className="settings-panel__close" type="button" onClick={onClose} aria-label="Close settings">
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="settings-panel__body">
          <div className="settings-field">
            <div className="settings-field__label-row">
              <label htmlFor="language-model-select">
                <Bot size={14} aria-hidden="true" />
                Language model
              </label>
              <span className="settings-field__value">{selectedLanguage.provider}</span>
            </div>
            <select
              id="language-model-select"
              className="settings-select"
              value={selectedLanguage.id}
              onChange={(event) => onLanguageModelChange(event.target.value)}
            >
              {LANGUAGE_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            <p className="settings-field__help">{selectedLanguage.description}</p>
          </div>

          <div className="settings-field">
            <div className="settings-field__label-row">
              <label htmlFor="image-model-select">
                <Image size={14} aria-hidden="true" />
                Image generation model
              </label>
              <span className="settings-field__value">{selected.provider}</span>
            </div>
            <select
              id="image-model-select"
              className="settings-select"
              value={selected.id}
              onChange={(event) => onImageModelChange(event.target.value)}
            >
              {IMAGE_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            <p className="settings-field__help">{selected.description}</p>
            {selected.provider === 'RunPod' && (
              <p className="settings-field__help settings-field__help--warn">
                RunPod requires <code>RUNPOD_API_KEY</code> on the server and may wait in a queue.
              </p>
            )}
          </div>

          <p className="settings-note">
            Choices are saved on this device. The language model applies to the next story or reply;
            switching the image model repaints the current scene with the same prompt and identity locks.
          </p>
        </div>
      </section>
    </div>
  );
}
