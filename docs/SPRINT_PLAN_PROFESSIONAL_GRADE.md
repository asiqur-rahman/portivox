# Portivox Sprint Plan — Professional Grade Delivery

This document converts the professional-grade roadmap into an execution plan that can be delivered sprint by sprint.

The goal is simple:

- keep each sprint focused
- avoid mixing polish, infrastructure, and platform expansion randomly
- define a clear exit condition for every sprint

---

## Planning Assumptions

This sprint plan assumes:

- the current platform already supports HTTP and TCP tunneling
- realtime updates, persistent client services, and admin/customer UI already exist
- current work should now prioritize reliability, consistency, and production maturity

Recommended sprint length:

- `1 sprint = 1 to 2 weeks`

Recommended team posture:

- do not start UDP, enterprise expansion, or large new product features until the core polish, validation, and production-hardening sprints are complete

---

## Sprint 1 — Frontend Product Finish

**Primary goal:** make the product feel visually intentional, consistent, and professional.

### Scope

- finish `Settings` page polish
- finish `Overview` page polish
- clean remaining admin page inconsistencies
- remove redundant onboarding/setup language
- normalize page roles:
  - customer pages
  - developer pages
  - admin pages
- standardize:
  - buttons
  - cards
  - tables
  - empty states
  - status chips
  - modal actions
  - mobile layouts
- remove visible leftover AI-era copy and UI wording
- reduce internal leftover naming where practical

### Deliverables

- visually consistent customer UI
- visually consistent admin UI
- cleaner mobile experience
- page-by-page UI polish notes completed

### Exit criteria

- every page has one clear purpose
- no duplicated onboarding between pages
- no obvious button/icon/layout misalignment
- customer-facing copy feels coherent and professional

### Risk

- tempting to keep adding features during polish

### Guardrail

- no new feature scope unless it directly fixes UX consistency

---

## Sprint 2 — Browser E2E and Visual Validation

**Primary goal:** test real user journeys in a browser, not only by API/smoke scripts.

### Scope

- add Playwright test framework
- cover core customer flows:
  - login
  - register
  - tunnel creation/reservation
  - live tunnel state updates
  - offline/unreachable client state
  - API key generation/revocation
- cover core admin flows:
  - gateway overview
  - tunnel visibility
  - admin status pages
- add responsive checks for:
  - `390px`
  - `430px`
  - tablet width
  - desktop width
- add screenshots or visual checkpoints for critical flows

### Deliverables

- Playwright test suite in repo
- browser validation workflow in CI
- basic visual regression safety for major screens

### Exit criteria

- key customer flows run automatically in browser CI
- major UI regressions become catchable before release

### Risk

- flaky browser tests

### Guardrail

- keep tests focused on high-value flows first, not every minor interaction

---

## Sprint 3 — Production Auth and Safety Hardening

**Primary goal:** make unsafe public deployment hard, loud, and unlikely.

### Scope

- enforce stronger startup validation for production mode
- fail fast on weak or missing secrets
- validate production auth configuration on boot
- make `AUTH_REQUIRED` expectations explicit and enforced
- tighten admin operation protections
- improve auth/configuration error messaging
- review dangerous dev-mode behavior and isolate it clearly

### Deliverables

- production startup validation rules
- safer auth defaults
- clearer deployment failure messages

### Exit criteria

- unsafe production configuration fails loudly
- public deployment guidance is no longer ambiguous

### Risk

- breaking loose local dev habits

### Guardrail

- dev mode remains usable, but production mode becomes strict

---

## Sprint 4 — Release Discipline and Clean Repository State

**Primary goal:** make releases intentional, reviewable, and repeatable.

### Scope

- reduce mixed local work into intentional commits
- clean temp/debug leftovers
- define artifact ownership:
  - generated docs
  - package outputs
  - build files
- align docs/export/test expectations
- finalize release workflow:
  - version bump
  - changelog
  - build
  - tests
  - package validation
  - deploy validation

### Deliverables

- clean release checklist
- intentional git hygiene
- stable release procedure

### Exit criteria

- working tree can be made clean before release
- release steps are documented and repeatable

### Risk

- hidden dependencies on messy local state

### Guardrail

- every required release step must be reproducible from repo state alone

---

