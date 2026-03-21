export function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): AbortSignal {
  const safeTimeout = Math.max(1, timeoutMs);
  const timeoutSignal = AbortSignal.timeout(safeTimeout);

  if (!parentSignal) {
    return timeoutSignal;
  }

  if (parentSignal.aborted) {
    return parentSignal;
  }

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([parentSignal, timeoutSignal]);
  }

  const controller = new AbortController();

  const abortFromParent = () => {
    controller.abort(parentSignal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  const abortFromTimeout = () => {
    controller.abort(timeoutSignal.reason ?? new DOMException('Timed out', 'TimeoutError'));
  };

  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  timeoutSignal.addEventListener('abort', abortFromTimeout, { once: true });

  return controller.signal;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
    return;
  }

  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }

  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    return name.includes('abort') || name.includes('timeout') || message.includes('aborted') || message.includes('timeout');
  }

  return false;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
