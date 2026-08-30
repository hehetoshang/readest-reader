'use client';

import '@/utils/polyfill';
import i18n from '@/i18n/i18n';
import { useEffect } from 'react';
import { IconContext } from 'react-icons';
import { AuthProvider } from '@/context/AuthContext';
import { useEnv } from '@/context/EnvContext';
import { SyncProvider } from '@/context/SyncContext';
import { initSystemThemeListener, loadDataTheme } from '@/store/themeStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomTextureStore } from '@/store/customTextureStore';
import { useSafeAreaInsets } from '@/hooks/useSafeAreaInsets';
import { useSettingsSync } from '@/hooks/useSettingsSync';
import { useDefaultIconSize } from '@/hooks/useResponsiveSize';
import { useBackgroundTexture } from '@/hooks/useBackgroundTexture';
import { useEinkMode } from '@/hooks/useEinkMode';
import { getLocale } from '@/utils/misc';
import { getDirFromUILanguage } from '@/utils/rtl';
import { getAndroidPatchedViewportContent } from '@/utils/viewport';
import { getLibraryViewSettings } from '@/helpers/settings';
import { DropdownProvider } from '@/context/DropdownContext';
import { CommandPaletteProvider, CommandPalette } from '@/components/command-palette';
import AtmosphereOverlay from '@/components/AtmosphereOverlay';
import AppLockScreen from '@/components/AppLockScreen';
import AppLockDialog from '@/components/settings/AppLockDialog';
import PassphrasePrompt from '@/components/PassphrasePrompt';
import { upgradeToKeychainIfAvailable } from '@/libs/crypto/passphrase';
import { cryptoSession } from '@/libs/crypto/session';
import { useAppLockStore } from '@/store/appLockStore';
import { initSettingsSync } from '@/services/sync/replicaSettingsSync';
import DebugLogIntegration from '@/components/DebugLogIntegration';

