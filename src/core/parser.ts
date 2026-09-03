/**
 * Obsidian Tasks parser — sdíleno s `Eisenhower-matrix/app/server/parser.ts`.
 * Čistá funkce, žádné fs / Obsidian API závislosti. Drž sync ručně.
 */

import type { Priority, Quadrant } from './types.ts';

const QUADRANT_TAGS = ['#DO', '#DECIDE', '#DELEGATE', '#DELETE'] as const;

// `[^\]]` = jakýkoli stav uvnitř hranatých závorek (kromě samotného `]`).
// Plugin pak rozliší 6 Basic stavů + ostatní (viz TASK_STATUSES v types.ts).
const TASK_LINE = /^(\s*-\s+\[)([^\]])(\]\s+)(.*)$/;
// Unicode-aware: matchuje tagy s diakritikou (#Osobní, #Příští, #Důležité…).
const TAG_TOKEN = /#[\p{L}\p{N}_-]+/gu;

const DUE_DATE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const START_DATE_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;
const DONE_DATE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const ID_RE = /🆔\s*([A-Za-z0-9_-]+)/;
const BLOCKED_BY_RE = /\u26d4\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)/;
const DEPENDENCY_ID_RE = /^[A-Za-z0-9_-]+$/;

const TASKS_METADATA_TOKEN_RE =
  /(?:^|\s)((?:\u{23F3}|\u{2795}|\u{1F501}|\u{1F3C1}|\u{274C})\s*.*?)(?=\s+(?:\u{1F4C5}|\u{1F6EB}|\u{2705}|\u{1F194}|\u{26D4}|\u{1F53A}|\u{23EB}|\u{1F53C}|\u{1F53D}|\u{23EC}|\u{23F3}|\u{2795}|\u{1F501}|\u{1F3C1}|\u{274C})(?:\s|$)|$)/gu;
const BARE_ID_RE = /\u{1F194}(?=\s*(?:(?:\u{1F4C5}|\u{1F6EB}|\u{2705}|\u{1F194}|\u{26D4}|\u{1F53A}|\u{23EB}|\u{1F53C}|\u{1F53D}|\u{23EC}|\u{23F3}|\u{2795}|\u{1F501}|\u{1F3C1}|\u{274C})|$))/u;
const KNOWN_METADATA_MARKERS = new Set([
  '📅',
  '🛫',
  '✅',
  '🆔',
  '⛔',
  '🔺',
  '⏫',
  '🔼',
  '🔽',
  '⏬',
  '⏳',
  '➕',
  '🔁',
  '🏁',
  '❌',
]);

const PRIORITY_RE = /(🔺|⏫|🔼|🔽|⏬)/;
const PRIORITY_STRIP_RE = /\s*(🔺|⏫|🔼|🔽|⏬)/g;
export const PRIORITY_EMOJI: Record<Priority, string> = {
  highest: '🔺',
  high: '⏫',
  medium: '🔼',
  low: '🔽',
  lowest: '⏬',
};
const EMOJI_TO_PRIORITY: Record<string, Priority> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest',
};

export type ParsedTask = {
  lineIndex: number;
  raw: string;
  status: string;
  checked: boolean;
  text: string;
  quadrant: Quadrant;
  contextTags: string[];
  dueDate?: string;
  startDate?: string;
  doneDate?: string;
  priority?: Priority;
  id?: string;
  blockedBy: string[];
  trailingTokens: string[];
};

/**
 * Parsuje celý MD soubor. Vrací tasky z konfigurovatelné sekce
 * (`sectionHeading`, např. `# Dnes` / `# Today`).
 */
export function parseDaily(
  raw: string,
  sectionHeading: string,
): {
  tasks: ParsedTask[];
  sectionHeadingLine: number | null;
} {
  const headingNorm = sectionHeading.trim().toLowerCase();
  const lines = raw.split(/\r?\n/);
  const tasks: ParsedTask[] = [];
  let inSection = false;
  let inCodeBlock = false;
  let sectionHeadingLine: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (/^#+\s/.test(line)) {
      if (line.trim().toLowerCase() === headingNorm) {
        inSection = true;
        sectionHeadingLine = i;
      } else {
        inSection = false;
      }
      continue;
    }

    if (!inSection) continue;

    const task = parseTaskLine(line, i);
    if (task) tasks.push(task);
  }

  return { tasks, sectionHeadingLine };
}

