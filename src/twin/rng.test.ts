import { describe, expect, it, vi } from "vitest";
import { Rng } from "./rng";

describe("binomial", () => {
  it.each([1e-20, Number.MIN_VALUE])("terminates for a tiny positive probability %s", (p) => {
    const rng = new Rng(7);
    let draws = 0;
    vi.spyOn(rng, "uniform").mockImplementation(() => {
      if (++draws > 2) throw new Error("geometric skip did not advance");
      return 0.5;
    });

    expect(rng.binomial(120, p)).toBe(0);
    expect(draws).toBe(1);
  });

  it("returns exact boundary counts without drawing", () => {
    const rng = new Rng(7);
    const draw = vi.spyOn(rng, "uniform");
    expect(rng.binomial(120, 0)).toBe(0);
    expect(rng.binomial(120, 1)).toBe(120);
    expect(draw).not.toHaveBeenCalled();
  });

  it("keeps ordinary seeded binomial draws reproducible and bounded", () => {
    const first = new Rng(42);
    const second = new Rng(42);
    const draws = Array.from({ length: 100 }, () => first.binomial(120, 0.2));
    expect(draws).toEqual(Array.from({ length: 100 }, () => second.binomial(120, 0.2)));
    expect(draws.every((value) => Number.isInteger(value) && value >= 0 && value <= 120)).toBe(true);
  });
});
