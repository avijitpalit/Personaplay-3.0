export default function Logo({ compact = false }) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`} aria-label="PersonaPlay">
      <span className="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="18.25" stroke="currentColor" strokeOpacity="0.27" />
          <circle cx="20" cy="20" r="12.25" stroke="currentColor" strokeOpacity="0.14" />
          <path
            d="M20 7.5l2.8 9.7L32.5 20l-9.7 2.8L20 32.5l-2.8-9.7L7.5 20l9.7-2.8L20 7.5z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span className="brand__word">
        Persona<em>Play</em>
      </span>
    </div>
  );
}
