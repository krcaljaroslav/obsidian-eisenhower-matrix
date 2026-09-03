import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Menu, Platform, setIcon, type App, type PaneType } from 'obsidian';
import type { Priority, Quadrant, Task } from '../core/types.ts';
import {
  PRIORITY_META,
  QUADRANTS,
  QUADRANT_META,
  TASK_STATUSES,
} from '../core/types.ts';
import { isOverdue } from '../core/taskUtils.ts';
import { DueDatePicker } from './DueDatePicker.tsx';
import { HiddenDateInput, type HiddenDateInputHandle } from './HiddenDateInput.tsx';
import { PriorityPicker } from './PriorityPicker.tsx';
import { TaskSuggest } from './TaskSuggest.ts';
import { renderInlineMarkdown, type InlineLinkHandler } from './inlineMarkdown.tsx';

export const GRACE_MS = 3000;

export const DependencyNavigationContext = createContext<
  ((task: Task, event?: React.MouseEvent) => void) | null
>(null);

export const TaskEditingContext = createContext<{ app: App; tasks: Task[] } | null>(null);

export type DependencySelection = {
  beforeTasks: Task[];
  afterTasks: Task[];
  missingBlockerIds: string[];
};

/**
 * Tenký wrapper kolem Obsidian `setIcon` — renderuje Lucide ikonu do
 * <span> přes effect. Používáme to ve statusovém boxu, aby se ikona
 * 100% shodovala s ikonou v kontextovém menu (stejný název = stejné SVG).
 */
function LucideIcon({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) setIcon(ref.current, name);
  }, [name]);
  return <span ref={ref} className="em-task-status-icon" aria-hidden="true" />;
}

type Props = {
  task: Task;
  today: string;
  graceExpiresAt?: number;
  isActiveDrag: boolean;
  compact: boolean;
  onToggle: () => void;
  onSetStatus: (newStatus: string) => Promise<void>;
  onSetDueDate: (newDueDate: string | null) => Promise<void>;
  onUpdateTask: (
    text: string,
    contextTags: string[],
    options: { dueDate: string | null; priority: Priority | null },
    dependencies: DependencySelection,
  ) => Promise<void>;
  onOpenSource: (mode?: PaneType | boolean) => void;
  onOpenLink: InlineLinkHandler;
  onMoveQuadrant: (target: Quadrant) => void;
  createTagSuggest: (inputEl: HTMLInputElement) => void;
};

