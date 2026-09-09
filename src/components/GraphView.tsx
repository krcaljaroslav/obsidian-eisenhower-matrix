import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDndMonitor, useDroppable, type DragEndEvent } from '@dnd-kit/core';
import { Menu, Platform, type PaneType } from 'obsidian';
import { buildGraphLayout, canToggleGraphBranch, cellToPoint, GRID, taskKey, type GridCell } from '../core/graphLayout.ts';
import { buildDependencyIndex, canLinkTasks } from '../core/graphLinks.ts';
import { centeredScrollOffset, isGraphCanvasBackground } from '../core/graphInteractions.ts';
import type { Priority, Quadrant, Task } from '../core/types.ts';
import { isClosedStatus } from '../core/types.ts';
import { showInfo } from '../obsidian-adapter/toast.ts';
import type { InlineLinkTarget } from './inlineMarkdown.tsx';
import { AddTaskInput } from './AddTaskInput.tsx';
import { TaskCard as UnmemoizedTaskCard, type DependencySelection } from './TaskCard.tsx';
import { Icon } from './Icon.tsx';

type NewTaskInput = { text: string; quadrant: Quadrant; dueDate: string | null; priority: Priority | null; status?: string };
type Props = {
  tasks: Task[]; seedKeys: Set<string>; selectedTags: string[]; showCompleted: boolean; graceMap: Map<string, number>;
  positions: Record<string, GridCell>; zoom: number; compact: boolean; today: string; activeTaskId: string | null; revealKey: string | null; highlightKey: string | null;
  onZoom: (zoom: number) => void; onBack: () => void; onSetPosition: (task: Task, cell: GridCell | null) => Promise<void>;
  onToggleTask: (task: Task) => void; onSetStatus: (task: Task, status: string) => Promise<void>; onSetDueDate: (task: Task, due: string | null) => Promise<void>;
  onUpdateTask: (task: Task, text: string, tags: string[], options: { dueDate: string | null; priority: Priority | null }, dependencies: DependencySelection) => Promise<void>;
  onOpenSource: (task: Task, mode?: PaneType | boolean) => void; onOpenLink: (task: Task, link: InlineLinkTarget) => void; onMoveQuadrant: (task: Task, quadrant: Quadrant) => void;
  onAddTask: (input: NewTaskInput) => Promise<void>; onAddAtCell: (cell: GridCell, input: NewTaskInput) => Promise<void>; onAddLinked: (target: Task, kind: 'blocker' | 'dependent', input: NewTaskInput) => Promise<void>;
  onLinkTasks: (source: Task, target: Task) => Promise<void>; onRemoveDependency: (source: Task, target: Task) => Promise<void>;
  createTagSuggest: (input: HTMLInputElement) => void; onRevealed: (key: string, present: boolean) => void; onResetAll: () => void;
};

const TaskCard = memo(UnmemoizedTaskCard);

