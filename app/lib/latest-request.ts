export type LatestRequestTicket = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

/**
 * Owns one replaceable request for a view. Starting a new generation aborts
 * the previous fetch and prevents an already-resolved stale promise from
 * mutating the current selection.
 */
export class LatestRequestGate {
  private generation = 0;
  private controller: AbortController | null = null;

  begin(): LatestRequestTicket {
    this.controller?.abort();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => generation === this.generation && !controller.signal.aborted,
    };
  }

  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  async run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    onSuccess: (value: T) => void,
    onError?: (error: unknown) => void,
  ): Promise<void> {
    const ticket = this.begin();
    try {
      const value = await task(ticket.signal);
      if (ticket.isCurrent()) onSuccess(value);
    } catch (error) {
      if (ticket.isCurrent()) onError?.(error);
    }
  }
}
