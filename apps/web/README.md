# Checkout frontend

Stage 1 содержит Vite/React foundation, единый API transport и восстановление гостевой сессии.

Из корня repository:

```sh
npm run dev:web
npm run typecheck:web
npm run test:web
npm run build:web
```

По умолчанию frontend обращается к `http://localhost:4000`. Другой адрес можно задать через `VITE_API_BASE_URL`.
