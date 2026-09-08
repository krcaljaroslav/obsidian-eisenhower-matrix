import { useEffect, useRef, useState } from 'react';
import { Platform } from 'obsidian';
import type { Priority, Quadrant } from '../core/types.ts';
import { PriorityPicker } from './PriorityPicker.tsx';
import { HiddenDateInput, type HiddenDateInputHandle } from './HiddenDateInput.tsx';

type Props = {
  quadrant: Quadrant;
  /** Status nově vytvořeného tasku (Kanban sloupec). Default ' ' = to-do. */
  status?: string;
  onSubmit: (input: {
    text: string;
    quadrant: Quadrant;
    dueDate: string | null;
    priority: Priority | null;
    status?: string;
  }) => Promise<void>;
  onCancel: () => void;
  createTagSuggest: (inputEl: HTMLInputElement) => void;
  initialTags?: string[];
};

function normalizeTagsInput(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));
}

export function AddTaskInput({ quadrant, status, onSubmit, onCancel, createTagSuggest, initialTags = [] }: Props) {
  const [text, setText] = useState('');
  const [tagsRaw, setTagsRaw] = useState(initialTags.join(' '));
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState<Priority | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HiddenDateInputHandle>(null);

  // Attach tag autocomplete na tags input — jen na mount.
  useEffect(() => {
    if (tagsRef.current) createTagSuggest(tagsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: attach tag autocomplete once
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    // Mobile: po focusování virtuální klávesnice překryje spodní polovinu obrazovky.
    // Form je v kvadrantu DO/DECIDE/... a může být pod klávesnicí (= neviditelný).
    // ScrollIntoView ho posune do středu zbylého viewportu.
    // Delay 350 ms = klávesnice má čas vyjet, jinak browser scrolluje do špatné pozice.
    if (Platform.isMobile) {
      const timer = window.setTimeout(() => {
        inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 350);
      return () => window.clearTimeout(timer);
    }
  }, []);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    const tags = normalizeTagsInput(tagsRaw);
    const composed = tags.length > 0 ? `${tags.join(' ')} ${trimmed}` : trimmed;
    setPending(true);
    try {
      await onSubmit({
        text: composed,
        quadrant,
        dueDate: dueDate || null,
        priority,
        status,
      });
      setText('');
      setTagsRaw('');
      setDueDate('');
      setPriority(null);
    } finally {
      setPending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Když je otevřený tag-autocomplete popup, nech Enter jemu — jinak
      // by se task uložil se stavem PŘED výběrem návrhu (= výběr by se ztratil).
      if (e.currentTarget.ownerDocument.querySelector('.suggestion-container')) {
        return;
      }
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const openDatePicker = () => dateRef.current?.open();

  return (
    <div className="em-add-form">
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`New task in ${quadrant}… (Enter)`}
        disabled={pending}
        className="em-add-input em-add-input-text"
      />
      <input
        ref={tagsRef}
        type="text"
        value={tagsRaw}
        onChange={(e) => setTagsRaw(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="#tags (autocomplete · space-separated · # added automatically)"
        disabled={pending}
        className="em-add-input em-add-input-tags"
      />
      <div className="em-add-controls">
        <button
          type="button"
          tabIndex={-1}
          onClick={openDatePicker}
          className={`em-badge ${dueDate ? 'em-badge-clickable' : 'em-badge-add'}`}
          title="Set due date"
        >
          📅 {dueDate || 'no date'}
        </button>
        {dueDate && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setDueDate('')}
            className="em-badge-clear"
            title="Remove due date"
          >
            ×
          </button>
        )}
        <HiddenDateInput
          ref={dateRef}
          value={dueDate}
          onCommit={(v) => {
            setDueDate(v);
            // Po zvolení data vrať focus do textu — Enter pak uloží task.
            inputRef.current?.focus();
          }}
        />

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
            onClick={() => void submit()}
            disabled={pending || !text.trim()}
            className="em-btn-primary-accent"
          >
            {pending ? '…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
