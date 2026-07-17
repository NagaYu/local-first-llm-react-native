import {
  executorchBackend,
  mergeGenerationConfig,
  toExecutorchMessages,
} from '../../src/backends/executorch';
import type { ExecutorchLLMModule } from '../../src/backends/executorch';
import { BackendError } from '../../src/errors';
import type { ChatMessage } from '../../src/types';

/** A controllable fake standing in for react-native-executorch's LLMModule instance. */
class FakeLLMModule implements ExecutorchLLMModule {
  lastMessages: { role: string; content: string }[] = [];
  lastTools: object[] | undefined;
  lastGenerationConfig: unknown;
  tokenCb?: (token: string) => void;
  generatedTokens = 0;
  promptTokens = 7;
  interrupted = false;
  deleted = false;

  constructor(private opts: { text?: string; emit?: string[]; tokenCountPerEmit?: number } = {}) {}

  async generate(messages: { role: string; content: string }[], tools?: object[]): Promise<string> {
    this.lastMessages = messages;
    this.lastTools = tools;
    for (const t of this.opts.emit ?? []) {
      if (this.interrupted) break;
      this.generatedTokens += this.opts.tokenCountPerEmit ?? 1;
      this.tokenCb?.(t);
    }
    return this.opts.text ?? 'ok';
  }
  configure(config: { generationConfig?: unknown }): void {
    this.lastGenerationConfig = config.generationConfig;
  }
  setTokenCallback(config: { tokenCallback: (token: string) => void }): void {
    this.tokenCb = config.tokenCallback;
  }
  interrupt(): void {
    this.interrupted = true;
  }
  delete(): void {
    this.deleted = true;
  }
  getPromptTokensCount(): number {
    return this.promptTokens;
  }
  getGeneratedTokenCount(): number {
    return this.generatedTokens;
  }
}

describe('toExecutorchMessages', () => {
  it('passes system/user/assistant through and folds tool into user', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null },
      { role: 'tool', content: 'result', tool_call_id: 'c' },
    ];
    expect(toExecutorchMessages(messages)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'result' },
    ]);
  });
});

describe('mergeGenerationConfig', () => {
  it('maps top_p → topP and overrides base with request values', () => {
    expect(
      mergeGenerationConfig(
        { temperature: 0.1, minP: 0.05 },
        {
          messages: [],
          temperature: 0.9,
          top_p: 0.7,
        },
      ),
    ).toEqual({ temperature: 0.9, minP: 0.05, topP: 0.7 });
  });

  it('returns undefined when nothing is configured', () => {
    expect(mergeGenerationConfig(undefined, { messages: [] })).toBeUndefined();
  });
});

describe('executorchBackend — createChatCompletion (injected module)', () => {
  it('generates from mapped messages and reports usage + stop', async () => {
    const module = new FakeLLMModule({ text: 'hello' });
    const backend = executorchBackend({ module });
    const res = await backend.createChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
    });

    expect(module.lastMessages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(module.lastGenerationConfig).toEqual({ temperature: 0.3 });
    expect(res.choices[0].message.content).toBe('hello');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 });
    expect(backend.kind).toBe('on-device');
  });

  it('streams tokens through options.onToken', async () => {
    const module = new FakeLLMModule({ text: 'abc', emit: ['a', 'b', 'c'] });
    const backend = executorchBackend({ module });
    const seen: string[] = [];
    await backend.createChatCompletion(
      { messages: [{ role: 'user', content: 'hi' }] },
      { onToken: (t) => seen.push(t) },
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('enforces max_tokens by interrupting and reports finish_reason=length', async () => {
    const module = new FakeLLMModule({ text: 'partial', emit: ['t1', 't2', 't3', 't4', 't5'] });
    const backend = executorchBackend({ module });
    const res = await backend.createChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 2,
    });
    expect(module.interrupted).toBe(true);
    expect(res.choices[0].finish_reason).toBe('length');
    expect(module.generatedTokens).toBeLessThanOrEqual(3); // stopped at/just past the cap
  });

  it('uses a custom loadModule and wraps generation errors in a BackendError', async () => {
    const module = new FakeLLMModule();
    module.generate = async () => {
      throw new Error('native boom');
    };
    const backend = executorchBackend({ loadModule: async () => module });
    await expect(
      backend.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it('probeCapability returns on-device-full when the model loads', async () => {
    const backend = executorchBackend({ module: new FakeLLMModule() });
    await expect(backend.probeCapability?.()).resolves.toBe('on-device-full');
  });

  it('probeCapability returns not-viable when loading fails', async () => {
    const backend = executorchBackend({
      loadModule: async () => {
        throw new Error('cannot load');
      },
    });
    await expect(backend.probeCapability?.()).resolves.toBe('not-viable');
  });

  it('dispose interrupts and deletes the module', async () => {
    const module = new FakeLLMModule();
    const backend = executorchBackend({ module });
    await backend.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    await backend.dispose?.();
    expect(module.deleted).toBe(true);
  });

  it('throws a clear BackendError when no model sources are configured', async () => {
    // No module / loadModule / sources → resolveSources should fail on load.
    const backend = executorchBackend({});
    await expect(
      backend.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/react-native-executorch|modelSource/);
  });
});
