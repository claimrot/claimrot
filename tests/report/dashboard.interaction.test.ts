import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { renderDashboard } from "../../src/report/dashboard.js";

type Listener = () => void;

function interactiveNode(extra: Record<string, unknown> = {}) {
  const listeners: Record<string, Listener> = {};
  return {
    hidden: false,
    listeners,
    attributes: {} as Record<string, string>,
    addEventListener(name: string, listener: Listener) { listeners[name] = listener; },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    ...extra,
  };
}

describe("dashboard interactions", () => {
  it("runs the embedded filter and search script and updates its live result count", () => {
    const html = renderDashboard(openDb(":memory:"));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const all = interactiveNode({ dataset: { filter: "all" } });
    const action = interactiveNode({ dataset: { filter: "action" } });
    const filters = [all, action];
    const adult = interactiveNode({ dataset: { group: "action", search: "adult price" } });
    const child = interactiveNode({ dataset: { group: "holds", search: "child price" } });
    const rows = [adult, child];
    const search = interactiveNode({ value: "" });
    const count = interactiveNode({ textContent: "2 results" });
    const empty = interactiveNode({ hidden: true });
    const document = {
      querySelectorAll(selector: string) {
        if (selector === ".filter") return filters;
        if (selector === ".claim-row") return rows;
        return [];
      },
      querySelector(selector: string) {
        if (selector === ".search") return search;
        if (selector === ".result-count") return count;
        if (selector === ".empty") return empty;
        return null;
      },
    };

    runInNewContext(script!, { document });
    (search as typeof search & { value: string }).value = "CHILD";
    search.listeners.input();
    expect(adult.hidden).toBe(true);
    expect(child.hidden).toBe(false);
    expect(count.textContent).toBe("1 result");

    (search as typeof search & { value: string }).value = "";
    action.listeners.click();
    expect(adult.hidden).toBe(false);
    expect(child.hidden).toBe(true);
    expect(action.attributes["aria-pressed"]).toBe("true");
  });
});
