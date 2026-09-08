import { describe, expect, it } from 'vitest';
import {
  assignCells,
  buildGraphLayout,
  buildGraphNodeSet,
  computeHiddenByCollapse,
  cellToPoint,
  computeLevels,
  layoutBand,
  routeEdge,
  taskKey,
  validateGraphPositions,
  type Geometry,
} from '../src/core/graphLayout.ts';
import type { Task } from '../src/core/types.ts';

function task(text: string, lineIndex: number, overrides: Partial<Task> = {}): Task {
  return {
    lineIndex,
    raw: `- [ ] ${text}`,
    status: ' ',
    checked: false,
    text,
    quadrant: 'OPEN',
    contextTags: [],
    blockedBy: [],
    trailingTokens: [],
    isBlocked: false,
    blockedByTasks: [],
    blocksTasks: [],
    missingBlockers: [],
    hasCircularDependency: false,
    sourceFile: 'tasks.md',
    isFromDnes: false,
    ...overrides,
  };
}

function link(blocker: Task, dependent: Task): void {
  blocker.blocksTasks.push(dependent);
  dependent.blockedByTasks.push(blocker);
}

describe('graph node selection and collapse', () => {
  it('expands a seed transitively but excludes completed and unrelated tasks', () => {
    const a = task('A', 0); const b = task('B', 1); const c = task('C', 2); const unrelated = task('Other', 3);
    link(c, b); link(b, a); c.status = 'x'; c.checked = true;
    const hiddenDone = buildGraphNodeSet([a, b, c, unrelated], new Set([taskKey(a)]), false, new Set());
    expect(hiddenDone.nodes).toEqual([a, b]);
    expect(buildGraphNodeSet([a, b, c, unrelated], new Set([taskKey(a)]), true, new Set()).nodes).toEqual([a, b, c]);
  });

  it('keeps a shared blocker visible until every dependent branch is collapsed', () => {
    const blocker = task('Shared', 0); const left = task('Left', 1); const right = task('Right', 2);
    link(blocker, left); link(blocker, right);
    expect(computeHiddenByCollapse([blocker, left, right], new Set([taskKey(left)])).hidden.has(taskKey(blocker))).toBe(false);
    expect(computeHiddenByCollapse([blocker, left, right], new Set([taskKey(left), taskKey(right)])).hidden.has(taskKey(blocker))).toBe(true);
  });
});

it('rejects malformed persisted graph positions', () => {
  expect(validateGraphPositions({ good_id: { col: 1, row: 0 }, 'bad id': { col: 0, row: 0 }, negative: { col: 0, row: -1 }, fraction: { col: 1.5, row: 0 } })).toEqual({ good_id: { col: 1, row: 0 } });
});

describe('computeLevels', () => {
  it('handles chains, diamonds, different blocker depths, and cycles', () => {
    const a = task('A', 0);
    const b = task('B', 1);
    const c = task('C', 2);
    const d = task('D', 3);
    const e = task('E', 4);
    link(a, b); link(a, c); link(b, d); link(c, d); link(a, e); link(d, e);
    const levels = computeLevels([a, b, c, d, e]);
    expect([a, b, c, d, e].map((node) => levels.get(taskKey(node))))
      .toEqual([0, 1, 1, 2, 3]);

    const x = task('X', 5);
    const y = task('Y', 6);
    link(x, y); link(y, x);
    const cyclic = computeLevels([a, x, y]);
    expect(cyclic.size).toBe(3);
    expect(cyclic.get(taskKey(x))).toBe(1);
    expect(cyclic.get(taskKey(y))).toBe(1);
  });

  it('assigns every node a level even when input order is reversed', () => {
    const blocker = task('Blocker', 0), dependent = task('Dependent', 1);
    link(blocker, dependent);
    const levels = computeLevels([dependent, blocker]);
    expect(levels.get(taskKey(blocker))).toBe(0);
    expect(levels.get(taskKey(dependent))).toBe(1);
  });
});

