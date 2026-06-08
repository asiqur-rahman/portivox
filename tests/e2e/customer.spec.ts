import { expect, test } from "@playwright/test";
import { gotoApp, seedSession } from "./helpers";

test.describe("customer dashboard flows", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await seedSession(page, { role: "owner", name: "Asiqur Rahman", initials: "AR" });
    await gotoApp(page);
  });

  test("shows live, reserved, and offline tunnel states", async ({ page }) => {
    await expect(page.locator(".tunnel-status-inline.offline small").first()).toHaveText("Client machine is not reachable");
    await expect(page.locator(".tunnel-status-inline.reserved small").first()).toHaveText("Reserved and waiting for a client connection");
    await expect(page.getByRole("table").getByText("ssh-prod", { exact: true })).toBeVisible();
  });

  test("can reserve a new tunnel from the dashboard", async ({ page }) => {
    await page.getByTestId("new-tunnel-button").click();
    await page.getByTestId("new-tunnel-subdomain").fill("qa-reserve");
    await page.getByTestId("create-tunnel-submit").click();

    await expect(page.getByRole("table").getByText("qa-reserve", { exact: true })).toBeVisible();
    await expect(page.locator(".tunnel-status-inline.reserved small").first()).toHaveText("Reserved and waiting for a client connection");
  });

  test("updates tunnel state in real time after a gateway event", async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/tunnels/state", {
      data: {
        subdomain: "gamma-app",
        active: true,
        status: "live",
        statusMessage: "Client connected and forwarding traffic",
        lastSeenAt: new Date().toISOString(),
      },
    });

    await expect(page.locator(".tunnel-status-inline.live small").filter({ hasText: "Client connected and forwarding traffic" }).first()).toBeVisible();
  });

  test("can generate and delete an API key", async ({ page }) => {
    await page.getByTestId("nav-api").click();
    await expect(page.getByTestId("generate-key-button")).toBeVisible();

    await page.getByTestId("generate-key-button").click();
    await page.getByTestId("new-key-description").fill("QA CI key");
    await page.getByTestId("generate-key-submit").click();

    await expect(page.getByText("Key ready - copy it now", { exact: true })).toBeVisible();
    await expect(page.locator("tr").filter({ hasText: "QA CI key" })).toBeVisible();

    const row = page.locator("tr", { hasText: "QA CI key" });
    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete key" }).click();

    await expect(page.getByText("QA CI key")).toHaveCount(0);
  });

  test("opens global search and navigates from search results", async ({ page }) => {
    await page.keyboard.press("Control+K");
    await expect(page.getByPlaceholder("Search pages, tunnels, API keys, and actions")).toBeVisible();
    await expect(page.getByText("Quick actions")).toBeVisible();

    await page.getByPlaceholder("Search pages, tunnels, API keys, and actions").fill("api keys");
    await page.getByRole("button", { name: /API Keys/i }).click();
    await expect(page.getByTestId("generate-key-button")).toBeVisible();

    await page.keyboard.press("/");
    await expect(page.getByText("Recent searches")).toBeVisible();
    await expect(page.getByRole("button", { name: /API Keys/i }).first()).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("Recent searches")).toHaveCount(0);
    await page.getByPlaceholder("Search pages, tunnels, API keys, and actions").fill("ssh-prod");
    await expect(page.getByRole("button", { name: /ssh-prod/i })).toBeVisible();
  });
});
