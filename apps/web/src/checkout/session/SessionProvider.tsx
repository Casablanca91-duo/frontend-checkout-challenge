import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { checkoutApi, recoveryStorage } from '../../runtime';
import { sessionCredential } from '../../lib/session-credential';
import { bootstrapSession } from './bootstrap';

type SessionState =
  | { status: 'loading'; sessionScope: null; error: null }
  | { status: 'ready'; sessionScope: string; error: null }
  | { status: 'error'; sessionScope: null; error: unknown };

type SessionContextValue = SessionState & { retry(): void };

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const [state, setState] = useState<SessionState>({
    status: 'loading',
    sessionScope: null,
    error: null,
  });

  const runBootstrap = useCallback(() => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const currentGeneration = ++generation.current;
    setState({ status: 'loading', sessionScope: null, error: null });
    void bootstrapSession({
      api: checkoutApi,
      queryClient,
      recoveryStorage,
      tokenAccess: sessionCredential,
      signal: controller.signal,
    }).then(
      (ready) => {
        if (generation.current === currentGeneration) {
          setState({ ...ready, error: null });
        }
      },
      (error: unknown) => {
        if (generation.current === currentGeneration) {
          setState({ status: 'error', sessionScope: null, error });
        }
      },
    );
  }, [queryClient]);

  useEffect(() => {
    runBootstrap();
    return () => {
      generation.current += 1;
      activeRequest.current?.abort();
    };
  }, [runBootstrap]);

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, retry: runBootstrap }),
    [runBootstrap, state],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession должен использоваться внутри SessionProvider.');
  return session;
}
