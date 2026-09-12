export interface ComposeServiceOutcome {
  status: string;
  containerId?: string;
  staticRoot?: string;
  carried?: true;
  runToCompletion?: true;
}

/**
 * Decide whether a compose pass changed enough live runtime to publish a new
 * project release. Kept separate from the deploy loop so failure semantics can
 * be locked down without a Docker daemon.
 */
export function composeDeployResultStatus(input: {
  successful: number;
  failed: number;
  services: ComposeServiceOutcome[];
}): "ready" | "failed" {
  if (input.failed === 0) return input.successful > 0 ? "ready" : "failed";

  // Carried services prove the incumbent is still serving; they are not work
  // published by this candidate. A completed one-shot task is similar: it can
  // prepare schema/state, but it does not leave a new live service behind. If
  // every selected live workload failed, publishing this deployment would move
  // the active-release pointer away from the still-running incumbent and make
  // reject start a needless whole-release restore.
  const publishedLiveWorkload = input.services.some(
    (service) =>
      !service.carried &&
      !service.runToCompletion &&
      service.status !== "failed" &&
      service.status !== "cancelled" &&
      service.status !== "indeterminate" &&
      Boolean(service.containerId || service.staticRoot),
  );
  return publishedLiveWorkload ? "ready" : "failed";
}
