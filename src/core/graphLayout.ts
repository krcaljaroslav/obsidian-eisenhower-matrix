import { makeCompareTask } from './taskUtils.ts';
import type { Task } from './types.ts';
import { isClosedStatus } from './types.ts';

export type GridCell = { col: number; row: number };
export type Point = { x: number; y: number };
export type Geometry = {
  w: number;
  h: number;
  gapX: number;
  gapY: number;
  topRow: number;
};
export type GraphNode = { key: string; task: Task; cell: GridCell; level: number; manual: boolean; inSeed: boolean; collapsed: boolean; hiddenCount: number; inBand: boolean };
export type GraphEdge = { from: string; to: string; points: Point[]; resolved: boolean; cycle: boolean };
export type GraphLayout = { nodes: GraphNode[]; edges: GraphEdge[]; hiddenKeys: Set<string>; columns: number; topRow: number; bandRows: number; bandColumns: number; size: { width: number; height: number }; bandTop: number };

export const GRID = {
  full: { w: 240, h: 112 },
  compact: { w: 272, h: 64 },
  gapX: 40,
  gapY: 48,
  bandGap: 40,
  bandMinColumns: 4,
};

export function taskKey(task: Task): string {
  return `${task.sourceFile}:${task.lineIndex}`;
}

export function canToggleGraphBranch(task: Task, collapsedKeys: Set<string>): boolean {
  return task.blockedByTasks.length > 0 || collapsedKeys.has(taskKey(task));
}

export function validateGraphPositions(value: Record<string, GridCell>, warn: (key: string) => void = () => undefined): Record<string, GridCell> {
  const valid: Record<string, GridCell> = {};
  for (const [key, cell] of Object.entries(value ?? {})) {
    if (/^[A-Za-z0-9_-]+$/.test(key) && Number.isInteger(cell?.col) && cell.col >= 0 && Number.isInteger(cell?.row) && cell.row >= 0) valid[key] = cell;
    else warn(key);
  }
  return valid;
}

export function buildGraphNodeSet(all: Task[], seedKeys: Set<string>, showCompleted: boolean, graceKeys: Set<string>): { nodes: Task[]; seed: Set<string> } {
  const allowed = (task: Task) => showCompleted || !isClosedStatus(task.status) || graceKeys.has(taskKey(task));
  const taskByKey = new Map(all.map((task) => [taskKey(task), task]));
  const included = new Set([...seedKeys].filter((key) => {
    const task = taskByKey.get(key);
    return task !== undefined && allowed(task);
  }));
  const queue = [...included].map((key) => taskByKey.get(key)!);
  for (let index = 0; index < queue.length; index++) {
    for (const neighbor of [...queue[index].blockedByTasks, ...queue[index].blocksTasks]) {
      const key = taskKey(neighbor);
      if (!included.has(key) && allowed(neighbor)) { included.add(key); queue.push(neighbor); }
    }
  }
  return { nodes: all.filter((task) => included.has(taskKey(task))), seed: new Set(seedKeys) };
}

export function computeHiddenByCollapse(nodes: Task[], collapsedKeys: Set<string>): { hidden: Set<string>; hiddenCount: Map<string, number> } {
  const keys = new Set(nodes.map(taskKey));
  const hidden = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const key = taskKey(node);
      if (collapsedKeys.has(key) || hidden.has(key)) continue;
      const dependents = node.blocksTasks.map(taskKey).filter((candidate) => keys.has(candidate));
      if (dependents.length > 0 && dependents.every((candidate) => collapsedKeys.has(candidate) || hidden.has(candidate))) {
        hidden.add(key); changed = true;
      }
    }
  }
  const hiddenCount = new Map<string, number>();
  for (const collapsedKey of collapsedKeys) {
    const root = nodes.find((node) => taskKey(node) === collapsedKey);
    if (!root) continue;
    const closure = new Set<string>();
    const stack = [...root.blockedByTasks];
    while (stack.length) { const node = stack.pop()!; const key = taskKey(node); if (!keys.has(key) || closure.has(key)) continue; closure.add(key); stack.push(...node.blockedByTasks); }
    hiddenCount.set(collapsedKey, [...closure].filter((key) => hidden.has(key)).length);
  }
  return { hidden, hiddenCount };
}

