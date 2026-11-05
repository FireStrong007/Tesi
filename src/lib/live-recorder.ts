/**
 * Turns the band's live channels into one database row per minute (table live_sample),
 * so Home and charts can show today's data while the band is connected, before the
 * FIT files are synced.
 *
 * Steps: the band sends its day counter (total steps today). Each minute stores the
 * increase of that counter. The first reading only sets the starting point: steps taken
 * while disconnected arrive with the FIT files (a sync runs on every connection), and
 * the Home shows the band's counter as today's total in the meantime.
 * Comparing the first reading with the database is NOT safe: the first sync may still be
 * importing, and the whole day would end up counted twice.
 */
import type { SqlExecutor } from "./db/sql";
import type { RealtimeUpdate } from "./garmin/multilink";

interface Minute {
  ts: number;
  hr: number[];
  resp: number[];
  spo2: number[];
  bodyBattery: number | null;
  /** last day-counter value seen in this minute */
  counter: number | null;
}

export class LiveRecorder {
  private cur: Minute | null = null;
  /** day counter at the end of the previous stored minute; null until the first reading */
  private baseline: number | null = null;
  /** minute of the last counter reading used as baseline */
  private baselineTs = 0;
  /** faster than this is not walking or running: treat it as a counter change, not as steps */
  static readonly MAX_STEPS_PER_MINUTE = 400;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private db: SqlExecutor,
    private deviceId: number,
    private userId: number,
    private onFlushed: () => void,
  ) {}

  /** Adds a live update. `now` is unix seconds (injectable for tests). */
  push(u: RealtimeUpdate, now = Date.now() / 1000) {
    this.pending = this.pending.then(() => this.apply(u, now)).catch((e) => console.error("live recorder", e));
    return this.pending;
  }

  private async apply(u: RealtimeUpdate, now: number) {
    const minute = Math.floor(now / 60) * 60;
    if (this.cur && this.cur.ts !== minute) await this.flush();
    if (!this.cur) this.cur = { ts: minute, hr: [], resp: [], spo2: [], bodyBattery: null, counter: null };
    const m = this.cur;
    if (u.heartRate) m.hr.push(u.heartRate);
    if (u.respiration) m.resp.push(u.respiration);
    if (u.spo2) m.spo2.push(u.spo2);
    if (u.bodyBattery != null) m.bodyBattery = u.bodyBattery;
    if (u.steps != null) {
      if (this.baseline === null) {
        this.baseline = u.steps;
        this.baselineTs = minute;
      }
      m.counter = u.steps;
    }
  }

  /** Writes the current minute (called automatically when the minute changes, and on disconnect). */
  async flush() {
    const m = this.cur;
    this.cur = null;
    if (!m) return;
    let steps = 0;
    if (m.counter !== null && this.baseline !== null) {
      steps = m.counter >= this.baseline ? m.counter - this.baseline : m.counter; // lower = midnight reset
      const minutes = Math.max(1, (m.ts - this.baselineTs) / 60);
      if (steps > LiveRecorder.MAX_STEPS_PER_MINUTE * minutes) steps = 0; // counter re-based, not real steps
      this.baseline = m.counter;
      this.baselineTs = m.ts;
    }
    const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const hr = avg(m.hr);
    if (hr === null && !steps && m.bodyBattery === null && !m.resp.length && !m.spo2.length) return;
    await this.db.run(
      `INSERT INTO live_sample (device_id, user_id, timestamp, heart_rate, steps, body_battery, respiration, spo2)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(device_id, timestamp) DO UPDATE SET
         heart_rate = COALESCE(excluded.heart_rate, heart_rate), steps = steps + excluded.steps,
         body_battery = COALESCE(excluded.body_battery, body_battery), respiration = COALESCE(excluded.respiration, respiration),
         spo2 = COALESCE(excluded.spo2, spo2)`,
      [this.deviceId, this.userId, m.ts, hr === null ? null : Math.round(hr), steps, m.bodyBattery, avg(m.resp), avg(m.spo2) === null ? null : Math.round(avg(m.spo2)!)],
    );
    this.onFlushed();
  }

  /** Flushes after all queued updates are applied. */
  async close() {
    await this.pending;
    await this.flush();
  }
}
