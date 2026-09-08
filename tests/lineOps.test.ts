import { describe, expect, it } from 'vitest';
import {
  addBlockerIdToLine,
  addIdToLine,
  removeBlockerIdFromLine,
  appendTaskUnderHeading,
  buildTaskLine,
  moveLineQuadrant,
  setDueDateOnLine,
  setStatusOnLine,
  toggleLine,
  transformLineInContent,
  updateLineTextAndTags,
} from '../src/core/lineOps.ts';
import { parseTaskLine } from '../src/core/parser.ts';

describe('toggleLine', () => {
  it('unchecked → checked + ✅ today', () => {
    const r = toggleLine('- [ ] #DO hello', '2026-05-14');
    expect(r.checked).toBe(true);
    expect(r.newLine).toBe('- [x] #DO hello ✅ 2026-05-14');
  });
  it('checked → unchecked strips ✅', () => {
    const r = toggleLine('- [x] #DO done ✅ 2026-05-10', '2026-05-14');
    expect(r.checked).toBe(false);
    expect(r.newLine).toBe('- [ ] #DO done');
  });
  it('canceled [-] → toggle reopens to [ ]', () => {
    const r = toggleLine('- [-] #DO scratched', '2026-05-21');
    expect(r.checked).toBe(false);
    expect(r.newLine).toBe('- [ ] #DO scratched');
  });
  it('incomplete [/] → toggle marks done', () => {
    const r = toggleLine('- [/] #DO doing', '2026-05-21');
    expect(r.checked).toBe(true);
    expect(r.newLine).toBe('- [x] #DO doing ✅ 2026-05-21');
  });
  it('throws on non-task line', () => {
    expect(() => toggleLine('# Heading', '2026-05-14')).toThrow(/Not a task line/);
  });
});

describe('buildTaskLine', () => {
  it('DO with text only', () => {
    expect(buildTaskLine('DO', 'hello', '2026-05-14')).toBe(
      '- [ ] #DO 🛫 2026-05-14 hello',
    );
  });
  it('OPEN — no prefix tag', () => {
    expect(buildTaskLine('OPEN', 'capture', '2026-05-14')).toBe(
      '- [ ] 🛫 2026-05-14 capture',
    );
  });
  it('extracts leading context tags', () => {
    expect(buildTaskLine('DO', '#Osobní #Work test', '2026-05-14')).toBe(
      '- [ ] #DO #Osobní #Work 🛫 2026-05-14 test',
    );
  });
  it('with due date + priority', () => {
    expect(buildTaskLine('DO', 'urgent', '2026-05-14', '2026-05-20', 'highest')).toBe(
      '- [ ] #DO 🔺 📅 2026-05-20 🛫 2026-05-14 urgent',
    );
  });
  it('strips user-typed quadrant tags', () => {
    expect(buildTaskLine('OPEN', '#DO misplaced', '2026-05-14')).toBe(
      '- [ ] 🛫 2026-05-14 misplaced',
    );
  });
  it('builds with a non-default status ([/] in progress)', () => {
    expect(buildTaskLine('DO', 'doing', '2026-05-14', null, null, '/')).toBe(
      '- [/] #DO 🛫 2026-05-14 doing',
    );
  });
  it('builds done status [x] with ✅ today appended', () => {
    expect(buildTaskLine('DECIDE', 'finished', '2026-05-14', null, null, 'x')).toBe(
      '- [x] #DECIDE 🛫 2026-05-14 finished ✅ 2026-05-14',
    );
  });
});

describe('moveLineQuadrant', () => {
  it('replaces existing quadrant', () => {
    const r = moveLineQuadrant('- [ ] #DO #Work hello', 'DECIDE');
    expect(r.newLine).toBe('- [ ] #DECIDE #Work hello');
  });
  it('adds quadrant to OPEN task', () => {
    const r = moveLineQuadrant('- [ ] #Work hello', 'DELEGATE');
    expect(r.newLine).toBe('- [ ] #DELEGATE #Work hello');
  });
  it('removes quadrant when moving to OPEN', () => {
    const r = moveLineQuadrant('- [ ] #DO #Work hello', 'OPEN');
    expect(r.newLine).toBe('- [ ] #Work hello');
  });
});

