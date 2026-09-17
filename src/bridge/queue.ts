import type { BridgeEvent, IgnoreReason } from "./types.js";

/**
 * In-memory bounded event queue with monotonically increasing sequence IDs.
 *
 * - No persistent volume assumptions: events live only in process memory.
 * - `enqueue` fails closed when the queue is full (explicit drop behavior:
 *   the newest event is rejected, not the oldest, so a listener that acks
 *   in order never loses an already-delivered event silently).
 * - `ack` removes events with sequence <= the acked sequence, mirroring
 *   at-least-once delivery with ordered acks.
 * - `waitSince` supports long polling: resolves as soon as an event with
 *   seq > after exists, or after the timeout with whatever is available.
 */
export class BridgeEventQueue {
  private readonly limit: number;
  private events: BridgeEvent[] = [];
  private nextSeq = 1;
  private waiters: Array<{ after: number; resolve: () => void; timer: NodeJS.Timeout }> = [];  /** Count of events dropped because the queue was full. */
  dropped = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Bridge queue limit must be a positive integer");
    this.limit = limit;
  }

  /**
   * Enqueue a message. Returns null (and increments `dropped`) when the queue
   * is at capacity — the caller must treat this as an explicit drop.
   */
  enqueue(message: BridgeEvent["message"]): BridgeEvent | null {
    if (this.events.length >= this.limit) {
      this.dropped += 1;
      return null;
    }
    const event: BridgeEvent = { seq: this.nextSeq++, enqueuedAt: new Date().toISOString(), message };
    this.events.push(event);
    this.notifyWaiters();
    return event;
  }

  /** Events with sequence greater than `after`, in order. */
  since(after: number): BridgeEvent[] {
    return this.events.filter(event => event.seq > after);
  }

  /** Highest sequence ever assigned (even if that event was acked). */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get size(): number {
    return this.events.length;
  }

  /**
   * Acknowledge everything up to and including `seq`. Unknown/future sequence
   * numbers are ignored (idempotent). Returns the number of removed events.
   */
  ack(seq: number): number {
    if (!Number.isInteger(seq) || seq < 0) return 0;
    const remaining = this.events.filter(event => event.seq > seq);
    const removed = this.events.length - remaining.length;
    this.events = remaining;
    return removed;
  }

  /**
   * Long-poll: resolve immediately if events after `after` exist; otherwise
   * wait until one arrives or `timeoutMs` elapses (then resolve with []).
   */
  waitSince(after: number, timeoutMs: number): Promise<BridgeEvent[]> {
    const available = this.since(after);
    if (available.length > 0 || timeoutMs <= 0) return Promise.resolve(available);
    return new Promise(resolve => {
      const waiter = { after, resolve: () => resolve(this.since(after)), timer: null as unknown as NodeJS.Timeout };
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter);
        resolve([]);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private notifyWaiters(): void {
    const ready = this.waiters.filter(waiter => this.since(waiter.after).length > 0);
    for (const waiter of ready) {
      this.removeWaiter(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private removeWaiter(waiter: { after: number; resolve: () => void; timer: NodeJS.Timeout }): void {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
  }
}

/**
 * Bounded idempotency set keyed by Discord message ID.
 * Duplicate message IDs are dropped; the set evicts oldest entries (LRU-ish)
 * once the capacity is reached so memory stays bounded.
 */
export class BoundedIdempotencySet {
  private readonly capacity: number;
  private seen: string[] = [];
  private index = new Set<string>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Idempotency capacity must be a positive integer");
    this.capacity = capacity;
  }

  /** Returns true if the key was newly recorded; false if it was a duplicate. */
  add(key: string): boolean {
    if (this.index.has(key)) return false;
    if (this.seen.length >= this.capacity) {
      const evicted = this.seen.shift();
      if (evicted !== undefined) this.index.delete(evicted);
    }
    this.seen.push(key);
    this.index.add(key);
    return true;
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  get size(): number {
    return this.seen.length;
  }
}

/** Classify queue-full drops for logging without content. */
export function describeDrop(reason: IgnoreReason): string {
  return reason === "queue_full" ? "bridge queue full; event dropped" : `event ignored (${reason})`;
}
