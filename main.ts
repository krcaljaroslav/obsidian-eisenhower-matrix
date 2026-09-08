import { addIcon, Plugin, WorkspaceLeaf } from 'obsidian';
import { MatrixView, VIEW_TYPE_MATRIX } from './src/view/MatrixView.ts';
import { DEFAULT_SETTINGS, type PluginSettings } from './src/settings/settings.ts';
import { MatrixSettingsTab } from './src/settings/SettingsTab.ts';
import { validateGraphPositions } from './src/core/graphLayout.ts';

// Vlastní ikona pro stav "In progress" [/] — Lucide nemá half-square,
// tak ji zaregistrujeme: hranatý rámeček + vyplněná levá polovina (Things-style).
// addIcon očekává obsah SVG s viewBoxem 0 0 100 100.
const SQUARE_HALF_ICON = `<rect x="14" y="14" width="72" height="72" rx="12" fill="none" stroke="currentColor" stroke-width="8"/><path d="M50 18 L24 18 A6 6 0 0 0 18 24 L18 76 A6 6 0 0 0 24 82 L50 82 Z" fill="currentColor"/>`;

export default class EisenhowerMatrixPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  /**
   * Callback registrované MatrixView při vytvoření — voláme ho po změně settings,
   * aby repo přepočítalo daily folder + excluded folders.
   */
  private repoConfigCallbacks: Set<() => void> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();

    addIcon('em-square-half', SQUARE_HALF_ICON);

    this.registerView(VIEW_TYPE_MATRIX, (leaf) => new MatrixView(leaf, this));

    this.addRibbonIcon('layout-grid', 'Open Eisenhower matrix', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open',
      name: 'Open matrix',
      callback: () => {
        void this.activateView();
      },
    });

    this.addSettingTab(new MatrixSettingsTab(this.app, this));
  }

  onunload(): void {
    // Obsidian uvolní view / ribbon / command / settings tab automaticky.
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(loaded ?? {}),
      collapsedQuadrants: {
        ...DEFAULT_SETTINGS.collapsedQuadrants,
        ...(loaded?.collapsedQuadrants ?? {}),
      },
    };
    this.settings.graphPositions = validateGraphPositions(this.settings.graphPositions, (key) => console.warn(`[4D Matrix] Ignoring invalid graph position: ${key}`));
    const zoom = Number(this.settings.graphZoom);
    if (!Number.isFinite(zoom) || zoom < .25 || zoom > 2) console.warn('[4D Matrix] Clamping invalid graph zoom');
    this.settings.graphZoom = Math.min(2, Math.max(.25, Number.isFinite(zoom) ? zoom : 1));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  registerRepoConfigCallback(cb: () => void): () => void {
    this.repoConfigCallbacks.add(cb);
    return () => this.repoConfigCallbacks.delete(cb);
  }

  /** Voláno z SettingsTab po změně daily folderu / excluded folders. */
  notifyRepoConfigChanged(): void {
    for (const cb of this.repoConfigCallbacks) cb();
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;

    const existing = workspace.getLeavesOfType(VIEW_TYPE_MATRIX);
    if (existing.length > 0) {
      void workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf: WorkspaceLeaf | null = workspace.getLeaf('tab');
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_MATRIX, active: true });
    void workspace.revealLeaf(leaf);
  }
}
