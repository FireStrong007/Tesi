/**
 * Login attempts limit: at most `maxFailures` failed logins per username and per IP address in a
 * sliding window. Kept in memory (one server process per app): a restart clears it.
 */
export class LoginLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private maxFailures: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string) {
    const since = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** milliseconds to wait before trying again, 0 when allowed */
  retryAfter(keys: string[]): number {
    let wait = 0;
    for (const k of keys) {
      const list = this.recent(k);
      if (list.length >= this.maxFailures) wait = Math.max(wait, list[list.length - this.maxFailures] + this.windowMs - this.now());
    }
    return wait;
  }

  fail(keys: string[]) {
    const t = this.now();
    for (const k of keys) this.failures.set(k, [...this.recent(k), t]);
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()]) this.recent(k);
  }

  /** after a successful login: the username starts again (the IP keeps its failures) */
  succeed(key: string) {
    this.failures.delete(key);
  }
}