/**
 * Parsuje VŠECHNY tasky v souboru, nezávisle na sekci. Přeskakuje code blocky.
 */
export function parseAllTasks(raw: string): ParsedTask[] {
  const lines = raw.split(/\r?\n/);
  const tasks: ParsedTask[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const task = parseTaskLine(line, i);
    if (task) tasks.push(task);
  }

  return tasks;
}

/**
 * Parsuje jeden řádek jako task. Vrací null pokud to není task řádek.
 */
export function parseTaskLine(line: string, lineIndex: number): ParsedTask | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;

  const status = m[2];
  const checked = status.toLowerCase() === 'x';
  const body = m[4];

  const quadrant = determineQuadrant(body);

  const contextTags: string[] = [];
  const allTags = body.match(TAG_TOKEN) ?? [];
  for (const t of allTags) {
    if (!QUADRANT_TAGS.includes(t.toUpperCase() as (typeof QUADRANT_TAGS)[number])) {
      contextTags.push(t);
    }
  }

  const dueDate = DUE_DATE_RE.exec(body)?.[1];
  const startDate = START_DATE_RE.exec(body)?.[1];
  const doneDate = DONE_DATE_RE.exec(body)?.[1];
  const id = ID_RE.exec(body)?.[1];
  const blockedBy = parseBlockedBy(body);
  const trailingTokens = parseTrailingTokens(body);

  const priorityMatch = PRIORITY_RE.exec(body)?.[1];
  const priority = priorityMatch ? EMOJI_TO_PRIORITY[priorityMatch] : undefined;

  let text = body;
  // strip leading hash-tags (quadrant + context na začátku)
  text = text.replace(/^(\s*#[\p{L}\p{N}_-]+)+\s*/u, '');
  // strip emoji datumy + priority
  text = text
    .replace(DUE_DATE_RE, '')
    .replace(START_DATE_RE, '')
    .replace(DONE_DATE_RE, '')
    .replace(ID_RE, '')
    .replace(BARE_ID_RE, '')
    .replace(BLOCKED_BY_RE, '')
    .replace(PRIORITY_STRIP_RE, '');
  for (const token of trailingTokens) {
    text = text.replace(token, '');
  }
  text = text.replace(/\s+/g, ' ').trim();

  return {
    lineIndex,
    raw: line,
    status,
    checked,
    text,
    quadrant,
    contextTags,
    dueDate,
    startDate,
    doneDate,
    priority,
    id,
    blockedBy,
    trailingTokens,
  };
}

function parseBlockedBy(body: string): string[] {
  const blockedByValue = BLOCKED_BY_RE.exec(body)?.[1];
  if (!blockedByValue) return [];

  return [...new Set(
    blockedByValue
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => DEPENDENCY_ID_RE.test(entry)),
  )];
}

function parseTrailingTokens(body: string): string[] {
  const trailingTokens: string[] = [];

  for (const match of body.matchAll(TASKS_METADATA_TOKEN_RE)) {
    const token = match[1].trim();
    const marker = /^\p{Extended_Pictographic}\uFE0F?/u.exec(token)?.[0];
    if (marker && KNOWN_METADATA_MARKERS.has(marker)) trailingTokens.push(token);
  }

  if (BARE_ID_RE.test(body)) trailingTokens.push('🆔');

  return trailingTokens;
}

function determineQuadrant(body: string): Quadrant {
  const firstTokenMatch = /^\s*(#[\p{L}][\p{L}\p{N}_-]*)/u.exec(body);
  if (!firstTokenMatch) return 'OPEN';
  const first = firstTokenMatch[1].toUpperCase();
  switch (first) {
    case '#DO':
      return 'DO';
    case '#DECIDE':
      return 'DECIDE';
    case '#DELEGATE':
      return 'DELEGATE';
    case '#DELETE':
      return 'DELETE';
    default:
      return 'OPEN';
  }
}
