import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatInrFromPaise, formatSubscriptionStatus, isUpgradeTransition } from "../lib/billing.js";

describe("web billing helpers", () => {
  test("formats INR prices cleanly from paise", () => {
    assert.equal(formatInrFromPaise(99900), "₹999");
    assert.equal(formatInrFromPaise(249900), "₹2,499");
    assert.equal(formatInrFromPaise(599900), "₹5,999");
    assert.equal(formatInrFromPaise(null), "Custom");
  });

  test("formats subscription statuses and upgrade transitions", () => {
    assert.deepEqual(formatSubscriptionStatus("active", false), { label: "Active", tone: "success" });
    assert.deepEqual(formatSubscriptionStatus("active", true), { label: "Cancels at Period End", tone: "warning" });
    assert.deepEqual(formatSubscriptionStatus("past_due"), { label: "Past Due", tone: "danger" });
    assert.equal(isUpgradeTransition(99900, 249900), true);
    assert.equal(isUpgradeTransition(599900, 249900), false);
  });
});
