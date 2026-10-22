import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/sse', () => ({ connectSSE: () => () => undefined, subscribeConnectionState: () => () => undefined }));

describe('App boot', () => {
  it('renders the whole provider tree without crashing (queries live inside QueryClientProvider)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const { App } = await import('../App');
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
    expect(() => render(<App />)).not.toThrow();
    expect(errors.some((args) => String(args).includes('No QueryClient set'))).toBe(false);
    spy.mockRestore();
    vi.unstubAllGlobals();
  });
});
