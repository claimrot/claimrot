import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli", () => {
  it("registers every documented command", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names.sort()).toEqual(["check", "ingest", "report", "study"]);
  });
});
