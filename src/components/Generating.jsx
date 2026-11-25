import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import Logo from './Logo.jsx';

const STEPS = [
  'Reading the shape of your world',
  'Listening for voices in the dark',
  'Choosing who has something to hide',
  'Lighting the opening scene'
];

export default function Generating({ blueprint, onCancel }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => Math.min(current + 1, STEPS.length - 1));
    }, 2400);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="creating">
      <header className="creating__header">
        <Logo />
        <button className="button button--quiet" type="button" onClick={onCancel}>
          <X size={15} aria-hidden="true" />
          Leave the stage
        </button>
      </header>

      <main className="creating__main" id="main" aria-live="polite" aria-busy="true">
        <div className="casting-visual" aria-hidden="true">
          <div className="casting-ring casting-ring--outer" />
          <div className="casting-ring casting-ring--inner" />
          <div className="casting-glow" />
          <span className="casting-orbit casting-orbit--one">
            <span className="casting-card-skeleton">?</span>
          </span>
          <span className="casting-orbit casting-orbit--two">
            <span className="casting-card-skeleton">?</span>
          </span>
          <span className="casting-orbit casting-orbit--three">
            <span className="casting-card-skeleton">?</span>
          </span>
          <span className="casting-star">
            <Sparkles size={25} />
          </span>
        </div>

        <span className="eyebrow creating__eyebrow">The stage is being set</span>
        <h1>
          Finding the <em>voices</em> in your story.
        </h1>
        <p className="creating__status">{STEPS[step]}…</p>

        <div className="casting-progress" aria-hidden="true">
          <span />
        </div>
        <p className="creating__time">The cast is taking shape. A good story takes a moment.</p>

        <blockquote className="creating__quote">
          <span aria-hidden="true">“</span>
          {blueprint.length > 280 ? `${blueprint.slice(0, 280).trim()}…”` : `${blueprint}”`}
        </blockquote>
      </main>

      <footer className="creating__footer">
        <span>Powered by Venice AI</span>
        <span>Your blueprint is only used to build this world.</span>
      </footer>
    </div>
  );
}
