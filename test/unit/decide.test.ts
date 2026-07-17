import { decide } from '../../src/policy/decide';
import type { Capability, DecideInput, PolicyConfig, TaskHint } from '../../src/policy/types';

/** Convenience: run decide with sane defaults for the fields a case doesn't care about. */
function run(partial: Partial<DecideInput>, config?: PolicyConfig) {
  const input: DecideInput = { capability: 'on-device-full', ...partial };
  return decide(input, config);
}

const ON_DEVICE_HINTS: TaskHint[] = ['classification', 'extraction', 'summarization'];
const CLOUD_HINTS: TaskHint[] = ['chat', 'reasoning', 'creative'];
const ALL_CAPABILITIES: Capability[] = ['on-device-full', 'on-device-degraded', 'not-viable'];

describe('decide() — Step 1: hard sensitive-privacy rule', () => {
  it('forces on-device when capability is full', () => {
    const r = run({ privacy: 'sensitive', hint: 'chat', capability: 'on-device-full' });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('privacy-sensitive');
    expect(r.preferredMode).toBe('on-device');
  });

  it('forces on-device when capability is degraded', () => {
    const r = run({ privacy: 'sensitive', hint: 'reasoning', capability: 'on-device-degraded' });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('privacy-sensitive');
  });

  it('blocks (never cloud) when capability is not-viable', () => {
    const r = run({ privacy: 'sensitive', hint: 'chat', capability: 'not-viable' });
    expect(r.mode).toBe('blocked');
    expect(r.code).toBe('privacy-sensitive-blocked');
    expect(r.reason).toMatch(/blocked rather than routed to the cloud/i);
  });

  it('sensitive wins over a cloud-preferring hint for every capability', () => {
    for (const capability of ALL_CAPABILITIES) {
      const r = run({ privacy: 'sensitive', hint: 'creative', capability });
      expect(r.mode).not.toBe('cloud');
    }
  });

  it('sensitive + not-viable stays blocked even with budgets that would otherwise flip a route', () => {
    const r = run({
      privacy: 'sensitive',
      hint: 'chat',
      capability: 'not-viable',
      latencyBudget: 10_000,
      costBudget: 10_000,
    });
    expect(r.mode).toBe('blocked');
  });

  it('sensitive + long-document summarization still forced on-device (privacy before override)', () => {
    const r = run({
      privacy: 'sensitive',
      hint: 'summarization',
      capability: 'on-device-full',
      request: { inputChars: 50_000 },
    });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('privacy-sensitive');
  });
});

describe('decide() — Step 2/3: taxonomy table + capability cross-reference', () => {
  it.each(ON_DEVICE_HINTS)(
    'hint %s prefers and routes on-device when capability is full',
    (hint) => {
      const r = run({ hint, capability: 'on-device-full' });
      expect(r.preferredMode).toBe('on-device');
      expect(r.mode).toBe('on-device');
      expect(r.code).toBe('task-preference');
    },
  );

  it.each(ON_DEVICE_HINTS)('hint %s still honors on-device when capability is degraded', (hint) => {
    const r = run({ hint, capability: 'on-device-degraded' });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('task-preference');
  });

  it.each(ON_DEVICE_HINTS)('hint %s falls back to cloud when capability is not-viable', (hint) => {
    const r = run({ hint, capability: 'not-viable' });
    expect(r.preferredMode).toBe('on-device');
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('capability-fallback');
  });

  it.each(CLOUD_HINTS)('hint %s prefers and routes cloud regardless of capability', (hint) => {
    for (const capability of ALL_CAPABILITIES) {
      const r = run({ hint, capability });
      expect(r.preferredMode).toBe('cloud');
      expect(r.mode).toBe('cloud');
      expect(r.code).toBe('task-preference');
    }
  });

  it('defaults privacy to normal when omitted', () => {
    const r = run({ hint: 'classification' });
    expect(r.mode).toBe('on-device');
  });

  it('treats an explicit privacy=normal identically', () => {
    const r = run({ hint: 'classification', privacy: 'normal' });
    expect(r.mode).toBe('on-device');
  });
});

