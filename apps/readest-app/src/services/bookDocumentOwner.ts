import type { BookDoc } from '@/libs/document';
import { holdBookDocument, trackBookResourceTeardown } from './bookResourceLifetime';

/** A long-lived consumer plus its already-started async operations. Moving the
 * consumer does not drop a generation still being read by an older operation.
 */
export class BookDocumentOwner {
  #document: BookDoc;
  #release: () => Promise<void>;
  #operations = new Set<Promise<unknown>>();
  #closed = false;
  #closing?: Promise<void>;

  constructor(private id: string, document: BookDoc) {
    this.#document = document;
    this.#release = holdBookDocument(id, document);
  }

  move(document: BookDoc): void {
    if (this.#closed) throw new Error('Book consumer is closed');
    if (document === this.#document) return;
    const release = this.#release;
    this.#release = holdBookDocument(this.id, document);
    this.#document = document;
    void release().catch(error => console.warn('Failed to release previous book consumer:', error));
  }

  run<T>(document: BookDoc, operation: () => Promise<T> | T): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Book consumer is closed'));
    const release = holdBookDocument(this.id, document);
    // Publish the completion fence before user code can synchronously close
    // the consumer (for example from a client initialization event).
    const pending = Promise.resolve().then(operation).finally(release);
    this.#operations.add(pending);
    void pending.then(() => this.#operations.delete(pending), () => this.#operations.delete(pending));
    return pending;
  }

  close(teardown: () => Promise<void>): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      const results = await Promise.allSettled([...this.#operations]);
      results.push(...await Promise.allSettled([Promise.resolve().then(teardown)]));
      await this.#release();
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Failed to close book consumer');
    })();
    trackBookResourceTeardown(this.id, this.#closing);
    return this.#closing;
  }
}
