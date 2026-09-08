import {
  type App,
  PluginSettingTab,
  requireApiVersion,
  Setting,
  type SettingDefinitionItem,
} from 'obsidian';
import type EisenhowerMatrixPlugin from '../../main.ts';
import { getDailyNotesFolder } from '../obsidian-adapter/dailyNotes.ts';
import { showError } from '../obsidian-adapter/toast.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { ExcludeFolderModal } from './ExcludeFolderModal.ts';
import { FolderSuggest } from './FolderSuggest.ts';

const DEFAULT_DAILY_HEADING = DEFAULT_SETTINGS.dailySectionHeading;

const DAILY_FOLDER_NAME = 'Daily folder';
const dailyFolderDesc = (coreLabel: string) =>
  `Folder where new daily notes are created. Leave empty to use the core "Daily notes" plugin config — currently ${coreLabel}.`;
const DAILY_FOLDER_PLACEHOLDER = 'e.g. Daily (or leave empty)';

const DAILY_HEADING_NAME = 'Daily section heading';
const DAILY_HEADING_DESC =
  "Heading in the daily note under which today's tasks are read and added. New tasks go below it; if missing, it is created automatically.";

const EXCLUDED_NAME = 'Excluded folders';
const EXCLUDED_DESC = 'Tasks from these folders are hidden from the matrix.';

const WARN_BLOCKED_NAME = 'Warn when completing a blocked task';
const WARN_BLOCKED_DESC = 'Ask for confirmation before completing a task with unfinished dependencies.';
const RESPECT_DEPENDENCIES_NAME = 'Respect task dependencies when sorting';
const RESPECT_DEPENDENCIES_DESC = 'Place blocking tasks before the tasks that depend on them.';
const HIDE_BLOCKED_NAME = 'Hide blocked tasks';
const HIDE_BLOCKED_DESC = 'Hide tasks that have at least one unfinished dependency.';

const RESET_NAME = 'Reset to defaults';
const RESET_DESC =
  'Clears overrides — daily folder falls back to the core config, excluded folders are emptied.';
const RESET_GRAPH_NAME = 'Reset graph positions';
const RESET_GRAPH_DESC = 'Forget every manually placed card in the dependency graph.';