describe('assignCells', () => {
  it('keeps a manual card in place after a dependency is created', () => {
    const blocker = task('Blocker', 0), fixed = task('Fixed', 1, { id: 'fixed' });
    const manual = new Map([['fixed', { col: 4, row: 3 }]]);
    expect(assignCells([blocker, fixed], computeLevels([blocker, fixed]), manual, new Set(), '2026-09-08').get(taskKey(fixed))).toEqual({ col: 4, row: 3 });
    link(blocker, fixed);
    expect(assignCells([blocker, fixed], computeLevels([blocker, fixed]), manual, new Set(), '2026-09-08').get(taskKey(fixed))).toEqual({ col: 4, row: 3 });
  });
  it('keeps disconnected peers in stable order beside a node with a barycenter', () => {
    const blocker = task('A blocker', 0), connected = task('Z connected', 1), peer = task('B peer', 2);
    link(blocker, connected);
    const cells = assignCells([blocker, connected, peer], new Map([
      [taskKey(blocker), 0], [taskKey(connected), 1], [taskKey(peer), 1],
    ]), new Map(), new Set(), '2026-09-08');
    expect(cells.get(taskKey(peer))!.col).toBeLessThan(cells.get(taskKey(connected))!.col);
  });
  it('is deterministic, collision-free, and barycentrically uncrosses', () => {
    const a = task('A', 0);
    const b = task('B', 1);
    const x = task('X', 2);
    const y = task('Y', 3);
    link(b, x); link(a, y);
    const nodes = [a, b, x, y];
    const levels = computeLevels(nodes);
    const first = assignCells(nodes, levels, new Map(), new Set(), '2026-09-08');
    const second = assignCells(nodes, levels, new Map(), new Set(), '2026-09-08');

    expect([...first]).toEqual([...second]);
    expect(new Set([...first.values()].map(({ col, row }) => `${col}:${row}`)).size).toBe(nodes.length);
    expect(first.get(taskKey(y))!.col).toBeLessThan(first.get(taskKey(x))!.col);
  });

  it('keeps a manual cell and prevents auto placement in it', () => {
    const fixed = task('Fixed', 0, { id: 'fixed' });
    const automatic = task('Automatic', 1);
    const levels = computeLevels([fixed, automatic]);
    const cells = assignCells(
      [fixed, automatic], levels, new Map([['fixed', { col: 0, row: 0 }]]),
      new Set(), '2026-09-08',
    );
    expect(cells.get(taskKey(fixed))).toEqual({ col: 0, row: 0 });
    expect(cells.get(taskKey(automatic))).toEqual({ col: 1, row: 0 });
  });

  it('does not let a manual cell in another row shift an automatic layer', () => {
    const fixed = task('A fixed', 0, { id: 'fixed' });
    const first = task('B first', 1);
    const second = task('C second', 2);
    const levels = new Map([
      [taskKey(fixed), 0], [taskKey(first), 0], [taskKey(second), 0],
    ]);
    const cells = assignCells(
      [fixed, first, second], levels, new Map([['fixed', { col: 7, row: 3 }]]),
      new Set(), '2026-09-08',
    );
    expect(cells.get(taskKey(first))).toEqual({ col: 1, row: 0 });
    expect(cells.get(taskKey(second))).toEqual({ col: 2, row: 0 });
  });

  it('keeps visible cells stable when a node is hidden', () => {
    const a = task('A', 0);
    const b = task('B', 1);
    const c = task('C', 2);
    const x = task('X', 3);
    const y = task('Y', 4);
    link(c, x);
    link(a, y);
    const nodes = [a, b, c, x, y];
    const levels = computeLevels(nodes);
    const expanded = assignCells(nodes, levels, new Map(), new Set(), '2026-09-08');
    const hiddenKey = taskKey(a);
    const collapsed = assignCells(nodes, levels, new Map(), new Set([hiddenKey]), '2026-09-08');

    for (const [key, cell] of expanded) {
      if (key !== hiddenKey) expect(collapsed.get(key)).toEqual(cell);
    }
  });

  it('keeps every visible cell stable across representative collapsed layouts', () => {
    for (let mask = 1; mask < 64; mask++) {
      const lower = [task('A', 0), task('B', 1), task('C', 2)];
      const upper = [task('X', 3), task('Y', 4)];
      for (let edge = 0; edge < 6; edge++) if (mask & (1 << edge)) link(lower[edge % 3], upper[Math.floor(edge / 3)]);
      const nodes = [...lower, ...upper];
      const levels = computeLevels(nodes);
      const expanded = assignCells(nodes, levels, new Map(), new Set(), '2026-09-08');
      for (const hidden of lower) {
        const hiddenKey = taskKey(hidden);
        const collapsed = assignCells(nodes, levels, new Map(), new Set([hiddenKey]), '2026-09-08');
        for (const [key, cell] of expanded) if (key !== hiddenKey) expect(collapsed.get(key), `mask ${mask}, hidden ${hidden.text}, key ${key}`).toEqual(cell);
      }
    }
  });

  it('orders an unlinked layer with makeCompareTask and omits hidden nodes', () => {
    const z = task('Zulu', 0);
    const a = task('Alpha', 1);
    const levels = computeLevels([z, a]);
    const cells = assignCells([z, a], levels, new Map(), new Set([taskKey(z)]), '2026-09-08');
    expect(cells.get(taskKey(a))).toEqual({ col: 0, row: 0 });
    expect(cells.has(taskKey(z))).toBe(false);
  });
});