export function TaskCard({
  task,
  today,
  graceExpiresAt,
  isActiveDrag,
  compact,
  onToggle,
  onSetStatus,
  onSetDueDate,
  onUpdateTask,
  onOpenSource,
  onOpenLink,
  onMoveQuadrant,
  createTagSuggest,
}: Props) {
  const navigateToDependency = useContext(DependencyNavigationContext);
  const overdue = isOverdue(task, today);
  const [editing, setEditing] = useState(false);

  const draggableId = `${task.sourceFile}:${task.lineIndex}`;
  // Drag jen na desktopu. Na mobilu je touch-drag v Obsidian webview
  // nespolehlivý (long-press hijackne OS) — místo toho přesun přes
  // context menu „Přesunout do…".
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: draggableId,
    disabled: editing || Platform.isMobile,
  });

  const now = Date.now();
  // Grace platí pro libovolný „closed" stav ([x] i [-]) — applyLocalStatus
  // přidává klíč do graceMap jen pro tyhle stavy, takže existence
  // graceExpiresAt > now implikuje, že má smysl ukázat zelený pruh + undo.
  // (Podmínka narovno testuje graceExpiresAt → TS ho zúží, není třeba `!`.)
  const graceRemaining =
    graceExpiresAt !== undefined && graceExpiresAt > now ? graceExpiresAt - now : 0;
  const inGrace = graceRemaining > 0;
  const gracePct = (graceRemaining / GRACE_MS) * 100;

  const enterEdit = () => {
    if (editing) return;
    setEditing(true);
  };

  const buildMenu = (): Menu => {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('Edit').setIcon('pencil').onClick(enterEdit),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Open file')
        .setIcon('file-text')
        .onClick(() => onOpenSource(false)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Open in new tab')
        .setIcon('file-plus')
        .onClick(() => onOpenSource('tab')),
    );
    menu.addItem((item) =>
      item
        .setTitle('Open in new pane to the right')
        .setIcon('separator-vertical')
        .onClick(() => onOpenSource('split')),
    );
    menu.addItem((item) =>
      item
        .setTitle('Open in new window')
        .setIcon('picture-in-picture-2')
        .onClick(() => onOpenSource('window')),
    );
    // Přesun do jiného kvadrantu — hlavní cesta pro mobil (drag tam nefunguje
    // spolehlivě). Vynechá aktuální kvadrant tasku.
    menu.addSeparator();
    for (const q of QUADRANTS) {
      if (q === task.quadrant) continue;
      menu.addItem((item) =>
        item
          .setTitle(`Move to ${QUADRANT_META[q].label}`)
          .setIcon('arrow-right')
          .onClick(() => onMoveQuadrant(q)),
      );
    }
    // Status (6 Basic stavů) — sekce úmyslně až dole, ať nepřebírá pozornost
    // od běžnějších voleb (Edit / Open / Move). Aktuální je zatržený.
    menu.addSeparator();
    for (const s of TASK_STATUSES) {
      const isCurrent =
        s.char === task.status ||
        (s.char === 'x' && task.status.toLowerCase() === 'x');
      menu.addItem((item) =>
        item
          .setTitle(`Mark as ${s.label}`)
          .setIcon(s.icon)
          .setChecked(isCurrent)
          .onClick(() => {
            if (!isCurrent) void onSetStatus(s.char);
          }),
      );
    }
    return menu;
  };

  /**
   * Kontextové menu — desktop: pravý klik · mobil: long-press i double-tap.
   */
  const showContextMenu = (e: React.MouseEvent) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    buildMenu().showAtMouseEvent(e.nativeEvent);
  };

  /**
   * Double-tap: desktop → rovnou edit (rychlá cesta) · mobil → kontextové menu.
   */
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (editing) return;
    if (Platform.isMobile) {
      e.preventDefault();
      e.stopPropagation();
      buildMenu().showAtMouseEvent(e.nativeEvent);
    } else {
      enterEdit();
    }
  };

  const taskText = task.text ? (
    renderInlineMarkdown(task.text, onOpenLink)
  ) : (
    <em className="em-empty-text">(empty text)</em>
  );

  // Statusový knoflík: ikona je TÁŽ Lucide ikona jako u příslušné položky
  // v kontextovém menu (TASK_STATUSES.icon) — vykreslíme přes Obsidian
  // setIcon, ať se v boxu i v menu zobrazuje 100 % stejně. data-task
  // necháme i pro CSS (např. accent výplň u done).
  const statusForRender = task.status === '' ? ' ' : task.status;
  const statusMeta = TASK_STATUSES.find(
    (s) =>
      s.char === task.status ||
      (s.char === 'x' && task.status.toLowerCase() === 'x'),
  );
  const statusIconName = statusMeta?.icon ?? 'circle';
  const checkbox = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        buildMenu().showAtMouseEvent(e.nativeEvent);
      }}
      className="em-task-checkbox em-task-status"
      data-task={statusForRender}
      aria-label={task.checked ? 'Mark as not done (undo)' : 'Mark as done'}
      title="Click to toggle done · right-click for all states"
    >
      <LucideIcon name={statusIconName} />
    </button>
  );

  const priorityBadge = task.priority ? (
    <span
      className="em-badge"
      style={{ color: PRIORITY_META[task.priority].tone }}
      title={`Priority: ${PRIORITY_META[task.priority].label}`}
    >
      {PRIORITY_META[task.priority].emoji} {PRIORITY_META[task.priority].label}
    </span>
  ) : null;

  const dueDatePicker = (
    <DueDatePicker
      currentDueDate={task.dueDate}
      onChange={onSetDueDate}
      variant={task.dueDate ? 'badge' : 'add'}
      overdue={overdue}
    />
  );

  const dependencyBadges = (
    <>
      {task.blockedByTasks.length > 0 && (() => {
        const [firstBlocker, ...otherBlockers] = task.blockedByTasks;
        const blockerNames = task.blockedByTasks.map((blocker) => blocker.text || '(empty text)');
        return (
          <button
            type="button"
            className="em-badge em-badge-clickable em-dependency-badge"
            title={blockerNames.join('\n')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              navigateToDependency?.(firstBlocker, event);
            }}
          >
            ⛔ {firstBlocker.text || '(empty text)'}
            {otherBlockers.length > 0 ? ` +${otherBlockers.length}` : ''}
          </button>
        );
      })()}
      {task.missingBlockers.length > 0 && (
        <span
          className="em-badge em-dependency-badge"
          title={`Depends on a task that no longer exists: ${task.missingBlockers.join(', ')}`}
        >
          ⛔ Unknown task
        </span>
      )}
      {task.blocksTasks.length > 0 && (
        <button
          type="button"
          className="em-badge em-badge-clickable em-dependency-badge"
          title={task.blocksTasks.map((blockedTask) => blockedTask.text || '(empty text)').join('\n')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (task.blocksTasks.length === 1) {
              navigateToDependency?.(task.blocksTasks[0], event);
              return;
            }
            const menu = new Menu();
            for (const blockedTask of task.blocksTasks) {
              menu.addItem((item) =>
                item
                  .setTitle(blockedTask.text || '(empty text)')
                  .onClick(() => navigateToDependency?.(blockedTask)),
              );
            }
            menu.showAtMouseEvent(event.nativeEvent);
          }}
        >
          🆔 blocks {task.blocksTasks.length}
        </button>
      )}
      {task.hasCircularDependency && (
        <span className="em-badge em-dependency-badge" title="Circular dependency">
          ⚠ Circular dependency
        </span>
      )}
    </>
  );

  return (
    <li
      ref={setNodeRef}
      {...(editing ? {} : attributes)}
      {...(editing ? {} : listeners)}
      onDoubleClick={handleDoubleClick}
      onContextMenu={showContextMenu}
      data-task-key={draggableId}
      className={`em-task ${overdue ? 'em-task-overdue' : ''} ${
        inGrace ? 'em-task-grace' : ''
      } ${editing ? 'em-task-editing' : ''} ${task.checked && !editing ? 'em-task-checked' : ''} ${
        task.status === '-' && !editing ? 'em-task-canceled' : ''
      } ${task.isBlocked && !editing ? 'em-task-blocked' : ''} ${
        isActiveDrag && !Platform.isMobile ? 'em-task-active-drag' : ''
      }`}
      title={
        editing
          ? undefined
          : Platform.isMobile
            ? 'Long-press or double-tap for menu'
            : 'Double-click to edit · right-click for menu'
      }
    >
      {editing ? (
        <EditForm
          task={task}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
          onUpdate={onUpdateTask}
          createTagSuggest={createTagSuggest}
        />
      ) : compact ? (
        <div className="em-task-row">
          {checkbox}
          <div className="em-task-body em-task-body-compact">
            <p className="em-task-text em-task-text-compact">{taskText}</p>
            <div className="em-task-badges">
              {dependencyBadges}
              {priorityBadge}
              {dueDatePicker}
            </div>
          </div>
        </div>
      ) : (
        <div className="em-task-row">
          {checkbox}
          <div className="em-task-body">
            <p className="em-task-text">{taskText}</p>
            {!task.isFromDnes && (
              <p className="em-task-source" title={task.sourceFile}>
                📁 {shortenPath(task.sourceFile)}
              </p>
            )}
            <div className="em-task-badges">
              {dependencyBadges}
              {task.contextTags.map((tag) => (
                <span key={tag} className="em-tag">
                  {tag}
                </span>
              ))}
              {priorityBadge}
              {dueDatePicker}
              {task.startDate && <span className="em-badge">🛫 {task.startDate}</span>}
              {task.doneDate && <span className="em-badge">✅ {task.doneDate}</span>}
            </div>
            {inGrace && (
              <p className="em-task-grace-hint">
                ↩ click again to undo · {Math.ceil(graceRemaining / 1000)} s
              </p>
            )}
          </div>
        </div>
      )}
      {inGrace && !editing && (
        <div className="em-grace-bar" style={{ width: `${gracePct}%` }} aria-hidden />
      )}
    </li>
  );
}

