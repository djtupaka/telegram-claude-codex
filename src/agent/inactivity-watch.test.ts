import { describe, expect, test } from "bun:test";
import { InactivityWatch } from "./inactivity-watch";

describe("InactivityWatch", () => {
  test("warns once per inactivity episode and re-arms after progress", () => {
    const watch = new InactivityWatch(1000, 0);

    expect(watch.poll(999)).toBe(false);
    expect(watch.poll(1000)).toBe(true);
    expect(watch.poll(2000)).toBe(false);

    watch.touch(2100);
    expect(watch.poll(3099)).toBe(false);
    expect(watch.poll(3100)).toBe(true);
  });

  test("zero disables warnings", () => {
    const watch = new InactivityWatch(0, 0);

    expect(watch.poll(Number.MAX_SAFE_INTEGER)).toBe(false);
    watch.touch(Number.MAX_SAFE_INTEGER);
    expect(watch.poll(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