describe('buildGraphLayout', () => {
  it('shows an otherwise unlinked task in its persisted manual cell', () => {
    const lone = task('Lone', 0, { id: 'lone' });
    const layout = buildGraphLayout({ tasks: [lone], seedKeys: new Set([taskKey(lone)]), showCompleted: false, graceKeys: new Set(), positions: { lone: { col: 3, row: 4 } }, collapsedKeys: new Set(), compact: false, viewportWidth: 800, zoom: 1, today: '2026-09-08' });
    expect(layout.nodes[0]).toMatchObject({ cell: { col: 3, row: 4 }, manual: true, inBand: false });
  });

  it('keeps topRow stable when a manually placed node is collapsed', () => {
    const blocker = task('Blocker', 0, { id: 'blocker' }), dependent = task('Dependent', 1);
    link(blocker, dependent);
    const input = { tasks: [blocker, dependent], seedKeys: new Set([taskKey(dependent)]), showCompleted: false, graceKeys: new Set<string>(), positions: { blocker: { col: 0, row: 5 } }, compact: false, viewportWidth: 800, zoom: 1, today: '2026-09-08' };
    expect(buildGraphLayout({ ...input, collapsedKeys: new Set<string>() }).topRow).toBe(6);
    expect(buildGraphLayout({ ...input, collapsedKeys: new Set([taskKey(dependent)]) }).topRow).toBe(6);
  });
});

describe('layoutBand', () => {
  it('sorts left-to-right and fills negative rows', () => {
    const nodes = ['D', 'C', 'B', 'A', 'E'].map((text, index) => task(text, index));
    const cells = layoutBand(nodes, 2, '2026-09-08');
    expect(cells.get(taskKey(nodes[3]))).toEqual({ col: 0, row: -1 });
    expect(Math.min(...[...cells.values()].map(({ row }) => row))).toBe(-3);
  });
});

describe('coordinates and routeEdge', () => {
  const geometry: Geometry = { w: 240, h: 112, gapX: 40, gapY: 48, topRow: 4 };

  it('maps graph and band cells to the specified coordinate systems', () => {
    expect(cellToPoint({ col: 2, row: 1 }, geometry)).toEqual({ x: 560, y: 480 });
    expect(cellToPoint({ col: 1, row: -2 }, geometry)).toEqual({ x: 280, y: 1000 });
    const graphBottom = cellToPoint({ col: 0, row: 0 }, geometry).y + geometry.h;
    const bandTop = cellToPoint({ col: 0, row: -1 }, geometry).y;
    expect(graphBottom).toBeLessThan(bandTop);
  });

  it('routes adjacent and long edges orthogonally', () => {
    const direct = routeEdge({ col: 1, row: 0 }, { col: 1, row: 1 }, geometry);
    const adjacent = routeEdge({ col: 0, row: 0 }, { col: 2, row: 1 }, geometry);
    const long = routeEdge({ col: 0, row: 0 }, { col: 2, row: 3 }, geometry);
    expect(direct).toHaveLength(2);
    expect(adjacent).toHaveLength(4);
    expect(long).toHaveLength(6);
    for (const route of [direct, adjacent, long]) {
      for (let index = 1; index < route.length; index++) {
        expect(route[index].x === route[index - 1].x || route[index].y === route[index - 1].y).toBe(true);
      }
    }
  });

  it('keeps general routes outside foreign card interiors', () => {
    const routes = [
      routeEdge({ col: 0, row: 0 }, { col: 2, row: 3 }, geometry),
      routeEdge({ col: 0, row: 2 }, { col: 2, row: 2 }, geometry),
      routeEdge({ col: 2, row: 3 }, { col: 0, row: 0 }, geometry),
    ];
    const foreignCells = [
      { col: 1, row: 0 }, { col: 1, row: 1 }, { col: 1, row: 2 }, { col: 1, row: 3 },
    ];

    for (const route of routes) {
      for (let index = 1; index < route.length; index++) {
        const from = route[index - 1];
        const to = route[index];
        for (const cell of foreignCells) {
          const corner = cellToPoint(cell, geometry);
          const crossesHorizontal = from.y === to.y
            && from.y > corner.y && from.y < corner.y + geometry.h
            && Math.max(from.x, to.x) > corner.x && Math.min(from.x, to.x) < corner.x + geometry.w;
          const crossesVertical = from.x === to.x
            && from.x > corner.x && from.x < corner.x + geometry.w
            && Math.max(from.y, to.y) > corner.y && Math.min(from.y, to.y) < corner.y + geometry.h;
          expect(crossesHorizontal || crossesVertical).toBe(false);
        }
      }
    }
  });
});
