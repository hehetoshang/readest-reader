import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewSettings } from '@/types/book';
import type { FoliateView } from '@/types/view';

const mocks = vi.hoisted(() => ({
  mobile: true,
  interceptKeys: vi.fn<(request: { volumeKeys?: boolean }) => Promise<void>>(async () => undefined),
  saveViewSettings: vi.fn(),
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobileApp: mocks.mobile, isMobile: true } }),
}));
vi.mock('@/utils/bridge', () => ({
  interceptKeys: mocks.interceptKeys,
  getScreenBrightness: vi.fn(),
  setScreenBrightness: vi.fn(),
  refreshEinkScreen: vi.fn(),
}));
vi.mock('@/store/readerStore', async () => {
  const { create } = await import('zustand');
  type State = {
    viewStates: Record<string, { inited: boolean; viewSettings: ViewSettings }>;
    hoveredBookKey: string | null;
  };
  const store = create((set, get) => ({
    viewStates: {} as State['viewStates'],
    hoveredBookKey: null as string | null,
    getViewSettings: (key: string) => (get() as State).viewStates[key]?.viewSettings,
    getViewState: (key: string) => (get() as State).viewStates[key],
    setHoveredBookKey: (key: string | null) => set({ hoveredBookKey: key }),
  }));
  return { useReaderStore: store };
});
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData: () => ({ isFixedLayout: false }) }),
}));
vi.mock('@/store/settingsStore', () => {
  const state = { settings: { hardwarePageTurner: { enabled: false, bindings: {} } } };
  return {
    useSettingsStore: Object.assign(
      (selector?: (value: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});
vi.mock('@/app/reader/hooks/useTouchInterceptor', () => ({ useTouchInterceptor: vi.fn() }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/utils/window', () => ({ tauriGetWindowLogicalPosition: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
vi.mock('@/hooks/useResetSettings', () => ({ useResetViewSettings: () => vi.fn() }));
vi.mock('@/helpers/settings', () => ({
  saveViewSettings: mocks.saveViewSettings,
  saveSysSettings: vi.fn(),
}));
vi.mock('@/components/settings/primitives', () => ({
  BoxedList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSwitchRow: ({
    label,
    checked,
    onChange,
  }: {
    label: string;
    checked: boolean;
    onChange: () => void;
  }) => (
    <button aria-pressed={checked} onClick={onChange}>
      {label}
    </button>
  ),
}));

import { useReaderStore } from '@/store/readerStore';
import { useDeviceControlStore } from '@/store/deviceStore';
import { eventDispatcher } from '@/utils/event';
import { usePagination } from '@/app/reader/hooks/usePagination';
import PageTurnerSettings from '@/components/settings/PageTurnerSettings';

const initialSettings = () =>
  ({
    volumeKeysToFlip: true,
    disableClick: false,
    zoomLevel: 100,
    zoomMode: 'fit-page',
  }) as ViewSettings;
function setSettings(patch: Partial<ViewSettings>, bookKey = 'book') {
  const store = useReaderStore.getState();
  const previous = store.viewStates[bookKey];
  useReaderStore.setState({
    viewStates: {
      ...store.viewStates,
      [bookKey]: {
        ...previous,
        inited: true,
        viewSettings: { ...initialSettings(), ...previous?.viewSettings, ...patch },
      } as NonNullable<ReturnType<typeof store.getViewState>>,
    },
  });
}
function reader(bookKey = 'book', strict = false) {
  const view = { book: {}, renderer: { scrolled: false }, prev: vi.fn(), next: vi.fn() };
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  return {
    view,
    ...renderHook(
      () =>
        usePagination(bookKey, { current: view as unknown as FoliateView }, { current: container }),
      strict ? { wrapper: StrictMode } : undefined,
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = true;
  useReaderStore.setState({ viewStates: {}, hoveredBookKey: null });
  useDeviceControlStore.setState({ volumeKeysInterceptionCount: 0, volumeKeysIntercepted: false });
  setSettings({});
  mocks.saveViewSettings.mockImplementation((_env, key, field, value) =>
    setSettings({ [field]: value }, key),
  );
});
afterEach(cleanup);

describe('reader volume interception ownership', () => {
  it('reopening or toggling the settings panel never adds a second owner', () => {
    const hook = reader();
    for (let i = 0; i < 3; i++) {
      const panel = render(<PageTurnerSettings bookKey='book' />);
      expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(1);
      panel.unmount();
    }
    const panel = render(<PageTurnerSettings bookKey='book' />);
    fireEvent.click(screen.getByText('Use Volume Keys'));
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(0);
    fireEvent.click(screen.getByText('Use Volume Keys'));
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(1);
    panel.unmount();
    hook.unmount();
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(0);
    expect(mocks.interceptKeys.mock.calls.map(([request]) => request)).toEqual([
      { volumeKeys: true },
      { volumeKeys: false },
      { volumeKeys: true },
      { volumeKeys: false },
    ]);
  });

  it('responds to settings loaded after mount and to TTS play/pause/resume/stop', async () => {
    act(() => setSettings({ volumeKeysToFlip: false }));
    const hook = reader();
    expect(mocks.interceptKeys).not.toHaveBeenCalled();
    act(() => setSettings({ volumeKeysToFlip: true }));
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(1);
    for (const [state, expected] of [
      ['playing', 0],
      ['paused', 1],
      ['playing', 0],
      ['stopped', 1],
    ] as const) {
      await act(() => eventDispatcher.dispatch('tts-playback-state', { bookKey: 'book', state }));
      expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(expected);
    }
    await act(() =>
      eventDispatcher.dispatch('tts-playback-state', { bookKey: 'book', state: 'playing' }),
    );
    act(() => setSettings({ volumeKeysToFlip: false }));
    await act(() =>
      eventDispatcher.dispatch('tts-playback-state', { bookKey: 'book', state: 'paused' }),
    );
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(0);
    hook.unmount();
  });

  it('balances StrictMode and independent readers and ignores unmatched releases', () => {
    const first = reader('book', true);
    setSettings({}, 'second');
    const second = reader('second');
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(2);
    first.unmount();
    expect(useDeviceControlStore.getState().volumeKeysIntercepted).toBe(true);
    second.unmount();
    const calls = mocks.interceptKeys.mock.calls.length;
    useDeviceControlStore.getState().releaseVolumeKeyInterception();
    expect(mocks.interceptKeys).toHaveBeenCalledTimes(calls);
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(0);
  });

  it('forwards one callback per direction and blocks disabled, playing and unmounted readers', async () => {
    const hook = reader();
    await act(async () => {
      await window.onNativeKeyDown?.('VolumeUp', 24);
      await window.onNativeKeyDown?.('VolumeDown', 25);
    });
    expect(hook.view.prev).toHaveBeenCalledTimes(1);
    expect(hook.view.next).toHaveBeenCalledTimes(1);
    await act(() =>
      eventDispatcher.dispatch('tts-playback-state', { bookKey: 'book', state: 'playing' }),
    );
    await act(async () => {
      await window.onNativeKeyDown?.('VolumeDown', 25);
    });
    await act(() =>
      eventDispatcher.dispatch('tts-playback-state', { bookKey: 'book', state: 'paused' }),
    );
    act(() => setSettings({ volumeKeysToFlip: false }));
    await act(async () => {
      await window.onNativeKeyDown?.('VolumeDown', 25);
    });
    hook.unmount();
    await window.onNativeKeyDown?.('VolumeDown', 25);
    expect(hook.view.next).toHaveBeenCalledTimes(1);
  });

  it('retains click directions, center menu, swapped/fullscreen areas and disable setting', async () => {
    const hook = reader();
    const click = (x: number) =>
      act(() =>
        hook.result.current.handlePageFlip(
          new MessageEvent('message', {
            data: { type: 'iframe-single-click', bookKey: 'book', screenX: x },
          }),
        ),
      );
    await click(100);
    await click(900);
    act(() => setSettings({ swapClickArea: true }));
    await click(100);
    await click(900);
    expect(hook.view.prev).toHaveBeenCalledTimes(2);
    expect(hook.view.next).toHaveBeenCalledTimes(2);
    await click(500);
    expect(useReaderStore.getState().hoveredBookKey).toBe('book');
    await click(900); // dismiss menu
    act(() => setSettings({ fullscreenClickArea: true }));
    await click(100);
    await click(900);
    expect(hook.view.next).toHaveBeenCalledTimes(4);
    act(() => setSettings({ disableClick: true }));
    await click(100);
    expect(hook.view.prev).toHaveBeenCalledTimes(2);
    expect(hook.view.next).toHaveBeenCalledTimes(4);
  });

  it('does not intercept volume keys on a desktop host', () => {
    mocks.mobile = false;
    reader();
    expect(mocks.interceptKeys).not.toHaveBeenCalled();
  });

  it('starts native event forwarding when the mobile host becomes ready after mount', async () => {
    mocks.mobile = false;
    const hook = reader();
    mocks.mobile = true;
    hook.rerender();
    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(1);
    await act(async () => {
      await window.onNativeKeyDown?.('VolumeDown', 25);
    });
    expect(hook.view.next).toHaveBeenCalledTimes(1);
  });
});
