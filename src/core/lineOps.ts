/**
 * Čisté string→string transformace task řádků v MD souborech.
 * Žádné fs / Obsidian API — testovatelné bez prostředí.
 * Volá je `ObsidianTaskRepo` přes `app.vault.process()`.
 */

import { parseTaskLine, PRIORITY_EMOJI } from './parser.ts';
import type { Priority, Quadrant } from './types.ts';

// Status v hranatých závorkách = jakýkoli znak kromě `]` (viz parser.ts).
const TASK_LINE_RE = /^(\s*-\s+\[)([^\]])(\].*)$/;
const DONE_DATE_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;
const DUE_DATE_STRIP_RE = /\s*📅\s*\d{4}-\d{2}-\d{2}/;
const LEADING_TAGS_FULL_RE = /^(\s*-\s+\[[^\]]\]\s+(?:#[\p{L}\p{N}_-]+\s+)*)/u;
const LEADING_QUADRANT_TAG_RE =
  /^(\s*-\s+\[[^\]]\]\s+)(#(?:DO|DECIDE|DELEGATE|DELETE))(\s+|$)/i;
const LEADING_NO_TAG_RE = /^(\s*-\s+\[[^\]]\]\s+)(.*)$/;
const FRONTMATTER_END_RE = /^---\s*$/;

const QUADRANT_TAG_SET = new Set(['#DO', '#DECIDE', '#DELEGATE', '#DELETE']);

// ============================================================
// Toggle checkbox + manage ✅ done date
// ============================================================

export type ToggleResult = {
  previousLine: string;
  newLine: string;
  checked: boolean;
};

export function toggleLine(line: string, todayISO: string): ToggleResult {
  const m = TASK_LINE_RE.exec(line);
  if (!m) throw new Error(`Not a task line: "${line}"`);

  // „Finished" = done [x] nebo canceled [-]. Klik na fajfku v takovém
  // stavu task otevře zpátky na [ ] (= přirozený undo během grace).
  // Z jakéhokoli jiného stavu se klikem dostaneme na [x] (mark done).
  const wasFinished = m[2] === '-' || m[2].toLowerCase() === 'x';
  const willBeChecked = !wasFinished;
  const newCheckboxChar = willBeChecked ? 'x' : ' ';

  let rest = m[3].replace(DONE_DATE_RE, '').replace(/\s+$/, '');
  let newLine = `${m[1]}${newCheckboxChar}${rest}`;
  if (willBeChecked) newLine += ` ✅ ${todayISO}`;

  return { previousLine: line, newLine, checked: willBeChecked };
}

// ============================================================
// Set arbitrary status char (Basic states: ' ', '/', 'x', '-', '>', '<')
// ============================================================

/**
 * Nastaví status (znak v hranatých závorkách) na konkrétní hodnotu.
 * Pokud nový status = `x`, přidá ✅ today (pokud chyběla). Jinak ✅ odstraní.
 */
export function setStatusOnLine(
  line: string,
  newStatus: string,
  todayISO: string,
): UpdateResult {
  const m = TASK_LINE_RE.exec(line);
  if (!m) throw new Error(`Not a task line: "${line}"`);
  if (newStatus.length !== 1 || newStatus === ']') {
    throw new Error(`Invalid status: "${newStatus}"`);
  }

  const isDone = newStatus.toLowerCase() === 'x';
  let rest = m[3].replace(DONE_DATE_RE, '').replace(/\s+$/, '');
  let newLine = `${m[1]}${newStatus}${rest}`;
  if (isDone) newLine += ` ✅ ${todayISO}`;

  return { previousLine: line, newLine };
}

// ============================================================
// Build new task line
// ============================================================

