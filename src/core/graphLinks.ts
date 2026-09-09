import { taskKey } from './graphLayout.ts';
import type { Task } from './types.ts';

export type LinkRejection = 'A task cannot block itself' | 'This dependency already exists' | 'That would create a circular dependency' | 'That task is not editable from here';
export type DependencyIndex = ReadonlyMap<string, Task>;
export type GraphLinkPort = 'top' | 'bottom';
export type GraphLinkRoles = { blocker: Task; blocked: Task };

export function graphLinkRoles(port: GraphLinkPort, draggedTask: Task, targetTask: Task): GraphLinkRoles {
  return port === 'top'
    ? { blocker: draggedTask, blocked: targetTask }
    : { blocker: targetTask, blocked: draggedTask };
}

export function buildDependencyIndex(tasks: Task[]): DependencyIndex {
  return new Map(tasks.map((task) => [taskKey(task), task]));
}

export function canLinkTasks(source: Task, target: Task, index: DependencyIndex): { ok: true } | { ok: false; reason: LinkRejection } {
  const sourceKey = taskKey(source), targetKey = taskKey(target);
  if (!index.has(sourceKey) || !index.has(targetKey)) return { ok: false, reason: 'That task is not editable from here' };
  if (sourceKey === targetKey) return { ok: false, reason: 'A task cannot block itself' };
  if (target.blockedByTasks.some((blocker) => taskKey(blocker) === sourceKey) || Boolean(source.id && target.blockedBy.includes(source.id))) {
    return { ok: false, reason: 'This dependency already exists' };
  }
  const pending = [target], visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop()!, candidateKey = taskKey(candidate);
    if (candidateKey === sourceKey) return { ok: false, reason: 'That would create a circular dependency' };
    if (visited.has(candidateKey)) continue;
    visited.add(candidateKey);
    pending.push(...candidate.blocksTasks);
  }
  return { ok: true };
}
