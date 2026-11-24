import { describe, expect, it } from "vitest";

import { dangerReason, hasRmInvocation, isDangerousBash } from "../src/policy.ts";

describe("bash policy", () => {
  it("detects rm invocations including wrappers", () => {
    expect(hasRmInvocation("rm -rf /tmp/x")).toBe(true);
    expect(hasRmInvocation("FOO=1 rm -rf x")).toBe(true);
    expect(hasRmInvocation("echo hi && rm x")).toBe(true);
    expect(hasRmInvocation("echo rm")).toBe(false);
    expect(hasRmInvocation("ls -la")).toBe(false);
  });

  it("detects configured dangerous patterns", () => {
    expect(isDangerousBash("sudo apt install x")).toBe(true);
    expect(isDangerousBash("git push origin main")).toBe(true);
    expect(isDangerousBash("gh pr merge 1")).toBe(true);
    expect(isDangerousBash("echo hello")).toBe(false);
  });

  it("reports a reason", () => {
    expect(dangerReason("rm -rf x")).toContain("removal");
    expect(dangerReason("sudo ls")).toContain("privilege");
    expect(dangerReason("git push")).toContain("git");
  });
});
