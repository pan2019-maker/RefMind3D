import { useEffect, useState } from 'react';
import { dismissTask, subscribeTasks, taskSnapshot } from '../features/tasks/taskCenter';

export function TaskCenter() {
  const [tasks, setTasks] = useState(taskSnapshot);
  useEffect(() => subscribeTasks(() => setTasks(taskSnapshot())), []);
  if (!tasks.length) return null;
  return <aside className="task-center" aria-label="后台任务">
    <strong>后台任务</strong>
    {tasks.map((task) => <div className={`task-center-item ${task.status}`} key={task.id}>
      <span>{task.status === 'running' ? '处理中…' : task.status === 'done' ? '完成' : '失败'}</span>
      <b>{task.title}</b>
      {task.detail && <small title={task.detail}>{task.detail}</small>}
      {task.status !== 'running' && <button onClick={() => dismissTask(task.id)}>×</button>}
    </div>)}
  </aside>;
}