## Sprint 5 — Observability and Operational Readiness

**Primary goal:** make the platform measurable and operable under real production use.

### Scope

- expand metrics coverage for:
  - tunnel opens
  - disconnect reasons
  - reconnect attempts
  - stale session cleanup
  - lease loss
  - TCP allocation pressure
  - auth failures
  - admin actions
- document key dashboards
- define alert signals and thresholds
- improve operational runbook references

### Deliverables

- richer metrics
- Grafana/Prometheus dashboard guidance
- alerting recommendations

### Exit criteria

- important failure modes are observable
- operators can tell what is wrong without guessing

---

## Sprint 6 — Database Maturity (MySQL + Postgres)

**Primary goal:** make database support operationally trustworthy across both supported engines.

### Scope

- validate migrations for MySQL and Postgres in CI
- verify Docker + Prisma generation paths for both
- document migration lifecycle clearly
- document backup/restore and rollback expectations
- confirm production startup behavior with each engine

### Deliverables

- DB compatibility validation matrix
- updated migration docs
- confidence in both engines

### Exit criteria

- MySQL and Postgres are both tested, not merely configurable

---

## Sprint 7 — Client Install and Always-On Experience

**Primary goal:** make the client installation and persistent service flow polished for real users.

### Scope

- strengthen first-run onboarding flow
- improve `doctor`
- improve service status and recovery output
- improve uninstall/reset flow
- validate restart persistence on Linux and Windows
- document exact customer machine behavior

### Deliverables

- smoother install/service experience
- clearer health diagnostics
- better always-on trust

### Exit criteria

- a normal user can install, register, expose, persist, and recover with low confusion

---

## Sprint 8 — Production Deployment Confidence

**Primary goal:** make deployment repeatable and boring.

### Scope

- tighten production docs
- validate nginx/gateway/domain/TCP mapping end-to-end
- document TLS and firewall expectations clearly
- add post-deploy smoke checks
- validate drain-mode rolling deployment procedure

### Deliverables

- hardened deployment instructions
- verified production smoke flow
- rolling deploy guidance

### Exit criteria

- deployment steps are clear and repeatable
- failure points are documented before production use

---

## Sprint 9 — Platform Expansion Preparation

**Primary goal:** prepare the platform for advanced capability growth without destabilizing the core.

### Scope

- design UDP architecture
- define enterprise/team feature boundaries
- review self-hosted asset strategy
- plan CSP tightening further

### Deliverables

- UDP architecture proposal
- enterprise feature outline
- future platform expansion backlog

### Exit criteria

- advanced expansion work is designed deliberately, not improvised

---

## Suggested Milestone Grouping

### Milestone A — Product Finish

- Sprint 1
- Sprint 2

**Outcome:** polished UI + real browser validation

### Milestone B — Production Safety

- Sprint 3
- Sprint 4

**Outcome:** safer deploys + disciplined release process

### Milestone C — Production Operations

- Sprint 5
- Sprint 6
- Sprint 8

**Outcome:** observable, testable, deployable production platform

### Milestone D — Client Excellence

- Sprint 7

**Outcome:** reliable customer install and always-on tunnel behavior

### Milestone E — Expansion

- Sprint 9

**Outcome:** prepared next-generation roadmap without destabilizing core delivery

---

## Recommended Start Order

If only one sprint starts now, start here:

### Start with Sprint 1

Why:

- it directly affects perceived quality
- it reduces UI confusion immediately
- it makes later browser E2E much easier to define
- it gives the product a cleaner base before harder infra work

After Sprint 1:

- move immediately to Sprint 2
- then Sprint 3

That is the highest-value sequence.

---

## Definition of Professional-Grade Ready

Portivox can be described as professional-grade when:

- Sprint 1 is complete
- Sprint 2 is complete
- Sprint 3 is complete
- Sprint 4 is complete
- core operational work from Sprint 5 and Sprint 8 is in place

At that point:

- product quality is polished
- real user flows are tested
- production deployment is safer
- release process is disciplined
- operations are much more trustworthy

---

## Practical Next Step

Immediate execution recommendation:

1. start Sprint 1
2. create a checklist issue list from Sprint 1 scope
3. complete Sprint 1 before starting Playwright work

That will create the cleanest path into the next sprint.
