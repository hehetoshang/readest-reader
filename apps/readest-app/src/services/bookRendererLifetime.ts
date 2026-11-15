import type { BookDoc } from '@/libs/document';
import { holdBookDocument, trackBookResourceTeardown } from './bookResourceLifetime';

/** React cleanup cannot await open. Keep the lease until late setup and the
 * renderer's actual teardown settle; direct close and unmount join one fence.
 */
export function createBookRendererLifetime(id: string, document: BookDoc, isCurrent = () => true) {
  const release = holdBookDocument(id, document);
  let active = true;
  let opening = Promise.resolve();
  let closing: Promise<void> | undefined;
  return {
    isActive: () => active && isCurrent(),
    open(setup: () => Promise<void>) {
      opening = Promise.resolve().then(() => active && isCurrent() ? setup() : undefined);
      return opening;
    },
    close(teardown: () => void | Promise<void>): Promise<void> {
      active = false;
      closing ??= (async () => {
        await opening.catch(() => undefined);
        try { await teardown(); }
        finally { await release(); }
      })();
      trackBookResourceTeardown(id, closing);
      return closing;
    },
  };
}
