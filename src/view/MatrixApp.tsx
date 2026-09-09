import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'obsidian';
import type { App, EventRef, PaneType } from 'obsidian';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import type { ObsidianTaskRepo } from '../obsidian-adapter/ObsidianTaskRepo.ts';
import { showError, showInfo } from '../obsidian-adapter/toast.ts';
import type { Priority, Quadrant, Task } from '../core/types.ts';
import { QUADRANTS, isClosedStatus } from '../core/types.ts';
import {
  extractAllContextTags,
  formatDateISO,
  makeCompareTask,
  sortTasksByDependencies,
  matchesDueFilter,
  matchesFilter,
  matchesSearch,
  normalizeForSearch,
  UNTAGGED_FILTER,
  type DueFilter,
} from '../core/taskUtils.ts';
import { Matrix } from '../components/Matrix.tsx';
import { KanbanView } from '../components/KanbanView.tsx';
import { GraphView } from '../components/GraphView.tsx';
import { parseTaskLine } from '../core/parser.ts';
import { FilterBar } from '../components/FilterBar.tsx';
import { DateNav } from '../components/DateNav.tsx';
import { SearchBox } from '../components/SearchBox.tsx';
import { Icon } from '../components/Icon.tsx';
import {
  DependencyNavigationContext,
  SearchHighlightContext,
  TaskEditingContext,
  TaskCardOverlay,
  GRACE_MS,
  type DependencySelection,
} from '../components/TaskCard.tsx';
import type { InlineLinkTarget } from '../components/inlineMarkdown.tsx';
import { TagSuggest } from '../components/TagSuggest.ts';
import type EisenhowerMatrixPlugin from '../../main.ts';

type Props = {
  app: App;
  repo: ObsidianTaskRepo;
  plugin: EisenhowerMatrixPlugin;
};

function taskKey(sourceFile: string, lineIndex: number): string {
  return `${sourceFile}:${lineIndex}`;
}

function showUnblockedTasks(task: Task): void {
  const unblockedCount = task.blocksTasks.filter((dependent) =>
    dependent.blockedByTasks.every(
      (blocker) => blocker === task || isClosedStatus(blocker.status),
    ),
  ).length;
  if (unblockedCount > 0) {
    showInfo(`Unblocked ${unblockedCount} ${unblockedCount === 1 ? 'task' : 'tasks'}`);
  }
}

function confirmBlockedCompletion(app: App, task: Task): boolean {
  const message = `"${task.text}" is not finished yet. Complete this task anyway?`;
  return app.workspace.containerEl.ownerDocument.defaultView?.confirm(message) ?? false;
}

/**
 * Z events všech typů (Mouse/Pointer/Touch) vytáhne clientX/Y. Default dnd-kit
 * to neumí univerzálně, takže si to spočítáme sami.
 */
function getEventCoordinates(event: Event): { x: number; y: number } | null {
  if (event instanceof MouseEvent) {
    return { x: event.clientX, y: event.clientY };
  }
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    if (touch) return { x: touch.clientX, y: touch.clientY };
  }
  // Fallback pro PointerEvent a jiné (mají clientX/Y)
  if ('clientX' in event && 'clientY' in event) {
    const ev = event as { clientX: number; clientY: number };
    return { x: ev.clientX, y: ev.clientY };
  }
  return null;
}

/**
 * Modifier pro DragOverlay — drží STŘED overlay přímo pod kurzorem,
 * bez ohledu na to, kde uživatel kliknul na originální kartu.
 *
 * Standardní chování dnd-kit: top-left overlay = top-left source. Pokud
 * uživatel kliknul na levý horní roh karty, vypadalo to OK; pokud kliknul
 * na střed, vypadalo to že overlay „odskočil" doprava dolů.
 */
const snapCenterToCursor: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const coords = getEventCoordinates(activatorEvent);
  if (!coords) return transform;
  const offsetX = coords.x - draggingNodeRect.left;
  const offsetY = coords.y - draggingNodeRect.top;
  return {
    ...transform,
    x: transform.x + offsetX - draggingNodeRect.width / 2,
    y: transform.y + offsetY - draggingNodeRect.height / 2,
  };
};

/**
 * Collision detection — pointerWithin (kurzor jako autorita) má přednost.
 * Pokud kurzor není přímo nad žádným droppable (např. kvůli scroll, malé
 * obrazovce), fallback na rectIntersection (bbox overlay vs droppable).
 */
const cursorFirstCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return rectIntersection(args);
};