describe('decide() — summarization long-document override', () => {
  it('overrides on-device summarization toward cloud at/above the long-document threshold', () => {
    const r = run({ hint: 'summarization', request: { inputChars: 8000 } });
    expect(r.preferredMode).toBe('cloud');
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('summarization-long-document');
  });

  it('does NOT override just below the threshold', () => {
    const r = run({ hint: 'summarization', request: { inputChars: 7999 } });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('task-preference');
  });

  it('respects a custom longDocumentChars threshold', () => {
    const config: PolicyConfig = { heuristics: { longDocumentChars: 100 } };
    const r = run({ hint: 'summarization', request: { inputChars: 150 } }, config);
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('summarization-long-document');
  });

  it('does not apply the override when the summarization row is user-overridden to cloud', () => {
    // Row already prefers cloud → not an "on-device" override situation.
    const config: PolicyConfig = { taxonomy: { summarization: 'cloud' } };
    const r = run({ hint: 'summarization', request: { inputChars: 50_000 } }, config);
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('task-preference');
  });

  it('overridden summarization is unaffected by capability (already cloud)', () => {
    const r = run({
      hint: 'summarization',
      capability: 'not-viable',
      request: { inputChars: 20_000 },
    });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('summarization-long-document');
  });
});

describe('decide() — hint-absent heuristic', () => {
  it('short input + no tools + no output cap → on-device', () => {
    const r = run({ request: { inputChars: 100 } });
    expect(r.preferredMode).toBe('on-device');
    expect(r.mode).toBe('on-device');
    expect(r.reason).toMatch(/heuristic/);
  });

  it('short input + no tools + modest output cap (at threshold) → on-device', () => {
    const r = run({ request: { inputChars: 100, maxOutputTokens: 256 } });
    expect(r.mode).toBe('on-device');
  });

  it('short input + no tools + large output cap (above threshold) → cloud', () => {
    const r = run({ request: { inputChars: 100, maxOutputTokens: 257 } });
    expect(r.preferredMode).toBe('cloud');
    expect(r.mode).toBe('cloud');
  });

  it('long input → cloud', () => {
    const r = run({ request: { inputChars: 5000 } });
    expect(r.mode).toBe('cloud');
  });

  it('input exactly at shortInputMaxChars is still short → on-device', () => {
    const r = run({ request: { inputChars: 280 } });
    expect(r.mode).toBe('on-device');
  });

  it('input one over shortInputMaxChars is long → cloud', () => {
    const r = run({ request: { inputChars: 281 } });
    expect(r.mode).toBe('cloud');
  });

  it('tools present → cloud even with short input', () => {
    const r = run({ request: { inputChars: 10, hasTools: true } });
    expect(r.mode).toBe('cloud');
  });

  it('empty request (no signals) → short/no-tools/no-cap → on-device', () => {
    const r = run({});
    expect(r.mode).toBe('on-device');
  });

  it('no request object at all → on-device (all signals default to cheap)', () => {
    const r = decide({ capability: 'on-device-full' });
    expect(r.mode).toBe('on-device');
  });

  it('falls back to cloud when the inferred on-device is not viable', () => {
    const r = run({ request: { inputChars: 10 }, capability: 'not-viable' });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('capability-fallback');
  });
});

describe('decide() — Step 4: cost budget (pushes cloud → on-device)', () => {
  it('flips a cloud decision to on-device when cloud cost exceeds the budget and on-device is viable', () => {
    const r = run({ hint: 'chat', capability: 'on-device-full', costBudget: 0.5 });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('budget-cost');
  });

  it('keeps cloud (budget-unmet) when cloud cost exceeds budget but on-device is not viable', () => {
    const r = run({ hint: 'chat', capability: 'not-viable', costBudget: 0.5 });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('budget-unmet');
  });

  it('capability-fallback cloud with a tight cost budget cannot move on-device → budget-unmet', () => {
    const r = run({ hint: 'classification', capability: 'not-viable', costBudget: 0.5 });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('budget-unmet');
  });

  it('does not flip when the cost budget comfortably covers cloud', () => {
    const r = run({ hint: 'chat', capability: 'on-device-full', costBudget: 5 });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('task-preference');
  });

  it('keeps cloud (budget-unmet) when even on-device cost exceeds the budget', () => {
    const config: PolicyConfig = { estimates: { onDeviceCost: 2 } };
    const r = run({ hint: 'chat', capability: 'on-device-full', costBudget: 0.5 }, config);
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('budget-unmet');
  });

  it('keeps cloud (budget-unmet) when moving on-device would blow the latency budget', () => {
    const r = run({
      hint: 'chat',
      capability: 'on-device-degraded',
      costBudget: 0.5,
      latencyBudget: 1000, // degraded on-device (5000ms) can't satisfy this
    });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('budget-unmet');
  });
});

