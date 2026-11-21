import { afterEach, expect, it, vi } from 'vitest';
import { MokeHostLaunch, type ReaderInvoke } from '@/services/mokeHostLaunch';
import { installMokeManagedBack } from '@/services/mokeManagedBack';
import {
  claimFixture,
  deferred,
  launchFixture,
  localProgressFixture,
  reservation,
} from '../helpers/hostLaunchFixture';

const current = vi.hoisted(() => ({ launch: null as MokeHostLaunch | null }));
vi.mock('@/services/mokeHostLaunch', async (original) => ({
  ...(await original<typeof import('@/services/mokeHostLaunch')>()),
  getMokeHostLaunch: () => current.launch,
}));

const claim = claimFixture(undefined, localProgressFixture({ returnTarget: 'mobile-library' }));
const binding = [claim.launchId, claim.documentGeneration] as const;
const complete = reservation(claim, { phase: 'returned', completion: 'complete' });

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  current.launch = null;
});

it('reports readiness, then shares one close and bound return across requests and toolbar', async () => {
  const hostAck = deferred<typeof complete>();
  const invoke = vi.fn(() => hostAck.promise);
  const { launch, listening } = launchFixture(claim, invoke as ReaderInvoke);
  current.launch = launch;
  let ready = false;
  const prepare = vi.fn(async () => {});
  const navigate = vi.fn(async () => {});
  const close = () => launch.returnToLibrary(prepare, navigate);
  installMokeManagedBack(launch, () => ready, close);
  const back = window.__MOKE_MANAGED_BACK__!;

  expect(back.getState(...binding)).toBe('loading');
  expect(back.requestClose(...binding)).toBe('loading');
  ready = true;
  expect(back.getState(...binding)).toBe('ready');
  expect(back.requestClose(claim.launchId, claim.documentGeneration + 1)).toBe('stale');
  expect(back.requestClose(...binding)).toBe('accepted');
  expect(back.requestClose(...binding)).toBe('closing');
  const toolbarClose = close();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(navigate).not.toHaveBeenCalled();

  hostAck.resolve(complete);
  await toolbarClose;
  expect(prepare).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledOnce();
  expect(listening()).toBe(false);
  expect(back.requestClose(...binding)).toBe('closing');
});

it('blocks another return after an unconfirmed persistence result', async () => {
  const { launch } = launchFixture(claim);
  current.launch = launch;
  const prepare = vi.fn(async () => {
    throw new Error('persistence unconfirmed');
  });
  const navigate = vi.fn();
  const close = () => launch.returnToLibrary(prepare, navigate);
  installMokeManagedBack(launch, () => true, close);
  const back = window.__MOKE_MANAGED_BACK__!;

  expect(back.requestClose(...binding)).toBe('accepted');
  await expect(close()).rejects.toThrow('persistence unconfirmed');
  expect(back.requestClose(...binding)).toBe('blocked');
  expect(prepare).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

it('invalidates dispatch on teardown and ignores terminal ACKs for a destroyed document', async () => {
  const hostAck = deferred<typeof complete>();
  const invoke = vi.fn(() => hostAck.promise);
  const { launch, listening } = launchFixture(claim, invoke as ReaderInvoke);
  current.launch = launch;
  const navigate = vi.fn();
  const close = () => launch.returnToLibrary(undefined, navigate);
  const dispose = installMokeManagedBack(launch, () => true, close);
  const oldBack = window.__MOKE_MANAGED_BACK__!;
  expect(oldBack.requestClose(...binding)).toBe('accepted');
  const closing = close();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

  window.dispatchEvent(new Event('pagehide'));
  launch.markUnknown();
  expect(window.__MOKE_MANAGED_BACK__).toBeUndefined();
  expect(oldBack.requestClose(...binding)).toBe('stale');
  expect(listening()).toBe(false);
  const next = launchFixture({ ...claim, documentGeneration: claim.documentGeneration + 1 }).launch;
  current.launch = next;
  installMokeManagedBack(next, () => true, vi.fn());
  dispose();
  expect(window.__MOKE_MANAGED_BACK__!.requestClose(...binding)).toBe('stale');

  hostAck.resolve(complete);
  await expect(closing).rejects.toThrow('reader_launch_unknown');
  expect(navigate).not.toHaveBeenCalled();
});

it('removes a drain listener whose registration resolves after document destruction', async () => {
  const registering = deferred<() => void>();
  const unlisten = vi.fn();
  const invoke = vi.fn();
  const launch = new MokeHostLaunch(claim, invoke, () => registering.promise);
  const closing = launch.close();
  launch.markUnknown();
  registering.resolve(unlisten);
  await expect(closing).rejects.toThrow('reader_launch_unknown');
  expect(unlisten).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});