describe('setStatusOnLine', () => {
  it('sets status to x adds ✅ today', () => {
    const r = setStatusOnLine('- [ ] #DO hello', 'x', '2026-05-21');
    expect(r.newLine).toBe('- [x] #DO hello ✅ 2026-05-21');
  });
  it('sets status to / and strips existing ✅', () => {
    const r = setStatusOnLine('- [x] #DO done ✅ 2026-05-10', '/', '2026-05-21');
    expect(r.newLine).toBe('- [/] #DO done');
  });
  it('sets status to - (canceled)', () => {
    const r = setStatusOnLine('- [ ] #DO nope', '-', '2026-05-21');
    expect(r.newLine).toBe('- [-] #DO nope');
  });
  it('accepts arbitrary single char like >', () => {
    const r = setStatusOnLine('- [ ] task', '>', '2026-05-21');
    expect(r.newLine).toBe('- [>] task');
  });
  it('throws on multi-char status', () => {
    expect(() => setStatusOnLine('- [ ] task', 'xx', '2026-05-21')).toThrow(/Invalid status/);
  });
});

describe('parseTaskLine — non-standard statuses', () => {
  it('parses [/] (incomplete) as not checked', () => {
    const p = parseTaskLine('- [/] #DO doing it', 0);
    expect(p).not.toBeNull();
    expect(p!.status).toBe('/');
    expect(p!.checked).toBe(false);
    expect(p!.text).toBe('doing it');
  });
  it('parses [-] (canceled) with status preserved', () => {
    const p = parseTaskLine('- [-] #DO scratch', 0);
    expect(p!.status).toBe('-');
    expect(p!.checked).toBe(false);
  });
  it('parses [>] (forwarded)', () => {
    const p = parseTaskLine('- [>] later', 0);
    expect(p!.status).toBe('>');
    expect(p!.checked).toBe(false);
  });
  it('parses [X] (uppercase done) as checked', () => {
    const p = parseTaskLine('- [X] capital done', 0);
    expect(p!.status).toBe('X');
    expect(p!.checked).toBe(true);
  });
});

describe('parseTaskLine — task metadata', () => {
  it('extracts id and a deduplicated blocked-by list from text', () => {
    const parsed = parseTaskLine('- [ ] #DO Draft proposal 🆔 draft-1 ⛔ brief, review_2,brief', 4);

    expect(parsed).toMatchObject({
      text: 'Draft proposal',
      id: 'draft-1',
      blockedBy: ['brief', 'review_2'],
      trailingTokens: [],
    });
  });

  it('defaults blockedBy and trailingTokens to empty arrays', () => {
    const parsed = parseTaskLine('- [ ] plain task', 0);

    expect(parsed?.blockedBy).toEqual([]);
    expect(parsed?.trailingTokens).toEqual([]);
  });
});

describe('setDueDateOnLine', () => {
  it('adds 📅 when none', () => {
    const r = setDueDateOnLine('- [ ] #DO hello', '2026-05-20');
    expect(r.newLine).toBe('- [ ] #DO 📅 2026-05-20 hello');
  });
  it('replaces existing 📅', () => {
    const r = setDueDateOnLine('- [ ] #DO 📅 2026-04-30 hello', '2026-05-20');
    expect(r.newLine).toBe('- [ ] #DO 📅 2026-05-20 hello');
  });
  it('removes 📅 when null', () => {
    const r = setDueDateOnLine('- [ ] #DO 📅 2026-04-30 hello', null);
    expect(r.newLine).toBe('- [ ] #DO hello');
  });
});

