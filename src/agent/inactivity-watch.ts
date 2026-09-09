/**
 * Pure state machine for warning once per inactivity episode.
 * A progress touch starts a new episode and re-arms the warning.
 */
export class InactivityWatch {
  private lastProgressAt: number;
  private readonly warningMs: number;
  private warned = false;

  constructor(warningMs: number, startedAt: number) {
    this.warningMs = warningMs;
    this.lastProgressAt = startedAt;
  }

  touch(now: number) {
    this.lastProgressAt = now;
    this.warned = false;
  }

  poll(now: number) {
    if (
      this.warningMs <= 0 ||
      this.warned ||
      now - this.lastProgressAt < this.warningMs
    ) {
      return false;
    }
    this.warned = true;
    return true;
  }
}
