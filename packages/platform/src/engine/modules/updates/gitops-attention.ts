/** GitOps verdicts that need an operator even when no newer target exists. */
export function gitopsReleaseAttention(item: { detail?: unknown }): boolean {
  const detail = item.detail as { gitops?: unknown; releaseState?: unknown } | null | undefined;
  return detail?.gitops === true && ["unknown", "blocked", "drift"].includes(String(detail.releaseState));
}
