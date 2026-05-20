type Bucket = {
  count: number;
  resetAt: number;
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  take(key: string, now = Date.now()): { allowed: boolean; limit: number; remaining: number; retryAfterMs: number } {
    // Periodically evict expired buckets to prevent unbounded memory growth
    if (now - this.lastSweep >= this.windowMs) {
      for (const [k, b] of this.buckets) {
        if (b.resetAt <= now) this.buckets.delete(k);
      }
      this.lastSweep = now;
    }

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, limit: this.limit, remaining: this.limit - 1, retryAfterMs: this.windowMs };
    }

    if (existing.count >= this.limit) {
      return { allowed: false, limit: this.limit, remaining: 0, retryAfterMs: Math.max(0, existing.resetAt - now) };
    }

    existing.count += 1;
    return { allowed: true, limit: this.limit, remaining: this.limit - existing.count, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }
}
