function renderInline(segment, key) {
  if (segment.startsWith('**') && segment.endsWith('**') && segment.length > 4) {
    return <strong key={key}>{segment.slice(2, -2)}</strong>;
  }
  if (segment.startsWith('*') && segment.endsWith('*') && segment.length > 2) {
    return <em key={key}>{segment.slice(1, -1)}</em>;
  }
  return <span key={key}>{segment}</span>;
}

function renderSpeech(text, keyPrefix) {
  return String(text)
    .split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((segment, index) => renderInline(segment, `${keyPrefix}-${index}`));
}

export default function MessageText({ text }) {
  const parts = String(text || '').split(/(\([^()]*\))/g).filter(Boolean);

  return (
    <>
      {parts.map((part, index) => {
        const action = part.match(/^\(([^()]*)\)$/s);
        if (action) {
          return (
            <span className="message-action" key={`action-${index}`}>
              {action[1].replace(/\*\*/g, '').replace(/\*/g, '')}
            </span>
          );
        }
        return <span key={`speech-${index}`}>{renderSpeech(part, `speech-${index}`)}</span>;
      })}
    </>
  );
}
