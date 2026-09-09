import { beforeEach, describe, expect, it, vi } from 'vitest';

import { graphLinkRoles } from '../src/core/graphLinks.ts';
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

  it('links tasks by changing exactly two lines and preserving field order', async () => {
    const sourceRaw = '- [ ] #DO Source 📅 2026-09-10';
    const targetRaw = '- [ ] #DO Target ✅ 2026-09-08';
    const { app, contents } = createApp({ 'source.md': `keep\n${sourceRaw}`, 'target.md': `${targetRaw}\nkeep` });
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const result = await new ObsidianTaskRepo(app as never).linkTasks(task(sourceRaw, 'source.md', 1), task(targetRaw, 'target.md'));
    expect(contents.get('source.md')).toBe(`keep\n${sourceRaw} 🆔 ${result.id}`);
    expect(contents.get('target.md')).toBe(`- [ ] #DO Target ⛔ ${result.id} ✅ 2026-09-08\nkeep`);
  });

  it('writes the blocker marker to the opposite row when dragging from the opposite port', async () => {
    const sourceRaw = '- [ ] Source 🆔 source-id';
    const targetRaw = '- [ ] Target 🆔 target-id';

    for (const [port, blockedFile, blockerId] of [
      ['top', 'target.md', 'source-id'],
      ['bottom', 'source.md', 'target-id'],
    ] as const) {
      const { app, contents } = createApp({ 'source.md': sourceRaw, 'target.md': targetRaw });
      const draggedTask = task(sourceRaw, 'source.md');
      const targetTask = task(targetRaw, 'target.md');
      const roles = graphLinkRoles(port, draggedTask, targetTask);
      await new ObsidianTaskRepo(app as never).linkTasks(roles.blocker, roles.blocked);
      expect(contents.get(blockedFile), `${port} port`).toContain(`⛔ ${blockerId}`);
    }
  });

  it('rolls back the source when the target write fails', async () => {
    const sourceRaw = '- [ ] Source', targetRaw = '- [ ] Target';
    const { app, contents, process } = createApp({ 'source.md': sourceRaw, 'target.md': targetRaw });
    process.mockImplementationOnce(async (file: MockFile, transform: (content: string) => string) => { contents.set(file.path, transform(contents.get(file.path)!)); })
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementationOnce(async (file: MockFile, transform: (content: string) => string) => { contents.set(file.path, transform(contents.get(file.path)!)); });
    const repo = new ObsidianTaskRepo(app as never);
    await expect(repo.linkTasks(task(sourceRaw, 'source.md'), task(targetRaw, 'target.md'))).rejects.toThrow('Could not update the linked task in target.md');
    expect(contents.get('source.md')).toBe(sourceRaw);
    expect(contents.get('target.md')).toBe(targetRaw);
  });

  it('removes one dependency but keeps the blocker id', async () => {
    const sourceRaw = '- [ ] Source 🆔 em-source', targetRaw = '- [ ] Target ⛔ other,em-source';
    const { app, contents } = createApp({ 'source.md': sourceRaw, 'target.md': targetRaw });
    await new ObsidianTaskRepo(app as never).unlinkTasks(task(sourceRaw, 'source.md'), task(targetRaw, 'target.md'));
    expect(contents.get('source.md')).toBe(sourceRaw);
    expect(contents.get('target.md')).toBe('- [ ] Target ⛔ other');
  });

  it('ensureTaskId changes only the task line and preserves its byte order', async () => {
    const raw = '- [ ] #DO 📅 2026-09-10 ⏫ Call #Petr';
    const content = `before\n${raw}\nafter`;
    const { app, contents, process } = createApp({ 'task.md': content });
    const repo = new ObsidianTaskRepo(app as never);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

    const result = await repo.ensureTaskId(task(raw, 'task.md', 1));

    expect(result.newLine.replace(` 🆔 ${result.id}`, '')).toBe(raw);
    expect(contents.get('task.md')?.split('\n')).toEqual(['before', result.newLine, 'after']);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('ensureTaskId returns an existing id without writing', async () => {
    const raw = '- [ ] task 🆔 existing';
    const { app, process } = createApp({ 'task.md': raw });
    const repo = new ObsidianTaskRepo(app as never);

    await expect(repo.ensureTaskId(task(raw, 'task.md')))
      .resolves.toEqual({ id: 'existing', newLine: raw });
    expect(process).not.toHaveBeenCalled();
  });

  it('ensureTaskId rejects a stale raw line without changing the file', async () => {
    const stale = task('- [ ] Original', 'task.md');
    const changed = '- [ ] Changed elsewhere';
    const { app, contents } = createApp({ 'task.md': changed });
    const repo = new ObsidianTaskRepo(app as never);

    await expect(repo.ensureTaskId(stale)).rejects.toThrow('Task changed before save');
    expect(contents.get('task.md')).toBe(changed);
  });

  it('ensureTaskId generates against ids from the latest scan', async () => {
    const ownRaw = '- [ ] Own';
    const existingRaw = '- [ ] Existing 🆔 em-4fzzzxjy';
    const { app, contents } = createApp({ 'own.md': ownRaw, 'existing.md': existingRaw });
    const repo = new ObsidianTaskRepo(app as never);
    const { tasks } = await repo.getMatrixTasks('2026-09-08');
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);

    const result = await repo.ensureTaskId(tasks.find((entry) => entry.sourceFile === 'own.md')!);

    expect(result.id).toBe('em-zk00000y');
    expect(parseTaskLine(contents.get('own.md') ?? '', 0)?.id).toBe(result.id);
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

  it('adds a blocker task and surgically links the target', async () => {
    const targetRaw = '- [ ] #DO Ship 📅 2026-09-10';
    const { app, contents } = createApp({ 'target.md': targetRaw, '2026-09-08.md': '# Today\n' });
    const repo = new ObsidianTaskRepo(app as never);
    const result = await repo.addLinkedTask('2026-09-08', { text: '#Project Prepare', quadrant: 'DO', dueDate: null, priority: null }, { kind: 'blocker', target: task(targetRaw, 'target.md') });
    expect(result.newId).toMatch(/^em-/);
    expect(parseTaskLine(contents.get('target.md')!, 0)?.blockedBy).toEqual([result.newId]);
    expect(parseTaskLine(result.newLine, result.lineIndex)?.id).toBe(result.newId);
  });

  it('adds a dependent and gives an id to an id-less target', async () => {
    const targetRaw = '- [ ] #DECIDE Design';
    const { app, contents } = createApp({ 'target.md': targetRaw, '2026-09-08.md': '# Today\n' });
    const repo = new ObsidianTaskRepo(app as never);
    const result = await repo.addLinkedTask('2026-09-08', { text: 'Implement', quadrant: 'DECIDE', dueDate: null, priority: null }, { kind: 'dependent', target: task(targetRaw, 'target.md') });
    const targetId = parseTaskLine(contents.get('target.md')!, 0)?.id;
    expect(targetId).toMatch(/^em-/);
    expect(parseTaskLine(result.newLine, result.lineIndex)?.blockedBy).toEqual([targetId]);
  });

  it('rolls back a linked target when appending the new task fails', async () => {
    const targetRaw = '- [ ] #DO Ship';
    const { app, contents, process } = createApp({ 'target.md': targetRaw, '2026-09-08.md': '# Today\n' });
    process.mockImplementationOnce(async (file: MockFile, transform: (content: string) => string) => {
      contents.set(file.path, transform(contents.get(file.path)!));
    }).mockRejectedValueOnce(new Error('append failed'))
      .mockImplementationOnce(async (file: MockFile, transform: (content: string) => string) => {
      contents.set(file.path, transform(contents.get(file.path)!));
    });
    const repo = new ObsidianTaskRepo(app as never);
    await expect(repo.addLinkedTask('2026-09-08', { text: 'Prepare', quadrant: 'DO', dueDate: null, priority: null }, { kind: 'blocker', target: task(targetRaw, 'target.md') })).rejects.toThrow();
    expect(contents.get('target.md')).toBe(targetRaw);
    expect(process).toHaveBeenCalledTimes(3);
  });

  it('does not overwrite a target changed between append failure and rollback', async () => {
    const targetRaw = '- [ ] #DO Ship';
    const concurrent = `${targetRaw} ⛔ concurrent\nuser typed this meanwhile`;
    const { app, contents, process } = createApp({ 'target.md': targetRaw, '2026-09-08.md': '# Today\n' });
    process.mockImplementationOnce(async (file: MockFile, transform: (content: string) => string) => {
      contents.set(file.path, transform(contents.get(file.path)!));
    }).mockImplementationOnce(async () => {
      contents.set('target.md', concurrent);
      throw new Error('append failed');
    }).mockImplementationOnce(async (file: MockFile, transform: (content: string) => string) => {
      contents.set(file.path, transform(contents.get(file.path)!));
    });
    const repo = new ObsidianTaskRepo(app as never);
    await expect(repo.addLinkedTask('2026-09-08', { text: 'Prepare', quadrant: 'DO', dueDate: null, priority: null }, { kind: 'blocker', target: task(targetRaw, 'target.md') }))
      .rejects.toThrow('Rollback failed for target.md');
    expect(contents.get('target.md')).toBe(concurrent);
  });

  it('updates and appends in one process call when the target is in the daily file', async () => {
    const targetRaw = '- [ ] #DECIDE Design';
    const initial = `# Today\n${targetRaw}\n`;
    const { app, contents, process } = createApp({ '2026-09-08.md': initial });
    const repo = new ObsidianTaskRepo(app as never);
    const result = await repo.addLinkedTask('2026-09-08', { text: 'Implement', quadrant: 'DECIDE', dueDate: null, priority: null }, { kind: 'dependent', target: task(targetRaw, '2026-09-08.md', 1) });
    expect(process).toHaveBeenCalledTimes(1);
    expect(parseTaskLine(contents.get('2026-09-08.md')!.split('\n')[1], 1)?.id).toBeTruthy();
    expect(result.lineIndex).toBeGreaterThan(1);
  });

  it('adds an OPEN task with an id for manual cell placement', async () => {
    const { app } = createApp({ '2026-09-08.md': '# Today\n' });
    const repo = new ObsidianTaskRepo(app as never);
    const result = await repo.addTaskAtCell('2026-09-08', { text: '#Project New', quadrant: 'OPEN', dueDate: null, priority: null });
    expect(parseTaskLine(result.newLine, result.lineIndex)).toMatchObject({ id: result.newId, quadrant: 'OPEN' });
  });
});
