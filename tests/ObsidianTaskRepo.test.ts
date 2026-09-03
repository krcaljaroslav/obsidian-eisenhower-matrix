import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTaskLine } from '../src/core/parser.ts';
import type { Task } from '../src/core/types.ts';
import { ObsidianTaskRepo } from '../src/obsidian-adapter/ObsidianTaskRepo.ts';

type MockFile = { path: string; name: string; parent: { path: string } | null };

function task(raw: string, sourceFile: string, lineIndex = 0): Task {
  const parsed = parseTaskLine(raw, lineIndex);
  if (!parsed) throw new Error('Invalid test task');
  return {
    ...parsed,
    sourceFile,
    isFromDnes: false,
    isBlocked: false,
    blockedByTasks: [],
    blocksTasks: [],
    missingBlockers: [],
    hasCircularDependency: false,
  };
}

function createApp(initial: Record<string, string>) {
  const contents = new Map(Object.entries(initial));
  const files = new Map<string, MockFile>();
  for (const path of contents.keys()) {
    files.set(path, { path, name: path.split('/').pop() ?? path, parent: null });
  }
  const process = vi.fn(async (file: MockFile, transform: (content: string) => string) => {
    const current = contents.get(file.path);
    if (current === undefined) throw new Error('Missing mock content');
    contents.set(file.path, transform(current));
  });
  const app = {
    vault: {
      getFileByPath: (path: string) => files.get(path) ?? null,
      getMarkdownFiles: () => [...files.values()],
      cachedRead: async (file: MockFile) => contents.get(file.path) ?? '',
      process,
    },
    workspace: { iterateAllLeaves: () => undefined },
  };
  return { app, contents, process };
}

describe('ObsidianTaskRepo dependency updates', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('adds ids and writes an After this dependency to both files', async () => {
    const ownRaw = '- [ ] #DO Draft';
    const linkedRaw = '- [ ] #DO Review';
    const own = task(ownRaw, 'draft.md');
    const linked = task(linkedRaw, 'review.md');
    const { app, contents, process } = createApp({
      'draft.md': ownRaw,
      'review.md': linkedRaw,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const repo = new ObsidianTaskRepo(app as never);

    await repo.updateTask(own, 'Draft revised', [], {}, {
      beforeTasks: [],
      afterTasks: [linked],
      missingBlockerIds: [],
    });

    const ownAfter = parseTaskLine(contents.get('draft.md') ?? '', 0);
    const linkedAfter = parseTaskLine(contents.get('review.md') ?? '', 0);
    expect(ownAfter?.text).toBe('Draft revised');
    expect(ownAfter?.id).toMatch(/^em-[a-z0-9]+$/);
    expect(linkedAfter?.blockedBy).toEqual([ownAfter?.id]);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('adds an id to a Before this task and references it from the edited task', async () => {
    const ownRaw = '- [ ] #DO Publish';
    const blockerRaw = '- [ ] #DO Legal review';
    const own = task(ownRaw, 'publish.md');
    const blocker = task(blockerRaw, 'legal.md');
    const { app, contents } = createApp({
      'publish.md': ownRaw,
      'legal.md': blockerRaw,
    });
    const repo = new ObsidianTaskRepo(app as never);

    await repo.updateTask(own, own.text, [], {}, {
      beforeTasks: [blocker],
      afterTasks: [],
      missingBlockerIds: [],
    });

    const ownAfter = parseTaskLine(contents.get('publish.md') ?? '', 0);
    const blockerAfter = parseTaskLine(contents.get('legal.md') ?? '', 0);
    expect(blockerAfter?.id).toMatch(/^em-[a-z0-9]+$/);
    expect(ownAfter?.blockedBy).toEqual([blockerAfter?.id]);
  });

  it('rejects a stale raw line before changing it', async () => {
    const staleTask = task('- [ ] #DO Original', 'task.md');
    const changed = '- [ ] #DO Changed elsewhere';
    const { app, contents } = createApp({ 'task.md': changed });
    const repo = new ObsidianTaskRepo(app as never);

    await expect(repo.updateTask(staleTask, 'My edit', [], {}, {
      beforeTasks: [],
      afterTasks: [],
      missingBlockerIds: [],
    })).rejects.toThrow('Task changed before save');
    expect(contents.get('task.md')).toBe(changed);
  });

  it('rolls back the own file when writing a linked file fails', async () => {
    const ownRaw = '- [ ] #DO Draft';
    const linkedRaw = '- [ ] #DO Review';
    const own = task(ownRaw, 'draft.md');
    const linked = task(linkedRaw, 'review.md');
    const { app, contents, process } = createApp({
      'draft.md': ownRaw,
      'review.md': linkedRaw,
    });
    process.mockImplementationOnce(async (file, transform) => {
      const current = contents.get(file.path) ?? '';
      contents.set(file.path, transform(current));
    }).mockRejectedValueOnce(new Error('disk error'))
      .mockImplementationOnce(async (file, transform) => {
        const current = contents.get(file.path) ?? '';
        contents.set(file.path, transform(current));
      });
    const repo = new ObsidianTaskRepo(app as never);

    await expect(repo.updateTask(own, own.text, [], {}, {
      beforeTasks: [],
      afterTasks: [linked],
      missingBlockerIds: [],
    })).rejects.toThrow('Could not update the linked task in review.md');
    expect(contents.get('draft.md')).toBe(ownRaw);
    expect(contents.get('review.md')).toBe(linkedRaw);
  });

  it('N4 rejects selecting the same task both before and after this one', async () => {
    const ownRaw = '- [ ] #DO Draft';
    const linkedRaw = '- [ ] #DO Review';
    const own = task(ownRaw, 'draft.md');
    const linked = task(linkedRaw, 'review.md');
    const { app, contents, process } = createApp({
      'draft.md': ownRaw,
      'review.md': linkedRaw,
    });
    const repo = new ObsidianTaskRepo(app as never);

    await expect(repo.updateTask(own, own.text, [], {}, {
      beforeTasks: [linked],
      afterTasks: [linked],
      missingBlockerIds: [],
    })).rejects.toThrow('A task cannot be both before and after this one');
    expect(process).not.toHaveBeenCalled();
    expect(contents.get('draft.md')).toBe(ownRaw);
    expect(contents.get('review.md')).toBe(linkedRaw);
  });

  it('generates ids against every id found by the latest vault scan', async () => {
    const ownRaw = '- [ ] #DO Draft';
    const linkedRaw = '- [ ] #DO Review';
    const existingRaw = '- [ ] #DO Existing 🆔 em-4fzzzxjy';
    const { app, contents } = createApp({
      'draft.md': ownRaw,
      'review.md': linkedRaw,
      'unrelated.md': existingRaw,
    });
    const repo = new ObsidianTaskRepo(app as never);
    const { tasks } = await repo.getMatrixTasks('2026-09-03');
    const own = tasks.find((candidate) => candidate.sourceFile === 'draft.md')!;
    const linked = tasks.find((candidate) => candidate.sourceFile === 'review.md')!;
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);

    await repo.updateTask(own, own.text, [], {}, {
      beforeTasks: [],
      afterTasks: [linked],
      missingBlockerIds: [],
    });

    expect(parseTaskLine(contents.get('draft.md') ?? '', 0)?.id).toBe('em-zk00000y');
  });
});
