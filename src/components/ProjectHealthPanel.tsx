import { useState } from 'react';
import type { RefMindProject } from '../shared/types';
import { inspectProjectHealth, type ProjectHealthIssue } from '../features/project/projectHealth';

export function ProjectHealthPanel({ project }: { project: RefMindProject }) {
  const [issues, setIssues] = useState<ProjectHealthIssue[] | null>(null);
  return (
    <section className="project-health-panel">
      <div className="settings-section-heading">
        <div><h3>工程健康检查</h3><p>检查失效引用、重复资源、空分组和超大资源。</p></div>
        <button onClick={() => setIssues(inspectProjectHealth(project))}>立即检查</button>
      </div>
      {issues && (issues.length === 0
        ? <p className="health-ok">未发现工程结构问题。</p>
        : <ul>{issues.map((issue, index) => <li className={issue.level} key={`${issue.message}-${index}`}>{issue.message}</li>)}</ul>)}
    </section>
  );
}
