import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("dense review layouts", () => {
  it("allows long Gate identifiers to shrink and wrap inside both review columns", () => {
    expect(styles).toMatch(/\.reviewGrid > \.panel\s*\{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.gateSelector > span\s*\{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.gateSelector strong[^}]*overflow-wrap:\s*anywhere/s);
    expect(styles).toMatch(/\.detailHeader > div\s*\{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.detailHeader strong[^}]*overflow-wrap:\s*anywhere/s);
  });
});
