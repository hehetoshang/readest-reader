import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

const contract = JSON.parse(readFileSync('contract/moke-reader.v1.json', 'utf8'));
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const appPackage = JSON.parse(readFileSync('apps/readest-app/package.json', 'utf8'));
const nextConfig = readFileSync('apps/readest-app/next.config.mjs', 'utf8');
const readerBackend = readFileSync('apps/readest-app/src-tauri/src/lib.rs', 'utf8');
const readerBuild = readFileSync('apps/readest-app/src-tauri/build.rs', 'utf8');
const gitmodules = readFileSync('.gitmodules', 'utf8');

function listFilesRecursive(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFilesRecursive(root, child) : [child];
  });
}

test('publishes the versioned Moke reader contract', () => {
  assert.equal(contract.id, 'moke.readest.embed.v1');
  assert.equal(contract.readerRoute, '/readest/reader');
  assert.equal(contract.progressApi.credentials, 'include');
  assert.equal(contract.progressApi.transport, '@tauri-apps/plugin-http');
  assert.equal(contract.progressApi.owner, 'host');
  assert.deepEqual(contract.hostLocalProgress, {
    schema: 'moke.readest.host-local-progress.v1',
    claimMember: 'localProgress',
    format: 'epub',
    progressOwner: 'host',
    commands: {
      restoreReceipt: 'moke_reader_acknowledge_restore',
      beginNavigation: 'moke_reader_begin_navigation',
      capture: 'moke_reader_progress',
      drain: 'moke_reader_closing',
    },
  });
  assert.ok(contract.readerEvents.includes('reader:error'));
  assert.deepEqual(contract.hostDownloadedEpub, {
    resourceKind: 'downloaded-epub',
    readCommand: 'moke_reader_download_read',
    maxReadBytes: 1048576,
    requiresHostLocalProgress: true,
  });
  assert.deepEqual(contract.legacyMobileProgress, {
    schema: 'moke.readest.legacy-mobile-progress.v1',
    queryLookup: 'mokeLegacyProgressId',
    readClaim: 'moke.readest.host-launch.v1',
    platforms: ['ohos', 'android', 'ios'],
    progressOwner: 'host',
    commands: {
      claim: 'moke_reader_legacy_progress_claim',
      capture: 'moke_reader_legacy_progress_capture',
      close: 'moke_reader_legacy_progress_close',
    },
  });
  assert.ok(contract.nativeLibrary.registrationFunctions.includes('reader_invoke_handler'));
});

test('packages the complete frozen host capability group and exact contract inputs', () => {
  const host = JSON.parse(readFileSync('contract/reader-host-launch.v1.json', 'utf8'));
  assert.deepEqual(contract.capabilities, host.requiredCapabilities);
  assert.equal(contract.progressSchema, host.progressSchema);
  assert.equal(contract.hostLaunch.progressOwner, 'host');
  assert.equal(contract.hostLaunch.remoteRestoreSnapshot, false);
  assert.match(readerBackend, /pub const MOKE_READER_MANIFEST_JSON: &str = include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/contract\/moke-reader\.v1\.json"\)/);
  const frozen = {
    'contract/reader-host-launch.v1.json': 'ab1ea705bc14a1f89641a9699d8542ee615a2962c61c3104cf54cf7c9f632068',
    'contract/fixtures/reader-host-launch.v1.json': 'd6d464cee11fc1eaf3cb097343c53e60c0b1f489c4cd947b0f6a92886c17da62',
    'docs/READER_HOST_LAUNCH.md': 'd963b7a046a80eace9b6ba7c93b02438b0837dd95c025a2df47537e431fe6063',
  };
  for (const [path, digest] of Object.entries(frozen)) {
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), digest, path);
  }
});

test('exports only the embedded Reader page', () => {
  assert.match(nextConfig, /pageExtensions: \['moke\.tsx'\]/);
  assert.match(nextConfig, /output: isDev \? undefined : 'export'/);
  assert.match(appPackage.scripts['build:reader'], /setup-vendors/);
  assert.match(appPackage.scripts['build:reader'], /\.env\.moke-reader/);
  assert.match(appPackage.scripts['build:reader'], /next build --webpack/);
  assert.match(readerBackend, /http:\/\/localhost:3001\/readest\/reader/);
  assert.match(readerBackend, /WebviewUrl::App\("readest\/reader\.html"\.into\(\)\)/);
  const pages = listFilesRecursive('apps/readest-app/src/pages').filter((path) =>
    /\.(?:js|jsx|ts|tsx)$/.test(path),
  );
  assert.deepEqual(pages, ['reader.moke.tsx']);
  for (const excluded of [
    'apps/readest-app/src/app/api',
    'apps/readest-app/src/pages/api',
    'apps/readest-app/workers',
    'apps/readest-app/extensions',
  ]) {
    assert.equal(existsSync(excluded), false, `${excluded} must stay outside the Reader boundary`);
  }
});

test('embedded Windows library builds do not require standalone packaging assets', () => {
  assert.match(readerBuild, /CARGO_FEATURE_STANDALONE/);
  assert.match(readerBuild, /CARGO_CFG_TARGET_OS[\s\S]*Ok\("windows"\)/);
  assert.match(readerBuild, /if embedded_windows \{[\s\S]*emit_embedded_windows_cfg\(\)/);
  assert.match(readerBuild, /else \{[\s\S]*tauri_build::try_build/);
  assert.match(readerBuild, /cargo:rustc-cfg=desktop/);
});

test('pins self-contained Reader vendors and public provenance', () => {
  assert.equal(rootPackage.license, 'AGPL-3.0-only');
  assert.equal(appPackage.license, 'AGPL-3.0-only');
  assert.match(gitmodules, /vendor\/foliate-js/);
  assert.match(gitmodules, /vendor\/simplecc-wasm/);
  assert.match(gitmodules, /vendor\/js-mdict/);
  assert.ok(existsSync('LICENSE'));
  assert.ok(existsSync('THIRD_PARTY_NOTICES.md'));
});
