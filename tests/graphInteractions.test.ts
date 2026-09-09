import { describe, expect, it } from 'vitest';
import { centeredScrollOffset, isGraphCanvasBackground } from '../src/core/graphInteractions.ts';

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

describe('graph centering', () => {
  it('aligns the canvas center with the viewport center', () => {
    const scrollWidth = 1600; const clientWidth = 600;
    const scrollLeft = centeredScrollOffset(scrollWidth, clientWidth);
    expect(scrollLeft + clientWidth / 2).toBe(scrollWidth / 2);
  });

  it('does not request negative scrolling when the canvas is smaller', () => {
    expect(centeredScrollOffset(400, 600)).toBe(0);
  });
});
