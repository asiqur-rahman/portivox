# Portivox Professional-Grade Roadmap

This roadmap defines what remains to move Portivox from a strong working system into a cleaner, more reliable, more professional production platform.

It is intentionally split into:

- `Must have` — required before calling the product production-grade
- `Should have` — strong next steps that improve trust, operations, and user experience
- `Nice to have` — valuable expansions after the core platform is hardened

---

## Current State

Portivox already has strong foundations:

- HTTP and raw TCP tunnel support
- realtime frontend updates
- persistent client service support
- Redis-backed multi-node lease coordination
- admin and customer frontend surfaces
- Dockerized gateway/client/frontend stack
- OpenAPI export and SDK compatibility checks
- CI-style smoke and contract tests

What still separates the system from a truly professional-grade product is not basic functionality — it is consistency, validation depth, operational maturity, and release discipline.

---

## Must Have

These are the highest-priority items. Completing this section is the line between “strong build” and “production-grade platform.”

### 1. Frontend Product Polish

**Goal:** make the UI feel intentional, consistent, and finished.

#### Work

- remove remaining redundant onboarding/guidance across pages
- standardize wording across customer, developer, and admin pages
- finish the `Settings`, `Overview`, and remaining admin-page polish
- remove internal naming leftovers such as old `ai-*` class naming where practical
- standardize empty states, section headers, cards, status labels, and action rows
- verify icon alignment, button spacing, modal layout, and mobile action bars

#### Definition of done

- every page has one clear job
- no repeated onboarding between screens
- no leftover AI wording in customer-facing UI
- no obvious visual inconsistency across desktop/mobile

---

### 2. Real Browser End-to-End Coverage

**Goal:** validate the product the way real users use it, not only through API/smoke scripts.

#### Work

- add Playwright E2E coverage for:
  - login/register
  - tunnel reservation from UI
  - realtime tunnel list updates
  - offline/unreachable client state
  - API key generation/revocation
  - admin gateway overview
  - mobile layouts at common widths
- add visual assertions for major flows
- run E2E checks in CI

#### Definition of done

- major customer and admin flows are browser-tested
- regressions like missing icons, broken buttons, or dead realtime UI are caught automatically

---

### 3. Production Authentication and Safety Hardening

**Goal:** make insecure deployment harder and safer deployment more automatic.

#### Work

- fail startup clearly when unsafe production config is detected
- enforce stronger `AUTH_REQUIRED` production expectations
- validate required secrets at boot
- validate JWT/API key configuration more aggressively
- protect admin endpoints and operational actions with stricter checks
- harden startup docs so public deployment defaults are unambiguous

#### Definition of done

- the gateway cannot be “accidentally public and weak”
- production misconfiguration fails loudly instead of silently

---

### 4. Release Discipline and Clean Git Hygiene

**Goal:** make releases reliable and reviewable.

#### Work

- reduce the current large mixed working tree into intentional commits
- remove temp/debug artifacts from tracked workflows
- ensure generated docs and artifacts are either committed intentionally or regenerated automatically
- define release steps:
  - build
  - tests
  - migration check
  - docker smoke
  - package smoke
  - changelog/version bump

#### Definition of done

- clean working tree before release
- every release follows one repeatable checklist

---

## Should Have

These are the next major maturity upgrades after the core must-have section.

### 5. Observability and Operations Dashboarding

**Goal:** make the system observable under real production load.

#### Work

- expand metrics for:
  - tunnel opens
  - disconnect reasons
  - reconnect attempts
  - stale session evictions
  - lease loss
  - TCP allocation pressure
  - auth failures
  - admin state changes
- add Prometheus/Grafana-ready dashboard guidance
- document alert thresholds for tunnel/gateway health

---

### 6. Database Maturity for MySQL and Postgres

**Goal:** make database support operationally trustworthy, not just configurable.

#### Work

- test migrations in CI for both MySQL and Postgres
- document schema lifecycle clearly
- verify Prisma generation and runtime behavior in Docker production builds
- document backup/restore and rollback strategy

---

### 7. Client Installation and Service Experience

**Goal:** make the client feel polished on fresh machines.

#### Work

- improve first-run setup flow
- add stronger `doctor` checks
- improve service health reporting
- improve uninstall/reset paths
- document exact Windows/Linux service behavior after restart/network recovery
- validate fresh install/uninstall on real Windows and Linux environments

---

### 8. Production Deployment Confidence

**Goal:** make deployment boring and repeatable.

#### Work

- tighten Docker production docs
- validate nginx/gateway domain and port mapping end-to-end
- document TLS, firewall, TCP port range, and reverse proxy expectations
- add production smoke checks after deploy
- document zero-downtime/rolling deploy flow with drain mode

---

## Nice to Have

These are valuable product and platform upgrades after the system is already stable and professional.

### 9. UDP Architecture and Delivery

**Goal:** extend Portivox beyond HTTP/TCP when there is a real product need.

#### Work

- design UDP relay architecture
- define CLI and gateway protocol changes
- add rate limits and abuse controls
- build observability around packet/session behavior

#### Note

UDP should be built as a first-class transport design, not as a small patch on top of TCP logic.

---

### 10. Enterprise and Team Features

**Goal:** make the platform stronger for teams and organizations.

#### Work

- organization roles and finer permissions
- audit retention settings
- team-scoped tunnel ownership
- service accounts / machine identities
- better billing/admin controls

---

### 11. Self-Hosted Asset and CSP Tightening

**Goal:** reduce third-party runtime dependency and tighten frontend security posture.

#### Work

- self-host remaining fonts/assets where useful
- remove unnecessary external allowances from CSP
- validate production asset loading fully offline from third-party CDNs

---

## Execution Plan

Recommended delivery order:

1. frontend polish and page-role cleanup
2. browser E2E coverage
3. auth and production safety hardening
4. release process and clean working tree
5. observability and dashboards
6. DB maturity across MySQL/Postgres
7. client install/service polish
8. deployment hardening
9. UDP and enterprise expansions

---

## Suggested Working Phases

### Phase 1 — Product Finish

- frontend cleanup
- responsive QA
- remove redundant UX
- customer/developer/admin separation

### Phase 2 — Validation Finish

- Playwright E2E
- release checklist
- package install/uninstall smoke tests

### Phase 3 — Production Finish

- auth hardening
- deployment hardening
- observability
- multi-node drills

### Phase 4 — Platform Expansion

- UDP
- enterprise/admin depth
- advanced install and automation improvements

---

## Release Gate

Before calling Portivox “professional-grade ready,” all of the following should be true:

- frontend pages are visually and structurally consistent
- realtime flows are browser-tested
- backend and client CI suite passes
- production auth configuration is safe by default
- deployment docs are accurate and verified
- release process is repeatable
- no accidental temp/debug/stale files remain in release scope

---

## Practical Next Step

The best next implementation sprint is:

1. finish frontend polish for `Settings`, `Overview`, and remaining wording/styling leftovers
2. add browser E2E coverage for the main customer/admin flows
3. tighten production auth/startup guardrails

That sequence gives the highest return on polish, trust, and safety.
