import { type MokeHostLaunch, getMokeHostLaunch } from './mokeHostLaunch';

type BackState = 'loading' | 'ready' | 'closing' | 'blocked' | 'stale';
type BackRequest = (launchId: string, documentGeneration: number) => BackState;

interface MokeManagedBack {
  getState: BackRequest;
  requestClose: (launchId: string, documentGeneration: number) => BackState | 'accepted';
}

declare global {
  interface Window {
    __MOKE_MANAGED_BACK__?: MokeManagedBack;
  }
}

export function installMokeManagedBack(
  launch: MokeHostLaunch,
  isReaderReady: () => boolean,
  closeReader: () => Promise<void>,
): () => void {
  const getState: BackRequest = (launchId, documentGeneration) => {
    if (
      window.__MOKE_MANAGED_BACK__ !== bridge ||
      getMokeHostLaunch() !== launch ||
      launch.claim.launchId !== launchId ||
      launch.claim.documentGeneration !== documentGeneration
    ) {
      return 'stale';
    }
    return launch.getMobileReturnState() ?? (isReaderReady() ? 'ready' : 'loading');
  };
  const bridge: MokeManagedBack = Object.freeze({
    getState,
    requestClose: (launchId: string, documentGeneration: number) => {
      const state = getState(launchId, documentGeneration);
      if (state !== 'ready') return state;
      void closeReader().catch(() => {
        console.warn('[reader] Host return could not be confirmed');
      });
      return 'accepted';
    },
  });
  const dispose = () => {
    window.removeEventListener('pagehide', dispose);
    if (window.__MOKE_MANAGED_BACK__ === bridge) delete window.__MOKE_MANAGED_BACK__;
  };
  window.__MOKE_MANAGED_BACK__ = bridge;
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
