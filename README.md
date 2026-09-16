# Checkout challenge

This repository contains the challenge API and a React checkout in `apps/web`. The frontend uses the supplied sandbox only; no real card details are entered.

Challenge references: [assignment](docs/ASSIGNMENT.md), [integration](docs/INTEGRATION.md), and [evaluation](docs/EVALUATION.md). The separate [React Flow canvas challenge](https://github.com/instatdigital/frontend-canvas-challenge) remains a separate submission.

## Requirements and run

Use Node.js 24.x and npm 11.x. From the repository root:

```sh
npm ci
npm run dev       # API at http://localhost:4000
npm run dev:web   # Vite at http://127.0.0.1:5173, in a second terminal
```

`VITE_API_BASE_URL` can override the frontend API URL. The API uses `.data/store.json` for demo data and requires no external account. For a production API build, run `npm run build` and then `npm start`. The API reference is in `docs/INTEGRATION.md` and `docs/openapi.json`.

Run one API instance per data file. To reset the demo data, stop the API and run `npm run data:reset`; then start it and create a new session. Test contacts such as `buyer@example.test` are sufficient.

## Checks

```sh
npm run typecheck:web
npm run test:web
npm run build:web
npm run check       # format, API build/tests, OpenAPI consistency
npm run smoke       # with npm start running in another terminal
npx playwright install chromium
npm run test:e2e    # starts the API and Vite through Playwright webServer
```

`npm run test:e2e -- --project=desktop` runs the 1280px project; `--project=mobile` runs the 390px project. Each Playwright test creates a separate guest session. CI runs root checks, web typecheck/tests/build, Chromium E2E, and API smoke. The smoke step starts the built API independently.

## Architecture and recovery

`apiClient` owns fetch, base URL, common headers, JSON encoding, response envelopes, empty responses, and error normalization. `checkoutApi` describes individual endpoints. TanStack Query owns server state: public keys begin with `['public', ...]`, authenticated keys with `['session', sessionScope, ...]`, and the Cart has one canonical entry. Cart, Quote, Order, and Payment amounts and statuses come from the API.

Versioned local storage holds only session credentials and recovery metadata. Bootstrap validates a saved session against the API. A Quote is accepted only for its current request revision, normalized Cart-version/delivery signature, and canonical Cart version; an old response cannot restore a stale Quote. Order and Payment creation persist one exact serialized body and `Idempotency-Key` before sending. Unknown outcomes replay that same body/key; a known terminal Payment permits a new attempt with a new key on the same Order. Simulation keeps its chosen scenario for the attempt, polls using `Retry-After`, and stops at a terminal result or unmount. Card success is shown only after an authoritative Order has both `status=paid` and `paymentStatus=succeeded`. Cash creates no Payment.

Playwright covers card success, decline and retry, cancellation and a new attempt, reload recovery, cash without Payment, and stale Cart/Quote recovery on desktop and mobile. Double clicks are exercised on Order and Payment creation. Unit tests cover exact idempotent replay after uncertain outcomes; browser E2E does not intercept a processed response because the browser cannot deterministically know whether the server committed it without changing production behavior. The E2E suite also checks horizontal overflow and reachable payment controls. Focus, labels, radio/select behavior, errors, and status announcements receive a keyboard smoke during final validation; this is not a full accessibility audit.

Known limits: if `currentOrderId` is lost, the Order list has no reliable originating idempotency key or Quote ID with which to match an unresolved local intent. Separate tabs do not have coordinated mutation locking.

## Performance review

`CatalogCart` builds `cartItemsByProduct` and `productsById` maps once per respective query result. For `c` Cart items and `p` products, construction takes one pass over each collection, `O(c + p)` time and `O(c + p)` additional space. Rendering the product and Cart lists then uses expected `O(1)` lookups per row, for `O(p + c)` total time. Repeated `.find()` calls for each rendered row would take up to `O(p × c)` time. The maps are memoized by the server-result array references, so local UI changes do not rebuild them. The collections are small here, but the indexing avoids a real nested-search cost without introducing persistent cache invalidation rules.
