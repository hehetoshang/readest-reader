import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

let handlers: typeof import('@/app/reader/utils/iframeEventHandlers');
let messages: MockInstance<Window['postMessage']>;
const ref = (disabled = false) => ({ current: disabled });
function mouse(type: string, target?: HTMLElement, x = 100) {
  const event = new MouseEvent(type, { clientX: x, clientY: 100, screenX: x, screenY: 100 });
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
}
function touch(phase: 'Start' | 'Move' | 'End' | 'Cancel', key = 'book', x = 100, count = 1) {
  const point = { clientX: x, clientY: 100, screenX: x, screenY: 100 };
  const event = new Event(`touch${phase.toLowerCase()}`, { cancelable: true });
  Object.defineProperties(event, {
    touches: { value: phase === 'End' || phase === 'Cancel' ? [] : Array(count).fill(point) },
    changedTouches: { value: [point] },
    timeStamp: { value: Date.now() },
  });
  handlers[`handleTouch${phase}`](key, event as TouchEvent);
}
function click(key = 'book', disabled = false, target?: HTMLElement, x = 100) {
  handlers.handleClick(key, ref(disabled), false, mouse('click', target, x));
}
function mouseTap(hold: number, key = 'book', disabled = false) {
  handlers.handleMousedown(key, mouse('mousedown'));
  vi.advanceTimersByTime(hold);
  handlers.handleMouseup(key, mouse('mouseup'));
  click(key, disabled);
}
function posted(type: string) {
  return messages.mock.calls.filter(([message]) => message.type === type);
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  handlers = await import('@/app/reader/utils/iframeEventHandlers');
  messages = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('iframe click recognition at release', () => {
  it.each([false, true])('keeps a 300ms mouse press when double-click disabled=%s', (disabled) => {
    mouseTap(300, 'book', disabled);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(1);
  });

  it.each([
    false,
    true,
  ])('recognizes touch+click without compatibility mousedown, disabled=%s', (disabled) => {
    touch('Start');
    vi.advanceTimersByTime(300);
    touch('End');
    click('book', disabled);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(1);
  });

  it.each([
    false,
    true,
  ])('keeps compatibility mouse events to a single touch click, disabled=%s', (disabled) => {
    touch('Start');
    vi.advanceTimersByTime(300);
    touch('End');
    mouseTap(0, 'book', disabled);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(1);
  });

  it.each([false, true])('rejects a true mouse long press, disabled=%s', (disabled) => {
    mouseTap(600, 'book', disabled);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it.each([
    false,
    true,
  ])('rejects touch long press even with compatibility mouse events=%s', (compatibility) => {
    touch('Start');
    vi.advanceTimersByTime(600);
    touch('End');
    if (compatibility) mouseTap(0);
    else click();
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('does not fire a pending single click during a second press/drag', () => {
    mouseTap(10);
    vi.advanceTimersByTime(100);
    handlers.handleMousedown('book', mouse('mousedown'));
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('emits one double-click without delayed single clicks', () => {
    mouseTap(10);
    vi.advanceTimersByTime(100);
    mouseTap(10);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-double-click')).toHaveLength(1);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('cancels the pending single click even when both clicks share a clock millisecond', () => {
    mouseTap(0);
    mouseTap(0);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-double-click')).toHaveLength(1);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('does not share press or double-click state between books', () => {
    mouseTap(300, 'first');
    mouseTap(10, 'second');
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(2);
    expect(posted('iframe-double-click')).toHaveLength(0);
  });

  it('suppresses swipes, cancelled touches and multitouch clicks', () => {
    touch('Start');
    touch('Move', 'book', 200);
    touch('End', 'book', 200);
    click('book', true, undefined, 200);
    touch('Start', 'cancel');
    touch('Cancel', 'cancel');
    click('cancel', true);
    touch('Start', 'multi', 100, 2);
    touch('End', 'multi');
    click('multi', true);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('honors a late native layered-turn claim before delayed dispatch', () => {
    touch('Start');
    touch('End');
    click();
    handlers.setLayeredTurnTouchClaimed('book', true);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('cancels a pending click when its reader unmounts', () => {
    mouseTap(10);
    handlers.clearIframeClickState('book');
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('does not let a preceding short touch hide a mouse long press', () => {
    touch('Start');
    touch('End');
    mouseTap(600);
    vi.advanceTimersByTime(300);
    expect(posted('iframe-single-click')).toHaveLength(0);
  });

  it('keeps links out of pagination and opens images only for a short click', () => {
    const link = document.createElement('a');
    link.href = '#chapter';
    handlers.handleMousedown('book', mouse('mousedown', link));
    handlers.handleMouseup('book', mouse('mouseup', link));
    click('book', true, link);
    expect(posted('iframe-single-click')).toHaveLength(0);
    const image = document.createElement('img');
    image.src = 'data:image/png;base64,';
    handlers.handleMousedown('book', mouse('mousedown', image));
    handlers.handleMouseup('book', mouse('mouseup', image));
    click('book', true, image);
    expect(posted('iframe-open-media')).toHaveLength(1);
    touch('Start');
    vi.advanceTimersByTime(600);
    touch('End');
    click('book', true, image);
    vi.advanceTimersByTime(1);
    expect(posted('iframe-open-media')).toHaveLength(1);
  });
});
