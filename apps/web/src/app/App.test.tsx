import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const session = vi.hoisted(() => ({
  state: {
    status: 'loading' as 'loading' | 'ready' | 'error',
    sessionScope: null as string | null,
    error: null as unknown,
    retry: vi.fn(),
  },
}));

vi.mock('../checkout/session/SessionProvider', () => ({
  useSession: () => session.state,
}));

describe('foundation shell', () => {
  beforeEach(() => {
    session.state.retry.mockClear();
  });

  it('shows a recoverable error action and invokes Retry', () => {
    session.state.status = 'error';
    session.state.error = new Error('offline');

    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось подготовить checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(session.state.retry).toHaveBeenCalledOnce();
  });
});
