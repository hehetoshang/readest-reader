import { afterEach, describe, expect, it } from 'vitest';
import { applyEinkTurnAttributes, isReaderEink } from './einkTurn';

afterEach(() => {
  delete window.__MOKE_EINK;
});

describe('e-ink page turns', () => {
  it('honors the Moke host despite a saved book opting into animation', () => {
    window.__MOKE_EINK = true;
    const renderer = document.createElement('div');
    renderer.setAttribute('animated', '');
    const saved = { isEink: false, animated: true };
    applyEinkTurnAttributes(renderer, saved);
    expect(isReaderEink(saved)).toBe(true);
    expect(renderer.hasAttribute('animated')).toBe(false);
    expect(renderer.hasAttribute('eink')).toBe(true);
    expect(saved).toEqual({ isEink: false, animated: true });
  });

  it('disables animation for reader e-ink mode without a host override', () => {
    window.__MOKE_EINK = false;
    const renderer = document.createElement('div');
    applyEinkTurnAttributes(renderer, { isEink: true, animated: true });
    expect(renderer.hasAttribute('animated')).toBe(false);
    expect(renderer.hasAttribute('eink')).toBe(true);
  });

  it('restores LCD animation and removes a stale e-ink attribute', () => {
    const renderer = document.createElement('div');
    window.__MOKE_EINK = true;
    applyEinkTurnAttributes(renderer, { animated: true });
    window.__MOKE_EINK = false;
    applyEinkTurnAttributes(renderer, { isEink: false, animated: true });
    expect(renderer.hasAttribute('animated')).toBe(true);
    expect(renderer.hasAttribute('eink')).toBe(false);
    applyEinkTurnAttributes(renderer, { animated: false });
    expect(renderer.hasAttribute('animated')).toBe(false);
  });
});
