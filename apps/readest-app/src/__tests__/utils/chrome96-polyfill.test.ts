import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';

const cloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
const lastDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'findLastIndex');

beforeAll(async () => {
  Reflect.deleteProperty(globalThis, 'structuredClone');
  Reflect.deleteProperty(Array.prototype, 'findLastIndex');
  await import('@/utils/polyfill');
});
afterAll(() => {
  if (cloneDescriptor) Object.defineProperty(globalThis, 'structuredClone', cloneDescriptor);
  if (lastDescriptor) Object.defineProperty(Array.prototype, 'findLastIndex', lastDescriptor);
});

describe('Reader behavior without Chrome 98/97 APIs', () => {
  it('sanitizes a backup without changing live settings or losing typed/cyclic values', async () => {
    const { sanitizeSettingsForBackup } = await import('@/services/backupService');
    const metadata = {
      date: new Date('2026-01-01'),
      bytes: new Uint8Array([1, 2]),
      map: new Map([['reader', true]]),
      cycle: {},
    };
    metadata.cycle = metadata;
    const settings = {
      localBooksDir: '/fictional/books',
      opdsCatalogs: [
        {
          url: 'https://example.invalid',
          username: 'fictional',
          password: 'test-secret',
        },
      ],
      metadata,
    } as unknown as SystemSettings;
    const clone = sanitizeSettingsForBackup(settings) as unknown as {
      metadata: typeof metadata;
      localBooksDir?: string;
      opdsCatalogs: Array<{ password?: string }>;
    };
    expect(clone.localBooksDir).toBeUndefined();
    expect(clone.opdsCatalogs[0]?.password).toBeUndefined();
    expect(settings.localBooksDir).toBe('/fictional/books');
    expect(settings.opdsCatalogs?.[0]?.password).toBe('test-secret');
    expect(clone.metadata).not.toBe(metadata);
    expect(clone.metadata.cycle).toBe(clone.metadata);
    expect(clone.metadata.date.getTime()).toBe(metadata.date.getTime());
    expect([...clone.metadata.bytes]).toEqual([1, 2]);
    expect(clone.metadata.map.get('reader')).toBe(true);
  });

  it('transfers the binary storage used by PDF fake-worker messages', () => {
    const data = new Uint8Array([10, 20, 30]);
    const clone = structuredClone({ data }, { transfer: [data.buffer] });
    expect([...clone.data]).toEqual([10, 20, 30]);
    expect(data.buffer.byteLength).toBe(0);
    expect(() => structuredClone({ callback: () => undefined })).toThrow();
  });

  it('navigates to the last linear EPUB section, skipping trailing ancillary sections', async () => {
    const { Paginator } = await import('foliate-js/paginator.js');
    const goTo = vi.fn();
    Paginator.prototype.lastSection.call({
      sections: [{ linear: 'yes' }, { linear: 'yes' }, { linear: 'no' }],
      goTo,
    });
    expect(goTo).toHaveBeenCalledWith({ index: 1 });
  });
});
