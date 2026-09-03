import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { type PaneType } from 'obsidian';
import type { Priority, Quadrant as QuadrantKind, Task } from '../core/types.ts';
import { QUADRANT_META } from '../core/types.ts';
import { TaskCard, type DependencySelection } from './TaskCard.tsx';
import { AddTaskInput } from './AddTaskInput.tsx';
import { Icon } from './Icon.tsx';
import type { InlineLinkTarget } from './inlineMarkdown.tsx';

type Props = {
  kind: QuadrantKind;
  tasks: Task[];
  today: string;
  collapsed: boolean;
  activeTaskId: string | null;
  compact: boolean;
  kanbanActive: boolean;
  onToggleKanban: () => void;
  onToggleCollapsed: () => void;
  graceMap: Map<string, number>;
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

export function Quadrant({
  kind,
  tasks,
  today,
  collapsed,
  activeTaskId,
  compact,
  kanbanActive,
  onToggleKanban,
  onToggleCollapsed,
  graceMap,
  onToggleTask,
  onSetStatus,
  onSetDueDate,
  onUpdateTask,
  onAddTask,
  onOpenSource,
  onOpenLink,
  onMoveQuadrant,
  createTagSuggest,
}: Props) {
  const meta = QUADRANT_META[kind];
  const [adding, setAdding] = useState(false);

  const { setNodeRef, isOver } = useDroppable({ id: kind });

  const openAdder = () => {
    setAdding(true);
    if (collapsed) onToggleCollapsed();
  };

  return (
    <section
      ref={setNodeRef}
      className={`em-quadrant em-quadrant-${kind.toLowerCase()} ${
        isOver ? 'em-quadrant-over' : ''
      }`}
      aria-label={meta.label}
    >
      <header className="em-quadrant-header">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="em-quadrant-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${meta.label}` : `Collapse ${meta.label}`}
          title={collapsed ? 'Expand quadrant' : 'Collapse quadrant'}
        >
          {collapsed ? '▶' : '▼'}
        </button>
        <div className="em-quadrant-title">
          <h3>{meta.label}</h3>
          <p>{meta.subtitle}</p>
        </div>
        <div className="em-quadrant-actions">
          <button
            type="button"
            onClick={openAdder}
            className="em-quadrant-add"
            title="Add task"
            aria-label={`Add task to ${meta.label}`}
          >
            +
          </button>
          <button
            type="button"
            onClick={onToggleKanban}
            className={`em-kanban-btn em-kanban-btn-labeled ${kanbanActive ? 'em-kanban-btn-active' : ''}`}
            title={kanbanActive ? 'Back to grid' : 'Kanban view (status columns)'}
            aria-label={kanbanActive ? 'Back to grid' : 'Kanban view'}
          >
            <Icon name="square-kanban" className="em-kanban-icon" />
            <span>Kanban</span>
          </button>
          <span className="em-quadrant-count">{tasks.length}</span>
        </div>
      </header>

      {!collapsed && (
        <div className="em-quadrant-body">
          {adding && (
            <AddTaskInput
              quadrant={kind}
              onSubmit={async (input) => {
                await onAddTask(input);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
              createTagSuggest={createTagSuggest}
            />
          )}
          {tasks.length === 0 && !adding ? (
            <p className="em-empty">No tasks</p>
          ) : (
            <ul className="em-task-list">
              {tasks.map((t) => {
                const key = `${t.sourceFile}:${t.lineIndex}`;
                return (
                  <TaskCard
                    key={key}
                    task={t}
                    today={today}
                    graceExpiresAt={graceMap.get(key)}
                    isActiveDrag={activeTaskId === key}
                    compact={compact}
                    onToggle={() => onToggleTask(t)}
                    onSetStatus={(s) => onSetStatus(t, s)}
                    onSetDueDate={(d) => onSetDueDate(t, d)}
                    onUpdateTask={(text, tags, opts, dependencies) =>
                      onUpdateTask(t, text, tags, opts, dependencies)
                    }
                    onOpenSource={(mode) => onOpenSource(t, mode)}
                    onOpenLink={(link) => onOpenLink(t, link)}
                    onMoveQuadrant={(target) => onMoveQuadrant(t, target)}
                    createTagSuggest={createTagSuggest}
                  />
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
