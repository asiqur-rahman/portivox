# Release Readiness Checklist

## Build & Test
- [ ] `npm run build`
- [ ] `npm run test:smoke`
- [ ] `npm run test:chunk`
- [ ] `npm run test:audit-replay`
- [ ] `npm run test:api-contract`
- [ ] `npm run test:rate-limit-contract`
- [ ] `npm run test:security-cors-contract`
- [ ] `npm run test:payload-validation-contract`
- [ ] `npm run test:idempotency-contract`
- [ ] `npm run test:audit-query-contract`
- [ ] `npm run test:sdk`
- [ ] `npm run test:auth`
- [ ] `npm run openapi:export`
- [ ] `npm run openapi:check-sdk-compat`
- [ ] Review `docs/runbooks/api-lifecycle-policy.md`
- [ ] `REDIS_URL=... npm run test:redis-registry` (if redis mode enabled)

## Security & Access
- [ ] Auth mode verified (`AUTH_REQUIRED`)
- [ ] Static keys rotated (if used)
- [ ] JWT scopes/roles verified for admin ops

## Database
- [ ] `npm run db:migrate:deploy`
- [ ] Prisma client generated and committed lock state

## Runtime & Ops
- [ ] `/healthz` and `/readyz` verified
- [ ] `/metrics` scrape verified
- [ ] Drain + maintenance admin controls verified

## Rollback Plan
- [ ] Previous image/tag available
- [ ] DB rollback strategy acknowledged
- [ ] On-call notified with deployment window
