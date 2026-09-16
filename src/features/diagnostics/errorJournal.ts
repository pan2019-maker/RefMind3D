export type ErrorJournalEntry = { at: string; kind: 'error' | 'rejection'; message: string };
const entries: ErrorJournalEntry[] = [];
const sanitize = (value: unknown) => String(value instanceof Error ? value.message : value)
  .replace(/(api[-_ ]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, '$1=[已脱敏]')
  .replace(/[A-Za-z]:\\[^\n\r"']+/g, '[本机路径]')
  .slice(0, 1200);
const push = (entry: ErrorJournalEntry) => { entries.push(entry); if (entries.length > 50) entries.shift(); };

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => push({ at: new Date().toISOString(), kind: 'error', message: sanitize(event.error || event.message) }));
  window.addEventListener('unhandledrejection', (event) => push({ at: new Date().toISOString(), kind: 'rejection', message: sanitize(event.reason) }));
}
export function errorJournalSnapshot() { return entries.slice(); }
