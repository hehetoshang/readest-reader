/** A close fence waits for actual I/O settlement, even when abort is ignored. */
export class FileLifetime {
  readonly controller = new AbortController();
  #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;

  check() {
    if (this.controller.signal.aborted) throw new Error('File is closed');
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.check();
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = Promise.resolve().then(operation);
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }

  close(cleanup: () => void | Promise<void>, drainFirst = false): Promise<void> {
    if (!this.#closing) {
      this.controller.abort();
      this.#closing = (async () => {
        // Start transport cancellation now, but do not confuse it with I/O completion.
        const results = await Promise.allSettled([
          ...this.#pending,
          Promise.resolve().then(async () => {
            if (drainFirst) await Promise.allSettled(this.#pending);
            await cleanup();
          }),
        ]);
        const cleanupResult = results[results.length - 1]!;
        if (cleanupResult.status === 'rejected') throw cleanupResult.reason;
      })();
    }
    return this.#closing;
  }
}
