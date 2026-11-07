export const runStatuses = [
  "created",
  "validating",
  "preparing_workspace",
  "queued",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof runStatuses)[number];

const transitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ["validating", "failed", "cancelled"],
  validating: ["preparing_workspace", "failed", "cancelled"],
  preparing_workspace: ["queued", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["waiting_for_approval", "succeeded", "failed", "cancelled"],
  waiting_for_approval: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class InvalidRunTransitionError extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`Cannot transition a run from ${from} to ${to}`);
    this.name = "InvalidRunTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransitionRun(from, to)) {
    throw new InvalidRunTransitionError(from, to);
  }

  return to;
}
