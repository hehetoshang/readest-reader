'use client';

import { useEffect, useState } from 'react';
import DebugLogPanel from '@/components/DebugLogPanel';
import {
  installConsoleCapture,
  installDebugLogBridge,
  installNetworkCapture,
  uninstallConsoleCapture,
  uninstallNetworkCapture,
} from '@/services/debugLog';
import { readPersistedMokeDebugPanel } from '@/helpers/mokeLaunchContext';

// The launch globals are injected before the Next bundle. Start capturing as
// soon as this module loads so failures during Providers/appService bootstrap
// are not lost before the panel component mounts.
if (typeof window !== 'undefined' && window.__MOKE_EMBEDDED && window.__MOKE_DEBUG_PANEL) {
  installConsoleCapture();
  installNetworkCapture();
}

function initialPanelVisibility(): boolean {
  if (typeof window === 'undefined' || !window.__MOKE_EMBEDDED) return false;
  // Never let a stale launch flag hide a switch that is durably enabled in
  // the shared mobile WebView storage. The URL remains authoritative for
  // enabling the panel in separate desktop reader windows.
  return window.__MOKE_DEBUG_PANEL === true || readPersistedMokeDebugPanel();
}

export default function DebugLogIntegration() {
  // The server cannot observe Moke's injected launch globals. Keep the first
  // client render identical to SSR, then restore the requested visibility
  // after hydration so the debug launcher never creates an overlay error.
  const [visible, setVisible] = useState(false);
  const embedded = typeof window !== 'undefined' && !!window.__MOKE_EMBEDDED;

  useEffect(() => {
    if (embedded) setVisible(initialPanelVisibility());
  }, [embedded]);

  useEffect(() => {
    if (!embedded) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void installDebugLogBridge(setVisible).then((uninstall) => {
      if (disposed) uninstall();
      else cleanup = uninstall;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [embedded]);

  useEffect(() => {
    if (!embedded || !visible) {
      uninstallConsoleCapture();
      uninstallNetworkCapture();
      return;
    }
    installConsoleCapture();
    installNetworkCapture();
    return () => {
      uninstallConsoleCapture();
      uninstallNetworkCapture();
    };
  }, [embedded, visible]);

  if (!embedded) return null;
  return <DebugLogPanel visible={visible} />;
}
