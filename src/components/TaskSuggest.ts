import { AbstractInputSuggest, type App } from 'obsidian';
import type { Task } from '../core/types.ts';

const MAX_SUGGESTIONS = 15;

function taskKey(task: Task): string {
  return `${task.sourceFile}:${task.lineIndex}`;
}

/** Autocomplete tasků podle názvu; id zůstává implementační detail formátu Tasks. */
export class TaskSuggest extends AbstractInputSuggest<Task> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly getAvailableTasks: () => Task[],
    private readonly getExcludedTaskKeys: () => Set<string>,
    private readonly onSelectTask: (task: Task) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): Task[] {
    const normalizedQuery = query.trim().toLowerCase();
    const excluded = this.getExcludedTaskKeys();
    return this.getAvailableTasks()
      .filter((task) =>
        !excluded.has(taskKey(task)) &&
        (normalizedQuery.length === 0 || task.text.toLowerCase().includes(normalizedQuery)),
      )
      .slice(0, MAX_SUGGESTIONS);
  }

  renderSuggestion(task: Task, el: HTMLElement): void {
    el.addClass('em-task-suggestion');
    const title = el.createDiv({ cls: 'em-task-suggestion-title' });
    title.setText(task.text || '(empty text)');
    const source = el.createDiv({ cls: 'em-task-suggestion-source' });
    source.setText(task.sourceFile);
  }

  selectSuggestion(task: Task): void {
    this.onSelectTask(task);
    this.inputEl.value = '';
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    this.inputEl.focus();
    this.close();
  }
}
