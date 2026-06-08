import { expect, test } from "@playwright/test";
import { gotoAuth, suppressInstallPrompt } from "./helpers";

test.describe("auth flows", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await suppressInstallPrompt(page);
  });

  test("user can sign in and reach the tunnel dashboard", async ({ page }) => {
    await gotoAuth(page);

    await page.getByTestId("login-email").fill("qa@braintechsolution.com");
    await page.getByTestId("login-password").fill("Password123!");
    await page.getByTestId("login-submit").click();

    await expect(page.getByText("Tunnel sessions")).toBeVisible();
    await expect(page.getByText("Active tunnels")).toBeVisible();
    await expect(page.getByTestId("new-tunnel-button")).toBeVisible();
  });

  test("user can register and reach the dashboard", async ({ page }) => {
    await gotoAuth(page);

    await page.getByTestId("auth-tab-register").click();
    await page.getByTestId("register-first-name").fill("QA");
    await page.getByTestId("register-last-name").fill("Engineer");
    await page.getByTestId("register-email").fill("register@braintechsolution.com");
    await page.getByTestId("register-password").fill("Password123!");
    await page.getByTestId("register-submit").click();

    await expect(page.getByText("Tunnel sessions")).toBeVisible();
    await expect(page.getByTestId("new-tunnel-button")).toBeVisible();
  });
});
