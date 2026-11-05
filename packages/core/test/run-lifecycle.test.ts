import { describe, expect, it } from "vitest";
import {
  canTransitionRun,
  InvalidRunTransitionError,
  transitionRun,
} from "../src/run-lifecycle.js";

describe("run lifecycle", () => {
  it("allows the normal execution path and a return after approval", () => {
    expect(transitionRun("created", "validating")).toBe("validating");
    expect(transitionRun("validating", "preparing_workspace")).toBe("preparing_workspace");
    expect(transitionRun("preparing_workspace", "queued")).toBe("queued");
    expect(transitionRun("queued", "running")).toBe("running");
    expect(transitionRun("running", "waiting_for_approval")).toBe("waiting_for_approval");
    expect(transitionRun("waiting_for_approval", "running")).toBe("running");
    expect(transitionRun("running", "succeeded")).toBe("succeeded");
  });

  it("allows cancellation and failure from nonterminal execution states", () => {
    expect(canTransitionRun("created", "cancelled")).toBe(true);
    expect(canTransitionRun("running", "cancelled")).toBe(true);
    expect(canTransitionRun("validating", "failed")).toBe(true);
  });

  it("rejects skipped states and transitions out of terminal states", () => {
    expect(canTransitionRun("created", "running")).toBe(false);
    expect(canTransitionRun("succeeded", "running")).toBe(false);
    expect(() => transitionRun("failed", "cancelled")).toThrow(InvalidRunTransitionError);
  });
});
