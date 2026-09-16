export type BackgroundTask = {
  id: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
  startedAt: number;
};

const tasks = new Map<string, BackgroundTask>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function taskSnapshot() { return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8); }
export function subscribeTasks(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function dismissTask(id: string) { tasks.delete(id); emit(); }

export async function runBackgroundTask<T>(title: string, work: () => Promise<T>): Promise<T> {
  const id = crypto.randomUUID();
  tasks.set(id, { id, title, status: 'running', startedAt: Date.now() }); emit();
  try {
    const result = await work();
    tasks.set(id, { ...tasks.get(id)!, status: 'done', detail: '已完成' }); emit();
    window.setTimeout(() => dismissTask(id), 5000);
    return result;
  } catch (error) {
    tasks.set(id, { ...tasks.get(id)!, status: 'failed', detail: error instanceof Error ? error.message : String(error) }); emit();
    throw error;
  }
}
