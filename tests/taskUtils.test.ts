import { describe, expect, it } from 'vitest';
import {
  addDaysISO,
  indexTaskDependencies,
  makeCompareTask,
  matchesDueFilter,
  sortTasksByDependencies,
} from '../src/core/taskUtils.ts';
import type { Task } from '../src/core/types.ts';

function task(dueDate?: string, overrides: Partial<Task> = {}): Task {
  return {
    lineIndex: 0,
    raw: '',
    status: ' ',
    checked: false,
    text: 'x',
    quadrant: 'DO',
    contextTags: [],
    dueDate,
    blockedBy: [],
    trailingTokens: [],
    isBlocked: false,
    blockedByTasks: [],
    blocksTasks: [],
    missingBlockers: [],
    hasCircularDependency: false,
    sourceFile: 'f.md',
    isFromDnes: false,
    ...overrides,
  };
}

const TODAY = '2026-06-15';
// Datum vybrané v horní liště — odlišné od TODAY, ať 'selected' testuje
// porovnání proti vybranému dni, ne proti dnešku.
const SELECTED = '2026-06-20';

describe('addDaysISO', () => {
  it('adds days within a month', () => {
    expect(addDaysISO('2026-06-15', 7)).toBe('2026-06-22');
  });
  it('rolls over month boundary', () => {
    expect(addDaysISO('2026-06-28', 7)).toBe('2026-07-05');
  });
});

describe('dependency ordering', () => {
  it('builds forward and reverse links and reports missing blockers', () => {
    const indexed = indexTaskDependencies([
      task(undefined, { id: 'done', text: 'Done blocker', status: 'x' }),
      task(undefined, { id: 'open', text: 'Open blocker' }),
      task(undefined, {
        id: 'dependent',
        text: 'Dependent',
        blockedBy: ['done', 'open', 'missing'],
      }),
    ]);
    const dependent = indexed[2];

    expect(dependent.blockedByTasks.map(({ id }) => id)).toEqual(['done', 'open']);
    expect(dependent.missingBlockers).toEqual(['missing']);
    expect(dependent.isBlocked).toBe(true);
    expect(indexed[0].blocksTasks).toEqual([dependent]);
    expect(indexed[1].blocksTasks).toEqual([dependent]);
  });

  it('keeps comparator order unchanged without dependencies', () => {
    const input = [
      task(undefined, { text: 'No priority' }),
      task('2026-06-10', { text: 'Overdue' }),
      task('2026-06-20', { text: 'High', priority: 'high' }),
      task('2026-06-20', { text: 'Low', priority: 'low' }),
    ];
    const baseline = [...input].sort(makeCompareTask(TODAY));

    expect(sortTasksByDependencies(input, TODAY)).toEqual(baseline);
  });

  it('orders a dependency chain ahead of conflicting priorities', () => {
    const indexed = indexTaskDependencies([
      task(undefined, { id: 'a', text: 'A', priority: 'lowest' }),
      task(undefined, { id: 'b', text: 'B', priority: 'medium', blockedBy: ['a'] }),
      task(undefined, { id: 'c', text: 'C', priority: 'highest', blockedBy: ['b'] }),
    ]);

    expect(sortTasksByDependencies(indexed, TODAY).map(({ id }) => id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps every task when dependencies contain a cycle', () => {
    const indexed = indexTaskDependencies([
      task(undefined, { id: 'a', text: 'A', blockedBy: ['b'] }),
      task(undefined, { id: 'b', text: 'B', blockedBy: ['a'] }),
      task(undefined, { id: 'c', text: 'C' }),
    ]);
    const output = sortTasksByDependencies(indexed, TODAY);

    expect(output).toHaveLength(indexed.length);
    expect(output.map(({ id }) => id).sort()).toEqual(['a', 'b', 'c']);
    expect(indexed.filter(({ hasCircularDependency }) => hasCircularDependency)).toHaveLength(2);
  });

  it('ignores a blocker in another quadrant for ordering but marks the task blocked', () => {
    const indexed = indexTaskDependencies([
      task(undefined, { id: 'blocker', text: 'Z blocker', quadrant: 'DECIDE' }),
      task(undefined, {
        id: 'dependent',
        text: 'A dependent',
        quadrant: 'DO',
        blockedBy: ['blocker'],
      }),
      task(undefined, { id: 'peer', text: 'B peer', quadrant: 'DO' }),
    ]);
    const doTasks = indexed.filter(({ quadrant }) => quadrant === 'DO');

    expect(sortTasksByDependencies(doTasks, TODAY).map(({ id }) => id)).toEqual([
      'dependent',
      'peer',
    ]);
    expect(doTasks[0].isBlocked).toBe(true);
  });
});

describe('matchesDueFilter', () => {
  it('none → everything passes (incl. no due date)', () => {
    expect(matchesDueFilter(task(), 'none', TODAY, SELECTED)).toBe(true);
    expect(matchesDueFilter(task('2026-12-31'), 'none', TODAY, SELECTED)).toBe(true);
  });

  it('today → overdue + due today, not future', () => {
    expect(matchesDueFilter(task('2026-06-10'), 'today', TODAY, SELECTED)).toBe(true); // overdue
    expect(matchesDueFilter(task('2026-06-15'), 'today', TODAY, SELECTED)).toBe(true); // today
    expect(matchesDueFilter(task('2026-06-16'), 'today', TODAY, SELECTED)).toBe(false); // tomorrow
    expect(matchesDueFilter(task(), 'today', TODAY, SELECTED)).toBe(false); // no due
  });

  it('week → overdue + due within 7 days, not beyond', () => {
    expect(matchesDueFilter(task('2026-06-10'), 'week', TODAY, SELECTED)).toBe(true); // overdue
    expect(matchesDueFilter(task('2026-06-15'), 'week', TODAY, SELECTED)).toBe(true); // today
    expect(matchesDueFilter(task('2026-06-22'), 'week', TODAY, SELECTED)).toBe(true); // +7
    expect(matchesDueFilter(task('2026-06-23'), 'week', TODAY, SELECTED)).toBe(false); // +8
    expect(matchesDueFilter(task(), 'week', TODAY, SELECTED)).toBe(false); // no due
  });

  it('selected → only due exactly on the selected date, no overdue', () => {
    expect(matchesDueFilter(task('2026-06-20'), 'selected', TODAY, SELECTED)).toBe(true); // = selected
    expect(matchesDueFilter(task('2026-06-10'), 'selected', TODAY, SELECTED)).toBe(false); // overdue not included
    expect(matchesDueFilter(task('2026-06-15'), 'selected', TODAY, SELECTED)).toBe(false); // today ≠ selected
    expect(matchesDueFilter(task('2026-06-21'), 'selected', TODAY, SELECTED)).toBe(false); // next day
    expect(matchesDueFilter(task(), 'selected', TODAY, SELECTED)).toBe(false); // no due
  });
});
