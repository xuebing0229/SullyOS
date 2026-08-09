/**
 * Local compatibility boundary for upstream feature telemetry.
 *
 * This fork does not ship an analytics backend. Active Message 2.0 still calls
 * this hook at useful product milestones, so keep the API while deliberately
 * performing no network or storage work.
 */
export function trackEvent(
  _event: string,
  _properties?: Record<string, string | number | boolean | null | undefined>,
): void {
  // Intentionally local and silent.
}

