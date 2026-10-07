// Pulls the JSON object out of a model reply: tolerates a ```json fence or a
// sentence either side, never guesses past the outermost braces.
export function extractJson(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(body.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
