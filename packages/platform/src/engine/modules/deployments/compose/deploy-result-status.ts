export interface ComposeServiceOutcome {
  status: string;
  containerId?: string;
  staticRoot?: string;
  carried?: true;
  runToCompletion?: true;
}

/** Carried workloads and successful completion jobs do not publish a new release. */
export function composeDeployResultStatus(input: {
  successful: number;
  failed: number;
  services: ComposeServiceOutcome[];
}): "ready" | "failed" {
  if (input.failed === 0) return input.successful > 0 ? "ready" : "failed";
  const publishedLiveWorkload = input.services.some(service =>
    !service.carried && !service.runToCompletion &&
    !["failed", "cancelled", "indeterminate"].includes(service.status) &&
    Boolean(service.containerId || service.staticRoot));
  return publishedLiveWorkload ? "ready" : "failed";
}