export function MatrixApp({ app, repo, plugin }: Props) {
  const appRootRef = useRef<HTMLDivElement>(null);
  const today = useMemo(() => formatDateISO(new Date()), []);
  const [date, setDate] = useState<string>(today);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [todayFileExists, setTodayFileExists] = useState(false);
  const [scannedFiles, setScannedFiles] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dependencyHighlightTimerRef = useRef<number | null>(null);
  const [existingDates, setExistingDates] = useState<Set<string>>(() => new Set());

  // Settings (persisted)
  const [selectedTags, setSelectedTags] = useState<string[]>(plugin.settings.selectedTags);
  const [dueFilter, setDueFilter] = useState<DueFilter>(plugin.settings.dueFilter);
  const [collapsed, setCollapsed] = useState<Record<Quadrant, boolean>>(
    plugin.settings.collapsedQuadrants,
  );
  const [showCompleted, setShowCompleted] = useState<boolean>(plugin.settings.showCompleted);
  const [headerCollapsed, setHeaderCollapsed] = useState<boolean>(
    plugin.settings.headerCollapsed,
  );
  const [compactMode, setCompactMode] = useState<boolean>(plugin.settings.compactMode);
  const [kanbanQuadrant, setKanbanQuadrant] = useState<Quadrant | null>(
    plugin.settings.kanbanQuadrant,
  );
  const [graphView, setGraphView] = useState(plugin.settings.graphView);
  const [graphPositions, setGraphPositions] = useState(plugin.settings.graphPositions);
  const [graphZoom, setGraphZoom] = useState(plugin.settings.graphZoom);
  const [graphRevealKey, setGraphRevealKey] = useState<string | null>(null);
  const [graphHighlightKey, setGraphHighlightKey] = useState<string | null>(null);
  useEffect(() => {
    if (!graphHighlightKey) return;
    const timer = window.setTimeout(() => setGraphHighlightKey(null), 1500);
    return () => window.clearTimeout(timer);
  }, [graphHighlightKey]);
  // Hledání (nepersistuje se — po otevření view je vždy zavřené a prázdné)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  /** Roste s každým skokem — ať „další" na jediné shodě zase odscrolluje. */
  const [searchJump, setSearchJump] = useState(0);
  /**
   * Poslední nalezený task; po zavření hledání zůstává vidět (a přes filtr).
   * Text si držíme spolu s klíčem: `sourceFile:lineIndex` se po editaci
   * souboru může posunout na jiný task a pin by pak ukazoval na cizí kartu.
   */
  const [pinnedTask, setPinnedTask] = useState<{ key: string; text: string } | null>(
    null,
  );
  const lastScrolledRef = useRef<string | null>(null);

  const [dayChangedBanner, setDayChangedBanner] = useState<string | null>(() => {
    const last = plugin.settings.lastOpenedDate;
    return last && last !== today ? last : null;
  });

  // Grace period: map key (sourceFile:lineIndex) -> expiresAt timestamp
  const [graceMap, setGraceMap] = useState<Map<string, number>>(() => new Map());
  const [, setTick] = useState(0);

  // Update last opened
  useEffect(() => {
    if (dayChangedBanner === null) {
      plugin.settings.lastOpenedDate = today;
      void plugin.saveSettings();
    }
  }, [today, dayChangedBanner, plugin]);

  useEffect(() => {
    plugin.settings.selectedTags = selectedTags;
    void plugin.saveSettings();
  }, [selectedTags, plugin]);

  useEffect(() => {
    plugin.settings.dueFilter = dueFilter;
    void plugin.saveSettings();
  }, [dueFilter, plugin]);

  useEffect(() => {
    plugin.settings.collapsedQuadrants = collapsed;
    void plugin.saveSettings();
  }, [collapsed, plugin]);

  useEffect(() => {
    plugin.settings.showCompleted = showCompleted;
    void plugin.saveSettings();
  }, [showCompleted, plugin]);

  useEffect(() => {
    plugin.settings.headerCollapsed = headerCollapsed;
    void plugin.saveSettings();
  }, [headerCollapsed, plugin]);

  useEffect(() => {
    plugin.settings.compactMode = compactMode;
    void plugin.saveSettings();
  }, [compactMode, plugin]);

  useEffect(() => {
    plugin.settings.kanbanQuadrant = kanbanQuadrant;
    void plugin.saveSettings();
  }, [kanbanQuadrant, plugin]);

  useEffect(() => { plugin.settings.graphView = graphView; void plugin.saveSettings(); }, [graphView, plugin]);
  useEffect(() => { plugin.settings.graphPositions = graphPositions; void plugin.saveSettings(); }, [graphPositions, plugin]);
  useEffect(() => { plugin.settings.graphZoom = graphZoom; void plugin.saveSettings(); }, [graphZoom, plugin]);

  // === Data fetching ===
  const refetchTimerRef = useRef<number | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const result = await repo.getMatrixTasks(date);
      setTasks(result.tasks);
      setTodayFileExists(result.todayFileExists);
      setScannedFiles(result.scannedFiles);
      setExistingDates(repo.getExistingDailyDates());
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [repo, date]);

  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current) window.clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = window.setTimeout(() => {
      void refetch();
      refetchTimerRef.current = null;
    }, 200);
  }, [refetch]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Live sync
  useEffect(() => {
    const refs: EventRef[] = [];
    refs.push(app.vault.on('modify', scheduleRefetch));
    refs.push(app.vault.on('create', scheduleRefetch));
    refs.push(app.vault.on('delete', scheduleRefetch));
    refs.push(app.vault.on('rename', scheduleRefetch));
    return () => {
      for (const ref of refs) app.vault.offref(ref);
      if (refetchTimerRef.current) window.clearTimeout(refetchTimerRef.current);
    };
  }, [app, scheduleRefetch]);

  // Grace period interval — clean expired keys + re-render
  useEffect(() => {
    if (graceMap.size === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      let mutated = false;
      setGraceMap((prev) => {
        const next = new Map(prev);
        for (const [k, exp] of next) {
          if (exp <= now) {
            next.delete(k);
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
      setTick((t) => t + 1);
    }, 250);
    return () => window.clearInterval(interval);
  }, [graceMap.size]);

  // === Local optimistic mutations ===
  // Optimisticky nastav status tasku + zařiď grace pro "closed" stavy
  // ([x] done a [-] canceled). Voláno z toggle (klik na box) i setStatus
  // (menu "Mark as …") — oba sdílejí stejné chování undo-grace.
  const applyLocalStatus = useCallback(
    (sourceFile: string, lineIndex: number, newStatus: string) => {
      const key = taskKey(sourceFile, lineIndex);
      const isChecked = newStatus.toLowerCase() === 'x';
      const isClosed = isClosedStatus(newStatus);
      setTasks((prev) =>
        prev.map((t) =>
          t.sourceFile === sourceFile && t.lineIndex === lineIndex
            ? {
                ...t,
                status: newStatus,
                checked: isChecked,
                doneDate: isChecked ? today : undefined,
              }
            : t,
        ),
      );
      if (isClosed) {
        setGraceMap((prev) => {
          const next = new Map(prev);
          next.set(key, Date.now() + GRACE_MS);
          return next;
        });
      } else {
        setGraceMap((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [today],
  );

  // === Write callbacks ===
  const handleToggle = useCallback(
    async (task: Task) => {
      // Z [x]/[-] zpátky na [ ], jinak na [x] — zrcadlí toggleLine v core.
      const newStatus = isClosedStatus(task.status) ? ' ' : 'x';
      if (
        !isClosedStatus(task.status) &&
        task.isBlocked &&
        plugin.settings.warnWhenCompletingBlockedTask &&
        !confirmBlockedCompletion(app, task)
      ) return;
      applyLocalStatus(task.sourceFile, task.lineIndex, newStatus);
      try {
        await repo.toggleTask(task.sourceFile, task.lineIndex, today);
        if (isClosedStatus(newStatus)) showUnblockedTasks(task);
      } catch (e) {
        applyLocalStatus(task.sourceFile, task.lineIndex, task.status);
        showError(`Toggle failed: ${String((e as Error).message ?? e)}`);
      }
    },
    [repo, today, applyLocalStatus, plugin, app],
  );

  const handleSetDueDate = useCallback(
    async (task: Task, newDueDate: string | null) => {
      try {
        await repo.setDueDate(task.sourceFile, task.lineIndex, newDueDate);
      } catch (e) {
        showError(`Changing due date failed: ${String((e as Error).message ?? e)}`);
      }
    },
    [repo],
  );

  const handleSetStatus = useCallback(
    async (task: Task, newStatus: string) => {
      const previousStatus = task.status;
      if (
        !isClosedStatus(previousStatus) &&
        isClosedStatus(newStatus) &&
        task.isBlocked &&
        plugin.settings.warnWhenCompletingBlockedTask &&
        !confirmBlockedCompletion(app, task)
      ) return;
      // Stejný optimistic flow jako u toggle — pro [x]/[-] nastartuje
      // 3s grace s undo, ostatní stavy se promítnou rovnou.
      applyLocalStatus(task.sourceFile, task.lineIndex, newStatus);
      try {
        await repo.setStatus(task.sourceFile, task.lineIndex, newStatus, today);
        if (isClosedStatus(newStatus)) showUnblockedTasks(task);
      } catch (e) {
        applyLocalStatus(task.sourceFile, task.lineIndex, previousStatus);
        showError(`Changing status failed: ${String((e as Error).message ?? e)}`);
      }
    },
    [repo, today, applyLocalStatus, plugin, app],
  );

  const handleUpdate = useCallback(
    async (
      task: Task,
      text: string,
      contextTags: string[],
      options: { dueDate: string | null; priority: Priority | null },
      dependencies: DependencySelection,
    ) => {
      try {
        await repo.updateTask(task, text, contextTags, options, dependencies);
      } catch (e) {
        showError(`Save failed: ${String((e as Error).message ?? e)}`);
        throw e;
      }
    },
    [repo],
  );

  const handleAdd = useCallback(
    async (input: {
      text: string;
      quadrant: Quadrant;
      dueDate: string | null;
      priority: Priority | null;
      status?: string;
    }) => {
      try {
        const result = await repo.addTask(
          date,
          input.text,
          input.quadrant,
          input.dueDate,
          input.priority,
          input.status ?? ' ',
        );
        setGraphHighlightKey(taskKey(result.sourceFile, result.lineIndex));
      } catch (e) {
        showError(`Adding task failed: ${String((e as Error).message ?? e)}`);
        throw e;
      }
    },
    [repo, date],
  );

  const handleOpenSource = useCallback(
    (task: Task, mode: PaneType | boolean = false) => {
      const file = app.vault.getFileByPath(task.sourceFile);
      if (!file) {
        showError(`File not found: ${task.sourceFile}`);
        return;
      }
      const leaf = app.workspace.getLeaf(mode);
      void leaf.openFile(file, {
        active: true,
        eState: { line: task.lineIndex },
      });
    },
    [app],
  );

  const handleNavigateToDependency = useCallback(
    (target: Task) => {
      const targetKey = taskKey(target.sourceFile, target.lineIndex);
      const targetCard = Array.from(
        appRootRef.current?.querySelectorAll<HTMLElement>('[data-task-key]') ?? [],
      ).find((card) => card.dataset.taskKey === targetKey);
      if (!targetCard) {
        if (graphView) { setGraphRevealKey(targetKey); return; }
        handleOpenSource(target);
        return;
      }

      targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetCard.classList.remove('em-task-highlight');
      void targetCard.offsetWidth;
      targetCard.classList.add('em-task-highlight');
      if (dependencyHighlightTimerRef.current !== null) {
        window.clearTimeout(dependencyHighlightTimerRef.current);
      }
      dependencyHighlightTimerRef.current = window.setTimeout(() => {
        targetCard.classList.remove('em-task-highlight');
        dependencyHighlightTimerRef.current = null;
      }, 1500);
    },
    [handleOpenSource, graphView],
  );

  const handleGraphRevealed = useCallback((key: string, present: boolean) => {
    if (!present) {
      const target = tasks.find((candidate) => taskKey(candidate.sourceFile, candidate.lineIndex) === key);
      if (target) handleOpenSource(target);
      setGraphRevealKey(null);
      return;
    }
    setSearchJump((value) => value + 1);
  }, [tasks, handleOpenSource]);

  useEffect(
    () => () => {
      if (dependencyHighlightTimerRef.current !== null) {
        window.clearTimeout(dependencyHighlightTimerRef.current);
      }
    },
    [],
  );

  // Klik na [[wikilink]] / [text](url) v textu tasku. Interní odkazy řeší
  // Obsidian přes openLinkText (rozlišuje relativně vůči zdrojovému souboru
  // tasku, včetně #headingů a aliasů); externí URL otevřeme v prohlížeči.
  const handleOpenLink = useCallback(
    (task: Task, link: InlineLinkTarget) => {
      if (link.external) {
        // Defense-in-depth: renderer linkuje externě jen https/http/mailto,
        // ale schéma zkontrolujeme znovu i tady, u samotného otevření.
        if (/^(https?:\/\/|mailto:)/i.test(link.target)) {
          window.open(link.target, '_blank');
        }
        return;
      }
      void app.workspace.openLinkText(link.target, task.sourceFile, link.newLeaf);
    },
    [app],
  );

  // === Derived state ===
  const normalizedQuery = useMemo(
    () => normalizeForSearch(searchQuery.trim()),
    [searchQuery],
  );

  /**
   * Pin platí, jen dokud na jeho řádku sedí i text — po refetchi (vložený
   * nebo smazaný řádek) se jinak drží cizí task. Když sedět přestane, pin
   * tiše zaniká.
   */
  const pinnedTaskKey = useMemo(() => {
    if (!pinnedTask) return null;
    const still = tasks.find(
      (t) => taskKey(t.sourceFile, t.lineIndex) === pinnedTask.key,
    );
    return still && still.text === pinnedTask.text ? pinnedTask.key : null;
  }, [pinnedTask, tasks]);

  const passesFilters = useCallback(
    (t: Task): boolean => {
      if (!graphView && plugin.settings.hideBlockedTasks && t.isBlocked) return false;
      if (!matchesFilter(t, selectedTags)) return false;
      if (!matchesDueFilter(t, dueFilter, today, date)) return false;
      if (showCompleted) return true;
      // "Closed" = done ([x]) i canceled ([-]) — oba schované, pokud
      // uživatel nezapne přepínač "Done" v hlavičce.
      if (!isClosedStatus(t.status)) return true;
      return graceMap.has(taskKey(t.sourceFile, t.lineIndex));
    },
    [plugin, selectedTags, dueFilter, today, date, showCompleted, graceMap, graphView],
  );

  /** Co projde filtry — bez ohledu na hledání. Tohle je číslo ve filter baru. */
  const filteredTasks = useMemo(
    () => tasks.filter(passesFilters),
    [tasks, passesFilters],
  );

  const visibleTasks = useMemo(
    () =>
      tasks.filter((t) => {
        // Shoda z hledání (a poslední nalezený task) projde i přes filtry,
        // „Done" a hideBlocked — jinak by hledání mlčky nic nenašlo
        // a vypadalo by to jako rozbité. Do počtu ve filter baru se ale
        // taková karta nezapočítá, ať číslo dál popisuje filtr.
        if (normalizedQuery !== '' && matchesSearch(t, normalizedQuery)) return true;
        if (taskKey(t.sourceFile, t.lineIndex) === pinnedTaskKey) return true;
        return passesFilters(t);
      }),
    [tasks, passesFilters, normalizedQuery, pinnedTaskKey],
  );

  const sortedVisibleTasks = useMemo(
    () => plugin.settings.respectTaskDependenciesWhenSorting
      ? sortTasksByDependencies(visibleTasks, today)
      : [...visibleTasks].sort(makeCompareTask(today)),
    [visibleTasks, today, plugin],
  );

  // === Hledání ===
  // Shody v pořadí, v jakém jsou vykreslené — „další" tak jde odshora dolů.
  const searchMatches = useMemo(() => {
    if (normalizedQuery === '') return [];
    return sortedVisibleTasks
      .filter((t) => matchesSearch(t, normalizedQuery))
      .map((t) => taskKey(t.sourceFile, t.lineIndex));
  }, [sortedVisibleTasks, normalizedQuery]);

  const searchMatchKeys = useMemo(() => new Set(searchMatches), [searchMatches]);

  const clampedIndex =
    searchMatches.length === 0 ? 0 : Math.min(searchIndex, searchMatches.length - 1);
  const currentMatchKey = searchMatches[clampedIndex] ?? null;

  // Memoizované, ať se identita contextu mění jen se shodami — jinak by
  // každý stisk klávesy překreslil všechny karty i beze změny výsledků.
  const searchHighlight = useMemo(
    () => ({
      matchKeys: searchMatchKeys,
      currentKey: searchOpen ? currentMatchKey : pinnedTaskKey,
    }),
    [searchMatchKeys, searchOpen, currentMatchKey, pinnedTaskKey],
  );

  // Nový dotaz → zpátky na první shodu.
  useEffect(() => {
    setSearchIndex(0);
    setSearchJump((n) => n + 1);
  }, [normalizedQuery]);

  const goToMatch = useCallback(
    (delta: number) => {
      setSearchIndex((prev) => {
        if (searchMatches.length === 0) return 0;
        const from = Math.min(prev, searchMatches.length - 1);
        return (from + delta + searchMatches.length) % searchMatches.length;
      });
      setSearchJump((n) => n + 1);
    },
    [searchMatches.length],
  );

  const closeSearch = useCallback(() => {
    // Aktuální shoda zůstane vidět i po zavření (i kdyby ji schovával filtr).
    const match = currentMatchKey
      ? tasks.find((t) => taskKey(t.sourceFile, t.lineIndex) === currentMatchKey)
      : undefined;
    setPinnedTask(
      match ? { key: taskKey(match.sourceFile, match.lineIndex), text: match.text } : null,
    );
    setSearchOpen(false);
    setSearchQuery('');
  }, [currentMatchKey, tasks]);

  const openSearch = useCallback(() => {
    setPinnedTask(null);
    setSearchOpen(true);
  }, []);

  // Skok na aktuální shodu: rozbalit kvadrant / přepnout Kanban a odscrollovat.
  // Efekt běží znovu po každém renderu, který kartu může zpřístupnit — dokud
  // karta v DOM není, scroll se odloží (`lastScrolledRef` hlídá duplicity).
  useEffect(() => {
    const revealTargetKey = graphRevealKey ?? currentMatchKey;
    if (!revealTargetKey) {
      lastScrolledRef.current = null;
      return;
    }
    const target = tasks.find(
      (t) => taskKey(t.sourceFile, t.lineIndex) === revealTargetKey,
    );
    if (!target) return;

    if (!graphView && collapsed[target.quadrant]) {
      setCollapsed((prev) => ({ ...prev, [target.quadrant]: false }));
      return;
    }
    if (!graphView && kanbanQuadrant !== null && kanbanQuadrant !== target.quadrant) {
      setKanbanQuadrant(target.quadrant);
      return;
    }

    const jumpId = `${revealTargetKey}#${searchJump}`;
    if (lastScrolledRef.current === jumpId) return;

    const card = Array.from(
      appRootRef.current?.querySelectorAll<HTMLElement>('[data-task-key]') ?? [],
    ).find((el) => el.dataset.taskKey === revealTargetKey);
    if (!card) return;

    lastScrolledRef.current = jumpId;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (graphRevealKey) setGraphRevealKey(null);
  }, [currentMatchKey, graphRevealKey, searchJump, tasks, collapsed, kanbanQuadrant, sortedVisibleTasks, graphView]);

  // Jiný den = jiný pohled; držet v něm starý nález nedává smysl. Změna
  // filtrů pin ruší schválně: uživatel po zavření hledání sáhl na filtr,
  // takže od té chvíle má rozhodovat filtr, ne starý nález.
  useEffect(() => {
    setPinnedTask(null);
  }, [date, selectedTags, dueFilter, showCompleted]);

  const availableTags = useMemo(
    () =>
      extractAllContextTags(
        tasks.filter((t) => showCompleted || !isClosedStatus(t.status)),
      ),
    [tasks, showCompleted],
  );

  // Live ref na seznam tagů pro autocomplete v add/edit formech.
  // Ref místo state aby se TagSuggest nemusel re-instantovat když se tagy mění.
  const availableTagNamesRef = useRef<string[]>([]);
  availableTagNamesRef.current = availableTags
    .filter((t) => t.tag !== UNTAGGED_FILTER)
    .map((t) => t.tag);

  const createTagSuggest = useCallback(
    (inputEl: HTMLInputElement) => {
      new TagSuggest(app, inputEl, () => availableTagNamesRef.current);
    },
    [app],
  );

  const totalUnfiltered = useMemo(
    () => tasks.filter((t) => showCompleted || !isClosedStatus(t.status)).length,
    [tasks, showCompleted],
  );

  // === UI handlers ===
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) =>
      prev.some((t) => t.toLowerCase() === tag.toLowerCase())
        ? prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...prev, tag],
    );
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedTags([]);
    setDueFilter('none');
  }, []);

  const toggleDueFilter = useCallback((f: DueFilter) => {
    setDueFilter((prev) => (prev === f ? 'none' : f));
  }, []);

  const toggleQuadrantCollapsed = useCallback((q: Quadrant) => {
    setCollapsed((prev) => ({ ...prev, [q]: !prev[q] }));
  }, []);

  const anyCollapsed = Object.values(collapsed).some(Boolean);

  const collapseAll = useCallback(() => {
    setCollapsed(
      Object.fromEntries(QUADRANTS.map((q) => [q, true])) as Record<Quadrant, boolean>,
    );
  }, []);

  const expandAll = useCallback(() => {
    setCollapsed(
      Object.fromEntries(QUADRANTS.map((q) => [q, false])) as Record<Quadrant, boolean>,
    );
  }, []);

  // Kanban: klik na ikonu zvoleného kvadrantu vypne (zpět na mřížku),
  // klik na jiný kvadrant prohodí fokus.
  const toggleKanban = useCallback((q: Quadrant) => {
    setKanbanQuadrant((prev) => (prev === q ? null : q));
  }, []);

  const acknowledgeDayChange = useCallback(
    (jumpToToday: boolean) => {
      if (jumpToToday) setDate(today);
      plugin.settings.lastOpenedDate = today;
      void plugin.saveSettings();
      setDayChangedBanner(null);
    },
    [today, plugin],
  );

  // === Drag & drop ===
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const onDragStart = useCallback(
    (e: DragStartEvent) => {
      const id = String(e.active.id);
      const t = tasks.find((x) => taskKey(x.sourceFile, x.lineIndex) === id);
      setActiveTask(t ?? null);
    },
    [tasks],
  );

  // Přesun tasku do jiného kvadrantu — sdíleno mezi drag-end a context menu.
  const handleMove = useCallback(
    async (task: Task, targetQuadrant: Quadrant) => {
      if (task.quadrant === targetQuadrant) return;
      const id = taskKey(task.sourceFile, task.lineIndex);

      // Optimistic update
      setTasks((prev) =>
        prev.map((t) =>
          taskKey(t.sourceFile, t.lineIndex) === id
            ? { ...t, quadrant: targetQuadrant }
            : t,
        ),
      );

      try {
        await repo.moveTask(task.sourceFile, task.lineIndex, targetQuadrant);
      } catch (err) {
        // rollback
        setTasks((prev) =>
          prev.map((t) => (taskKey(t.sourceFile, t.lineIndex) === id ? task : t)),
        );
        showError(`Move failed: ${String((err as Error).message ?? err)}`);
      }
    },
    [repo],
  );

  // Kanban drop ze spodního kvadrantu do status-sloupce: kvadrant + status najednou.
  const handleMoveAndSetStatus = useCallback(
    async (task: Task, targetQuadrant: Quadrant, newStatus: string) => {
      const id = taskKey(task.sourceFile, task.lineIndex);
      applyLocalStatus(task.sourceFile, task.lineIndex, newStatus);
      setTasks((prev) =>
        prev.map((t) =>
          taskKey(t.sourceFile, t.lineIndex) === id ? { ...t, quadrant: targetQuadrant } : t,
        ),
      );
      try {
        await repo.moveAndSetStatus(
          task.sourceFile,
          task.lineIndex,
          targetQuadrant,
          newStatus,
          today,
        );
      } catch (err) {
        applyLocalStatus(task.sourceFile, task.lineIndex, task.status);
        setTasks((prev) =>
          prev.map((t) => (taskKey(t.sourceFile, t.lineIndex) === id ? task : t)),
        );
        showError(`Move failed: ${String((err as Error).message ?? err)}`);
      }
    },
    [repo, today, applyLocalStatus],
  );

  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      setActiveTask(null);
      if (!e.over) return;

      const draggedId = String(e.active.id);
      const overId = String(e.over.id);
      if (overId === 'graph-canvas') return;
      if (draggedId === overId) return;

      const dragged = tasks.find((t) => taskKey(t.sourceFile, t.lineIndex) === draggedId);
      if (!dragged) return;

      // Kanban status-sloupec → změna checkboxu (+ případně kvadrantu).
      if (overId.startsWith('kanban-status:')) {
        const statusChar = overId.slice('kanban-status:'.length);
        if (kanbanQuadrant && dragged.quadrant !== kanbanQuadrant) {
          await handleMoveAndSetStatus(dragged, kanbanQuadrant, statusChar);
        } else if (dragged.status !== statusChar) {
          await handleSetStatus(dragged, statusChar);
        }
        return;
      }

      // Jinak je overId Quadrant kind → změna kvadrantu (jako dosud).
      if (QUADRANTS.includes(overId as Quadrant)) {
        await handleMove(dragged, overId as Quadrant);
      }
    },
    [tasks, handleMove, handleSetStatus, handleMoveAndSetStatus, kanbanQuadrant],
  );

  const isPastOrFuture = date !== today;
  // Kanban je dostupný i na mobilu/tabletu. Přesun mezi status-sloupci tam
  // nejde dragem (touch-drag je v Obsidian webview nespolehlivý) — řeší se přes
  // kontextové menu karty „Mark as…", stejně jako přesun mezi kvadranty.
  const effectiveKanban = kanbanQuadrant;

  // Ovládání zobrazení (Collapse all / Done / Compact) — sdílené mezi
  // rozbalenou i sbalenou hlavičkou, ať jsou ty přepínače dostupné i
  // když je hlavička sbalená (uživatel je chce mít po ruce vždy).
  const viewControls = (
    <>
      <SearchBox
        open={searchOpen}
        query={searchQuery}
        matchCount={searchMatches.length}
        currentIndex={searchMatches.length === 0 ? 0 : clampedIndex + 1}
        onOpen={openSearch}
        onClose={closeSearch}
        onQueryChange={setSearchQuery}
        onNext={() => goToMatch(1)}
        onPrev={() => goToMatch(-1)}
      />
      {!graphView && <button
        type="button"
        onClick={anyCollapsed ? expandAll : collapseAll}
        className="em-btn-link"
      >
        {anyCollapsed ? 'Expand all' : 'Collapse all'}
      </button>}
      <button type="button" onClick={() => setGraphView((current) => !current)} className={graphView ? 'em-kanban-btn-active' : ''} title={graphView ? 'Back to grid' : 'Dependency graph'}><Icon name={graphView ? 'layout-grid' : 'workflow'} className="em-kanban-icon" /> {graphView ? 'Back' : 'Graph'}</button>
      <label className="em-toggle">
        <input
          type="checkbox"
          checked={showCompleted}
          onChange={(e) => setShowCompleted(e.target.checked)}
        />
        <span>Done</span>
      </label>
      <label className="em-toggle" title="Compact 2-line task cards">
        <input
          type="checkbox"
          checked={compactMode}
          onChange={(e) => setCompactMode(e.target.checked)}
        />
        <span>Compact</span>
      </label>
    </>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={cursorFirstCollisionDetection}
      onDragStart={onDragStart}
      onDragEnd={(e) => void onDragEnd(e)}
    >
      <div ref={appRootRef} className="em-app">
        {headerCollapsed ? (
          <div className="em-app-header em-app-header-compact">
            <span className="em-compact-info">⚡ {totalUnfiltered} tasks</span>
            <div className="em-header-right">
              {viewControls}
              <button
                type="button"
                onClick={() => setHeaderCollapsed(false)}
                className="em-header-collapse-btn"
                title="Expand header"
                aria-label="Expand header"
              >
                ▼
              </button>
            </div>
          </div>
        ) : (
        <div className="em-app-header">
        <header className="em-header">
          <div className="em-header-left">
            <h2 className="em-title">Eisenhower Matrix</h2>
            <DateNav
              date={date}
              today={today}
              existingDates={existingDates}
              onChange={setDate}
            />
          </div>
          <div className="em-header-right">
            {viewControls}
            <button
              type="button"
              onClick={() => setHeaderCollapsed(true)}
              className="em-header-collapse-btn"
              title="Collapse the whole header (frees up space)"
              aria-label="Collapse header"
            >
              ▲
            </button>
          </div>
        </header>

        <p className="em-subtitle">
          {formatDisplayDate(date)}
          {isPastOrFuture && <span className="em-warn"> (not today)</span>}
          {loading && <span className="em-loading"> · loading…</span>}
          {!loading && (
            <span className="em-stats">
              {' '}· {totalUnfiltered} tasks · {scannedFiles} files scanned
            </span>
          )}
        </p>

        {dayChangedBanner && (
          <div className="em-banner em-banner-warn">
            <span>
              A new day has started since you last opened this (
              <strong>{dayChangedBanner}</strong>). Switch to today (
              <strong>{today}</strong>)?
            </span>
            <div className="em-banner-actions">
              <button
                type="button"
                onClick={() => acknowledgeDayChange(true)}
                className="em-btn-primary"
              >
                Switch
              </button>
              <button
                type="button"
                onClick={() => acknowledgeDayChange(false)}
                className="em-btn-secondary"
              >
                Stay
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="em-error" role="alert">
            Error: {error}
          </div>
        )}

        {!todayFileExists && !loading && (
          <div className="em-info">
            No daily note exists for {date} yet. Add the first task via <code>+</code>{' '}
            in any quadrant — the file is created automatically.
          </div>
        )}

        <FilterBar
          availableTags={availableTags}
          selectedTags={selectedTags}
          dueFilter={dueFilter}
          selectedDate={date}
          onToggle={toggleTag}
          onDueFilter={toggleDueFilter}
          onClear={clearFilters}
          totalCount={totalUnfiltered}
          filteredCount={filteredTasks.length}
        />
        </div>
        )}

        <TaskEditingContext.Provider value={{ app, tasks }}>
        <DependencyNavigationContext.Provider value={handleNavigateToDependency}>
        <SearchHighlightContext.Provider value={searchHighlight}>
        <div className="em-app-body">
        {graphView ? (
          <GraphView
            tasks={tasks}
            seedKeys={new Set(visibleTasks.map((task) => taskKey(task.sourceFile, task.lineIndex)))}
            selectedTags={selectedTags}
            showCompleted={showCompleted}
            graceMap={graceMap}
            positions={graphPositions}
            zoom={graphZoom}
            compact={compactMode}
            today={today}
            activeTaskId={activeTask ? taskKey(activeTask.sourceFile, activeTask.lineIndex) : null}
            revealKey={graphRevealKey ?? currentMatchKey}
            highlightKey={graphHighlightKey}
            onRevealed={handleGraphRevealed}
            onZoom={setGraphZoom}
            onBack={() => setGraphView(false)}
            onResetAll={() => setGraphPositions({})}
            onSetPosition={async (task, cell) => {
              if (!cell) { if (task.id) setGraphPositions((current) => { const next = { ...current }; delete next[task.id!]; return next; }); return; }
              try {
                const ensured = await repo.ensureTaskId(task);
                setGraphPositions((current) => ({ ...current, [ensured.id]: cell }));
                if (!task.id) setTasks((current) => current.map((candidate) => taskKey(candidate.sourceFile, candidate.lineIndex) === taskKey(task.sourceFile, task.lineIndex) ? { ...candidate, id: ensured.id, raw: ensured.newLine } : candidate));
              } catch (error) { showError(`Could not save position: ${String((error as Error).message ?? error)}`); }
            }}
            onToggleTask={(task) => void handleToggle(task)} onSetStatus={handleSetStatus} onSetDueDate={handleSetDueDate} onUpdateTask={handleUpdate}
            onOpenSource={handleOpenSource} onOpenLink={handleOpenLink} onMoveQuadrant={(task, quadrant) => void handleMove(task, quadrant)}
            onAddTask={handleAdd}
            onAddAtCell={async (cell, input) => { const result = await repo.addTaskAtCell(date, input); setGraphPositions((current) => ({ ...current, [result.newId]: cell })); setGraphHighlightKey(taskKey(result.sourceFile, result.lineIndex)); const parsed = parseTaskLine(result.newLine, result.lineIndex); if (parsed) setTasks((current) => [...current, { ...parsed, sourceFile: result.sourceFile, isFromDnes: true, isBlocked: false, blockedByTasks: [], blocksTasks: [], missingBlockers: [], hasCircularDependency: false }]); }}
            onAddLinked={async (target, kind, input) => { const result = await repo.addLinkedTask(date, input, { target, kind }); setGraphHighlightKey(taskKey(result.sourceFile, result.lineIndex)); }}
            onLinkTasks={async (source, target) => { await repo.linkTasks(source, target); setTasks((await repo.getMatrixTasks(date)).tasks); }}
            onRemoveDependency={async (source, target) => { await repo.unlinkTasks(source, target); setTasks((await repo.getMatrixTasks(date)).tasks); }}
            createTagSuggest={createTagSuggest}
          />
        ) : effectiveKanban ? (
          <KanbanView
            kanbanQuadrant={effectiveKanban}
            tasks={sortedVisibleTasks}
            today={today}
            collapsed={collapsed}
            graceMap={graceMap}
            compact={compactMode}
            activeTaskId={
              activeTask ? taskKey(activeTask.sourceFile, activeTask.lineIndex) : null
            }
            onToggleKanban={toggleKanban}
            onToggleCollapsed={toggleQuadrantCollapsed}
            onToggleTask={(t) => void handleToggle(t)}
            onSetStatus={handleSetStatus}
            onSetDueDate={handleSetDueDate}
            onUpdateTask={handleUpdate}
            onAddTask={handleAdd}
            onOpenSource={handleOpenSource}
            onOpenLink={handleOpenLink}
            onMoveQuadrant={(t, q) => void handleMove(t, q)}
            createTagSuggest={createTagSuggest}
          />
        ) : (
          <Matrix
            tasks={sortedVisibleTasks}
            today={today}
            collapsed={collapsed}
            graceMap={graceMap}
            compact={compactMode}
            activeTaskId={
              activeTask ? taskKey(activeTask.sourceFile, activeTask.lineIndex) : null
            }
            kanbanQuadrant={effectiveKanban}
            onToggleKanban={toggleKanban}
            onToggleCollapsed={toggleQuadrantCollapsed}
            onToggleTask={(t) => void handleToggle(t)}
            onSetStatus={handleSetStatus}
            onSetDueDate={handleSetDueDate}
            onUpdateTask={handleUpdate}
            onAddTask={handleAdd}
            onOpenSource={handleOpenSource}
            onOpenLink={handleOpenLink}
            onMoveQuadrant={(t, q) => void handleMove(t, q)}
            createTagSuggest={createTagSuggest}
          />
        )}
        </div>
        </SearchHighlightContext.Provider>
        </DependencyNavigationContext.Provider>
        </TaskEditingContext.Provider>
      </div>
      {/* DragOverlay jen na desktopu — na mobilu se posouvá originální karta
          (position:fixed overlay je na Obsidian mobile nespolehlivý). */}
      <DragOverlay dropAnimation={null} modifiers={[snapCenterToCursor]}>
        {activeTask && !Platform.isMobile ? <TaskCardOverlay task={activeTask} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function formatDisplayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${days[date.getDay()]} ${d} ${months[m - 1]} ${y}`;
}
