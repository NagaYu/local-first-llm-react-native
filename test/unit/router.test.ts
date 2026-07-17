import { NoBackendError, RoutingBlockedError } from '../../src/errors';
import type { Capability } from '../../src/policy/types';
import { createRouter } from '../../src/router';
import type { Backend, ChatCompletionResponse } from '../../src/types';

function response(id: string): ChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: id }, finish_reason: 'stop' }],
  };
}

interface FakeBackendOptions {
  kind: Backend['kind'];
  id: string;
  fail?: boolean;
  probe?: Capability;
}

function fakeBackend(opts: FakeBackendOptions): Backend & { calls: number } {
  const backend = {
    id: opts.id,
    kind: opts.kind,
    calls: 0,
    async createChatCompletion() {
      this.calls += 1;
      if (opts.fail) throw new Error(`${opts.id} failed`);
      return response(opts.id);
    },
    ...(opts.probe ? { probeCapability: () => opts.probe as Capability } : {}),
  };
  return backend;
}

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

describe('createRouter — routing', () => {
  it('routes a classification hint on-device when capability is full', async () => {
    const onDevice = fakeBackend({ kind: 'on-device', id: 'exec', probe: 'on-device-full' });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ onDevice, cloud });

    const res = await router.chat.completions.create({
      messages: MESSAGES,
      hint: 'classification',
    });
    expect(res.routedTo).toBe('on-device');
    expect(res.id).toBe('exec');
    expect(res.fellBack).toBe(false);
    expect(res.routingReason).toMatch(/on-device/);
    expect(onDevice.calls).toBe(1);
    expect(cloud.calls).toBe(0);
  });

  it('routes a chat hint to the cloud', async () => {
    const onDevice = fakeBackend({ kind: 'on-device', id: 'exec', probe: 'on-device-full' });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ onDevice, cloud });

    const res = await router.chat.completions.create({ messages: MESSAGES, hint: 'chat' });
    expect(res.routedTo).toBe('cloud');
    expect(res.id).toBe('cloud');
  });

  it('honors an explicit capability override on the request', async () => {
    const onDevice = fakeBackend({ kind: 'on-device', id: 'exec' });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ onDevice, cloud });
    // classification prefers on-device, but override says not-viable → cloud fallback.
    const res = await router.chat.completions.create({
      messages: MESSAGES,
      hint: 'classification',
      capability: 'not-viable',
    });
    expect(res.routedTo).toBe('cloud');
    expect(res.routingCode).toBe('capability-fallback');
  });
});

describe('createRouter — sensitive privacy', () => {
  it('routes sensitive requests on-device', async () => {
    const onDevice = fakeBackend({ kind: 'on-device', id: 'exec', probe: 'on-device-full' });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ onDevice, cloud });
    const res = await router.chat.completions.create({
      messages: MESSAGES,
      hint: 'chat',
      privacy: 'sensitive',
    });
    expect(res.routedTo).toBe('on-device');
  });

  it('blocks a sensitive request when on-device is not viable (never cloud)', async () => {
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ cloud }); // no on-device backend → capability not-viable
    await expect(
      router.chat.completions.create({
        messages: MESSAGES,
        privacy: 'sensitive',
        hint: 'classification',
      }),
    ).rejects.toBeInstanceOf(RoutingBlockedError);
    expect(cloud.calls).toBe(0);
  });

  it('never falls back a sensitive on-device request to the cloud on failure', async () => {
    const onDevice = fakeBackend({
      kind: 'on-device',
      id: 'exec',
      fail: true,
      probe: 'on-device-full',
    });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ onDevice, cloud });
    await expect(
      router.chat.completions.create({
        messages: MESSAGES,
        privacy: 'sensitive',
        hint: 'classification',
      }),
    ).rejects.toThrow(/exec failed/);
    expect(cloud.calls).toBe(0);
  });
});

describe('createRouter — bounded fallback', () => {
  it('falls back to cloud once when the on-device primary fails', async () => {
    const onDevice = fakeBackend({
      kind: 'on-device',
      id: 'exec',
      fail: true,
      probe: 'on-device-full',
    });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ onDevice, cloud });
    const res = await router.chat.completions.create({
      messages: MESSAGES,
      hint: 'classification',
    });
    expect(res.routedTo).toBe('cloud');
    expect(res.fellBack).toBe(true);
    expect(res.routingReason).toMatch(/did not succeed.*served by 'cloud'/);
    expect(onDevice.calls).toBe(1);
    expect(cloud.calls).toBe(1);
  });

  it('does not fall back when disabled', async () => {
    const onDevice = fakeBackend({
      kind: 'on-device',
      id: 'exec',
      fail: true,
      probe: 'on-device-full',
    });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud' });
    const router = createRouter({ onDevice, cloud, fallback: { enabled: false } });
    await expect(
      router.chat.completions.create({ messages: MESSAGES, hint: 'classification' }),
    ).rejects.toThrow(/exec failed/);
    expect(cloud.calls).toBe(0);
  });

  it('throws NoBackendError when the chosen mode has no backend and no fallback exists', async () => {
    const onDevice = fakeBackend({ kind: 'on-device', id: 'exec', probe: 'on-device-full' });
    const router = createRouter({ onDevice, fallback: { enabled: false } });
    // chat prefers cloud, but no cloud backend and fallback disabled.
    await expect(
      router.chat.completions.create({ messages: MESSAGES, hint: 'chat' }),
    ).rejects.toBeInstanceOf(NoBackendError);
  });

  it('falls back cloud→on-device when cloud fails and capability is viable', async () => {
    const onDevice = fakeBackend({ kind: 'on-device', id: 'exec', probe: 'on-device-full' });
    const cloud = fakeBackend({ kind: 'cloud', id: 'cloud', fail: true });
    const router = createRouter({ onDevice, cloud });
    const res = await router.chat.completions.create({ messages: MESSAGES, hint: 'chat' });
    expect(res.routedTo).toBe('on-device');
    expect(res.fellBack).toBe(true);
  });

  it('serves the fallback mode (clean reason) when the primary mode has no backend', async () => {
    // chat prefers cloud, but only on-device is configured; capability is viable.
    const onDevice = fakeBackend({ kind: 'on-device', id: 'exec', probe: 'on-device-full' });
    const router = createRouter({ onDevice });
    const res = await router.chat.completions.create({ messages: MESSAGES, hint: 'chat' });
    expect(res.routedTo).toBe('on-device');
    expect(res.fellBack).toBe(true);
    expect(res.routingReason).toMatch(/No backend configured for 'cloud'/);
    expect(res.routingReason).not.toMatch(/undefined/);
  });
});

describe('createRouter — dispose', () => {
  it('disposes configured backends', async () => {
    let disposed = false;
    const onDevice: Backend = {
      id: 'exec',
      kind: 'on-device',
      createChatCompletion: async () => response('exec'),
      dispose: () => {
        disposed = true;
      },
    };
    const router = createRouter({ onDevice });
    await router.dispose();
    expect(disposed).toBe(true);
  });
});