export class MatrixSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: EisenhowerMatrixPlugin,
  ) {
    super(app, plugin);
  }

  // ==========================================================================
  // Deklarativní API (Obsidian 1.13+). Když vrátí neprázdné pole, `display()`
  // se vůbec nevolá — a nastavení se objeví i v globálním vyhledávání
  // v Settings.
  // ==========================================================================

  getSettingDefinitions(): SettingDefinitionItem[] {
    const coreFolder = getDailyNotesFolder(this.app, '');
    const coreLabel = coreFolder ? `\`${coreFolder}\`` : '(vault root)';
    const excluded = this.plugin.settings.excludedFolders;

    return [
      {
        name: DAILY_FOLDER_NAME,
        desc: dailyFolderDesc(coreLabel),
        control: {
          type: 'folder',
          key: 'dailyFolderOverride',
          placeholder: DAILY_FOLDER_PLACEHOLDER,
        },
      },
      {
        name: DAILY_HEADING_NAME,
        desc: DAILY_HEADING_DESC,
        control: {
          type: 'text',
          key: 'dailySectionHeading',
          placeholder: DEFAULT_DAILY_HEADING,
        },
      },
      {
        name: WARN_BLOCKED_NAME,
        desc: WARN_BLOCKED_DESC,
        control: { type: 'toggle', key: 'warnWhenCompletingBlockedTask' },
      },
      {
        name: RESPECT_DEPENDENCIES_NAME,
        desc: RESPECT_DEPENDENCIES_DESC,
        control: { type: 'toggle', key: 'respectTaskDependenciesWhenSorting' },
      },
      {
        name: HIDE_BLOCKED_NAME,
        desc: HIDE_BLOCKED_DESC,
        control: { type: 'toggle', key: 'hideBlockedTasks' },
      },
      {
        type: 'list',
        heading: EXCLUDED_NAME,
        emptyState: `${EXCLUDED_DESC} None excluded yet.`,
        items: excluded.map((folder) => ({ name: folder, aliases: [EXCLUDED_NAME] })),
        onDelete: (index) => {
          const folder = excluded[index];
          if (folder === undefined) return;
          void this.removeExcludedFolder(folder, index).then(() => this.refreshDefinitions());
        },
        addItem: {
          name: 'Exclude a folder',
          action: () => {
            new ExcludeFolderModal(this.app, this.plugin.settings.excludedFolders, (path) => {
              void this.addExcludedFolder(path).then(() => this.refreshDefinitions());
            }).open();
          },
        },
      },
      {
        name: RESET_GRAPH_NAME,
        desc: RESET_GRAPH_DESC,
        render: (setting: Setting) => setting.addButton((btn) => {
          btn.setButtonText('Reset').onClick(() => {
            if (confirm('Reset every manually placed graph card?')) void this.resetGraphPositions().then(() => this.refreshDefinitions());
          });
          if (requireApiVersion('1.13.0')) btn.setDestructive();
        }),
      },
      {
        name: RESET_NAME,
        desc: RESET_DESC,
        render: (setting: Setting) => {
          setting.addButton((btn) => {
            btn.setButtonText('Reset').onClick(() => {
              void this.resetOverrides().then(() => this.refreshDefinitions());
            });
            // `setDestructive()` je 1.13+; sem se dostaneme jen na 1.13+, ale statická
            // kontrola to neví — guard drží `minAppVersion` na 1.8.0 bez nálezu.
            // Bez `else`: nedosažitelná větev by přidala deprecated `setWarning()` navíc.
            if (requireApiVersion('1.13.0')) btn.setDestructive();
          });
        },
      },
    ];
  }

  /**
   * Překreslení deklarativní karty. Volá se jen z definic, které konzumuje
   * Obsidian 1.13+, takže guard je pojistka — a hlavně to jediné, čím se dá
   * statické kontrole doložit, že se `update()` (1.13+) nezavolá na 1.8.0.
   */
  private refreshDefinitions(): void {
    if (requireApiVersion('1.13.0')) this.update();
  }

  /** Čtení hodnoty pro deklarativní `control` — protějšek `setControlValue`. */
  getControlValue(key: string): unknown {
    switch (key) {
      case 'dailyFolderOverride':
        return this.plugin.settings.dailyFolderOverride;
      case 'dailySectionHeading':
        return this.plugin.settings.dailySectionHeading;
      case 'warnWhenCompletingBlockedTask':
        return this.plugin.settings.warnWhenCompletingBlockedTask;
      case 'respectTaskDependenciesWhenSorting':
        return this.plugin.settings.respectTaskDependenciesWhenSorting;
      case 'hideBlockedTasks':
        return this.plugin.settings.hideBlockedTasks;
      default:
        return undefined;
    }
  }

  /**
   * Zápis hodnoty z deklarativního `control`. Default implementace v
   * `PluginSettingTab` sice do `plugin.settings` zapíše, ale neví o
   * `notifyRepoConfigChanged()` — bez něj by otevřené view drželo starou
   * konfiguraci až do restartu.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case 'dailyFolderOverride':
        if (typeof value !== 'string') return;
        await this.setDailyFolderOverride(value);
        break;
      case 'dailySectionHeading':
        if (typeof value !== 'string') return;
        await this.setDailySectionHeading(value);
        break;
      case 'warnWhenCompletingBlockedTask':
      case 'respectTaskDependenciesWhenSorting':
      case 'hideBlockedTasks':
        if (typeof value !== 'boolean') return;
        await this.setBooleanSetting(key, value);
        break;
      default:
        break;
    }
  }

  // ==========================================================================
  // Mutace stavu — sdílené oběma větvím. Překreslení si řeší každá větev sama
  // (`update()` deklarativně, `display()` ve fallbacku), protože `update()`
  // na Obsidianu < 1.13 neexistuje.
  // ==========================================================================

  /** Serializuje zápisy — dvojklik nesmí poslat na disk dva soubory najednou. */
  private saveQueue: Promise<void> = Promise.resolve();

  /**
   * Provede změnu nastavení, uloží ji a dá vědět otevřenému view. Běží až po
   * doběhnutí předchozí mutace; když zápis na disk selže, vrátí pole, která
   * tenhle tab vlastní, zpátky — jinak by UI ukazovalo hodnotu, která po
   * restartu zmizí.
   */
  private mutate(change: () => void): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      // Pole se vždy nahrazují novou instancí, takže stačí mělký snímek.
      const before = {
        dailyFolderOverride: this.plugin.settings.dailyFolderOverride,
        dailySectionHeading: this.plugin.settings.dailySectionHeading,
        excludedFolders: this.plugin.settings.excludedFolders,
        warnWhenCompletingBlockedTask: this.plugin.settings.warnWhenCompletingBlockedTask,
        respectTaskDependenciesWhenSorting: this.plugin.settings.respectTaskDependenciesWhenSorting,
        hideBlockedTasks: this.plugin.settings.hideBlockedTasks,
        graphPositions: this.plugin.settings.graphPositions,
      };
      try {
        change();
        await this.plugin.saveSettings();
      } catch (err) {
        Object.assign(this.plugin.settings, before);
        console.error('[4D Matrix] saving settings failed', err);
        showError('Could not save settings — the change was reverted.');
        return false;
      }

      try {
        this.plugin.notifyRepoConfigChanged();
      } catch (err) {
        // Uloženo je — spadlý listener nesmí shodit frontu ani vrátit stav zpět.
        console.error('[4D Matrix] repo config listener failed', err);
      }
      return true;
    };

    const result = this.saveQueue.then(run);
    // Fronta nesmí uváznout na odmítnutém promisu.
    this.saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async setDailyFolderOverride(value: string): Promise<void> {
    const trimmed = value.trim();
    await this.mutate(() => {
      this.plugin.settings.dailyFolderOverride = trimmed;
    });
  }

  private async setDailySectionHeading(value: string): Promise<void> {
    const trimmed = value.trim();
    await this.mutate(() => {
      // Fallback to default if the user clears it.
      this.plugin.settings.dailySectionHeading = trimmed || DEFAULT_DAILY_HEADING;
    });
  }

  private async setBooleanSetting(
    key: 'warnWhenCompletingBlockedTask' | 'respectTaskDependenciesWhenSorting' | 'hideBlockedTasks',
    value: boolean,
  ): Promise<void> {
    await this.mutate(() => {
      this.plugin.settings[key] = value;
    });
  }

  private async addExcludedFolder(path: string): Promise<'added' | 'duplicate' | 'failed'> {
    const value = path.trim();
    if (!value) return 'failed';
    const existing = this.plugin.settings.excludedFolders;
    if (existing.some((f) => f.toLowerCase() === value.toLowerCase())) return 'duplicate';

    let duplicate = false;
    const saved = await this.mutate(() => {
      // Znovu proti čerstvému stavu — mezi kontrolou výš a frontou mohla projít jiná mutace.
      const current = this.plugin.settings.excludedFolders;
      if (current.some((f) => f.toLowerCase() === value.toLowerCase())) {
        duplicate = true;
        return;
      }
      this.plugin.settings.excludedFolders = [...current, value];
    });
    if (duplicate) return 'duplicate';
    return saved ? 'added' : 'failed';
  }

  /** Maže podle indexu (ne podle hodnoty), aby ruční duplicita v `data.json` nezmizela celá. */
  /**
   * Maže položku, na kterou uživatel klikl — index je jen z renderu, takže se
   * ověřuje proti hodnotě; fronta mohla mezitím indexy posunout. Podle indexu
   * (ne podle hodnoty) proto, aby ruční duplicita v `data.json` nezmizela celá.
   */
  private async removeExcludedFolder(folder: string, index: number): Promise<void> {
    await this.mutate(() => {
      const folders = this.plugin.settings.excludedFolders;
      const at = folders[index] === folder ? index : folders.indexOf(folder);
      if (at < 0) return;
      this.plugin.settings.excludedFolders = folders.filter((_, i) => i !== at);
    });
  }

  private async resetOverrides(): Promise<void> {
    await this.mutate(() => {
      this.plugin.settings.dailyFolderOverride = '';
      this.plugin.settings.excludedFolders = [];
      this.plugin.settings.warnWhenCompletingBlockedTask = DEFAULT_SETTINGS.warnWhenCompletingBlockedTask;
      this.plugin.settings.respectTaskDependenciesWhenSorting = DEFAULT_SETTINGS.respectTaskDependenciesWhenSorting;
      this.plugin.settings.hideBlockedTasks = DEFAULT_SETTINGS.hideBlockedTasks;
    });
  }

  private async resetGraphPositions(): Promise<void> {
    await this.mutate(() => { this.plugin.settings.graphPositions = {}; });
  }

  // ==========================================================================
  // Imperativní fallback pro Obsidian < 1.13, kde `getSettingDefinitions()`
  // neexistuje. Na 1.13+ se tahle větev nevolá. Smazat, až `minAppVersion`
  // v manifestu vyskočí na 1.13.0.
  // ==========================================================================

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // No plugin-name heading — Obsidian renders it itself.

    // === Daily folder override ===
    const coreFolder = getDailyNotesFolder(this.app, '');
    const coreLabel = coreFolder ? `\`${coreFolder}\`` : '(vault root)';

    new Setting(containerEl)
      .setName(DAILY_FOLDER_NAME)
      .setDesc(dailyFolderDesc(coreLabel))
      .addText((text) => {
        text
          .setPlaceholder(DAILY_FOLDER_PLACEHOLDER)
          .setValue(this.plugin.settings.dailyFolderOverride)
          .onChange(async (value) => {
            await this.setDailyFolderOverride(value);
          });
        new FolderSuggest(this.app, text.inputEl);
      });

    // === Daily section heading ===
    new Setting(containerEl)
      .setName(DAILY_HEADING_NAME)
      .setDesc(DAILY_HEADING_DESC)
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_DAILY_HEADING)
          .setValue(this.plugin.settings.dailySectionHeading)
          .onChange(async (value) => {
            await this.setDailySectionHeading(value);
          }),
      );

    this.renderDependencyToggles(containerEl);

    // === Excluded folders ===
    this.renderExcludedFoldersSection(containerEl);

    new Setting(containerEl).setName(RESET_GRAPH_NAME).setDesc(RESET_GRAPH_DESC).addButton((btn) => btn.setButtonText('Reset').setWarning().onClick(async () => {
      if (confirm('Reset every manually placed graph card?')) { await this.resetGraphPositions(); this.display(); }
    }));

    // === Reset ===
    new Setting(containerEl)
      .setName(RESET_NAME)
      .setDesc(RESET_DESC)
      .addButton((btn) =>
        btn
          .setButtonText('Reset')
          // `setDestructive()` je až od 1.13.0 — tahle větev běží na starších verzích.
          .setWarning()
          .onClick(async () => {
            await this.resetOverrides();
            this.display();
          }),
      );
  }

  private renderDependencyToggles(parent: HTMLElement): void {
    const toggles = [
      [WARN_BLOCKED_NAME, WARN_BLOCKED_DESC, 'warnWhenCompletingBlockedTask'],
      [RESPECT_DEPENDENCIES_NAME, RESPECT_DEPENDENCIES_DESC, 'respectTaskDependenciesWhenSorting'],
      [HIDE_BLOCKED_NAME, HIDE_BLOCKED_DESC, 'hideBlockedTasks'],
    ] as const;

    for (const [name, desc, key] of toggles) {
      new Setting(parent).setName(name).setDesc(desc).addToggle((toggle) =>
        toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
          await this.setBooleanSetting(key, value);
        }),
      );
    }
  }

  /**
   * Excluded folders — list of rows with × + an add input with a folder
   * suggester. Mirrors the native Obsidian "Excluded files" dialog.
   */
  private renderExcludedFoldersSection(parent: HTMLElement): void {
    new Setting(parent).setName(EXCLUDED_NAME).setHeading();

    const section = parent.createDiv({ cls: 'em-settings-excluded' });

    section.createEl('p', {
      text: `${EXCLUDED_DESC} Click × to remove, or add a new folder below.`,
      cls: 'setting-item-description',
    });

    const list = section.createDiv({ cls: 'em-excluded-list' });

    const folders = this.plugin.settings.excludedFolders;
    if (folders.length === 0) {
      list.createDiv({
        cls: 'em-excluded-empty',
        text: 'No excluded folders.',
      });
    } else {
      folders.forEach((folder, index) => {
        const row = list.createDiv({ cls: 'em-excluded-row' });
        row.createSpan({ text: folder, cls: 'em-excluded-path' });
        const removeBtn = row.createEl('button', {
          cls: 'em-excluded-remove',
          attr: { 'aria-label': `Remove ${folder}` },
          text: '×',
        });
        const removeFolder = async () => {
          await this.removeExcludedFolder(folder, index);
          this.display();
        };
        removeBtn.addEventListener('click', () => void removeFolder());
      });
    }

    // Add row
    const addRow = section.createDiv({ cls: 'em-excluded-add' });
    const addInput = addRow.createEl('input', {
      type: 'text',
      cls: 'em-excluded-input',
      attr: { placeholder: 'Add a folder…' },
    });
    new FolderSuggest(this.app, addInput);

    const addBtn = addRow.createEl('button', {
      cls: 'mod-cta em-excluded-add-btn',
      text: 'Add',
    });

    const tryAdd = async () => {
      const value = addInput.value.trim();
      if (!value) return;
      // Při selhání zápisu necháváme text v inputu, ať uživatel nepřijde o cestu.
      const result = await this.addExcludedFolder(value);
      if (result === 'failed') return;
      addInput.value = '';
      this.display();
    };

    addBtn.addEventListener('click', () => void tryAdd());
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void tryAdd();
      }
    });
  }
}
