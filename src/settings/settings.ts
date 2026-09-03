import type { Quadrant } from '../core/types.ts';
import type { DueFilter } from '../core/taskUtils.ts';

/**
 * Plugin nastavení — persistovaná napříč restarty Obsidianu přes
 * `plugin.loadData()` / `plugin.saveData()`.
 *
 * Toto NEzahrnuje `date` (currently viewed) — to se vždy resetuje na dnešek
 * při otevření view.
 */
export type PluginSettings = {
  selectedTags: string[];
  /** Rychlý filtr podle due date: none / today (overdue+dnes) / week (overdue+7 dní). */
  dueFilter: DueFilter;
  collapsedQuadrants: Record<Quadrant, boolean>;
  showCompleted: boolean;
  lastOpenedDate: string | null;
  excludedFolders: string[];
  /**
   * Override pro daily notes folder. Prázdný string = použij konfiguraci
   * z core pluginu „Daily notes". Cesta relativní k vault rootu.
   */
  dailyFolderOverride: string;
  /**
   * Heading sekce v daily note, pod kterou se přidávají / ze které se čtou
   * dnešní tasky. Default `# Today`.
   */
  dailySectionHeading: string;
  /**
   * Skrytí horní hlavičky (titulek + datum nav + filter bar + subtitle).
   * Užitečné na mobilu, kde header zabírá moc místa. Stav persistovaný.
   */
  headerCollapsed: boolean;
  /**
   * Kompaktní zobrazení tasků — každá karta jen 2 řádky (text na prvním,
   * priorita + due date na druhém). Tagy / cesta / start/done badge se
   * skryjí, editace zůstává plná. Přepíná se v hlavičce. Persistované.
   */
  compactMode: boolean;
  /** Zobrazí potvrzení před uzavřením blokovaného úkolu. */
  warnWhenCompletingBlockedTask: boolean;
  /** Řadí blokátory před úkoly, které na ně čekají. */
  respectTaskDependenciesWhenSorting: boolean;
  /** Skryje úkoly, které čekají na alespoň jeden otevřený blokátor. */
  hideBlockedTasks: boolean;
  /**
   * Kanban režim (desktop i mobil/tablet): pokud je nastaven kvadrant, ten se rozbalí
   * na celou šířku se 4 status-sloupci (To-do / In progress / Scheduled /
   * Done) a zbylé kvadranty jsou pod ním. `null` = normální 5-mřížka.
   */
  kanbanQuadrant: Quadrant | null;
};

export const DEFAULT_SETTINGS: PluginSettings = {
  selectedTags: [],
  dueFilter: 'none',
  collapsedQuadrants: {
    DO: false,
    DECIDE: false,
    DELEGATE: false,
    DELETE: false,
    OPEN: false,
  },
  showCompleted: false,
  lastOpenedDate: null,
  // Prázdné — uživatel si vyloučené složky nastaví sám (v Settings).
  // Generic plugin nemá hádat vault-specifické složky.
  excludedFolders: [],
  dailyFolderOverride: '',
  dailySectionHeading: '# Today',
  headerCollapsed: false,
  compactMode: false,
  warnWhenCompletingBlockedTask: true,
  respectTaskDependenciesWhenSorting: true,
  hideBlockedTasks: false,
  kanbanQuadrant: null,
};
