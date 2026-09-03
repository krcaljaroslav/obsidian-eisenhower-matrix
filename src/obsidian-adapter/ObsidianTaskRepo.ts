import { MarkdownView, type App, type TFile } from 'obsidian';
import { parseAllTasks, parseDaily } from '../core/parser.ts';
import {
  appendTaskUnderHeading,
  moveLineQuadrant,
  setDueDateOnLine,
  setStatusOnLine,
  toggleLine,
  transformLineInContent,
  updateLineTextAndTags,
  type UpdateOptions,
} from '../core/lineOps.ts';
import type { Priority, Quadrant, Task } from '../core/types.ts';
import { indexTaskDependencies } from '../core/taskUtils.ts';
import {
  buildDailyNotePath,
  ensureDailyExists,
  getDailyNotesFolder,
} from './dailyNotes.ts';

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export type TaskDependencySelection = {
  beforeTasks: Task[];
  afterTasks: Task[];
  missingBlockerIds: string[];
};

type PlannedTaskUpdate = {
  task: Task;
  text: string;
  contextTags: string[];
  options: UpdateOptions;
};

type WrittenFile = {
  file: TFile;
  before: string;
  after: string;
};

/**
 * Read + write přístup k taskům přes Obsidian Vault API.
 * Write operace běží přes `app.vault.process()` — atomic + serializovaný.
 */
export class ObsidianTaskRepo {
  private excludedFolders: string[];
  private dailyFolderOverride: string;
  private sectionHeading: string;
  private knownTaskIds = new Set<string>();

  constructor(
    private app: App,
    excludedFolders: string[] = [],
    dailyFolderOverride: string = '',
    sectionHeading: string = '# Today',
  ) {
    this.excludedFolders = excludedFolders;
    this.dailyFolderOverride = dailyFolderOverride;
    this.sectionHeading = sectionHeading;
  }

  setDailyFolderOverride(folder: string) {
    this.dailyFolderOverride = folder;
  }

  setSectionHeading(heading: string) {
    this.sectionHeading = heading;
  }

  // ============================================================
  // READ
  // ============================================================

