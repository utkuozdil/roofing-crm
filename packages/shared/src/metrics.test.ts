import { describe, expect, it } from 'vitest';
import { METRIC_ITEMS, failedMetric, predictInvocationCostUsd, processedMetric } from './metrics';

describe('metric names', () => {
  it('derives PascalCase {Item}Processed / {Item}Failed names', () => {
    expect(processedMetric(METRIC_ITEMS.request)).toBe('RequestProcessed');
    expect(failedMetric(METRIC_ITEMS.request)).toBe('RequestFailed');
    expect(processedMetric(METRIC_ITEMS.lead)).toBe('LeadProcessed');
  });
});

describe('predictInvocationCostUsd', () => {
  it('charges the per-request floor even for a zero-duration invocation', () => {
    expect(predictInvocationCostUsd(0, 512)).toBeCloseTo(0.0000002, 12);
  });

  it('scales with both memory and duration', () => {
    const cheap = predictInvocationCostUsd(100, 512);
    const pricier = predictInvocationCostUsd(200, 1024);
    expect(pricier).toBeGreaterThan(cheap);
  });
});