describe('updateLineTextAndTags', () => {
  it.each([
    '- [ ] #DO #Petr Call about X',
    '- [ ] #DO Call #Petr about X',
    '- [ ] #DO Call about X #Petr',
    '- [ ] #DO Call #pEtR about #Petr',
  ])('round-trips context tags without duplicating them: %s', (line) => {
    const parsed = parseTaskLine(line, 0)!;

    expect(
      updateLineTextAndTags(line, parsed.text, parsed.contextTags).newLine,
    ).toBe(line);
  });

  it('updates text + tags, preserves other parts', () => {
    const r = updateLineTextAndTags(
      '- [x] #DO #Work 📅 2026-05-20 🛫 2026-05-10 Send report ✅ 2026-05-15',
      'Send weekly report',
      ['#Urgent'],
    );
    expect(r.newLine).toBe(
      '- [x] #DO #Urgent 📅 2026-05-20 🛫 2026-05-10 Send weekly report ✅ 2026-05-15',
    );
  });

  it('tri-state dueDate: undefined preserves', () => {
    const r = updateLineTextAndTags(
      '- [ ] #DO 📅 2026-05-20 hello',
      'hello',
      [],
      {},
    );
    expect(r.newLine).toBe('- [ ] #DO 📅 2026-05-20 hello');
  });
  it('tri-state dueDate: null clears', () => {
    const r = updateLineTextAndTags(
      '- [ ] #DO 📅 2026-05-20 hello',
      'hello',
      [],
      { dueDate: null },
    );
    expect(r.newLine).toBe('- [ ] #DO hello');
  });
  it('tri-state dueDate: value sets', () => {
    const r = updateLineTextAndTags(
      '- [ ] #DO hello',
      'hello',
      [],
      { dueDate: '2026-05-25' },
    );
    expect(r.newLine).toBe('- [ ] #DO 📅 2026-05-25 hello');
  });

  it('tri-state priority: set', () => {
    const r = updateLineTextAndTags(
      '- [ ] #DO hello',
      'hello',
      [],
      { priority: 'high' },
    );
    expect(r.newLine).toBe('- [ ] #DO ⏫ hello');
  });
  it('tri-state priority: clear', () => {
    const r = updateLineTextAndTags(
      '- [ ] #DO ⏫ hello',
      'hello',
      [],
      { priority: null },
    );
    expect(r.newLine).toBe('- [ ] #DO hello');
  });

  it('normalizes tags (prepend #, dedupe)', () => {
    const r = updateLineTextAndTags(
      '- [ ] #DO hello',
      'hello',
      ['Osobní', '#osobní', '#Work'],
    );
    expect(r.newLine).toBe('- [ ] #DO #Osobní #Work hello');
  });

  it('round-trips dependency metadata and named Tasks tokens', () => {
    const original =
      '- [ ] #DO 📅 2026-06-01 🛫 2026-05-10 Send draft ⏳ 2026-05-20 ➕ 2026-05-01 🔁 every week 🏁 keep ❌ 2026-05-30 🧩 future value 🆔 draft1 ⛔ brief,review,brief';
    const parsedBefore = parseTaskLine(original, 0)!;
    const updated = updateLineTextAndTags(
      original,
      parsedBefore.text,
      parsedBefore.contextTags,
    ).newLine;
    const parsedAfter = parseTaskLine(updated, 0)!;

    expect(parsedAfter.id).toBe(parsedBefore.id);
    expect(parsedAfter.blockedBy).toEqual(parsedBefore.blockedBy);
    expect(parsedAfter.trailingTokens).toEqual(parsedBefore.trailingTokens);
    expect(parsedAfter.trailingTokens).toEqual([
      '⏳ 2026-05-20',
      '➕ 2026-05-01',
      '🔁 every week',
      '🏁 keep',
      '❌ 2026-05-30 🧩 future value',
    ]);
  });

  it('can replace dependency metadata while preserving the rest of the task', () => {
    const updated = updateLineTextAndTags(
      '- [ ] #DO Draft 🆔 old-id ⛔ first,second',
      'Draft',
      [],
      { id: 'new-id', blockedBy: ['third'] },
    ).newLine;

    expect(updated).toBe('- [ ] #DO Draft 🆔 new-id ⛔ third');
  });

  it('builds a task line with preserved metadata before the done date', () => {
    expect(
      buildTaskLine(
        'DO',
        'finished',
        '2026-05-14',
        null,
        null,
        'x',
        'task-1',
        ['blocker_a', 'blocker-b'],
        ['⏳ 2026-05-15'],
      ),
    ).toBe(
      '- [x] #DO 🛫 2026-05-14 finished ⏳ 2026-05-15 🆔 task-1 ⛔ blocker_a,blocker-b ✅ 2026-05-14',
    );
  });
});

describe('appendTaskUnderHeading', () => {
  it('round-trips id and blockers in a newly appended task', () => {
    const result = appendTaskUnderHeading(
      '# Today\n', '# Today', 'linked', 'OPEN', '2026-09-08', null, null, ' ',
      'task-1', ['blocker-a', 'blocker_b'],
    );

    expect(parseTaskLine(result.newLine, result.lineIndex)).toMatchObject({
      id: 'task-1',
      blockedBy: ['blocker-a', 'blocker_b'],
    });
  });

  it('inserts after existing tasks under # Dnes', () => {
    const content = [
      '---',
      'date: 2026-05-14',
      '---',
      '',
      '# Dnes',
      '- [ ] #DO existing',
      '',
      '## Other',
    ].join('\n');
    const r = appendTaskUnderHeading(content, '# Dnes', 'new task', 'DECIDE', '2026-05-14');
    expect(r.lineIndex).toBe(6);
    const lines = r.newContent.split('\n');
    expect(lines[5]).toBe('- [ ] #DO existing');
    expect(lines[6]).toBe('- [ ] #DECIDE 🛫 2026-05-14 new task');
  });

  it('creates # Dnes when missing', () => {
    const content = [
      '---',
      'date: 2026-05-14',
      '---',
      '',
      '# Notes',
      'text',
    ].join('\n');
    const r = appendTaskUnderHeading(content, '# Dnes', 'fresh', 'DO', '2026-05-14');
    expect(r.newContent).toContain('# Dnes');
    expect(r.newContent).toContain('- [ ] #DO 🛫 2026-05-14 fresh');
  });
});

