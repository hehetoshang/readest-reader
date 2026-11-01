import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init, convert } = vi.hoisted(() => ({
  init: vi.fn<(options: { module_or_path: string }) => Promise<void>>(),
  convert: vi.fn<(text: string, variant: string) => string>(),
}));

vi.mock('@simplecc/simplecc_wasm', () => ({
  default: init,
  simplecc: convert,
}));

beforeEach(() => {
  vi.resetModules();
  init.mockReset().mockResolvedValue(undefined);
  convert.mockReset();
  vi.stubEnv('NEXT_PUBLIC_EMBEDDED_BASE_PATH', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SimpleCC initialization', () => {
  it('loads the conversion WASM from the embedded Reader base path', async () => {
    const { initSimpleCC } = await import('@/utils/simplecc');

    await initSimpleCC();

    expect(init).toHaveBeenCalledExactlyOnceWith({
      module_or_path: '/readest/vendor/simplecc/simplecc_wasm_bg.wasm',
    });
  });

  it('uses the configured base path without duplicate slashes', async () => {
    vi.stubEnv('NEXT_PUBLIC_EMBEDDED_BASE_PATH', '/moke/reader///');
    const { initSimpleCC } = await import('@/utils/simplecc');

    await initSimpleCC();

    expect(init).toHaveBeenCalledExactlyOnceWith({
      module_or_path: '/moke/reader/vendor/simplecc/simplecc_wasm_bg.wasm',
    });
  });

  it('makes concurrent book opens wait for one initialization', async () => {
    let finishInit: () => void = () => {};
    init.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishInit = resolve;
      }),
    );
    const { initSimpleCC } = await import('@/utils/simplecc');
    const finished = vi.fn();

    const opening = Promise.all([initSimpleCC(), initSimpleCC()]).then(finished);
    await Promise.resolve();

    expect(init).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();

    finishInit();
    await opening;
    await initSimpleCC();

    expect(finished).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledOnce();
  });

  it('allows a new book open to retry after a failed initialization', async () => {
    const error = new Error('WASM download failed');
    init.mockRejectedValueOnce(error);
    const { initSimpleCC } = await import('@/utils/simplecc');

    await expect(initSimpleCC()).rejects.toBe(error);
    await expect(initSimpleCC()).resolves.toBeUndefined();
    await initSimpleCC();

    expect(init).toHaveBeenCalledTimes(2);
  });
});

describe('SimpleCC conversion', () => {
  it('returns the converted book text', async () => {
    convert.mockReturnValueOnce('简体书籍');
    const { runSimpleCC } = await import('@/utils/simplecc');

    expect(runSimpleCC('簡體書籍', 't2s')).toBe('简体书籍');
    expect(convert).toHaveBeenCalledExactlyOnceWith('簡體書籍', 't2s');
  });

  it('reverses traditional-to-simplified conversion for annotation lookup', async () => {
    const { runSimpleCC } = await import('@/utils/simplecc');

    runSimpleCC('书籍', 't2s', true);

    expect(convert).toHaveBeenCalledExactlyOnceWith('书籍', 's2t');
  });
});