describe('decide() — Step 4: latency budget (pushes on-device → cloud)', () => {
  it('flips degraded on-device to cloud when its latency exceeds the budget', () => {
    const r = run({
      hint: 'classification',
      capability: 'on-device-degraded',
      latencyBudget: 2000,
    });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('budget-latency');
  });

  it('degraded on-device is honored when no latency budget is given', () => {
    const r = run({ hint: 'classification', capability: 'on-device-degraded' });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('task-preference');
  });

  it('full on-device (1500ms) is within a 2000ms budget → stays on-device', () => {
    const r = run({ hint: 'classification', capability: 'on-device-full', latencyBudget: 2000 });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('task-preference');
  });

  it('keeps on-device (budget-unmet) when latency is blown but cloud blows the cost budget', () => {
    const r = run({
      hint: 'classification',
      capability: 'on-device-degraded',
      latencyBudget: 2000,
      costBudget: 0.5, // cloud (cost 1) exceeds this
    });
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('budget-unmet');
  });

  it('keeps on-device (budget-unmet) when on-device cost exceeds the budget but cloud is not cheaper', () => {
    const config: PolicyConfig = { estimates: { onDeviceCost: 2, cloudCost: 3 } };
    const r = run(
      { hint: 'classification', capability: 'on-device-full', costBudget: 0.5 },
      config,
    );
    expect(r.mode).toBe('on-device');
    expect(r.code).toBe('budget-unmet');
  });
});

describe('decide() — Step 4: latency budget on the cloud path', () => {
  it('keeps cloud (budget-unmet) when a chat request cannot meet a sub-cloud latency budget', () => {
    const r = run({ hint: 'chat', capability: 'on-device-full', latencyBudget: 500 });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('budget-unmet');
  });

  it('leaves a cloud decision untouched when it fits both budgets', () => {
    const r = run({
      hint: 'chat',
      capability: 'on-device-full',
      latencyBudget: 5000,
      costBudget: 5,
    });
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('task-preference');
  });
});

describe('decide() — config overrides', () => {
  it('honors a taxonomy row override (chat → on-device)', () => {
    const config: PolicyConfig = { taxonomy: { chat: 'on-device' } };
    const r = run({ hint: 'chat', capability: 'on-device-full' }, config);
    expect(r.preferredMode).toBe('on-device');
    expect(r.mode).toBe('on-device');
  });

  it('honors a heuristic threshold override (shortInputMaxChars)', () => {
    const config: PolicyConfig = { heuristics: { shortInputMaxChars: 5 } };
    const r = run({ request: { inputChars: 10 } }, config);
    expect(r.mode).toBe('cloud'); // 10 > 5 → no longer "short"
  });

  it('honors an estimates override that changes a budget outcome', () => {
    // Make cloud cheap enough that a previously-flipping budget no longer flips.
    const config: PolicyConfig = { estimates: { cloudCost: 0.1 } };
    const r = run({ hint: 'chat', capability: 'on-device-full', costBudget: 0.5 }, config);
    expect(r.mode).toBe('cloud');
    expect(r.code).toBe('task-preference');
  });
});

describe('decide() — result contract', () => {
  it('always returns mode, reason, code, and preferredMode', () => {
    const r = run({ hint: 'chat' });
    expect(r).toEqual(
      expect.objectContaining({
        mode: expect.any(String),
        reason: expect.any(String),
        code: expect.any(String),
        preferredMode: expect.any(String),
      }),
    );
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
