# Browser E2E Testing

Portivox includes a Playwright-based browser validation layer for customer flows, admin flows, responsive layouts, and visual baselines.

## What is covered

- authentication flows
- customer tunnel dashboard flows
- API key management
- admin overview, gateway, and TCP views
- traffic inspector flows
- responsive layouts at mobile, tablet, and desktop widths
- visual baseline snapshots for key screens

## Test files

- `tests/e2e/auth.spec.ts`
- `tests/e2e/customer.spec.ts`
- `tests/e2e/admin.spec.ts`
- `tests/e2e/inspector.spec.ts`
- `tests/e2e/responsive.spec.ts`
- `tests/e2e/visual.spec.ts`

## Local commands

List tests:

```bash
npm run test:e2e:list
```

Run the full browser suite:

```bash
npm run test:e2e
```

Run only visual baseline checks:

```bash
npm run test:e2e:visual
```

Update visual snapshots after an intentional UI change:

```bash
npm run test:e2e:update-snapshots
```

## How the suite works

- Playwright starts the frontend dev server from `apps/frontend`
- Playwright starts a mock gateway from `tests/e2e/mock-gateway.cjs`
- the mock gateway provides deterministic test data and realtime event endpoints
- visual tests freeze browser time and disable motion for stable snapshots

## Snapshot files

Visual baselines are stored in:

- `tests/e2e/visual.spec.ts-snapshots/`

These files are expected to be committed when UI changes are intentional.

## Disposable output

These folders are generated during local runs and are ignored by git:

- `playwright-report/`
- `test-results/`
- `.codex-temp/`

## CI

GitHub Actions runs the browser E2E suite in the `browser-e2e` job in:

- `.github/workflows/ci.yml`

The publish step depends on browser E2E success, so UI regressions block npm client release automatically.
