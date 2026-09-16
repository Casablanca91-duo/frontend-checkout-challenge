import type { Cart, Product } from '@checkout/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpApiError } from '../../api/errors';
import { queryKeys } from '../../lib/query-client';
import { CatalogCart } from './CatalogCart';
import { cartQueryOptions, productsQueryOptions } from './queries';

const api = vi.hoisted(() => ({
  listProducts: vi.fn(),
  getCart: vi.fn(),
  setCartItem: vi.fn(),
  removeCartItem: vi.fn(),
}));

vi.mock('../../runtime', () => ({ checkoutApi: api }));

const products: Product[] = [
  {
    id: 'lamp-orbit',
    sku: 'DEMO-001',
    title: 'Лампа «Орбита»',
    description: 'Свет для рабочего стола.',
    price: 249000,
    currency: 'RUB',
    stock: 10,
  },
  {
    id: 'clock-dot',
    sku: 'DEMO-004',
    title: 'Часы «Точка»',
    description: 'Товар закончился.',
    price: 329000,
    currency: 'RUB',
    stock: 0,
  },
];

const emptyCart: Cart = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 0,
  items: [],
  quantity: 0,
  subtotal: 0,
  currency: 'RUB',
};

const filledCart: Cart = {
  ...emptyCart,
  version: 1,
  items: [
    {
      productId: 'lamp-orbit',
      title: 'Лампа «Орбита»',
      unitPrice: 249000,
      quantity: 2,
      lineTotal: 498000,
    },
  ],
  quantity: 2,
  subtotal: 498000,
};

function renderCatalog(cart = emptyCart) {
  api.listProducts.mockResolvedValue(products);
  api.getCart.mockResolvedValue(cart);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CatalogCart sessionScope="scope-1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return queryClient;
}

