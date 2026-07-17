import { openaiCompatibleBackend } from '../../src/backends/openai-compatible';
import { BackendError } from '../../src/errors';
import type { ChatCompletionRequest } from '../../src/types';
import { createFakeFetch } from '../helpers/fake-fetch';

const REQUEST: ChatCompletionRequest = {
  messages: [{ role: 'user', content: 'Hi' }],
  model: 'gpt-x',
  max_tokens: 64,
  temperature: 0.2,
  top_p: 0.9,
  stop: ['\n'],
};

const OPENAI_RESPONSE = {
  id: 'chatcmpl-1',
  created: 1_700_000_000,
  model: 'gpt-x',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

describe('openaiCompatibleBackend — request mapping', () => {
  it('POSTs to <baseURL>/chat/completions with a bearer token and JSON body', async () => {
    const { fetch, calls } = createFakeFetch({ json: OPENAI_RESPONSE });
    const backend = openaiCompatibleBackend({
      baseURL: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      fetch,
    });

    await backend.createChatCompletion(REQUEST);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://api.example.com/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect((call.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(call.body).toMatchObject({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['\n'],
    });
  });

  it('falls back to the configured default model when the request omits one', async () => {
    const { fetch, calls } = createFakeFetch({ json: OPENAI_RESPONSE });
    const backend = openaiCompatibleBackend({
      baseURL: 'https://x',
      model: 'default-model',
      fetch,
    });
    await backend.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect((calls[0].body as { model: string }).model).toBe('default-model');
  });

  it('omits the Authorization header when no apiKey is given', async () => {
    const { fetch, calls } = createFakeFetch({ json: OPENAI_RESPONSE });
    const backend = openaiCompatibleBackend({ baseURL: 'https://local', fetch });
    await backend.createChatCompletion(REQUEST);
    expect((calls[0].headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe('openaiCompatibleBackend — response mapping', () => {
  it('normalizes into an OpenAI-shaped ChatCompletionResponse', async () => {
    const { fetch } = createFakeFetch({ json: OPENAI_RESPONSE });
    const backend = openaiCompatibleBackend({ baseURL: 'https://x', fetch });
    const res = await backend.createChatCompletion(REQUEST);

    expect(res.object).toBe('chat.completion');
    expect(res.id).toBe('chatcmpl-1');
    expect(res.model).toBe('gpt-x');
    expect(res.choices[0].message.content).toBe('Hello!');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it('preserves tool_calls on the assistant message', async () => {
    const toolResponse = {
      ...OPENAI_RESPONSE,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const { fetch } = createFakeFetch({ json: toolResponse });
    const backend = openaiCompatibleBackend({ baseURL: 'https://x', fetch });
    const res = await backend.createChatCompletion(REQUEST);
    expect(res.choices[0].message.tool_calls?.[0].function.name).toBe('f');
    expect(res.choices[0].finish_reason).toBe('tool_calls');
  });

  it('synthesizes id/created/model when the endpoint omits them, and computes total_tokens', async () => {
    const { fetch } = createFakeFetch({
      json: {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
        usage: { prompt_tokens: 4, completion_tokens: 6 },
      },
    });
    const backend = openaiCompatibleBackend({ baseURL: 'https://x', model: 'm', fetch });
    const res = await backend.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.id).toMatch(/^chatcmpl-/);
    expect(res.created).toBeGreaterThan(0);
    expect(res.model).toBe('m');
    expect(res.usage?.total_tokens).toBe(10);
    expect(res.choices[0].finish_reason).toBeNull();
  });
});

describe('openaiCompatibleBackend — error handling', () => {
  it('throws a BackendError with status on a non-2xx response', async () => {
    const { fetch } = createFakeFetch({ status: 429, text: 'rate limited' });
    const backend = openaiCompatibleBackend({ baseURL: 'https://x', fetch });
    await expect(backend.createChatCompletion(REQUEST)).rejects.toMatchObject({
      name: 'BackendError',
      status: 429,
      responseBody: 'rate limited',
    });
  });

  it('throws a BackendError when the response has no choices', async () => {
    const { fetch } = createFakeFetch({ json: { choices: [] } });
    const backend = openaiCompatibleBackend({ baseURL: 'https://x', fetch });
    await expect(backend.createChatCompletion(REQUEST)).rejects.toBeInstanceOf(BackendError);
  });

  it('wraps a network failure in a BackendError', async () => {
    const failing = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const backend = openaiCompatibleBackend({ baseURL: 'https://x', fetch: failing });
    await expect(backend.createChatCompletion(REQUEST)).rejects.toBeInstanceOf(BackendError);
  });
});
