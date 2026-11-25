function renderInline(segment, key) {
  if (segment.startsWith('**') && segment.endsWith('**') && segment.length > 4) {
    return <strong key={key}>{segment.slice(2, -2)}</strong>;
  }
  if (segment.startsWith('*') && segment.endsWith('*') && segment.length > 2) {
    return <em key={key}>{segment.slice(1, -1)}</em>;
  }
  return <span key={key}>{segment}</span>;
}

export default function MessageText({ text }) {
  const segments = String(text || '').split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return <>{segments.map((segment, index) => renderInline(segment, index))}</>;
}
