import { expect, test } from "@playwright/test";
import { gotoApp, seedSession } from "./helpers";

test.describe("admin visibility flows", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await seedSession(page, { role: "admin", name: "Admin Operator", initials: "AO" });
    await gotoApp(page);
  });

  test("shows gateway operations overview", async ({ page }) => {
    await page.getByTestId("nav-admin-overview").click();

    await expect(page.getByText("Gateway operations")).toBeVisible();
    await expect(page.getByText("Live tunnels", { exact: true })).toBeVisible();
    await expect(page.getByText("Recent activity", { exact: true })).toBeVisible();
    await expect(page.locator(".section-title").filter({ hasText: "Gateway controls" }).first()).toBeVisible();
  });

  test("runtime controls reflect maintenance and draining states", async ({ page, request }) => {
    await page.getByTestId("nav-admin-overview").click();
    await expect(page.getByText("Healthy", { exact: true })).toBeVisible();

    const maintenanceRow = page.locator(".toggle-row").filter({ hasText: "Maintenance mode" });
    const drainingRow = page.locator(".toggle-row").filter({ hasText: "Draining mode" });
    const gatewayStateCard = page.locator(".kpi-card").filter({ hasText: "Gateway state" });

    await request.post("http://127.0.0.1:4010/__test/admin/state", {
      data: { maintenanceMode: true, draining: false },
    });

    await expect(maintenanceRow.locator('input[type="checkbox"]')).toBeChecked();
    await expect(gatewayStateCard).toContainText("Maintenance");

    await request.post("http://127.0.0.1:4010/__test/admin/state", {
      data: { maintenanceMode: true, draining: true },
    });

    await expect(drainingRow.locator('input[type="checkbox"]')).toBeChecked();
    await expect(gatewayStateCard).toContainText("Maintenance");
  });

  test("shows admin gateway sessions across users", async ({ page }) => {
    await page.getByTestId("nav-admin-gateway").click();

    await expect(page.getByText("Gateway sessions")).toBeVisible();
    await expect(page.getByRole("table").getByText("alpha-demo", { exact: true })).toBeVisible();
    await expect(page.locator(".tunnel-status-inline.offline small").first()).toHaveText("Client machine is not reachable");
  });

  test("shows TCP reservations for operations staff", async ({ page }) => {
    await page.getByTestId("nav-admin-tcp").click();

    await expect(page.getByText("TCP port reservations")).toBeVisible();
    await expect(page.getByRole("table").getByText("Production SSH", { exact: true })).toBeVisible();
    await expect(page.getByRole("table").getByText("Reporting Postgres", { exact: true })).toBeVisible();
  });

  test("reflects runtime state changes pushed from the gateway", async ({ page, request }) => {
    await page.getByTestId("nav-admin-overview").click();
    await expect(page.getByText("Healthy", { exact: true })).toBeVisible();

    await request.post("http://127.0.0.1:4010/__test/admin/state", {
      data: { maintenanceMode: true, draining: false },
    });

    await expect(page.getByText("Maintenance", { exact: true })).toBeVisible();
  });
});