const Providers = ({ children }: { children: React.ReactNode }) => {
  const { envConfig, appService, appServiceError, retryAppService } = useEnv();
  const { applyUILanguage } = useSettingsStore();
  const { applyBackgroundTexture } = useBackgroundTexture();
  const { applyEinkMode } = useEinkMode();
  const {
    isInitialized: isLockInitialized,
    isUnlocked,
    initialize: initializeAppLock,
  } = useAppLockStore();
  const iconSize = useDefaultIconSize();
  useSafeAreaInsets(); // Initialize safe area insets
  useSettingsSync(); // Adopt global settings broadcast by other windows (#4580)

  useEffect(() => {
    const handlerLanguageChanged = (lng: string) => {
      document.documentElement.lang = lng;
      // Set RTL class on document for targeted styling without affecting layout
      const dir = getDirFromUILanguage();
      if (dir === 'rtl') {
        document.documentElement.classList.add('ui-rtl');
      } else {
        document.documentElement.classList.remove('ui-rtl');
      }
    };

    const locale = getLocale();
    handlerLanguageChanged(locale);
    i18n.on('languageChanged', handlerLanguageChanged);
    return () => {
      i18n.off('languageChanged', handlerLanguageChanged);
    };
  }, []);

  useEffect(() => {
    loadDataTheme();
    if (appService) {
      initSystemThemeListener(appService);
      appService.loadSettings().then(async (settings) => {
        const globalViewSettings = settings.globalViewSettings;
        applyUILanguage(globalViewSettings.uiLanguage);
        // Seed the customTextureStore with the disk-loaded textures (preserving
        // their saved ids) so the boot-time applyBackgroundTexture below can
        // resolve a custom textureId. Without this, the store is empty until
        // ThemePanel or the replica-pull seed runs — and the in-hook addTexture
        // fallback re-derives the id from name, which mismatches whenever the
        // saved id wasn't computed from the current name (legacy imports,
        // cross-device sync, name-based id collisions).
        if (settings.customTextures?.length) {
          useCustomTextureStore.getState().setTextures(settings.customTextures);
        }
        // The app boots onto the library, so apply the library background
        // (which inherits the reader/global texture until decoupled). The
        // reader re-applies its own texture when a book opens (issue #4743).
        applyBackgroundTexture(envConfig, getLibraryViewSettings(settings));
        if (globalViewSettings.isEink) {
          applyEinkMode(true);
        }
        // ponytail: host (Moke) can force e-ink even when the on-disk setting is
        // off (desktop WebView can't be detected via CSS media query).
        if (typeof window !== 'undefined' && window.__MOKE_EINK === true) {
          applyEinkMode(true);
        }
        // Initialize the app-lock gate from on-disk settings. Until
        // this runs, the gate renders nothing — guarantees the
        // library can't flash on screen before the lock screen does.
        initializeAppLock({
          enabled: !!settings.pinCodeEnabled,
          hash: settings.pinCodeHash,
          salt: settings.pinCodeSalt,
          biometricUnlockEnabled: !!settings.biometricUnlockEnabled,
        });
        // Subscribe the bundled-settings publisher to settingsStore
        // changes, AFTER priming the publish snapshot from the just-
        // loaded disk settings. Without this priming, the very first
        // setSettings(disk_default) at boot (typically from library
        // page's initLibrary) would diff every whitelisted field
        // against `undefined`, treat them all as "new", and push the
        // local defaults to the server with a fresh HLC — overwriting
        // the cross-device authoritative values another device set.
        // Idempotent — safe to call on remount.
        initSettingsSync(settings);
      });
    }
  }, [
    envConfig,
    appService,
    applyUILanguage,
    applyBackgroundTexture,
    applyEinkMode,
    initializeAppLock,
  ]);

  // Sync-passphrase boot path: upgrade the passphrase store from
  // ephemeral to OS keychain on Tauri (probe is async — must run after
  // the platform check resolves), then attempt a silent unlock from
  // the saved passphrase. Failures are silent — the gate prompts on
  // first encrypted-field operation if we couldn't restore.
  useEffect(() => {
    void (async () => {
      await upgradeToKeychainIfAvailable();
      await cryptoSession.tryRestoreFromStore();
    })();
  }, []);

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const updated = getAndroidPatchedViewportContent(navigator.userAgent, meta.content);
    if (updated) meta.content = updated;
  }, []);

  // Keep diagnostics available while the native service starts. Previously
  // this guard also hid the embedded debug launcher, turning every startup
  // error into an unobservable permanent white screen.
  if (!appService) {
    return (
      <>
        <DebugLogIntegration />
        {appServiceError && (
          <main
            role='alert'
            style={{
              minHeight: '100vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              background: '#fff',
              color: '#111',
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ width: 'min(100%, 520px)' }}>
              <h1 style={{ margin: '0 0 12px', fontSize: 22 }}>Reader failed to start</h1>
              <p style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
                The native reader service could not be initialized.
              </p>
              <pre
                style={{
                  margin: '0 0 16px',
                  padding: 12,
                  overflowWrap: 'anywhere',
                  whiteSpace: 'pre-wrap',
                  borderRadius: 8,
                  background: '#f1f1f1',
                  fontSize: 12,
                }}
              >
                {appServiceError}
              </pre>
              <button
                type='button'
                onClick={retryAppService}
                style={{
                  minHeight: 44,
                  padding: '0 20px',
                  border: 0,
                  borderRadius: 8,
                  background: '#2563eb',
                  color: '#fff',
                  fontWeight: 600,
                }}
              >
                Retry
              </button>
            </div>
          </main>
        )}
      </>
    );
  }

  // App-lock gate. While the lock store is uninitialized we render
  // nothing — without this guard the library would flash on screen
  // for a few hundred ms before `loadSettings` resolved and let the
  // lock store decide whether to lock.
  const showAppLockScreen = isLockInitialized && !isUnlocked;
  const appShellHidden = !isLockInitialized || !isUnlocked;

  return (
      <AuthProvider>
        <IconContext.Provider value={{ size: `${iconSize}px` }}>
          <SyncProvider>
            <DropdownProvider>
              <CommandPaletteProvider>
                <div
                  aria-hidden={appShellHidden}
                  style={appShellHidden ? { display: 'none' } : undefined}
                >
                  {children}
                  <CommandPalette />
                  <AtmosphereOverlay />
                  <PassphrasePrompt />
                </div>
                <AppLockDialog />
                <DebugLogIntegration />
                {showAppLockScreen && <AppLockScreen />}
              </CommandPaletteProvider>
            </DropdownProvider>
          </SyncProvider>
        </IconContext.Provider>
      </AuthProvider>
  );
};

export default Providers;