export function GraphView(props: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const initiallyCenteredRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set());
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [addPanel, setAddPanel] = useState<{ cell: GridCell; target?: Task; kind?: 'blocker' | 'dependent' } | null>(null);
  const [linkDrag, setLinkDrag] = useState<{ source: Task; start: { x: number; y: number }; pointer: { x: number; y: number }; target: Task | null } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const { setNodeRef } = useDroppable({ id: 'graph-canvas' });
  const geometry = props.compact ? GRID.compact : GRID.full;
  const graceKeys = useMemo(() => new Set(props.graceMap.keys()), [props.graceMap]);
  const layout = useMemo(() => buildGraphLayout({ tasks: props.tasks, seedKeys: props.seedKeys, showCompleted: props.showCompleted, graceKeys, positions: props.positions, collapsedKeys, compact: props.compact, viewportWidth, zoom: props.zoom, today: props.today }), [props.tasks, props.seedKeys, props.showCompleted, graceKeys, props.positions, collapsedKeys, props.compact, viewportWidth, props.zoom, props.today]);
  const dependencyIndex = useMemo(() => buildDependencyIndex(layout.nodes.map((node) => node.task)), [layout.nodes]);
  const nodeByKey = useMemo(() => new Map(layout.nodes.map((node) => [node.key, node])), [layout.nodes]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (initiallyCenteredRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    initiallyCenteredRef.current = true;
    requestAnimationFrame(() => {
      viewport.scrollLeft = centeredScrollOffset(viewport.scrollWidth, viewport.clientWidth);
      viewport.scrollTop = centeredScrollOffset(viewport.scrollHeight, viewport.clientHeight);
    });
  }, [layout.size.width, layout.size.height, props.zoom]);
  useEffect(() => {
    if (!props.highlightKey) return;
    const card = canvasRef.current?.querySelector<HTMLElement>(`[data-task-key="${CSS.escape(props.highlightKey)}"]`);
    card?.classList.add('em-task-highlight');
    return () => card?.classList.remove('em-task-highlight');
  }, [props.highlightKey, layout.nodes]);
  useEffect(() => {
    if (!props.revealKey) return;
    if (!nodeByKey.has(props.revealKey) && !layout.hiddenKeys.has(props.revealKey)) {
      props.onRevealed(props.revealKey, false);
      return;
    }
    if (!layout.hiddenKeys.has(props.revealKey)) {
      props.onRevealed(props.revealKey, true);
      return;
    }
    setCollapsedKeys((current) => {
      const next = new Set(current);
      for (const key of current) {
        const node = props.tasks.find((task) => taskKey(task) === key);
        const stack = [...(node?.blockedByTasks ?? [])];
        const closure = new Set<string>();
        while (stack.length) { const task = stack.pop()!; const key = taskKey(task); if (closure.has(key)) continue; closure.add(key); stack.push(...task.blockedByTasks); }
        if (closure.has(props.revealKey!)) next.delete(key);
      }
      return next;
    });
    props.onRevealed(props.revealKey, true);
  }, [props.revealKey, layout.hiddenKeys, nodeByKey, props.tasks, props.onRevealed]);

  const handleDrop = useCallback(async (event: DragEndEvent) => {
    if (String(event.over?.id) !== 'graph-canvas') return;
    const task = props.tasks.find((candidate) => taskKey(candidate) === String(event.active.id));
    const coordinates = event.activatorEvent && 'clientX' in event.activatorEvent && 'clientY' in event.activatorEvent ? { x: Number(event.activatorEvent.clientX) + event.delta.x, y: Number(event.activatorEvent.clientY) + event.delta.y } : null;
    const canvas = canvasRef.current;
    if (!task || !coordinates || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (coordinates.x - rect.left) / props.zoom;
    const y = (coordinates.y - rect.top) / props.zoom;
    if (y >= layout.bandTop) { await props.onSetPosition(task, null); return; }
    const cell = { col: Math.max(0, Math.floor(x / (geometry.w + GRID.gapX))), row: layout.topRow - Math.max(0, Math.floor(y / (geometry.h + GRID.gapY))) };
    const ownNode = nodeByKey.get(taskKey(task));
    if (ownNode && ownNode.cell.col === cell.col && ownNode.cell.row === cell.row) return;
    const occupant = layout.nodes.find((node) => node.key !== taskKey(task) && node.cell.col === cell.col && node.cell.row === cell.row);
    if (occupant) { showInfo('That cell is occupied'); return; }
    await props.onSetPosition(task, cell);
  }, [props, layout, geometry, nodeByKey]);
  useDndMonitor({ onDragEnd: (event) => void handleDrop(event) });

  useEffect(() => {
    if (!linkDrag) return;
    const pointerMove = (event: PointerEvent) => {
      const canvas = canvasRef.current; if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const pointer = { x: (event.clientX - rect.left) / props.zoom, y: (event.clientY - rect.top) / props.zoom };
      const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-task-key]');
      const target = props.tasks.find((task) => taskKey(task) === card?.dataset.taskKey) ?? null;
      canvas.querySelector('.em-graph-drop-target')?.classList.remove('em-graph-drop-target');
      if (card && target && canLinkTasks(linkDrag.source, target, dependencyIndex).ok) card.classList.add('em-graph-drop-target');
      setLinkDrag((current) => current ? { ...current, pointer, target } : null);
    };
    const pointerUp = async () => {
      const current = linkDrag; canvasRef.current?.querySelector('.em-graph-drop-target')?.classList.remove('em-graph-drop-target'); setLinkDrag(null);
      if (!current.target) return;
      const verdict = canLinkTasks(current.source, current.target, dependencyIndex);
      if (!verdict.ok) { showInfo(verdict.reason); return; }
      try { await props.onLinkTasks(current.source, current.target); }
      catch (error) { showInfo(`Could not save the dependency: ${String((error as Error).message ?? error)}`); }
    };
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp, { once: true });
    return () => { window.removeEventListener('pointermove', pointerMove); window.removeEventListener('pointerup', pointerUp); };
  }, [linkDrag, props, dependencyIndex]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSelectedEdge(null); setAddPanel(null); return; }
      if (!selectedEdge || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
      const eventTarget = event.target;
      if (eventTarget instanceof HTMLElement && (eventTarget.isContentEditable || eventTarget.matches('input, textarea, select, button, [contenteditable="true"]'))) return;
      const edge = layout.edges.find((candidate) => `${candidate.from}->${candidate.to}` === selectedEdge);
      const source = props.tasks.find((task) => taskKey(task) === edge?.from), target = props.tasks.find((task) => taskKey(task) === edge?.to);
      if (source && target) { event.preventDefault(); void props.onRemoveDependency(source, target); setSelectedEdge(null); }
    };
    window.addEventListener('keydown', keyDown); return () => window.removeEventListener('keydown', keyDown);
  }, [selectedEdge, layout.edges, props]);

  const setCenteredZoom = (next: number) => {
    const viewport = viewportRef.current;
    if (!viewport) { props.onZoom(next); return; }
    const pointX = (viewport.scrollLeft + viewport.clientWidth / 2) / props.zoom;
    const pointY = (viewport.scrollTop + viewport.clientHeight / 2) / props.zoom;
    props.onZoom(next);
    requestAnimationFrame(() => { viewport.scrollLeft = pointX * next - viewport.clientWidth / 2; viewport.scrollTop = pointY * next - viewport.clientHeight / 2; });
  };
  const fit = () => setCenteredZoom(Math.max(.25, Math.min(1, viewportWidth / layout.size.width)));
  const zoomAtPointer = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey || Platform.isMobile) return;
    event.preventDefault();
    const viewport = viewportRef.current; if (!viewport) return;
    const pointX = (viewport.scrollLeft + viewport.clientWidth / 2) / props.zoom;
    const pointY = (viewport.scrollTop + viewport.clientHeight / 2) / props.zoom;
    const next = Math.max(.25, Math.min(2, props.zoom * (event.deltaY < 0 ? 1.25 : .8)));
    props.onZoom(next);
    requestAnimationFrame(() => { viewport.scrollLeft = pointX * next - viewport.clientWidth / 2; viewport.scrollTop = pointY * next - viewport.clientHeight / 2; });
  }, [props]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.addEventListener('wheel', zoomAtPointer, { passive: false });
    return () => viewport.removeEventListener('wheel', zoomAtPointer);
  }, [zoomAtPointer]);
  const initialTags = props.selectedTags.filter((tag) => tag !== '__untagged__');
  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (Platform.isMobile || event.button !== 0 || !isGraphCanvasBackground(event.target)) return;
    const viewport = viewportRef.current; if (!viewport) return;
    panRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId); setPanning(true); event.preventDefault();
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => { const pan = panRef.current, viewport = viewportRef.current; if (pan && viewport) { viewport.scrollLeft = pan.left - event.clientX + pan.x; viewport.scrollTop = pan.top - event.clientY + pan.y; } };
  const stopPan = (event: React.PointerEvent<HTMLDivElement>) => { if (panRef.current?.id === event.pointerId) { panRef.current = null; setPanning(false); } };
  const openEmptyCell = (event: React.MouseEvent) => {
    if (Platform.isMobile || event.target !== event.currentTarget) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = (event.clientX - rect.left) / props.zoom, y = (event.clientY - rect.top) / props.zoom;
    const cell = { col: Math.max(0, Math.floor(x / (geometry.w + GRID.gapX))), row: layout.topRow - Math.floor(y / (geometry.h + GRID.gapY)) };
    if (!layout.nodes.some((node) => node.cell.col === cell.col && node.cell.row === cell.row)) setAddPanel({ cell });
  };
  return <div className="em-graph">
    <div className="em-graph-toolbar">
      <button onClick={props.onBack}><Icon name="layout-grid" className="em-kanban-icon" /> Back to grid</button><button onClick={() => setCenteredZoom(Math.max(.25, props.zoom / 1.25))}>−</button><button onClick={() => setCenteredZoom(1)}>{Math.round(props.zoom * 100)} %</button><button onClick={() => setCenteredZoom(Math.min(2, props.zoom * 1.25))}>+</button><button onClick={fit}>Fit</button>
      <button onClick={() => setAddPanel({ cell: { col: 0, row: -1 } })}>+ Task</button><button onClick={() => setCollapsedKeys(new Set())}>Expand all</button><button onClick={() => { props.onResetAll(); requestAnimationFrame(() => requestAnimationFrame(() => { const viewport = viewportRef.current; if (viewport) { viewport.scrollLeft = centeredScrollOffset(viewport.scrollWidth, viewport.clientWidth); viewport.scrollTop = centeredScrollOffset(viewport.scrollHeight, viewport.clientHeight); } })); }}>Reset all positions</button>
    </div>
    <div ref={viewportRef} className={`em-graph-viewport ${panning ? 'em-graph-panning' : ''}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={stopPan}>
      <div className="em-graph-scaler" style={{ width: layout.size.width * props.zoom, height: layout.size.height * props.zoom }}>
        <div ref={(element) => { canvasRef.current = element; setNodeRef(element); }} className="em-graph-canvas" style={{ width: layout.size.width, height: layout.size.height, transform: `scale(${props.zoom})` }} onClick={(event) => { if (event.target === event.currentTarget || (event.target instanceof SVGSVGElement && event.target.classList.contains('em-graph-edges'))) setSelectedEdge(null); }} onDoubleClick={openEmptyCell}>
          <svg className="em-graph-edges" width={layout.size.width} height={layout.size.height}><defs><marker id="em-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>{layout.edges.map((edge) => { const edgeKey = `${edge.from}->${edge.to}`; return <path key={edgeKey} d={edge.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')} className={`em-graph-edge ${edge.resolved ? 'em-graph-edge-resolved' : ''} ${edge.cycle ? 'em-graph-edge-cycle' : ''} ${hoverKey === edge.from || hoverKey === edge.to ? 'em-graph-edge-active' : ''} ${selectedEdge === edgeKey ? 'em-graph-edge-selected' : ''}`} markerEnd="url(#em-graph-arrow)" onClick={(event) => { event.stopPropagation(); setSelectedEdge(edgeKey); }} onContextMenu={(event) => { event.preventDefault(); setSelectedEdge(edgeKey); const source = props.tasks.find((task) => taskKey(task) === edge.from), target = props.tasks.find((task) => taskKey(task) === edge.to); if (!source || !target) return; const menu = new Menu(); menu.addItem((item) => item.setTitle('Remove dependency').setIcon('trash-2').onClick(() => void props.onRemoveDependency(source, target))); menu.showAtMouseEvent(event.nativeEvent); }} />; })}{linkDrag && <line x1={linkDrag.start.x} y1={linkDrag.start.y} x2={linkDrag.pointer.x} y2={linkDrag.pointer.y} className={`em-graph-link-preview ${linkDrag.target && !canLinkTasks(linkDrag.source, linkDrag.target, dependencyIndex).ok ? 'em-graph-link-preview-invalid' : ''}`} />}</svg>
          <div className="em-graph-band-separator" style={{ top: layout.bandTop }}>No dependencies · {layout.nodes.filter((node) => node.inBand).length}</div>
          <ul className="em-graph-nodes">{layout.nodes.map((node) => {
            const point = cellToPoint(node.cell, { ...geometry, gapX: GRID.gapX, gapY: GRID.gapY, topRow: layout.topRow });
            const canToggleBranch = canToggleGraphBranch(node.task, collapsedKeys);
            return <TaskCard key={node.key} task={node.task} today={props.today} graceExpiresAt={props.graceMap.get(node.key)} isActiveDrag={props.activeTaskId === node.key} compact={props.compact} style={{ left: point.x, top: point.y, width: geometry.w, height: geometry.h }} className={`${node.manual ? 'em-task-manual' : ''} ${node.collapsed ? 'em-graph-task-collapsed' : ''} ${(!node.inSeed && props.selectedTags.length) || (isClosedStatus(node.task.status) && !props.graceMap.has(node.key)) ? 'em-task-dimmed' : ''}`} onToggle={() => props.onToggleTask(node.task)} onSetStatus={(status) => props.onSetStatus(node.task, status)} onSetDueDate={(due) => props.onSetDueDate(node.task, due)} onUpdateTask={(text, tags, options, dependencies) => props.onUpdateTask(node.task, text, tags, options, dependencies)} onOpenSource={(mode) => props.onOpenSource(node.task, mode)} onOpenLink={(link) => props.onOpenLink(node.task, link)} onMoveQuadrant={(quadrant) => props.onMoveQuadrant(node.task, quadrant)} createTagSuggest={props.createTagSuggest} extendMenu={(menu: Menu) => {
              menu.addItem((item) => item.setTitle('Add blocker below').setIcon('arrow-down-to-line').onClick(() => setAddPanel({ cell: { col: node.cell.col, row: Math.max(0, node.cell.row - 1) }, target: node.task, kind: 'blocker' })));
              menu.addItem((item) => item.setTitle('Add dependent above').setIcon('arrow-up-to-line').onClick(() => setAddPanel({ cell: { col: node.cell.col, row: node.cell.row + 1 }, target: node.task, kind: 'dependent' })));
              if (node.manual) menu.addItem((item) => item.setTitle('Reset position').setIcon('rotate-ccw').onClick(() => void props.onSetPosition(node.task, null)));
              if (canToggleBranch) menu.addItem((item) => item.setTitle(node.collapsed ? 'Expand branch' : 'Collapse branch').onClick(() => setCollapsedKeys((current) => { const next = new Set(current); node.collapsed ? next.delete(node.key) : next.add(node.key); return next; })));
            }} onMouseEnter={() => setHoverKey(node.key)} onMouseLeave={() => setHoverKey(null)}>
              {node.manual && <span className="em-graph-manual-pin" title="Placed manually · right-click → Reset position"><Icon name="pin" /></span>}
              {!Platform.isMobile && (['top', 'right', 'bottom', 'left'] as const).map((side) => <button key={side} aria-label={`Create dependency from ${side} port`} className={`em-graph-port em-graph-port-${side}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); const canvas = canvasRef.current; if (!canvas) return; const canvasRect = canvas.getBoundingClientRect(), portRect = event.currentTarget.getBoundingClientRect(); const start = { x: (portRect.left + portRect.width / 2 - canvasRect.left) / props.zoom, y: (portRect.top + portRect.height / 2 - canvasRect.top) / props.zoom }; setLinkDrag({ source: node.task, start, pointer: start, target: null }); }} />)}
              {canToggleBranch && <button aria-label={node.collapsed ? `Expand branch (${node.hiddenCount} hidden)` : 'Collapse branch'} className="em-graph-collapse" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setCollapsedKeys((current) => { const next = new Set(current); node.collapsed ? next.delete(node.key) : next.add(node.key); return next; }); }}>{node.collapsed ? '▼' : '▲'}</button>}
            </TaskCard>;
          })}</ul>
          {addPanel && <div className="em-graph-add-panel" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} style={{ left: addPanel.cell.col * (geometry.w + GRID.gapX), top: cellToPoint(addPanel.cell, { ...geometry, gapX: GRID.gapX, gapY: GRID.gapY, topRow: layout.topRow }).y, width: geometry.w * 2 + GRID.gapX }}><AddTaskInput quadrant={addPanel.target?.quadrant ?? 'OPEN'} initialTags={initialTags} createTagSuggest={props.createTagSuggest} onCancel={() => setAddPanel(null)} onSubmit={async (input) => { if (addPanel.target && addPanel.kind) await props.onAddLinked(addPanel.target, addPanel.kind, input); else if (addPanel.cell.row < 0) await props.onAddTask(input); else await props.onAddAtCell(addPanel.cell, { ...input, quadrant: 'OPEN' }); setAddPanel(null); }} /></div>}
        </div>
      </div>
    </div>
  </div>;
}
