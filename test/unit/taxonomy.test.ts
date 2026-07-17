import {
  DEFAULT_ESTIMATES,
  DEFAULT_HEURISTICS,
  DEFAULT_TAXONOMY,
  computeInputChars,
  inferHintlessPreference,
  normalizeRequest,
  resolvePolicyConfig,
  resolvePreferredMode,
} from '../../src/policy/taxonomy';

describe('computeInputChars', () => {
  it('returns 0 for undefined messages', () => {
    expect(computeInputChars(undefined)).toBe(0);
  });

  it('sums string content lengths', () => {
    expect(computeInputChars([{ content: 'hello' }, { content: 'world!' }])).toBe(11);
  });

  it('sums text parts in content-part arrays and ignores non-text parts', () => {
    const messages = [
      {
        content: [
          { type: 'text', text: 'abc' },
          { type: 'image_url', image_url: { url: 'x' } }, // no text → ignored
          { type: 'text', text: 'de' },
        ],
      },
    ];
    expect(computeInputChars(messages)).toBe(5);
  });

  it('ignores null / non-object / text-less parts inside a content array', () => {
    const messages = [
      {
        content: [
          null,
          'a-bare-string-part',
          42,
          { type: 'text' }, // text missing
          { type: 'text', text: 'ok' },
        ],
      },
    ];
    expect(computeInputChars(messages as never)).toBe(2);
  });

  it('ignores content that is neither string nor array', () => {
    expect(computeInputChars([{ content: 42 as never }, { content: undefined }])).toBe(0);
  });
});

describe('normalizeRequest', () => {
  it('defaults everything for an undefined request', () => {
    expect(normalizeRequest(undefined)).toEqual({
      inputChars: 0,
      hasTools: false,
      maxOutputTokens: undefined,
    });
  });

  it('prefers an explicit inputChars over computing from messages', () => {
    const n = normalizeRequest({ inputChars: 999, messages: [{ content: 'x' }] });
    expect(n.inputChars).toBe(999);
  });

  it('computes inputChars from messages when not provided', () => {
    expect(normalizeRequest({ messages: [{ content: 'four' }] }).inputChars).toBe(4);
  });

  it('prefers explicit hasTools over toolCount', () => {
    expect(normalizeRequest({ hasTools: false, toolCount: 5 }).hasTools).toBe(false);
  });

  it('derives hasTools from a positive toolCount', () => {
    expect(normalizeRequest({ toolCount: 2 }).hasTools).toBe(true);
  });

  it('derives hasTools=false from a zero toolCount', () => {
    expect(normalizeRequest({ toolCount: 0 }).hasTools).toBe(false);
  });

  it('defaults hasTools=false when neither hasTools nor toolCount is set', () => {
    expect(normalizeRequest({ inputChars: 1 }).hasTools).toBe(false);
  });

  it('passes maxOutputTokens through', () => {
    expect(normalizeRequest({ maxOutputTokens: 128 }).maxOutputTokens).toBe(128);
  });
});

describe('resolvePolicyConfig', () => {
  it('returns the defaults when no config is provided', () => {
    const c = resolvePolicyConfig();
    expect(c.taxonomy).toEqual(DEFAULT_TAXONOMY);
    expect(c.heuristics).toEqual(DEFAULT_HEURISTICS);
    expect(c.estimates).toEqual(DEFAULT_ESTIMATES);
  });

  it('merges partial overrides over defaults', () => {
    const c = resolvePolicyConfig({
      taxonomy: { chat: 'on-device' },
      heuristics: { shortInputMaxChars: 10 },
      estimates: { cloudCost: 42 },
    });
    expect(c.taxonomy.chat).toBe('on-device');
    expect(c.taxonomy.reasoning).toBe('cloud'); // untouched default preserved
    expect(c.heuristics.shortInputMaxChars).toBe(10);
    expect(c.heuristics.modestMaxOutputTokens).toBe(DEFAULT_HEURISTICS.modestMaxOutputTokens);
    expect(c.estimates.cloudCost).toBe(42);
    expect(c.estimates.onDeviceCost).toBe(DEFAULT_ESTIMATES.onDeviceCost);
  });
});

describe('inferHintlessPreference', () => {
  const h = DEFAULT_HEURISTICS;

  it('short + no tools + no cap → on-device', () => {
    expect(
      inferHintlessPreference({ inputChars: 10, hasTools: false, maxOutputTokens: undefined }, h),
    ).toBe('on-device');
  });

  it('long input → cloud', () => {
    expect(
      inferHintlessPreference(
        { inputChars: 10_000, hasTools: false, maxOutputTokens: undefined },
        h,
      ),
    ).toBe('cloud');
  });

  it('tools → cloud', () => {
    expect(
      inferHintlessPreference({ inputChars: 1, hasTools: true, maxOutputTokens: undefined }, h),
    ).toBe('cloud');
  });

  it('large output cap → cloud', () => {
    expect(
      inferHintlessPreference({ inputChars: 1, hasTools: false, maxOutputTokens: 4096 }, h),
    ).toBe('cloud');
  });
});

describe('resolvePreferredMode', () => {
  const config = resolvePolicyConfig();

  it('uses the heuristic when no hint is given', () => {
    const res = resolvePreferredMode(
      undefined,
      { inputChars: 10, hasTools: false, maxOutputTokens: undefined },
      config,
    );
    expect(res.usedHeuristic).toBe(true);
    expect(res.summarizationOverride).toBe(false);
    expect(res.preferredMode).toBe('on-device');
  });

  it('reads the taxonomy table for a present hint', () => {
    const res = resolvePreferredMode(
      'reasoning',
      { inputChars: 1, hasTools: false, maxOutputTokens: undefined },
      config,
    );
    expect(res.usedHeuristic).toBe(false);
    expect(res.preferredMode).toBe('cloud');
  });

  it('flags the summarization long-document override', () => {
    const res = resolvePreferredMode(
      'summarization',
      { inputChars: 10_000, hasTools: false, maxOutputTokens: undefined },
      config,
    );
    expect(res.summarizationOverride).toBe(true);
    expect(res.preferredMode).toBe('cloud');
  });

  it('does not override short summarization', () => {
    const res = resolvePreferredMode(
      'summarization',
      { inputChars: 100, hasTools: false, maxOutputTokens: undefined },
      config,
    );
    expect(res.summarizationOverride).toBe(false);
    expect(res.preferredMode).toBe('on-device');
  });
});
