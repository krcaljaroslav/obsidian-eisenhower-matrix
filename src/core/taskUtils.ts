/**
 * Sort + filter utility — sdíleno s `Eisenhower-matrix/app/src/utils/taskUtils.ts`.
 * Drž sync ručně.
 */

import { isClosedStatus, type Priority, type Task } from './types.ts';

const PRIORITY_RANK: Record<Priority | 'none', number> = {
  highest: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4,
  none: 5,
};

function priorityRank(p?: Priority): number {
  return p ? PRIORITY_RANK[p] : PRIORITY_RANK.none;
}

/**
 * Comparator pro řazení tasků uvnitř kvadrantu:
 *   1. Overdue (dueDate < today)
 *   2. Priorita desc (🔺 → ⏫ → 🔼 → 🔽 → ⏬ → bez)
 *   3. Due date asc (s dueDate před bez)
 *   4. Text alfabeticky (cs locale)
 */
export function makeCompareTask(today: string): (a: Task, b: Task) => number {
  return (a, b) => {
    const aOverdue = isOverdue(a, today);
    const bOverdue = isOverdue(b, today);
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;

    if (a.dueDate && b.dueDate) {
      const cmp = a.dueDate.localeCompare(b.dueDate);
      if (cmp !== 0) return cmp;
    } else if (a.dueDate) {
      return -1;
    } else if (b.dueDate) {
      return 1;
    }

    return a.text.localeCompare(b.text, 'cs');
  };
}

/**
 * Doplní obousměrný index závislostí. První task s daným ID vyhrává,
 * aby duplicitní ID neměnilo význam podle pozdějšího pořadí průchodu.
 */
export function indexTaskDependencies(tasks: Task[]): Task[] {
  const indexedTasks: Task[] = tasks.map((task) => ({
    ...task,
    isBlocked: false,
    blockedByTasks: [],
    blocksTasks: [],
    missingBlockers: [],
    hasCircularDependency: false,
  }));
  const byId = new Map<string, Task>();

  for (const task of indexedTasks) {
    if (!task.id) continue;
    if (byId.has(task.id)) {
      console.warn(`[4D Matrix] Duplicate task ID: ${task.id}`);
      continue;
    }
    byId.set(task.id, task);
  }

  for (const task of indexedTasks) {
    for (const blockerId of task.blockedBy) {
      const blocker = byId.get(blockerId);
      if (!blocker) {
        task.missingBlockers.push(blockerId);
        continue;
      }
      task.blockedByTasks.push(blocker);
      blocker.blocksTasks.push(task);
      if (!isClosedStatus(blocker.status)) task.isBlocked = true;
    }
  }

  markCircularDependencies(indexedTasks);
  return indexedTasks;
}

/**
 * Kahnovo řazení zachová dosavadní comparator jako jediný tie-breaker.
 * Hrany mimo aktuální kvadrant/pohled pořadí záměrně neovlivňují.
 */
export function sortTasksByDependencies(tasks: Task[], today: string): Task[] {
  const compareTask = makeCompareTask(today);
  const taskSet = new Set(tasks);
  const remainingBlockers = new Map<Task, number>();
  const dependents = new Map<Task, Task[]>();

  for (const task of tasks) {
    const localBlockers = task.blockedByTasks.filter(
      (blocker) => taskSet.has(blocker) && blocker.quadrant === task.quadrant,
    );
    remainingBlockers.set(task, localBlockers.length);
    for (const blocker of localBlockers) {
      const blockedTasks = dependents.get(blocker) ?? [];
      blockedTasks.push(task);
      dependents.set(blocker, blockedTasks);
    }
  }

  const candidates = tasks.filter((task) => remainingBlockers.get(task) === 0);
  const sorted: Task[] = [];
  const emitted = new Set<Task>();

  while (candidates.length > 0) {
    candidates.sort(compareTask);
    const next = candidates.shift();
    if (!next) break;
    sorted.push(next);
    emitted.add(next);

    for (const dependent of dependents.get(next) ?? []) {
      const count = (remainingBlockers.get(dependent) ?? 0) - 1;
      remainingBlockers.set(dependent, count);
      if (count === 0) candidates.push(dependent);
    }
  }

  if (sorted.length < tasks.length) {
    sorted.push(...tasks.filter((task) => !emitted.has(task)).sort(compareTask));
  }
  return sorted;
}

