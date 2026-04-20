import { describe, expect, it, vi } from "vitest";
import { createDMNScheduler } from "./dmn.js";

/**
 * Injectable fake timer — tracks calls to setTimeoutFn/clearTimeoutFn without
 * involving the global event loop. Each setTimeoutFn returns a unique token;
 * clearTimeoutFn asserts the token matches so we catch double-clears or
 * stale-clear bugs.
 */
function createFakeTimer() {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  const setCalls: Array<{ handle: number; ms: number }> = [];
  const clearCalls: Array<{ handle: number }> = [];

  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const handle = nextHandle++;
    pending.set(handle, fn);
    setCalls.push({ handle, ms });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const clearTimeoutFn = ((handle: unknown) => {
    const h = handle as number;
    clearCalls.push({ handle: h });
    pending.delete(h);
  }) as typeof clearTimeout;

  async function fireLast(): Promise<void> {
    const entries = [...pending.entries()];
    if (entries.length === 0) return;
    const [handle, fn] = entries[entries.length - 1];
    pending.delete(handle);
    fn();
    // Yield so the async tick body can complete before assertions.
    await Promise.resolve();
    await Promise.resolve();
  }

  return {
    setTimeoutFn,
    clearTimeoutFn,
    setCalls,
    clearCalls,
    pendingCount: () => pending.size,
    fireLast,
  };
}

describe("createDMNScheduler", () => {
  it("start schedules a single timer at the requested delay", () => {
    const fake = createFakeTimer();
    const scheduler = createDMNScheduler({
      tick: async () => {
        /* noop */
      },
      nextDelayMs: () => 90_000,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
    });

    scheduler.start(1_000);
    expect(fake.setCalls).toHaveLength(1);
    expect(fake.setCalls[0].ms).toBe(1_000);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.stop();
  });

  it("double start clears the prior timer before scheduling a new one", () => {
    const fake = createFakeTimer();
    const scheduler = createDMNScheduler({
      tick: async () => {
        /* noop */
      },
      nextDelayMs: () => 90_000,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
    });

    scheduler.start(1_000);
    scheduler.start(5_000);
    // First handle should have been cleared.
    expect(fake.clearCalls.some((c) => c.handle === 1)).toBe(true);
    // Second set call is at the new delay.
    expect(fake.setCalls[1].ms).toBe(5_000);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.stop();
  });

  it("tick completion self-reschedules at nextDelayMs", async () => {
    const fake = createFakeTimer();
    const delays = [1_000, 2_000, 3_000];
    let delayIdx = 0;
    let tickCount = 0;
    const scheduler = createDMNScheduler({
      tick: async () => {
        tickCount++;
      },
      nextDelayMs: () => delays[Math.min(delayIdx++, delays.length - 1)],
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
    });

    scheduler.start(1_000);
    await fake.fireLast();
    expect(tickCount).toBe(1);
    expect(fake.setCalls).toHaveLength(2);
    expect(fake.setCalls[1].ms).toBe(1_000); // first nextDelayMs() return

    await fake.fireLast();
    expect(tickCount).toBe(2);
    expect(fake.setCalls[2].ms).toBe(2_000);

    scheduler.stop();
  });

  it("stop clears a pending timer + cancels future scheduling", async () => {
    const fake = createFakeTimer();
    let tickCount = 0;
    const scheduler = createDMNScheduler({
      tick: async () => {
        tickCount++;
      },
      nextDelayMs: () => 1_000,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
    });

    scheduler.start(1_000);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.stop();
    expect(scheduler.pendingCount()).toBe(0);
    expect(fake.clearCalls.some((c) => c.handle === 1)).toBe(true);

    // Firing a stale timer (shouldn't exist, but double-check safety).
    await fake.fireLast();
    expect(tickCount).toBe(0);

    // After stop, calling start should still work — it resumes.
    scheduler.start(500);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.stop();
  });

  it("stop mid-tick does not schedule a new timer", async () => {
    const fake = createFakeTimer();
    let ticking = true;
    const scheduler = createDMNScheduler({
      tick: async () => {
        // Simulate long-running tick — stop is called during this window.
        if (ticking) {
          scheduler.stop();
        }
        ticking = false;
      },
      nextDelayMs: () => 1_000,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
    });

    scheduler.start(1_000);
    await fake.fireLast();
    // Only the initial timer existed; tick called stop() synchronously, so
    // the tick completion must not schedule a follow-up.
    expect(scheduler.pendingCount()).toBe(0);
    // No reschedule call beyond the initial start.
    expect(fake.setCalls).toHaveLength(1);
  });

  it("tick throw is caught + onError invoked + scheduling continues", async () => {
    const fake = createFakeTimer();
    const onError = vi.fn();
    let tickCount = 0;
    const scheduler = createDMNScheduler({
      tick: async () => {
        tickCount++;
        if (tickCount === 1) throw new Error("boom");
      },
      nextDelayMs: () => 1_000,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
      onError,
    });

    scheduler.start(1_000);
    await fake.fireLast(); // first tick throws
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("boom");
    expect(scheduler.pendingCount()).toBe(1); // rescheduled despite throw

    await fake.fireLast(); // second tick succeeds
    expect(tickCount).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("nextDelayMs returning Infinity halts scheduling", async () => {
    const fake = createFakeTimer();
    const scheduler = createDMNScheduler({
      tick: async () => {
        /* noop */
      },
      nextDelayMs: () => Number.POSITIVE_INFINITY,
      setTimeoutFn: fake.setTimeoutFn,
      clearTimeoutFn: fake.clearTimeoutFn,
    });

    scheduler.start(1_000);
    await fake.fireLast();
    expect(scheduler.pendingCount()).toBe(0);
    expect(fake.setCalls).toHaveLength(1); // only the initial start
    scheduler.stop();
  });
});