export function computeLevels(nodes: Task[]): Map<string, number> {
  const byKey = new Map(nodes.map((node) => [taskKey(node), node]));
  const nodeKeys = new Set(nodes.map(taskKey));
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const levels = new Map<string, number>();

  for (const node of nodes) {
    const key = taskKey(node);
    const blockerKeys = node.blockedByTasks.map(taskKey).filter((candidate) => nodeKeys.has(candidate));
    remaining.set(key, blockerKeys.length);
    for (const blockerKey of blockerKeys) {
      const blocked = dependents.get(blockerKey) ?? [];
      blocked.push(key);
      dependents.set(blockerKey, blocked);
    }
  }

  const ready = nodes.map(taskKey).filter((key) => remaining.get(key) === 0);
  while (ready.length > 0) {
    const key = ready.shift()!;
    const node = byKey.get(key)!;
    const blockerLevels = node.blockedByTasks
      .map((blocker) => levels.get(taskKey(blocker)))
      .filter((level): level is number => level !== undefined);
    levels.set(key, blockerLevels.length === 0 ? 0 : Math.max(...blockerLevels) + 1);
    for (const dependentKey of dependents.get(key) ?? []) {
      const count = (remaining.get(dependentKey) ?? 0) - 1;
      remaining.set(dependentKey, count);
      if (count === 0) ready.push(dependentKey);
    }
  }

  const cycleLevel = Math.max(-1, ...levels.values()) + 1;
  for (const node of nodes) {
    const key = taskKey(node);
    if (!levels.has(key)) levels.set(key, cycleLevel);
  }
  return levels;
}

