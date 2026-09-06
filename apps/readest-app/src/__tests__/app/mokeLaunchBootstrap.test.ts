import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const readerEntrySource = readFileSync(
  resolve(process.cwd(), 'src/pages/reader.moke.tsx'),
  'utf-8',
);
const readerContentSource = readFileSync(
  resolve(process.cwd(), 'src/app/reader/components/ReaderContent.tsx'),
  'utf-8',
);

describe('Moke launch bootstrap', () => {
  it('runs synchronously before the Reader component is rendered', () => {
    expect(readerEntrySource).toMatch(
      /if \(typeof window !== 'undefined'\) \{\s*bootstrapMokeLaunchContext\(\);\s*\}/,
    );
    expect(readerEntrySource.indexOf('bootstrapMokeLaunchContext();')).toBeLessThan(
      readerEntrySource.indexOf('export default function MokeReaderPage'),
    );
  });

  it('retries a failed online import in place without reloading or pre-hashing twice', () => {
    expect(readerContentSource).toMatch(/if \(!isMokeRemoteSourceUrl\(file\)\)/);
    expect(readerContentSource).toMatch(/setOpenAttempt\(\(attempt\) => attempt \+ 1\)/);
    expect(readerContentSource).not.toMatch(/window\.location\.reload\(\)/);
    expect(readerContentSource).toMatch(/does not support byte-range reading[\s\S]*Download/);
    expect(readerContentSource).toMatch(/getCurrentWindow\(\)\.label !== 'main'/);
  });
});
