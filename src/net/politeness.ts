/**
 * One in-flight request per host, spaced by minIntervalMs (~0.8 req/s default).
 * Parallelism is ACROSS hosts only. A monitor that hammers 352 hosts is a DDoS
 * with a cron; we have taken a partner's production host down this way before.
 */
export class HostQueue {
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly minIntervalMs = 1250) {}

  run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch (err) {
      return Promise.reject(err);
    }
    const prior = this.tails.get(host) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        const started = Date.now();
        try {
          return await fn();
        } finally {
          const wait = this.minIntervalMs - (Date.now() - started);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      });
    this.tails.set(host, next.catch(() => {}));
    return next as Promise<T>;
  }
}
