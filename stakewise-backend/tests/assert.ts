// Minimal assertions (no external download needed).
export function assert(cond: unknown, msg = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
export function assertEquals(a: unknown, b: unknown, msg?: string) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ?? `Expected ${sb}, got ${sa}`);
}
export function assertAlmostEquals(a: number, b: number, tol = 1e-7) {
  if (Math.abs(a - b) > tol) throw new Error(`Expected ${b} ± ${tol}, got ${a}`);
}
