import { describe, expect, it } from 'vitest';

import { updateLineTextAndTags } from '../src/core/lineOps.ts';
import { parseTaskLine } from '../src/core/parser.ts';

describe('parser regressions from dependency cross-check round 2', () => {
  it('N1 keeps prose after a blocked-by id in the task title', () => {
    const parsed = parseTaskLine(
      '- [ ] #DO Send for review ⛔ draft1 please check before merge 📅 2026-01-01',
      0,
    );

    expect(parsed?.blockedBy).toEqual(['draft1']);
    expect(parsed?.text).toBe('Send for review please check before merge');
  });

  it.each([
    ['- [ ] Call 📞 Petr about the offer', 'Call 📞 Petr about the offer'],
    ['- [ ] Buy 🥛 milk today please', 'Buy 🥛 milk today please'],
  ])('N2 keeps an unlisted emoji in task text: %s', (line, expectedText) => {
    const parsed = parseTaskLine(line, 0);

    expect(parsed?.text).toBe(expectedText);
    expect(parsed?.trailingTokens).toEqual([]);
  });

  it('N2 preserves only explicitly supported Tasks metadata fields', () => {
    const parsed = parseTaskLine(
      '- [ ] Plan 🧩 future value ⏳ 2026-01-02 ➕ 2026-01-01 🔁 every week 🏁 keep ❌ 2026-01-03',
      0,
    );

    expect(parsed?.text).toBe('Plan 🧩 future value');
    expect(parsed?.trailingTokens).toEqual([
      '⏳ 2026-01-02',
      '➕ 2026-01-01',
      '🔁 every week',
      '🏁 keep',
      '❌ 2026-01-03',
    ]);
  });

  it('N3 strips and round-trips a bare id marker', () => {
    const original = '- [ ] #DO Draft 🆔 ⛔ x';
    const parsed = parseTaskLine(original, 0)!;

    expect(parsed.text).toBe('Draft');
    expect(parsed.id).toBeUndefined();
    expect(parsed.trailingTokens).toContain('🆔');

    const updated = updateLineTextAndTags(
      original,
      parsed.text,
      parsed.contextTags,
    ).newLine;
    expect(updated).toContain('🆔');
    expect(parseTaskLine(updated, 0)?.text).toBe('Draft');
  });
});
