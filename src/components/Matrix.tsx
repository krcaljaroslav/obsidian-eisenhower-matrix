import { useMemo } from 'react';
import type { PaneType } from 'obsidian';
import type { Priority, Task, Quadrant as QuadrantKind } from '../core/types.ts';
import { QUADRANTS } from '../core/types.ts';
import { Quadrant } from './Quadrant.tsx';
import type { DependencySelection } from './TaskCard.tsx';
import type { InlineLinkTarget } from './inlineMarkdown.tsx';

type Props = {
  tasks: Task[];
  today: string;
  collapsed: Record<QuadrantKind, boolean>;
  graceMap: Map<string, number>;
  activeTaskId: string | null;
  compact: boolean;
  kanbanQuadrant: QuadrantKind | null;
  onToggleKanban: (q: QuadrantKind) => void;
  onToggleCollapsed: (q: QuadrantKind) => void;
  onToggleTask: (task: Task) => void;
  onSetStatus: (task: Task, newStatus: string) => Promise<void>;
  onSetDueDate: (task: Task, newDueDate: string | null) => Promise<void>;
  onUpdateTask: (
    task: Task,
    text: string,
    contextTags: string[],
    options: { dueDate: string | null; priority: Priority | null },
    dependencies: DependencySelection,
  ) => Promise<void>;
  onAddTask: (input: {
    text: string;
    quadrant: QuadrantKind;
    dueDate: string | null;
    priority: Priority | null;
  }) => Promise<void>;
  onOpenSource: (task: Task, mode?: PaneType | boolean) => void;
  onOpenLink: (task: Task, link: InlineLinkTarget) => void;
  onMoveQuadrant: (task: Task, target: QuadrantKind) => void;
  createTagSuggest: (inputEl: HTMLInputElement) => void;
};

export function Matrix(props: Props) {
  const tasksByQuadrant = useMemo(() => {
    const map: Record<QuadrantKind, Task[]> = {
      DO: [],
      DECIDE: [],
      DELEGATE: [],
      DELETE: [],
      OPEN: [],
    };
    for (const t of props.tasks) {
      map[t.quadrant].push(t);
    }
    return map;
  }, [props.tasks]);

  const renderQuadrant = (q: QuadrantKind) => (
    <Quadrant
      key={q}
      kind={q}
      tasks={tasksByQuadrant[q]}
      today={props.today}
      collapsed={props.collapsed[q]}
      graceMap={props.graceMap}
      activeTaskId={props.activeTaskId}
      compact={props.compact}
      kanbanActive={props.kanbanQuadrant === q}
      onToggleKanban={() => props.onToggleKanban(q)}
      onToggleCollapsed={() => props.onToggleCollapsed(q)}
      onToggleTask={props.onToggleTask}
      onSetStatus={props.onSetStatus}
      onSetDueDate={props.onSetDueDate}
      onUpdateTask={props.onUpdateTask}
      onAddTask={props.onAddTask}
      onOpenSource={props.onOpenSource}
      onOpenLink={props.onOpenLink}
      onMoveQuadrant={props.onMoveQuadrant}
      createTagSuggest={props.createTagSuggest}
    />
  );

  return (
    <div className="em-matrix">
      <div className="em-matrix-grid">
        {QUADRANTS.filter((q) => q !== 'OPEN').map(renderQuadrant)}
      </div>
      <div className="em-matrix-open">{renderQuadrant('OPEN')}</div>
    </div>
  );
}
