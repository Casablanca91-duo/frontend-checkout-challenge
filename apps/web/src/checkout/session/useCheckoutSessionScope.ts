import { useOutletContext } from 'react-router-dom';

export function useCheckoutSessionScope(): string {
  return useOutletContext<{ sessionScope: string }>().sessionScope;
}
