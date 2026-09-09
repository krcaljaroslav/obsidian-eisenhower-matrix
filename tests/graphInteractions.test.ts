import { describe, expect, it } from 'vitest';
import { isGraphCanvasBackground } from '../src/core/graphInteractions.ts';

const target = (...classes: string[]) => ({
  classList: { contains: (name: string) => classes.includes(name) },
}) as unknown as EventTarget;

describe('graph pointer isolation', () => {
  it.each(['em-graph-viewport', 'em-graph-scaler', 'em-graph-canvas', 'em-graph-edges'])('allows panning from %s', (name) => {
    expect(isGraphCanvasBackground(target(name))).toBe(true);
  });

  it.each(['em-task', 'em-graph-port', 'em-graph-add-panel', 'em-add-input', 'em-btn-primary-accent'])('does not start canvas panning from %s', (name) => {
    expect(isGraphCanvasBackground(target(name))).toBe(false);
  });
});