// ===========================================================
// Edit form (text + tags + due date + priority)
// ===========================================================

type EditFormProps = {
  task: Task;
  onCancel: () => void;
  onSaved: () => void;
  onUpdate: Props['onUpdateTask'];
  createTagSuggest: (inputEl: HTMLInputElement) => void;
};

function EditForm({ task, onCancel, onSaved, onUpdate, createTagSuggest }: EditFormProps) {
  const editingContext = useContext(TaskEditingContext);
  const [text, setText] = useState(task.text);
  const [tagsRaw, setTagsRaw] = useState(task.contextTags.join(' '));
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [priority, setPriority] = useState<Priority | null>(task.priority ?? null);
  const [beforeTasks, setBeforeTasks] = useState(task.blockedByTasks);
  const [afterTasks, setAfterTasks] = useState(task.blocksTasks);
  const [missingBlockerIds, setMissingBlockerIds] = useState(task.missingBlockers);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HiddenDateInputHandle>(null);
  const beforeTasksRef = useRef(beforeTasks);
  const afterTasksRef = useRef(afterTasks);
  beforeTasksRef.current = beforeTasks;
  afterTasksRef.current = afterTasks;

  useEffect(() => {
    const el = textRef.current;
    if (el) {
      el.focus();
      el.select();
    }
    if (tagsRef.current) createTagSuggest(tagsRef.current);
    if (editingContext && beforeRef.current && afterRef.current) {
      const ownKey = dependencyTaskKey(task);
      new TaskSuggest(
        editingContext.app,
        beforeRef.current,
        () => editingContext.tasks,
        () => new Set([
          ownKey,
          ...beforeTasksRef.current.map(dependencyTaskKey),
          ...afterTasksRef.current.map(dependencyTaskKey),
        ]),
        (selected) => setBeforeTasks((current) => [...current, selected]),
      );
      new TaskSuggest(
        editingContext.app,
        afterRef.current,
        () => editingContext.tasks,
        () => new Set([
          ownKey,
          ...afterTasksRef.current.map(dependencyTaskKey),
          ...beforeTasksRef.current.map(dependencyTaskKey),
        ]),
        (selected) => setAfterTasks((current) => [...current, selected]),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: focus + attach autocomplete once
  }, []);

  const save = async () => {
    if (pending) return;
    const trimmed = text.trim();
    if (!trimmed) {
      setError('Text cannot be empty');
      return;
    }
    const tagsArray = tagsRaw
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    setPending(true);
    setError(null);
    try {
      await onUpdate(trimmed, tagsArray, {
        dueDate: dueDate || null,
        priority,
      }, {
        beforeTasks,
        afterTasks,
        missingBlockerIds,
      });
      onSaved();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setPending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Když je otevřený tag-autocomplete popup, nech Enter jemu — jinak
      // by se uložil stav PŘED výběrem návrhu (výběr tagu by se ztratil).
      const doc = (e.currentTarget as HTMLElement).ownerDocument;
      if (doc.querySelector('.suggestion-container')) {
        return;
      }
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const openDatePicker = () => dateRef.current?.open();

  return (
    <div
      className="em-edit-form"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <input
        ref={textRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={pending}
        className="em-edit-text"
        placeholder="Task text"
      />
      <input
        ref={tagsRef}
        type="text"
        value={tagsRaw}
        onChange={(e) => setTagsRaw(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={pending}
        placeholder="#tag1 #tag2 (autocomplete · space-separated · # added automatically)"
        className="em-edit-tags"
      />
      <div className="em-edit-dependencies">
        <DependencyField
          icon="⛔"
          placeholder="Before this"
          title="Type to search tasks that must be completed before this task"
          inputRef={beforeRef}
          tasks={beforeTasks}
          missingIds={missingBlockerIds}
          disabled={pending || !editingContext}
          onRemoveTask={(removed) =>
            setBeforeTasks((current) => current.filter((candidate) => dependencyTaskKey(candidate) !== dependencyTaskKey(removed)))
          }
          onRemoveMissing={(removedId) =>
            setMissingBlockerIds((current) => current.filter((id) => id !== removedId))
          }
        />
        <DependencyField
          icon="🆔"
          placeholder="After this"
          title="Type to search tasks that must be completed after this task"
          inputRef={afterRef}
          tasks={afterTasks}
          missingIds={[]}
          disabled={pending || !editingContext}
          onRemoveTask={(removed) =>
            setAfterTasks((current) => current.filter((candidate) => dependencyTaskKey(candidate) !== dependencyTaskKey(removed)))
          }
          onRemoveMissing={() => undefined}
        />
      </div>
      <div className="em-edit-controls">
        <button
          type="button"
          onClick={openDatePicker}
          disabled={pending}
          className={`em-badge ${dueDate ? 'em-badge-clickable' : 'em-badge-add'}`}
          title="Set due date"
        >
          📅 {dueDate || 'no date'}
        </button>
        {dueDate && (
          <button
            type="button"
            onClick={() => setDueDate('')}
            disabled={pending}
            className="em-badge-clear"
            title="Remove due date"
          >
            ×
          </button>
        )}
        <HiddenDateInput ref={dateRef} value={dueDate} onCommit={setDueDate} />

        <PriorityPicker value={priority} onChange={setPriority} disabled={pending} />
      </div>
      <div className="em-edit-actions">
        <span className="em-edit-hint">Enter = save · Esc = cancel</span>
        <div className="em-edit-buttons">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="em-btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={pending || !text.trim()}
            className="em-btn-primary-accent"
          >
            {pending ? '…' : 'Save'}
          </button>
        </div>
      </div>
      {error && (
        <p className="em-edit-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function dependencyTaskKey(task: Task): string {
  return `${task.sourceFile}:${task.lineIndex}`;
}

type DependencyFieldProps = {
  icon: string;
  placeholder: string;
  title: string;
  inputRef: React.RefObject<HTMLInputElement>;
  tasks: Task[];
  missingIds: string[];
  disabled: boolean;
  onRemoveTask: (task: Task) => void;
  onRemoveMissing: (id: string) => void;
};

function DependencyField({
  icon,
  placeholder,
  title,
  inputRef,
  tasks,
  missingIds,
  disabled,
  onRemoveTask,
  onRemoveMissing,
}: DependencyFieldProps) {
  const dependencies = [
    ...tasks.map((task) => ({ label: task.text || '(empty text)', remove: () => onRemoveTask(task) })),
    ...missingIds.map((id) => ({ label: `Unknown task (${id})`, remove: () => onRemoveMissing(id) })),
  ];
  const [first, ...additional] = dependencies;
  const showAdditional = (event: React.MouseEvent) => {
    const menu = new Menu();
    for (const dependency of additional) {
      menu.addItem((item) => item
        .setTitle(`Remove ${dependency.label}`)
        .setIcon('x')
        .onClick(dependency.remove));
    }
    menu.showAtMouseEvent(event.nativeEvent);
  };

  return (
    <div className="em-dependency-field" title={title}>
      {first && (
        <button
          type="button"
          className="em-dependency-chip"
          disabled={disabled}
          onClick={first.remove}
          title={`Remove ${first.label}`}
        >
          <span className="em-dependency-chip-label">{first.label}</span>
          <span aria-hidden>×</span>
        </button>
      )}
      {additional.length > 0 && (
        <button
          type="button"
          className="em-dependency-more"
          disabled={disabled}
          onClick={showAdditional}
          title={additional.map((dependency) => dependency.label).join('\n')}
        >
          +{additional.length}
        </button>
      )}
      <span className="em-dependency-input-icon" aria-hidden>{icon}</span>
      <input
        ref={inputRef}
        type="text"
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur();
        }}
      />
    </div>
  );
}

// ===========================================================
// Drag overlay (zobrazena nad ostatními kartami při tažení)
// ===========================================================

export function TaskCardOverlay({ task }: { task: Task }) {
  return (
    <div className="em-task em-task-overlay">
      <p className="em-task-text">{renderInlineMarkdown(task.text)}</p>
      {(task.contextTags.length > 0 || task.priority) && (
        <div className="em-task-badges">
          {task.contextTags.map((tag) => (
            <span key={tag} className="em-tag">
              {tag}
            </span>
          ))}
          {task.priority && (
            <span className="em-badge" style={{ color: PRIORITY_META[task.priority].tone }}>
              {PRIORITY_META[task.priority].emoji} {PRIORITY_META[task.priority].label}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function shortenPath(rel: string): string {
  const parts = rel.split('/');
  const filename = parts.pop() ?? '';
  const name = filename.replace(/\.md$/i, '');
  const cleaned = parts.map((p) => p.replace(/^\d+_/, ''));
  if (cleaned[0]?.toLowerCase() === 'daily-tasks') {
    return `Daily / ${name}`;
  }
  const short = cleaned.slice(-2).join(' / ');
  return short ? `${short} / ${name}` : name;
}
