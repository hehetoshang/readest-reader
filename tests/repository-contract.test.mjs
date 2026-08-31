import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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
  assert.ok(contract.readerEvents.includes('reader:error'));
  assert.ok(contract.nativeLibrary.registrationFunctions.includes('reader_invoke_handler'));
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