function markCircularDependencies(tasks: Task[]): void {
  let nextIndex = 0;
  const indices = new Map<Task, number>();
  const lowLinks = new Map<Task, number>();
  const stack: Task[] = [];
  const onStack = new Set<Task>();
  const taskSet = new Set(tasks);

  const visit = (task: Task): void => {
    indices.set(task, nextIndex);
    lowLinks.set(task, nextIndex);
    nextIndex++;
    stack.push(task);
    onStack.add(task);

    for (const blocker of task.blockedByTasks) {
      if (!taskSet.has(blocker)) continue;
      if (!indices.has(blocker)) {
        visit(blocker);
        lowLinks.set(task, Math.min(lowLinks.get(task)!, lowLinks.get(blocker)!));
      } else if (onStack.has(blocker)) {
        lowLinks.set(task, Math.min(lowLinks.get(task)!, indices.get(blocker)!));
      }
    }

    if (lowLinks.get(task) !== indices.get(task)) return;
    const component: Task[] = [];
    let member: Task | undefined;
    do {
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== task);

    const selfCycle = component.length === 1 && component[0].blockedByTasks.includes(component[0]);
    if (component.length > 1 || selfCycle) {
      for (const cycleTask of component) cycleTask.hasCircularDependency = true;
    }
  };

  for (const task of tasks) {
    if (!indices.has(task)) visit(task);
  }
}

export function isOverdue(task: Task, today: string): boolean {
  return !!task.dueDate && task.dueDate < today;
}

export const UNTAGGED_FILTER = '__untagged__';

export function extractAllContextTags(tasks: Task[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const t of tasks) {
    if (t.contextTags.length === 0) untagged++;
    for (const tag of t.contextTags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag, 'cs', { sensitivity: 'base' }));
  // UNTAGGED_FILTER ("Ostatní") vždy na konci, nezávisle na abecedě.
  if (untagged > 0) {
    entries.push({ tag: UNTAGGED_FILTER, count: untagged });
  }
  return entries;
}

export function matchesFilter(task: Task, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) return true;
  return selectedTags.some((sel) => {
    if (sel === UNTAGGED_FILTER) return task.contextTags.length === 0;
    return task.contextTags.some((t) => t.toLowerCase() === sel.toLowerCase());
  });
}

// ============================================================
// Fulltext hledání napříč zobrazenými tasky
// ============================================================

/**
 * Normalizace dotazu i textu tasku: bez diakritiky, lowercase.
 * „Správa" tak najde „sprava" i „SPRÁVA" — Jaroslav píše dotazy
 * často bez háčků a čárek.
 */
export function normalizeForSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Prohledávaný text jednoho tasku: text + kontextové tagy + jméno
 * zdrojového souboru (bez cesty). Cesta záměrně ne — jinak by dotaz
 * „daily" označil úplně všechno v `Daily notes/`.
 */
export function taskSearchHaystack(task: Task): string {
  const fileName = task.sourceFile.split('/').pop() ?? task.sourceFile;
  return normalizeForSearch(
    `${task.text} ${task.contextTags.join(' ')} ${fileName}`,
  );
}

/**
 * `normalizedQuery` musí projít `normalizeForSearch` (voláme to jednou
 * nad dotazem, ne pro každý task znovu). Prázdný dotaz nematchuje nic.
 */
export function matchesSearch(task: Task, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return false;
  return taskSearchHaystack(task).includes(normalizedQuery);
}

// ============================================================
// Rychlý filtr podle due date
// ============================================================

export type DueFilter = 'none' | 'today' | 'week' | 'selected';

/** Vrátí ISO datum posunuté o `days` (lokální čas, bez UTC off-by-one). */
export function addDaysISO(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return formatDateISO(new Date(y, m - 1, d + days));
}

/**
 * Due-date quick filtr:
 *   'today'    = overdue + due dnes
 *   'week'     = overdue + due v rozmezí dnes .. dnes+7
 *   'selected' = due přesně na datum vybrané v horní liště (`selectedDate`),
 *                bez overdue — čistě tasky toho jednoho dne
 * Tasky bez due date při aktivním filtru nikdy nematchují.
 */
export function matchesDueFilter(
  task: Task,
  dueFilter: DueFilter,
  today: string,
  selectedDate: string,
): boolean {
  if (dueFilter === 'none') return true;
  if (!task.dueDate) return false;
  if (dueFilter === 'selected') return task.dueDate === selectedDate;
  if (task.dueDate < today) return true; // overdue platí pro 'today' i 'week'
  if (dueFilter === 'today') return task.dueDate === today;
  return task.dueDate <= addDaysISO(today, 7); // 'week': dnes .. dnes+7
}

export function formatDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