describe('surgical dependency metadata', () => {
  it('adds an id at the end without changing any preceding byte', () => {
    const line = '- [ ] #DO 📅 2026-09-10 ⏫ 🛫 2026-09-08 ⏳ later 🔁 weekly Task  ';
    const result = addIdToLine(line, 'x');
    expect(result.newLine.replace(' 🆔 x', '')).toBe(line.trimEnd());
    expect(parseTaskLine(result.newLine, 0)?.id).toBe('x');
  });

  it('adds an id before a done date', () => {
    expect(addIdToLine('- [x] done ✅ 2026-09-08', 'x').newLine)
      .toBe('- [x] done 🆔 x ✅ 2026-09-08');
  });

  it('rejects invalid targets, duplicate ids, and invalid ids', () => {
    expect(() => addIdToLine('heading', 'x')).toThrow(/Not a task/);
    expect(() => addIdToLine('- [ ] task 🆔 old', 'x')).toThrow(/already/);
    expect(() => addIdToLine('- [ ] task', 'bad id')).toThrow(/Invalid/);
  });

  it('replaces a bare id marker in place', () => {
    const line = '- [ ] task 🆔';
    const result = addIdToLine(line, 'x').newLine;
    expect(result).toBe('- [ ] task 🆔 x');
    expect(parseTaskLine(result, 0)?.id).toBe('x');
  });

  it('extends blockers, inserts blockers, and is idempotent', () => {
    expect(addBlockerIdToLine('- [ ] task ⛔ a', 'x').newLine).toBe('- [ ] task ⛔ a,x');
    const inserted = addBlockerIdToLine('- [x] task ✅ 2026-09-08', 'x').newLine;
    expect(inserted).toBe('- [x] task ⛔ x ✅ 2026-09-08');
    expect(addBlockerIdToLine(inserted, 'x').newLine).toBe(inserted);
    expect(parseTaskLine(addBlockerIdToLine('- [ ] task ⛔ a', 'x').newLine, 0)?.blockedBy)
      .toEqual(['a', 'x']);
  });

  it('replaces a bare blocker marker in place', () => {
    const result = addBlockerIdToLine('- [ ] task ⛔', 'x').newLine;
    expect(result).toBe('- [ ] task ⛔ x');
    expect(parseTaskLine(result, 0)?.blockedBy).toEqual(['x']);
  });

  it('removes one blocker without removing an orphaned task id', () => {
    expect(removeBlockerIdFromLine('- [ ] task 🆔 own ⛔ a,b ✅ 2026-09-08', 'a').newLine).toBe('- [ ] task 🆔 own ⛔ b ✅ 2026-09-08');
    expect(removeBlockerIdFromLine('- [ ] task 🆔 own ⛔ a ✅ 2026-09-08', 'a').newLine).toBe('- [ ] task 🆔 own ✅ 2026-09-08');
    expect(removeBlockerIdFromLine('- [ ] task  ⛔ a,  b , c  tail', 'b').newLine).toBe('- [ ] task  ⛔ a,  c  tail');
  });
});

describe('transformLineInContent', () => {
  it('replaces target line, preserves rest', () => {
    const content = ['# Dnes', '- [ ] #DO a', '- [ ] #DO b'].join('\n');
    const out = transformLineInContent(content, 1, (l) =>
      toggleLine(l, '2026-05-14').newLine,
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('# Dnes');
    expect(lines[1]).toBe('- [x] #DO a ✅ 2026-05-14');
    expect(lines[2]).toBe('- [ ] #DO b');
  });
  it('preserves CRLF when present', () => {
    const content = ['- [ ] #DO a', '- [ ] #DO b'].join('\r\n');
    const out = transformLineInContent(content, 0, (l) =>
      toggleLine(l, '2026-05-14').newLine,
    );
    expect(out.includes('\r\n')).toBe(true);
  });
  it('preserves every original line ending in a mixed-EOL file', () => {
    const content = 'a\nb\r\nc\n- [ ] task\r\n';
    expect(transformLineInContent(content, 3, (line) => `${line} 🆔 x`))
      .toBe('a\nb\r\nc\n- [ ] task 🆔 x\r\n');
  });
});