export function buildTaskLine(
  quadrant: Quadrant,
  text: string,
  todayISO: string,
  dueDate?: string | null,
  priority?: Priority | null,
  status: string = ' ',
  id?: string,
  blockedBy: string[] = [],
  trailingTokens: string[] = [],
): string {
  const trimmed = text.trim();

  const leadingMatch = trimmed.match(/^((?:#[\p{L}\p{N}_-]+\s+)+)(.*)$/u);
  let leadingTags: string[] = [];
  let remaining = trimmed;
  if (leadingMatch) {
    leadingTags = leadingMatch[1].trim().split(/\s+/);
    remaining = leadingMatch[2].trim();
  }

  const contextTags = leadingTags.filter((t) => !QUADRANT_TAG_SET.has(t.toUpperCase()));

  const prefix = quadrant === 'OPEN' ? '' : `#${quadrant} `;
  const tagsPart = contextTags.length > 0 ? contextTags.join(' ') + ' ' : '';
  const priorityPart = priority ? `${PRIORITY_EMOJI[priority]} ` : '';
  const duePart = dueDate ? `📅 ${dueDate} ` : '';
  const trailingPart = trailingTokens.length > 0 ? `${trailingTokens.join(' ')} ` : '';
  const idPart = id ? `🆔 ${id} ` : '';
  const blockedByPart = blockedBy.length > 0 ? `⛔ ${blockedBy.join(',')} ` : '';
  // Pokud se task rovnou zakládá jako "done" ([x]), doplň ✅ today (jako toggle).
  const donePart = status.toLowerCase() === 'x' ? ` ✅ ${todayISO}` : '';
  return `- [${status}] ${prefix}${tagsPart}${priorityPart}${duePart}🛫 ${todayISO} ${remaining} ${trailingPart}${idPart}${blockedByPart}${donePart}`
    .replace(/  +/g, ' ')
    .trimEnd();
}

// ============================================================
// Move task between quadrants (změna úvodního tagu)
// ============================================================

export type MoveResult = {
  previousLine: string;
  newLine: string;
  newQuadrant: Quadrant;
};

export function moveLineQuadrant(line: string, newQuadrant: Quadrant): MoveResult {
  let newLine: string;

  const taggedMatch = LEADING_QUADRANT_TAG_RE.exec(line);
  if (taggedMatch) {
    const prefix = taggedMatch[1];
    const rest = line.slice(prefix.length + taggedMatch[2].length + taggedMatch[3].length);
    newLine =
      newQuadrant === 'OPEN'
        ? `${prefix}${rest}`
        : `${prefix}#${newQuadrant} ${rest}`;
  } else {
    const noTagMatch = LEADING_NO_TAG_RE.exec(line);
    if (!noTagMatch) throw new Error(`Not a task line: "${line}"`);
    if (newQuadrant === 'OPEN') {
      return { previousLine: line, newLine: line, newQuadrant };
    }
    newLine = `${noTagMatch[1]}#${newQuadrant} ${noTagMatch[2]}`;
  }

  return { previousLine: line, newLine, newQuadrant };
}

// ============================================================
// Set / remove due date
// ============================================================

export type SetDueDateResult = {
  previousLine: string;
  newLine: string;
  newDueDate: string | null;
};

export function setDueDateOnLine(
  line: string,
  newDueDate: string | null,
): SetDueDateResult {
  if (newDueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(newDueDate)) {
    throw new Error(`Invalid dueDate format: "${newDueDate}"`);
  }

  let cleaned = line.replace(DUE_DATE_STRIP_RE, '');

  let newLine = cleaned;
  if (newDueDate) {
    const m = LEADING_TAGS_FULL_RE.exec(cleaned);
    if (!m) throw new Error(`Not a task line: "${line}"`);
    const before = cleaned.slice(0, m[0].length);
    const after = cleaned.slice(m[0].length);
    newLine = `${before}📅 ${newDueDate} ${after}`;
  }

  newLine = newLine.replace(/  +/g, ' ').replace(/\s+$/, '');

  return { previousLine: line, newLine, newDueDate };
}

// ============================================================
// Update text + tags + (volitelně) dueDate + priority
// Tri-state: undefined = preserve, null = clear, value = set
// ============================================================

export type UpdateOptions = {
  dueDate?: string | null;
  priority?: Priority | null;
  id?: string | null;
  blockedBy?: string[];
};

export type UpdateResult = {
  previousLine: string;
  newLine: string;
};

const DEPENDENCY_ID_RE = /^[A-Za-z0-9_-]+$/;

function insertBeforeDoneDate(line: string, token: string): string {
  const trimmedLine = line.trimEnd();
  const doneDate = /\s+✅\s*\d{4}-\d{2}-\d{2}\s*$/.exec(trimmedLine);
  if (!doneDate) return `${trimmedLine} ${token}`;
  return `${trimmedLine.slice(0, doneDate.index)} ${token}${doneDate[0]}`;
}

export function addIdToLine(line: string, id: string): UpdateResult {
  if (!DEPENDENCY_ID_RE.test(id)) throw new Error(`Invalid task ID: "${id}"`);
  const parsed = parseTaskLine(line, 0);
  if (!parsed) throw new Error(`Not a task line: "${line}"`);
  if (parsed.id) throw new Error('Task already has an ID');
  if (/🆔/.test(line)) {
    return { previousLine: line, newLine: line.replace(/🆔(?!\s*[A-Za-z0-9_-])/, `🆔 ${id}`) };
  }
  return { previousLine: line, newLine: insertBeforeDoneDate(line, `🆔 ${id}`) };
}

export function addBlockerIdToLine(line: string, id: string): UpdateResult {
  if (!DEPENDENCY_ID_RE.test(id)) throw new Error(`Invalid blocker ID: "${id}"`);
  const parsed = parseTaskLine(line, 0);
  if (!parsed) throw new Error(`Not a task line: "${line}"`);
  if (parsed.blockedBy.includes(id)) {
    return { previousLine: line, newLine: line };
  }

  if (/⛔/.test(line) && !/⛔\s*[A-Za-z0-9_-]/.test(line)) {
    return { previousLine: line, newLine: line.replace(/⛔/, `⛔ ${id}`) };
  }

  const blockerList = /⛔\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)/.exec(line);
  if (blockerList) {
    const insertAt = blockerList.index + blockerList[0].length;
    return {
      previousLine: line,
      newLine: `${line.slice(0, insertAt)},${id}${line.slice(insertAt)}`,
    };
  }
  return { previousLine: line, newLine: insertBeforeDoneDate(line, `⛔ ${id}`) };
}

export function removeBlockerIdFromLine(line: string, id: string): UpdateResult {
  if (!DEPENDENCY_ID_RE.test(id)) throw new Error(`Invalid blocker ID: "${id}"`);
  const parsed = parseTaskLine(line, 0);
  if (!parsed) throw new Error(`Not a task line: "${line}"`);
  if (!parsed.blockedBy.includes(id)) return { previousLine: line, newLine: line };
  const blockerList = /⛔\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)/.exec(line);
  if (!blockerList) return { previousLine: line, newLine: line };
  const entries = [...blockerList[1].matchAll(/[A-Za-z0-9_-]+/g)];
  const removed = entries.find((entry) => entry[0] === id);
  if (!removed || removed.index === undefined) return { previousLine: line, newLine: line };
  const valueStart = blockerList.index + blockerList[0].indexOf(blockerList[1]);
  const absoluteStart = valueStart + removed.index;
  const nextComma = /\s*,\s*/.exec(line.slice(absoluteStart + id.length, blockerList.index + blockerList[0].length));
  const previousText = line.slice(valueStart, absoluteStart);
  const previousComma = /\s*,\s*$/.exec(previousText);
  let start = absoluteStart;
  let end = absoluteStart + id.length;
  if (nextComma) end += nextComma.index + nextComma[0].length;
  else if (previousComma) start -= previousComma[0].length;
  else {
    start = blockerList.index;
    while (start > 0 && line[start - 1] === ' ') start--;
  }
  return { previousLine: line, newLine: line.slice(0, start) + line.slice(end) };
}

export function updateLineTextAndTags(
  line: string,
  newText: string,
  newContextTags: string[],
  options: UpdateOptions = {},
): UpdateResult {
  const parsed = parseTaskLine(line, 0);
  if (!parsed) throw new Error(`Not a task line: "${line}"`);

  const indentMatch = /^(\s*)-\s+\[/.exec(line);
  const indent = indentMatch?.[1] ?? '';

  // Normalize tags: trim, drop empty, prepend #, dedupe case-insensitive
  const seen = new Set<string>();
  const normalizedTags: string[] = [];
  const tagsRemainingInText = new Set(
    (newText.match(/#[\p{L}\p{N}_-]+/gu) ?? []).map((tag) => tag.toLowerCase()),
  );
  for (const raw of newContextTags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    const key = withHash.toLowerCase();
    if (seen.has(key) || tagsRemainingInText.has(key)) continue;
    seen.add(key);
    normalizedTags.push(withHash);
  }

  // Tri-state resolution
  const effectiveDueDate =
    options.dueDate === undefined ? parsed.dueDate ?? null : options.dueDate;
  const effectivePriority =
    options.priority === undefined ? parsed.priority ?? null : options.priority;
  const effectiveId = options.id === undefined ? parsed.id ?? null : options.id;
  const effectiveBlockedBy = options.blockedBy ?? parsed.blockedBy;

  if (effectiveDueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDueDate)) {
    throw new Error(`Invalid dueDate format: "${effectiveDueDate}"`);
  }

  // Zachováme původní status (` `, `/`, `x`, `-`, `>`, `<` …) — update se
  // týká jen textu/tagů/datumů/priority, ne checkbox stavu.
  const statusChar = parsed.status;
  const quadrantPart = parsed.quadrant === 'OPEN' ? '' : `#${parsed.quadrant} `;
  const tagsPart = normalizedTags.length > 0 ? normalizedTags.join(' ') + ' ' : '';
  const priorityPart = effectivePriority ? `${PRIORITY_EMOJI[effectivePriority]} ` : '';
  const duePart = effectiveDueDate ? `📅 ${effectiveDueDate} ` : '';
  const startPart = parsed.startDate ? `🛫 ${parsed.startDate} ` : '';
  const text = newText.trim();
  const trailingPart =
    parsed.trailingTokens.length > 0 ? ` ${parsed.trailingTokens.join(' ')}` : '';
  const idPart = effectiveId ? ` 🆔 ${effectiveId}` : '';
  const blockedByPart =
    effectiveBlockedBy.length > 0 ? ` ⛔ ${effectiveBlockedBy.join(',')}` : '';
  const donePart = parsed.doneDate ? ` ✅ ${parsed.doneDate}` : '';

  const body = `${quadrantPart}${tagsPart}${priorityPart}${duePart}${startPart}${text}${trailingPart}${idPart}${blockedByPart}${donePart}`
    .replace(/  +/g, ' ')
    .replace(/\s+$/, '');
  const newLine = `${indent}- [${statusChar}] ${body}`;

  return { previousLine: line, newLine };
}

// ============================================================
// Append nový task pod konfigurovatelnou sekci (full-content op)
// ============================================================

export type AppendResult = {
  newContent: string;
  lineIndex: number;
  newLine: string;
};

/**
 * Příjme celý obsah daily souboru, vrátí nový obsah s vloženým taskem.
 * Pokud sekční heading (`sectionHeading`, např. `# Today`) chybí, vloží ho
 * hned za frontmatter.
 */
export function appendTaskUnderHeading(
  content: string,
  sectionHeading: string,
  text: string,
  quadrant: Quadrant,
  todayISO: string,
  dueDate?: string | null,
  priority?: Priority | null,
  status: string = ' ',
  id?: string,
  blockedBy: string[] = [],
): AppendResult {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const headingNorm = sectionHeading.trim().toLowerCase();

  let dnesIdx = lines.findIndex(
    (l) => /^#+\s/.test(l) && l.trim().toLowerCase() === headingNorm,
  );
  if (dnesIdx === -1) {
    const fmEnd = findFrontmatterEnd(lines);
    const insertAt = fmEnd + 1;
    lines.splice(insertAt, 0, '', sectionHeading.trim(), '');
    dnesIdx = insertAt + 1;
  }

  // Najdi pozici za posledním taskem v sekci, nebo hned za heading.
  let insertAt = dnesIdx + 1;
  for (let i = dnesIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#+\s/.test(l)) break;
    if (/^---\s*$/.test(l)) break;
    if (/^\s*-\s+\[[^\]]\]/.test(l)) {
      insertAt = i + 1;
    }
  }

  const newLine = buildTaskLine(
    quadrant,
    text,
    todayISO,
    dueDate,
    priority,
    status,
    id,
    blockedBy,
  );
  lines.splice(insertAt, 0, newLine);

  return {
    newContent: lines.join(eol),
    lineIndex: insertAt,
    newLine,
  };
}

function findFrontmatterEnd(lines: string[]): number {
  if (!FRONTMATTER_END_RE.test(lines[0] ?? '')) return -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_END_RE.test(lines[i])) return i;
  }
  return -1;
}

// ============================================================
// Aplikuj transformaci na konkrétní řádek v celém obsahu souboru
// ============================================================

/**
 * Helper: na řádku `lineIndex` v `content` zavolá `fn` s tím řádkem
 * a nahradí jeho výstupem. Zachovává EOL stylu (CRLF / LF) původního souboru.
 */
export function transformLineInContent(
  content: string,
  lineIndex: number,
  fn: (line: string) => string,
): string {
  const parts = content.split(/(\r?\n)/);
  const lineOffsets: number[] = [];
  for (let index = 0; index < parts.length; index += 2) lineOffsets.push(index);

  if (lineIndex < 0 || lineIndex >= lineOffsets.length) {
    throw new Error(`lineIndex ${lineIndex} out of range (0..${lineOffsets.length - 1})`);
  }

  const partIndex = lineOffsets[lineIndex];
  parts[partIndex] = fn(parts[partIndex]);
  return parts.join('');
}
