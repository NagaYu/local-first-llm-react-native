import { builtinCapabilityProvider } from '../../src/capability/builtin';
import type { Capability } from '../../src/policy/types';
import type { Backend } from '../../src/types';

function fakeBackend(probe?: () => Promise<Capability> | Capability): Backend {
  return {
    id: 'fake',
    kind: 'on-device',
    createChatCompletion: async () => {
      throw new Error('unused');
    },
    ...(probe ? { probeCapability: probe } : {}),
  };
}

describe('builtinCapabilityProvider', () => {
  it('returns not-viable when there is nothing to probe', async () => {
    const provider = builtinCapabilityProvider();
    expect(await provider.getCapability()).toBe('not-viable');
  });

  it('returns on-device-full when a backend is present but exposes no probe', async () => {
    const provider = builtinCapabilityProvider({ backend: fakeBackend() });
    expect(await provider.getCapability()).toBe('on-device-full');
  });

  it("uses the backend's probeCapability when available", async () => {
    const provider = builtinCapabilityProvider({
      backend: fakeBackend(async () => 'on-device-degraded'),
    });
    expect(await provider.getCapability()).toBe('on-device-degraded');
  });

  it('prefers an explicit custom probe over the backend', async () => {
    const provider = builtinCapabilityProvider({
      backend: fakeBackend(async () => 'on-device-full'),
      probe: async () => 'not-viable',
    });
    expect(await provider.getCapability()).toBe('not-viable');
  });

  it('treats a throwing probe as not-viable', async () => {
    const provider = builtinCapabilityProvider({
      probe: () => {
        throw new Error('load failed');
      },
    });
    expect(await provider.getCapability()).toBe('not-viable');
  });

  it('caches the first result by default', async () => {
    let calls = 0;
    const provider = builtinCapabilityProvider({
      probe: async () => {
        calls += 1;
        return 'on-device-full';
      },
    });
    await provider.getCapability();
    await provider.getCapability();
    expect(calls).toBe(1);
  });

  it('re-probes every call when caching is disabled', async () => {
    let calls = 0;
    const provider = builtinCapabilityProvider({
      cache: false,
      probe: async () => {
        calls += 1;
        return 'on-device-full';
      },
    });
    await provider.getCapability();
    await provider.getCapability();
    expect(calls).toBe(2);
  });
});