  async getMatrixTasks(date: string): Promise<{
    tasks: Task[];
    todayFileExists: boolean;
    scannedFiles: number;
  }> {
    const dailyPath = buildDailyNotePath(this.app, date, this.dailyFolderOverride);
    const dailyFile = this.app.vault.getFileByPath(dailyPath);

    const dnesTasks: Task[] = [];
    let todayFileExists = false;

    if (dailyFile) {
      todayFileExists = true;
      const raw = await this.app.vault.cachedRead(dailyFile);
      const { tasks } = parseDaily(raw, this.sectionHeading);
      for (const t of tasks) {
        // Prázdné tasky (jen checkbox/tag bez textu) nezobrazujeme —
        // stejný filtr jako u ostatních souborů níž.
        if (!t.text) continue;
        dnesTasks.push({
          ...t,
          sourceFile: dailyFile.path,
          isFromDnes: true,
          isBlocked: false,
          blockedByTasks: [],
          blocksTasks: [],
          missingBlockers: [],
          hasCircularDependency: false,
        });
      }
    }

    const allFiles = this.app.vault.getMarkdownFiles();
    const otherTasks: Task[] = [];
    let scanned = 0;

    for (const file of allFiles) {
      if (dailyFile && file.path === dailyFile.path) continue;
      if (this.isExcluded(file)) continue;

      scanned++;
      const raw = await this.app.vault.cachedRead(file);
      const tasks = parseAllTasks(raw);
      for (const t of tasks) {
        if (!t.text) continue;
        otherTasks.push({
          ...t,
          sourceFile: file.path,
          isFromDnes: false,
          isBlocked: false,
          blockedByTasks: [],
          blocksTasks: [],
          missingBlockers: [],
          hasCircularDependency: false,
        });
      }
    }

    const seen = new Set<string>();
    const merged: Task[] = [];
    for (const t of [...dnesTasks, ...otherTasks]) {
      const key = `${t.sourceFile}:${t.lineIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(t);
    }
    this.knownTaskIds = new Set(merged.flatMap((task) => task.id ? [task.id] : []));

    return {
      tasks: indexTaskDependencies(merged),
      todayFileExists,
      scannedFiles: scanned,
    };
  }

  getExistingDailyDates(): Set<string> {
    const folder = getDailyNotesFolder(this.app, this.dailyFolderOverride);
    const dates = new Set<string>();
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      const fileDir = f.parent?.path ?? '';
      const inFolder =
        folder === '' ? (fileDir === '' || fileDir === '/') : fileDir === folder;
      if (!inFolder) continue;
      const m = DATE_FILE_RE.exec(f.name);
      if (m) dates.add(m[1]);
    }
    return dates;
  }

  // ============================================================
  // WRITE
  // ============================================================

  async toggleTask(sourceFile: string, lineIndex: number, todayISO: string): Promise<void> {
    const file = this.requireFile(sourceFile);
    await this.app.vault.process(file, (content) =>
      transformLineInContent(content, lineIndex, (line) => toggleLine(line, todayISO).newLine),
    );
  }

  async setStatus(
    sourceFile: string,
    lineIndex: number,
    status: string,
    todayISO: string,
  ): Promise<void> {
    const file = this.requireFile(sourceFile);
    await this.app.vault.process(file, (content) =>
      transformLineInContent(
        content,
        lineIndex,
        (line) => setStatusOnLine(line, status, todayISO).newLine,
      ),
    );
  }

  /**
   * Kanban drop ze spodního kvadrantu do status-sloupce: změní zároveň
   * kvadrant (#tag) i status (checkbox) v jednom zápisu.
   */
  async moveAndSetStatus(
    sourceFile: string,
    lineIndex: number,
    newQuadrant: Quadrant,
    status: string,
    todayISO: string,
  ): Promise<void> {
    const file = this.requireFile(sourceFile);
    await this.app.vault.process(file, (content) =>
      transformLineInContent(content, lineIndex, (line) => {
        const moved = moveLineQuadrant(line, newQuadrant).newLine;
        return setStatusOnLine(moved, status, todayISO).newLine;
      }),
    );
  }

  async moveTask(
    sourceFile: string,
    lineIndex: number,
    newQuadrant: Quadrant,
  ): Promise<void> {
    const file = this.requireFile(sourceFile);
    await this.app.vault.process(file, (content) =>
      transformLineInContent(
        content,
        lineIndex,
        (line) => moveLineQuadrant(line, newQuadrant).newLine,
      ),
    );
  }

  async setDueDate(
    sourceFile: string,
    lineIndex: number,
    newDueDate: string | null,
  ): Promise<void> {
    const file = this.requireFile(sourceFile);
    await this.app.vault.process(file, (content) =>
      transformLineInContent(
        content,
        lineIndex,
        (line) => setDueDateOnLine(line, newDueDate).newLine,
      ),
    );
  }

  async updateTask(
    task: Task,
    text: string,
    contextTags: string[],
    options: UpdateOptions = {},
    dependencies?: TaskDependencySelection,
  ): Promise<void> {
    if (!dependencies) {
      await this.applyTaskUpdates([
        { task, text, contextTags, options },
      ], task.sourceFile);
      return;
    }

    const updates = this.planDependencyUpdates(task, text, contextTags, options, dependencies);
    await this.applyTaskUpdates(updates, task.sourceFile);
  }

  private planDependencyUpdates(
    task: Task,
    text: string,
    contextTags: string[],
    options: UpdateOptions,
    dependencies: TaskDependencySelection,
  ): PlannedTaskUpdate[] {
    const beforeTasks = this.uniqueTasks(dependencies.beforeTasks, task);
    const afterTasks = this.uniqueTasks(dependencies.afterTasks, task);
    const beforeKeys = new Set(beforeTasks.map((candidate) => this.taskKey(candidate)));
    if (afterTasks.some((candidate) => beforeKeys.has(this.taskKey(candidate)))) {
      throw new Error('A task cannot be both before and after this one');
    }
    const allKnownTasks = [task, ...task.blockedByTasks, ...task.blocksTasks, ...beforeTasks, ...afterTasks];
    const usedIds = new Set([
      ...this.knownTaskIds,
      ...allKnownTasks.flatMap((candidate) => candidate.id ? [candidate.id] : []),
    ]);
    const assignedIds = new Map<string, string>();
    const idFor = (candidate: Task): string => {
      if (candidate.id) return candidate.id;
      const key = this.taskKey(candidate);
      const existing = assignedIds.get(key);
      if (existing) return existing;
      const generated = this.generateTaskId(usedIds);
      assignedIds.set(key, generated);
      return generated;
    };

    const ownId = afterTasks.length > 0 ? idFor(task) : task.id;
    const ownBlockedBy = [
      ...new Set([
        ...dependencies.missingBlockerIds,
        ...beforeTasks.map(idFor),
      ]),
    ];
    const planned = new Map<string, PlannedTaskUpdate>();
    planned.set(this.taskKey(task), {
      task,
      text,
      contextTags,
      options: { ...options, id: ownId, blockedBy: ownBlockedBy },
    });

    for (const blocker of beforeTasks) {
      this.mergePlannedUpdate(planned, blocker, { id: idFor(blocker) });
    }

    const selectedAfterKeys = new Set(afterTasks.map((candidate) => this.taskKey(candidate)));
    for (const dependent of this.uniqueTasks([...task.blocksTasks, ...afterTasks], task)) {
      const withoutOldId = task.id
        ? dependent.blockedBy.filter((blockerId) => blockerId !== task.id)
        : dependent.blockedBy;
      const nextBlockedBy = selectedAfterKeys.has(this.taskKey(dependent)) && ownId
        ? [...new Set([...withoutOldId, ownId])]
        : withoutOldId;
      this.mergePlannedUpdate(planned, dependent, { blockedBy: nextBlockedBy });
    }

    return [...planned.values()];
  }

  private mergePlannedUpdate(
    planned: Map<string, PlannedTaskUpdate>,
    task: Task,
    options: UpdateOptions,
  ): void {
    const key = this.taskKey(task);
    const existing = planned.get(key);
    planned.set(key, {
      task,
      text: existing?.text ?? task.text,
      contextTags: existing?.contextTags ?? task.contextTags,
      options: { ...existing?.options, ...options },
    });
  }

  private async applyTaskUpdates(
    updates: PlannedTaskUpdate[],
    ownSourceFile: string,
  ): Promise<void> {
    const byFile = new Map<string, PlannedTaskUpdate[]>();
    for (const update of updates) {
      const fileUpdates = byFile.get(update.task.sourceFile) ?? [];
      fileUpdates.push(update);
      byFile.set(update.task.sourceFile, fileUpdates);
    }

    const orderedPaths = [
      ownSourceFile,
      ...[...byFile.keys()].filter((path) => path !== ownSourceFile),
    ];
    const written: WrittenFile[] = [];
    try {
      for (const path of orderedPaths) {
        const fileUpdates = byFile.get(path);
        if (!fileUpdates) continue;
        const file = this.requireFile(path);
        let before = '';
        let after = '';
        await this.app.vault.process(file, (content) => {
          before = content;
          after = fileUpdates
            .slice()
            .sort((left, right) => right.task.lineIndex - left.task.lineIndex)
            .reduce((current, update) =>
              transformLineInContent(current, update.task.lineIndex, (line) => {
                if (line !== update.task.raw) {
                  throw new Error(`Task changed before save: ${update.task.sourceFile}:${update.task.lineIndex + 1}`);
                }
                return updateLineTextAndTags(
                  line,
                  update.text,
                  update.contextTags,
                  update.options,
                ).newLine;
              }), content);
          return after;
        });
        written.push({ file, before, after });
      }
    } catch (error) {
      const rollbackErrors = await this.rollbackWrittenFiles(written);
      const failedPath = orderedPaths[written.length] ?? ownSourceFile;
      const baseMessage = failedPath === ownSourceFile
        ? String((error as Error).message ?? error)
        : `Could not update the linked task in ${failedPath}`;
      const rollbackSuffix = rollbackErrors.length > 0
        ? ` Rollback failed for ${rollbackErrors.join(', ')}.`
        : '';
      throw new Error(baseMessage + rollbackSuffix);
    }
  }

  private async rollbackWrittenFiles(written: WrittenFile[]): Promise<string[]> {
    const failures: string[] = [];
    for (const entry of written.slice().reverse()) {
      try {
        await this.app.vault.process(entry.file, (content) => {
          if (content !== entry.after) {
            throw new Error('File changed after dependency update');
          }
          return entry.before;
        });
      } catch {
        failures.push(entry.file.path);
      }
    }
    return failures;
  }

  private uniqueTasks(tasks: Task[], excluded: Task): Task[] {
    const unique = new Map<string, Task>();
    for (const task of tasks) {
      const key = this.taskKey(task);
      if (key !== this.taskKey(excluded)) unique.set(key, task);
    }
    return [...unique.values()];
  }

  private taskKey(task: Task): string {
    return `${task.sourceFile}:${task.lineIndex}`;
  }

  private generateTaskId(usedIds: Set<string>): string {
    let candidate = '';
    do {
      candidate = `em-${Math.random().toString(36).slice(2, 10)}`;
    } while (usedIds.has(candidate));
    usedIds.add(candidate);
    return candidate;
  }

  /**
   * Přidá task pod sekční heading v daily note pro `date`. Pokud daily note
   * neexistuje, vytvoří ji přes core „Daily notes" template (nebo minimum scaffold).
   *
   * Vrací `sourceFile` (cestu k daily souboru) — UI ji pak může použít pro refetch.
   */
  async addTask(
    date: string,
    text: string,
    quadrant: Quadrant,
    dueDate?: string | null,
    priority?: Priority | null,
    status: string = ' ',
  ): Promise<{ sourceFile: string; lineIndex: number; newLine: string }> {
    const file = await ensureDailyExists(
      this.app,
      date,
      this.sectionHeading,
      this.dailyFolderOverride,
    );

    let lineIndex = -1;
    let newLine = '';
    await this.app.vault.process(file, (content) => {
      const result = appendTaskUnderHeading(
        content,
        this.sectionHeading,
        text,
        quadrant,
        date,
        dueDate,
        priority,
        status,
      );
      lineIndex = result.lineIndex;
      newLine = result.newLine;
      return result.newContent;
    });

    // U právě vytvořeného daily souboru se občas stane, že už otevřené
    // reading view nezareaguje na první modify event a uživatel pak nový
    // task v náhledu nevidí, dokud nepřepne do edit modu. Proaktivně
    // překreslíme všechny otevřené preview viewy téhož souboru.
    this.refreshOpenPreviews(file);

    return { sourceFile: file.path, lineIndex, newLine };
  }

  private refreshOpenPreviews(file: TFile): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (
        view instanceof MarkdownView &&
        view.file?.path === file.path &&
        view.getMode() === 'preview'
      ) {
        view.previewMode?.rerender(true);
      }
    });
  }

  // ============================================================
  // Helpers
  // ============================================================

  private requireFile(sourcePath: string): TFile {
    const file = this.app.vault.getFileByPath(sourcePath);
    if (!file) throw new Error(`File not found in vault: ${sourcePath}`);
    return file;
  }

  private isExcluded(file: TFile): boolean {
    return this.excludedFolders.some(
      (folder) => file.path === folder || file.path.startsWith(folder + '/'),
    );
  }

  setExcludedFolders(folders: string[]) {
    this.excludedFolders = folders;
  }
}
