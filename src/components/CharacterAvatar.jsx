function initialsFor(name) {
  const parts = String(name || '?')
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export default function CharacterAvatar({ character, size = 'md', className = '' }) {
  const accent = character?.accent || 'ember';
  return (
    <span
      className={`avatar avatar--${accent} avatar--${size}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      <span className="avatar__wash" />
      <span className="avatar__initials">{initialsFor(character?.name)}</span>
    </span>
  );
}