describe('Catalog and Cart', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the public Products key and only the canonical session Cart key', () => {
    expect(productsQueryOptions.queryKey).toEqual(['public', 'products']);
    expect(cartQueryOptions('scope-1').queryKey).toEqual(['session', 'scope-1', 'cart']);
    expect(queryKeys.cart('scope-1')).toEqual(['session', 'scope-1', 'cart']);
  });

  it('renders the empty Cart and prevents adding an unavailable Product', async () => {
    renderCatalog();

    expect(await screen.findByText('Корзина пуста')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Добавить «Часы «Точка»» в корзину' }),
    ).toBeDisabled();
    expect(screen.getAllByText('Нет в наличии')).toHaveLength(2);
  });

  it('adds with the next absolute quantity and displays only server Cart totals', async () => {
    const authoritative: Cart = {
      ...filledCart,
      version: 2,
      items: [{ ...filledCart.items[0], quantity: 3, lineTotal: 888800 }],
      quantity: 3,
      subtotal: 999900,
    };
    api.setCartItem.mockResolvedValue(authoritative);
    const queryClient = renderCatalog(filledCart);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Добавить «Лампа «Орбита»» в корзину' }),
    );

    await waitFor(() => expect(api.setCartItem).toHaveBeenCalledWith('lamp-orbit', 3));
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.cart('scope-1'))).toEqual(authoritative),
    );
    expect(screen.getByText(/9.?999/)).toBeInTheDocument();
    expect(screen.getByText(/8.?888/)).toBeInTheDocument();
  });

  it('does not restore an older Cart response after a successful mutation', async () => {
    const authoritative: Cart = {
      ...filledCart,
      version: 2,
      items: [{ ...filledCart.items[0], quantity: 3, lineTotal: 747000 }],
      quantity: 3,
      subtotal: 747000,
    };
    api.setCartItem.mockResolvedValue(authoritative);
    const queryClient = renderCatalog(filledCart);
    await screen.findByRole('button', { name: 'Добавить «Лампа «Орбита»» в корзину' });

    let resolveOldCart!: (cart: Cart) => void;
    api.getCart.mockImplementationOnce(
      () => new Promise<Cart>((resolve) => (resolveOldCart = resolve)),
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.cart('scope-1') });
    await waitFor(() => expect(api.getCart).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Добавить «Лампа «Орбита»» в корзину' }));
    await waitFor(() =>
      expect(queryClient.getQueryData<Cart>(queryKeys.cart('scope-1'))?.version).toBe(2),
    );

    await act(async () => resolveOldCart(filledCart));
    expect(queryClient.getQueryData<Cart>(queryKeys.cart('scope-1'))?.version).toBe(2);
  });

  it('keeps a newer canonical Cart when an older mutation response arrives', async () => {
    let resolveMutation!: (cart: Cart) => void;
    api.setCartItem.mockImplementation(
      () => new Promise<Cart>((resolve) => (resolveMutation = resolve)),
    );
    const queryClient = renderCatalog(filledCart);
    const add = await screen.findByRole('button', { name: 'Добавить «Лампа «Орбита»» в корзину' });
    fireEvent.click(add);
    await waitFor(() => expect(api.setCartItem).toHaveBeenCalledOnce());

    const newerCart = { ...filledCart, version: 3 };
    act(() => queryClient.setQueryData(queryKeys.cart('scope-1'), newerCart));
    await act(async () => resolveMutation({ ...filledCart, version: 2 }));
    expect(queryClient.getQueryData(queryKeys.cart('scope-1'))).toEqual(newerCart);
  });

  it('announces a pending mutation and blocks repeated clicks', async () => {
    let resolveMutation: ((cart: Cart) => void) | undefined;
    api.setCartItem.mockImplementation(
      () => new Promise<Cart>((resolve) => (resolveMutation = resolve)),
    );
    renderCatalog();
    const add = await screen.findByRole('button', { name: 'Добавить «Лампа «Орбита»» в корзину' });

    fireEvent.click(add);

    expect(
      await screen.findByRole('button', { name: 'Добавить «Лампа «Орбита»» в корзину' }),
    ).toBeDisabled();
    expect(screen.getByText('Добавляем…')).toBeInTheDocument();
    fireEvent.click(add);
    expect(api.setCartItem).toHaveBeenCalledOnce();
    resolveMutation?.(filledCart);
  });

  it('removes an item and replaces the canonical cache with the server Cart', async () => {
    const removedCart = { ...emptyCart, version: 2 };
    api.removeCartItem.mockResolvedValue(removedCart);
    const queryClient = renderCatalog(filledCart);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Удалить «Лампа «Орбита»» из корзины' }),
    );

    await waitFor(() => expect(api.removeCartItem).toHaveBeenCalledWith('lamp-orbit'));
    await waitFor(() => expect(screen.getByText('Корзина пуста')).toBeInTheDocument());
    expect(queryClient.getQueryData(queryKeys.cart('scope-1'))).toEqual(removedCart);
  });

  it('offers retry for a Catalog loading error', async () => {
    api.listProducts.mockRejectedValue(new Error('Каталог временно недоступен.'));
    api.getCart.mockResolvedValue(emptyCart);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <CatalogCart sessionScope="scope-error" />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Каталог временно недоступен.');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeEnabled();
  });

  it('shows a recoverable stock conflict and synchronizes active Products and Cart', async () => {
    api.setCartItem.mockRejectedValue(
      new HttpApiError(
        409,
        'INSUFFICIENT_STOCK',
        'Доступно не более 2 шт.',
        undefined,
        'request-conflict',
      ),
    );
    renderCatalog();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Добавить «Лампа «Орбита»» в корзину' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Доступно не более 2 шт.');
    await waitFor(() => {
      expect(api.listProducts).toHaveBeenCalledTimes(2);
      expect(api.getCart).toHaveBeenCalledTimes(2);
    });
    expect(api.setCartItem).toHaveBeenCalledOnce();
  });
});
