import { createBrowserRouter } from 'react-router-dom';
import { CatalogCart } from '../checkout/catalog-cart/CatalogCart';
import { CheckoutPage } from '../checkout/form/CheckoutPage';
import { useCheckoutSessionScope } from '../checkout/session/useCheckoutSessionScope';
import { App } from './App';

function CatalogRoute() {
  return <CatalogCart sessionScope={useCheckoutSessionScope()} />;
}

function CheckoutRoute() {
  return <CheckoutPage sessionScope={useCheckoutSessionScope()} />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <CatalogRoute /> },
      { path: 'checkout', element: <CheckoutRoute /> },
    ],
  },
]);
