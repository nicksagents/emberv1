import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFailoverCause,
  clearFailoverMetrics,
  getFailoverMetricsSnapshot,
  isProviderAvailable,
  recordFailoverEvent,
  recordProviderFailure,
  recordProviderSuccess,
} from "./failover.js";

test("classifyFailoverCause maps common failure categories", () => {
  assert.equal(classifyFailoverCause("Dispatch timed out after 10000ms."), "timeout");
  assert.equal(classifyFailoverCause("HTTP 429 rate limit exceeded."), "rate-limit");
  assert.equal(classifyFailoverCause("401 invalid API token"), "auth");
  assert.equal(classifyFailoverCause("socket hang up ECONNRESET"), "network");
  assert.equal(classifyFailoverCause("provider unavailable and disconnected"), "provider-status");
  assert.equal(classifyFailoverCause("model context window exceeded"), "model-error");
});

test("recordFailoverEvent tracks counts by cause, role, and switch type", () => {
  clearFailoverMetrics();
  recordFailoverEvent({
    role: "director",
    fromProviderId: "provider_a",
    fromModelId: "model_alpha",
    toProviderId: "provider_b",
    toModelId: "model_beta",
    cause: "timeout",
    reason: "failover to alternate provider after repeated timeout",
  });
  recordFailoverEvent({
    role: "director",
    fromProviderId: "provider_b",
    fromModelId: "model_beta",
    toProviderId: "provider_b",
    toModelId: "model_gamma",
    cause: "model-error",
    reason: "fallback to smaller model",
  });

  const snapshot = getFailoverMetricsSnapshot(10);
  assert.equal(snapshot.totalEvents, 2);
  assert.equal(snapshot.providerSwitches, 1);
  assert.equal(snapshot.modelSwitches, 2);
  assert.equal(snapshot.byCause.timeout, 1);
  assert.equal(snapshot.byCause["model-error"], 1);
  assert.equal(snapshot.byRole.director, 2);
  assert.equal(snapshot.recentEvents.length, 2);
  assert.deepEqual(snapshot.circuitBreakers, {});
});

test("circuit breaker opens after repeated failures and filters provider", () => {
  clearFailoverMetrics();
  const now = Date.UTC(2026, 2, 17, 12, 0, 0);
  const providerId = "provider_dead";

  assert.equal(isProviderAvailable(providerId, now), true);
  recordProviderFailure(providerId, now + 1_000);
  recordProviderFailure(providerId, now + 2_000);
  assert.equal(isProviderAvailable(providerId, now + 2_500), true);
  recordProviderFailure(providerId, now + 3_000);

  assert.equal(isProviderAvailable(providerId, now + 3_100), false);
  const snapshot = getFailoverMetricsSnapshot();
  assert.equal(snapshot.circuitBreakers[providerId]?.state, "open");
});

test("circuit breaker half-opens after cooldown and allows one probe", () => {
  clearFailoverMetrics();
  const now = Date.UTC(2026, 2, 17, 12, 0, 0);
  const providerId = "provider_probe";

  recordProviderFailure(providerId, now + 1_000);
  recordProviderFailure(providerId, now + 2_000);
  recordProviderFailure(providerId, now + 3_000);
  assert.equal(isProviderAvailable(providerId, now + 3_100), false);

  const afterReset = now + 65_000;
  assert.equal(isProviderAvailable(providerId, afterReset), true);
  assert.equal(isProviderAvailable(providerId, afterReset + 100), false);
  recordProviderSuccess(providerId, afterReset + 200);
  assert.equal(isProviderAvailable(providerId, afterReset + 300), true);

  const snapshot = getFailoverMetricsSnapshot();
  assert.equal(snapshot.circuitBreakers[providerId]?.state, "closed");
});
