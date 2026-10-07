import { describe, expect, it } from "vitest";
import { AppError } from "@repo/contracts";
import { githubReleaseError, releaseInspectionFailure } from "../src/release-diagnostics";
import { releaseUpdateStatus } from "../src/engine/modules/issues/release-update-status";

describe("safe GitOps inspection diagnostics", () => {
  it.each([
    [new AppError("private credential must not escape", 403, "GITHUB_CONNECTION_REQUIRED"), "GITHUB_USER_CONNECTION_REQUIRED", "inspection.github.connection"],
    [{ status: 401, message: "private credential must not escape" }, "GITHUB_USER_CONNECTION_REQUIRED", "inspection.github.connection"],
    [{ status: 403, credentialRejected: true }, "GITHUB_USER_PERMISSION_REQUIRED", "inspection.github.access"],
    [{ status: 403, credentialRejected: false }, "RELEASE_SOURCE_RATE_LIMITED", "inspection.github.rate_limit"],
    [{ status: 429 }, "RELEASE_SOURCE_RATE_LIMITED", "inspection.github.rate_limit"],
    [{ status: 404 }, "RELEASE_SOURCE_NOT_FOUND", "inspection.github.source"],
    [new Error("private credential must not escape"), "RELEASE_SOURCE_UNAVAILABLE", "inspection.github.source"],
  ])("classifies a source failure without exposing its body", (error, code, key) => {
    const mapped = githubReleaseError(error), check = releaseInspectionFailure(mapped);
    expect(mapped.code).toBe(code); expect(check.key).toBe(key);
    expect(check).toMatchObject({ status: "unknown", blocking: true });
    expect(JSON.stringify(check)).not.toContain("private credential");
  });
  it("shows the blocking reason without calling unknown, blocked, drift or configuration an update", () => {
    const reason = releaseInspectionFailure(githubReleaseError(new AppError("unlinked", 403, "GITHUB_CONNECTION_REQUIRED")));
    expect(releaseUpdateStatus("unknown", [reason])).toEqual({ kind: "release_unknown", message: reason.detail });
    expect(releaseUpdateStatus("blocked", [{ ...reason, key: "activation", status: "fail", detail: "此环境尚未通过接管与恢复验收" }])).toMatchObject({ kind: "release_blocked", message: "此环境尚未通过接管与恢复验收" });
    expect(releaseUpdateStatus("drift", [])).toMatchObject({ kind: "release_drift" });
    expect(releaseUpdateStatus("configuration", [])).toMatchObject({ kind: "release_configuration" });
    expect(releaseUpdateStatus("available", [])).toMatchObject({ kind: "update_available" });
    expect(releaseUpdateStatus("unknown", [{ detail: "malformed" }]).message).not.toBe("malformed");
  });
  it("preserves a safe retry deadline and explains legacy host ownership", () => {
    const deadline = Date.now() + 600_000;
    expect(githubReleaseError({ status: 429, retryAt: deadline, message: "private response" })).toMatchObject({ retryAt: new Date(deadline).toISOString() });
    const ownership = releaseInspectionFailure(new AppError("private response", 403, "LOCAL_HOST_ACCESS_DENIED"));
    expect(ownership.key).toBe("inspection.runtime.ownership");
    expect(ownership.detail).toContain("工作区"); expect(ownership.detail).not.toContain("private response");
  });
});
