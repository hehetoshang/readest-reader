import { expect, it, vi } from 'vitest';
import { type FoliateView, wrappedFoliateView } from '@/types/view';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const createView = (announceNavigation?: (generation: number) => void) => {
  const view = Object.assign(document.createElement('div'), {
    init: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
    goTo: vi.fn(async (_target: string | number) => {}),
    goToFraction: vi.fn(async (_fraction: number) => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    close: vi.fn(),
    addAnnotation: vi.fn(),
    history: { back: vi.fn(), forward: vi.fn() },
  });
  return {
    original: { ...view },
    view: wrappedFoliateView(view as unknown as FoliateView, announceNavigation),
  };
};

it('orders overlapping, repeated and mixed navigation behind initialization', async () => {
  const { original, view } = createView();
  const initialized = deferred(),
    slow = deferred();
  const calls: (string | number)[] = [];
  original.init.mockImplementation(() => initialized.promise);
  original.goTo.mockImplementation(async (target) => {
    calls.push(target);
    if (target === 'slow') await slow.promise;
  });
  original.next.mockImplementation(async () => {
    calls.push('next');
  });
  const init = view.init({ lastLocation: 'initial' });
  const tasks = [view.goTo('slow'), view.goTo('latest'), view.goTo('latest'), view.next()];
  expect(calls).toEqual([]);
  initialized.resolve();
  await init;
  await vi.waitFor(() => expect(calls).toEqual(['slow']));
  slow.resolve();
  await Promise.all(tasks);
  expect(calls).toEqual(['slow', 'latest', 'latest', 'next']);
});

it('returns a failed operation to its caller and keeps subsequent navigation usable', async () => {
  const { original, view } = createView();
  original.goTo.mockRejectedValueOnce(new Error('document failed'));
  const failed = view.goTo('failed');
  const next = view.goTo('valid');
  await expect(failed).rejects.toThrow('document failed');
  await next;
  expect(original.goTo).toHaveBeenNthCalledWith(2, 'valid');
});

it('distinguishes automatic initial positioning and canceled restores from new reading actions', async () => {
  const { view } = createView();
  await view.init({ lastLocation: 'saved' });
  await view.goToFraction(0, { initial: true });
  expect(view.hasUserNavigation).toBe(false);
  const ignoreDuplicate = (event: Event) => event.preventDefault();
  view.addEventListener('navigate-start', ignoreDuplicate);
  await view.goTo('saved');
  expect(view.hasUserNavigation).toBe(false);
  view.removeEventListener('navigate-start', ignoreDuplicate);
  await view.goToFraction(0);
  expect(view.hasUserNavigation).toBe(true);
});

it('settles queued callers on close without starting another document load', async () => {
  const { original, view } = createView();
  const slow = deferred();
  original.goTo.mockImplementation(() => slow.promise);
  const first = view.goTo('slow');
  const second = view.goTo('canceled');
  await vi.waitFor(() => expect(original.goTo).toHaveBeenCalledTimes(1));
  view.close();
  await Promise.all([first, second]);
  expect(original.close).toHaveBeenCalledOnce();
  slow.resolve();
  await Promise.resolve();
  expect(original.goTo).toHaveBeenCalledTimes(1);
});

it('does not relabel a slow old navigation or let a new turn enter the close drain', async () => {
  const announce = vi.fn();
  const { original, view } = createView(announce);
  const slow = deferred();
  const rendered: (number | null | undefined)[] = [];
  original.goTo.mockImplementation(async (target) => {
    if (target === 'slow') await slow.promise;
    rendered.push(view.getNavigationGeneration?.());
  });
  const first = view.goTo('slow');
  await vi.waitFor(() => expect(original.goTo).toHaveBeenCalledWith('slow'));
  const final = view.goTo('last accepted intent');
  const closing = view.finishNavigation?.();
  await view.goTo('after close');
  slow.resolve();
  await Promise.all([first, final, closing]);
  expect(announce.mock.calls).toEqual([[2], [3]]);
  expect(rendered).toEqual([null, 3]);
});
