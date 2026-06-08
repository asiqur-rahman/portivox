import { expect, type Page } from "@playwright/test";

type SessionSeed = {
  token: string;
  email: string;
  name: string;
  initials: string;
  role: string;
};

const DEFAULT_SESSION: SessionSeed = {
  token: "mock-token",
  email: "qa@braintechsolution.com",
  name: "QA Operator",
  initials: "QO",
  role: "admin",
};

const FIXED_NOW = Date.parse("2026-06-08T12:00:00.000Z");

export async function seedSession(page: Page, overrides: Partial<SessionSeed> = {}): Promise<void> {
  const session = { ...DEFAULT_SESSION, ...overrides };
  await page.addInitScript(({ seededSession }) => {
    localStorage.setItem("ptx-install-dismissed-at", String(Date.now()));
    localStorage.setItem("ptx-session", JSON.stringify(seededSession));
  }, { seededSession: session });
}

export async function suppressInstallPrompt(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ptx-install-dismissed-at", String(Date.now()));
  });
}

export async function freezeTime(page: Page): Promise<void> {
  await page.addInitScript(({ fixedNow }) => {
    const RealDate = Date;

    class MockDate extends RealDate {
      constructor(value) {
        if (arguments.length === 0) {
          super(fixedNow);
          return;
        }
        super(value);
      }

      static now() {
        return fixedNow;
      }
    }

    Object.setPrototypeOf(MockDate, RealDate);
    // @ts-expect-error browser-side Date override for deterministic tests
    window.Date = MockDate;
  }, { fixedNow: FIXED_NOW });
}

export async function prepareVisualUi(page: Page): Promise<void> {
  await freezeTime(page);
  await suppressInstallPrompt(page);
}

export async function disableMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `,
  });
}

export async function gotoApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Tunnel sessions")).toBeVisible();
}

export async function gotoAuth(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Welcome back")).toBeVisible();
}
