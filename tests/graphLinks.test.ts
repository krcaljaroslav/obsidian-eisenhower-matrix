import { describe, expect, it } from 'vitest';
import { buildDependencyIndex, canLinkTasks } from '../src/core/graphLinks.ts';
import type { Task } from '../src/core/types.ts';

function task(text: string, lineIndex: number): Task {
  return { lineIndex, raw: `- [ ] ${text}`, status: ' ', checked: false, text, quadrant: 'OPEN', contextTags: [], blockedBy: [], trailingTokens: [], isBlocked: false, blockedByTasks: [], blocksTasks: [], missingBlockers: [], hasCircularDependency: false, sourceFile: 'tasks.md', isFromDnes: false };
}
function link(blocker: Task, dependent: Task): void { blocker.blocksTasks.push(dependent); dependent.blockedByTasks.push(blocker); }

describe('canLinkTasks', () => {
  it('rejects a self-link', () => { const a = task('A', 0); expect(canLinkTasks(a, a, buildDependencyIndex([a]))).toEqual({ ok: false, reason: 'A task cannot block itself' }); });
  it('rejects an existing dependency', () => { const a = task('A', 0), b = task('B', 1); link(a, b); expect(canLinkTasks(a, b, buildDependencyIndex([a, b]))).toEqual({ ok: false, reason: 'This dependency already exists' }); });
  it.each([false, true])('rejects a cycle (indirect=%s)', (indirect) => { const a = task('A', 0), b = task('B', 1), c = task('C', 2); link(a, b); if (indirect) link(b, c); expect(canLinkTasks(indirect ? c : b, a, buildDependencyIndex([a, b, c]))).toEqual({ ok: false, reason: 'That would create a circular dependency' }); });
  it('rejects a node outside the editable set', () => { const a = task('A', 0), b = task('B', 1); expect(canLinkTasks(a, b, buildDependencyIndex([a]))).toEqual({ ok: false, reason: 'That task is not editable from here' }); });
  it('accepts a valid link', () => { const a = task('A', 0), b = task('B', 1); expect(canLinkTasks(a, b, buildDependencyIndex([a, b]))).toEqual({ ok: true }); });
  it('rejects a cycle through a task hidden from the editable graph', () => {
    const source = task('Source', 0), hidden = task('Hidden done', 1), target = task('Target', 2);
    link(source, hidden);
    link(hidden, target);
    expect(canLinkTasks(target, source, buildDependencyIndex([source, target])))
      .toEqual({ ok: false, reason: 'That would create a circular dependency' });
  });
});
