export type ErrorJournalEntry = { at: string; kind: 'error' | 'rejection'; message: string };
const STORAGE_KEY = 'refmind3d.error-journal.v1';
const SESSION_KEY = 'refmind3d.session-state.v1';
const entries: ErrorJournalEntry[] = (() => {
  if (typeof localStorage === 'undefined') return [];
  try { return (JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as ErrorJournalEntry[]).slice(-50); } catch { return []; }
})();
const sanitize = (value: unknown) => String(value instanceof Error ? value.message : value)
  .replace(/(api[-_ ]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, '$1=[已脱敏]')
  .replace(/[A-Za-z]:\\[^\n\r"']+/g, '[本机路径]')
  .slice(0, 1200);
const push = (entry: ErrorJournalEntry) => {
  entries.push(entry); if (entries.length > 50) entries.shift();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* Diagnostics must never interrupt editing. */ }
};

let previousSessionUnclean = false;

if (typeof window !== 'undefined') {
  try {
    previousSessionUnclean = localStorage.getItem(SESSION_KEY) === 'running';
    localStorage.setItem(SESSION_KEY, 'running');
    window.addEventListener('beforeunload', () => localStorage.setItem(SESSION_KEY, 'closed'));
  } catch { /* Storage may be unavailable in restricted WebViews. */ }
  window.addEventListener('error', (event) => push({ at: new Date().toISOString(), kind: 'error', message: sanitize(event.error || event.message) }));
  window.addEventListener('unhandledrejection', (event) => push({ at: new Date().toISOString(), kind: 'rejection', message: sanitize(event.reason) }));
}
export function errorJournalSnapshot() { return entries.slice(); }
export function crashSessionStatus() { return { previousSessionUnclean, persistedErrors: entries.length }; }