function average(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function compareBarycentricValues(
  leftMean: number | undefined,
  rightMean: number | undefined,
  leftPosition: number,
  rightPosition: number,
  fallback: number,
): number {
  const left = leftMean ?? leftPosition;
  const right = rightMean ?? rightPosition;
  return left === right ? fallback : left - right;
}

export function assignCells(
  nodes: Task[],
  levels: Map<string, number>,
  manual: Map<string, GridCell>,
  hidden: Set<string>,
  today: string,
): Map<string, GridCell> {
  const compareTask = makeCompareTask(today);
  const byKey = new Map(nodes.map((node) => [taskKey(node), node]));
  const maxLevel = Math.max(0, ...levels.values());
  const ordered = new Map<number, Task[]>();
  for (let level = 0; level <= maxLevel; level++) {
    ordered.set(level, nodes.filter((node) => levels.get(taskKey(node)) === level).sort(compareTask));
  }

  const positions = new Map<string, number>();
  const seedPositions = () => {
    for (const layer of ordered.values()) layer.forEach((node, index) => positions.set(taskKey(node), index));
  };
  seedPositions();

  const sortLayer = (level: number, neighbors: (node: Task) => Task[]) => {
    const layer = ordered.get(level) ?? [];
    layer.sort((left, right) => {
      const leftMean = average(neighbors(left).map((node) => positions.get(taskKey(node))).filter((value): value is number => value !== undefined));
      const rightMean = average(neighbors(right).map((node) => positions.get(taskKey(node))).filter((value): value is number => value !== undefined));
      return compareBarycentricValues(leftMean, rightMean, positions.get(taskKey(left)) ?? 0, positions.get(taskKey(right)) ?? 0, compareTask(left, right));
    });
    layer.forEach((node, index) => positions.set(taskKey(node), index));
  };

  const visibleNeighbors = (neighbors: Task[]) => neighbors.filter((neighbor) => byKey.has(taskKey(neighbor)));
  for (let level = 1; level <= maxLevel; level++) sortLayer(level, (node) => visibleNeighbors(node.blockedByTasks));
  for (let level = maxLevel - 1; level >= 0; level--) sortLayer(level, (node) => visibleNeighbors(node.blocksTasks));
  for (let level = 1; level <= maxLevel; level++) sortLayer(level, (node) => visibleNeighbors(node.blockedByTasks));

  const cells = new Map<string, GridCell>();
  const occupied = new Set<string>();
  for (const node of nodes) {
    if (!node.id) continue;
    const cell = manual.get(node.id);
    if (!cell) continue;
    const cellKey = `${cell.col}:${cell.row}`;
    if (occupied.has(cellKey)) {
      console.warn(`[4D Matrix] Duplicate manual graph cell: ${cellKey}`);
      continue;
    }
    cells.set(taskKey(node), cell);
    occupied.add(cellKey);
  }

  for (let level = 0; level <= maxLevel; level++) {
    let previousColumn = -1;
    for (const node of ordered.get(level) ?? []) {
      const key = taskKey(node);
      const fixed = cells.get(key);
      if (fixed) continue;
      const neighborColumns = node.blockedByTasks
        .map((neighbor) => cells.get(taskKey(neighbor))?.col)
        .filter((column): column is number => column !== undefined);
      let column = Math.max(Math.round(average(neighborColumns) ?? (positions.get(key) ?? 0)), previousColumn + 1);
      while (occupied.has(`${column}:${level}`)) column++;
      cells.set(key, { col: column, row: level });
      occupied.add(`${column}:${level}`);
      previousColumn = column;
    }
  }

  for (const key of hidden) cells.delete(key);
  return cells;
}

export function layoutBand(unlinked: Task[], bandColumns: number, today: string): Map<string, GridCell> {
  const columns = Math.max(1, bandColumns);
  const cells = new Map<string, GridCell>();
  unlinked.slice().sort(makeCompareTask(today)).forEach((task, index) => {
    cells.set(taskKey(task), { col: index % columns, row: -Math.floor(index / columns) - 1 });
  });
  return cells;
}

export function cellToPoint(cell: GridCell, geometry: Geometry): Point {
  const x = cell.col * (geometry.w + geometry.gapX);
  if (cell.row >= 0) {
    return { x, y: (geometry.topRow - cell.row) * (geometry.h + geometry.gapY) };
  }
  return {
    x,
    y: (geometry.topRow + 1) * (geometry.h + geometry.gapY)
      + GRID.bandGap + (-cell.row - 1) * (geometry.h + geometry.gapY),
  };
}

export function routeEdge(from: GridCell, to: GridCell, geometry: Geometry): Point[] {
  const source = cellToPoint(from, geometry);
  const target = cellToPoint(to, geometry);
  const sourceCenter = { x: source.x + geometry.w / 2, y: source.y };
  const targetCenter = { x: target.x + geometry.w / 2, y: target.y + geometry.h };
  const sourceRenderRow = geometry.topRow - from.row;
  const targetRenderRow = geometry.topRow - to.row;

  if (sourceRenderRow === targetRenderRow + 1 && from.col === to.col) {
    return [sourceCenter, targetCenter];
  }
  const sourceChannelY = source.y - geometry.gapY / 2;
  const targetChannelY = target.y + geometry.h + geometry.gapY / 2;
  if (sourceRenderRow === targetRenderRow + 1) {
    return [sourceCenter, { x: sourceCenter.x, y: sourceChannelY }, { x: targetCenter.x, y: sourceChannelY }, targetCenter];
  }
  const gutterColumn = to.col > from.col ? from.col : to.col < from.col ? from.col - 1 : from.col;
  const gutterX = gutterColumn * (geometry.w + geometry.gapX) + geometry.w + geometry.gapX / 2;
  return [
    sourceCenter,
    { x: sourceCenter.x, y: sourceChannelY },
    { x: gutterX, y: sourceChannelY },
    { x: gutterX, y: targetChannelY },
    { x: targetCenter.x, y: targetChannelY },
    targetCenter,
  ];
}

export function buildGraphLayout(input: { tasks: Task[]; seedKeys: Set<string>; showCompleted: boolean; graceKeys: Set<string>; positions: Record<string, GridCell>; collapsedKeys: Set<string>; compact: boolean; viewportWidth: number; zoom: number; today: string }): GraphLayout {
  const graphSet = buildGraphNodeSet(input.tasks, input.seedKeys, input.showCompleted, input.graceKeys);
  const keys = new Set(graphSet.nodes.map(taskKey));
  const manual = new Map(Object.entries(input.positions));
  const linked = graphSet.nodes.filter((node) =>
    [...node.blockedByTasks, ...node.blocksTasks].some((neighbor) => keys.has(taskKey(neighbor)))
    || Boolean(node.id && manual.has(node.id)));
  const linkedKeys = new Set(linked.map(taskKey));
  const unlinked = graphSet.nodes.filter((node) => !linkedKeys.has(taskKey(node)));
  const levels = computeLevels(linked);
  const collapsed = computeHiddenByCollapse(linked, input.collapsedKeys);
  const graphCells = assignCells(linked, levels, manual, collapsed.hidden, input.today);
  const geometryBase = input.compact ? GRID.compact : GRID.full;
  let columns = Math.max(1, ...[...graphCells.values()].map((cell) => cell.col + 1));
  const topRow = Math.max(0, ...[...levels.values()], ...[...manual.values()].map((cell) => cell.row)) + 1;
  const bandColumns = Math.max(columns, GRID.bandMinColumns, Math.floor(input.viewportWidth / Math.max(input.zoom, .25) / (geometryBase.w + GRID.gapX)));
  const bandCells = layoutBand(unlinked, bandColumns, input.today);
  columns = Math.max(columns, bandColumns);
  const geometry: Geometry = { ...geometryBase, gapX: GRID.gapX, gapY: GRID.gapY, topRow };
  const nodes: GraphNode[] = [];
  for (const task of graphSet.nodes) {
    const key = taskKey(task); const cell = graphCells.get(key) ?? bandCells.get(key); if (!cell) continue;
    nodes.push({ key, task, cell, level: levels.get(key) ?? 0, manual: !!task.id && manual.has(task.id), inSeed: graphSet.seed.has(key), collapsed: input.collapsedKeys.has(key), hiddenCount: collapsed.hiddenCount.get(key) ?? 0, inBand: cell.row < 0 });
  }
  const edges: GraphEdge[] = [];
  for (const blocker of linked) for (const dependent of blocker.blocksTasks) {
    const from = taskKey(blocker), to = taskKey(dependent);
    if (!keys.has(to) || collapsed.hidden.has(from) || collapsed.hidden.has(to)) continue;
    const fromCell = graphCells.get(from), toCell = graphCells.get(to); if (!fromCell || !toCell) continue;
    edges.push({ from, to, points: routeEdge(fromCell, toCell, geometry), resolved: isClosedStatus(blocker.status), cycle: blocker.hasCircularDependency && dependent.hasCircularDependency });
  }
  const bandRows = Math.ceil(unlinked.length / bandColumns);
  const bandTop = (topRow + 1) * (geometry.h + geometry.gapY) + GRID.bandGap / 2;
  const height = bandRows > 0 ? cellToPoint({ col: 0, row: -bandRows }, geometry).y + geometry.h + geometry.gapY : bandTop + geometry.gapY;
  return { nodes, edges, hiddenKeys: collapsed.hidden, columns, topRow, bandRows, bandColumns, size: { width: columns * (geometry.w + geometry.gapX), height }, bandTop };
}
