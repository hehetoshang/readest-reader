import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const readerEntrySource = readFileSync(resolve(process.cwd(), 'src/pages/reader.moke.tsx'), 'utf-8');

describe('Moke launch bootstrap', () => {
  it('runs synchronously before the Reader component is rendered', () => {
    expect(readerEntrySource).toMatch(
      /if \(typeof window !== 'undefined'\) \{\s*bootstrapMokeLaunchContext\(\);\s*\}/,
    );
    expect(readerEntrySource.indexOf('bootstrapMokeLaunchContext();')).toBeLessThan(
      readerEntrySource.indexOf('export default function MokeReaderPage'),
    );
  });
});
