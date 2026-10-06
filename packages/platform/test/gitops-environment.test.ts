import { describe, expect, it } from "vitest";
import { checkReleaseEnvironment } from "../src/gitops-environment";
const group = { key: "stripe", label: "Stripe 收款", enabled: true, required: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], optional: ["STRIPE_RETURN_URL"] };
describe("feature environment admission", () => {
  it("blocks an enabled feature with a partial configuration and never exposes values", () => {
    const checks = checkReleaseEnvironment([group], { STRIPE_SECRET_KEY: "private-value", STRIPE_RETURN_URL: "private-return-url" });
    expect(checks[0]).toMatchObject({ status: "fail", blocking: true });
    expect(checks[0]!.detail).toContain("STRIPE_WEBHOOK_SECRET");
    expect(JSON.stringify(checks)).not.toContain("private-");
  });
  it("allows absent optional settings and disabled features", () => {
    expect(checkReleaseEnvironment([group], { STRIPE_SECRET_KEY: "key", STRIPE_WEBHOOK_SECRET: "secret" })[0]).toMatchObject({ status: "pass", blocking: true });
    expect(checkReleaseEnvironment([{ ...group, enabled: false }], {})[0]).toMatchObject({ status: "pass", blocking: false });
  });
  it("rejects contradictory or malformed feature policies", () => {
    expect(() => checkReleaseEnvironment([group, group], {})).toThrow("Invalid feature");
    expect(() => checkReleaseEnvironment([{ ...group, optional: group.required }], {})).toThrow("Invalid feature");
  });
});
