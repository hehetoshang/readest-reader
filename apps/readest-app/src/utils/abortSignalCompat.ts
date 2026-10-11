/** Extend Chrome 96's native signals so fetch/Request keep real cancellation. */
export function installAbortSignalCompat(): void {
  if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined') return;
  const prototype = AbortSignal.prototype;
  const aborted = Object.getOwnPropertyDescriptor(prototype, 'aborted')!.get!;
  const define = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { configurable: true, writable: true, value });

  if (!('reason' in prototype)) {
    const reasons = new WeakMap<AbortSignal, unknown>();
    const abortError = () => new DOMException('This operation was aborted', 'AbortError');
    const nativeAbort = AbortController.prototype.abort;
    define(AbortController.prototype, 'abort', function (this: AbortController, reason?: unknown) {
      const signal = this.signal;
      if (!aborted.call(signal)) reasons.set(signal, reason === undefined ? abortError() : reason);
      // Store the reason before native abort dispatches its single abort event.
      nativeAbort.call(this, reason);
    });
    Object.defineProperty(prototype, 'reason', {
      configurable: true,
      get(this: AbortSignal) {
        if (!aborted.call(this)) return undefined;
        // Signals created internally by Request or the browser can lack a
        // recorded reason. Give them one stable default AbortError.
        if (!reasons.has(this)) reasons.set(this, abortError());
        return reasons.get(this);
      },
    });
    // Chrome 96 already has abort(), but drops its reason argument.
    define(AbortSignal, 'abort', (reason?: unknown) => {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    });
  }

  if (!prototype.throwIfAborted) {
    define(prototype, 'throwIfAborted', function (this: AbortSignal) {
      if (aborted.call(this)) throw this.reason;
    });
  }

  if (!AbortSignal.timeout) {
    define(AbortSignal, 'timeout', (milliseconds: number) => {
      if (typeof milliseconds === 'bigint') throw new TypeError('Timeout cannot be a BigInt');
      const delay = Number(milliseconds);
      if (!Number.isFinite(delay) || delay < 0 || delay >= 2 ** 64) {
        throw new TypeError('Timeout must be an unsigned 64-bit integer');
      }
      const controller = new AbortController();
      // setTimeout has a signed 32-bit limit. Chunk longer delays so they
      // cannot overflow into an immediate timeout. Like other JS timers this
      // fallback follows the event loop, rather than native active-time rules.
      const schedule = (remaining: number) => {
        const chunk = Math.min(remaining, 2 ** 31 - 1);
        setTimeout(() => {
          if (remaining > chunk) schedule(remaining - chunk);
          else controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
        }, chunk);
      };
      schedule(Math.trunc(delay));
      return controller.signal;
    });
  }

  if (!AbortSignal.any) {
    define(AbortSignal, 'any', (iterable: Iterable<AbortSignal>) => {
      const signals = [...new Set([...iterable])];
      // Validate every signal before adding listeners, including ones after
      // an already aborted input. The native getter accepts other realms.
      for (const signal of signals) aborted.call(signal);
      const first = signals.find((signal) => signal.aborted);
      if (first) return AbortSignal.abort(first.reason);
      const controller = new AbortController();
      const listeners = new Map<AbortSignal, () => void>();
      const cleanup = () => {
        for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
        listeners.clear();
      };
      for (const signal of signals) {
        const listener = () => {
          cleanup();
          controller.abort(signal.reason);
        };
        listeners.set(signal, listener);
        signal.addEventListener('abort', listener, { once: true });
      }
      return controller.signal;
    });
  }
}
