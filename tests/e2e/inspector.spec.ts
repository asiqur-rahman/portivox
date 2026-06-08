import { expect, test } from "@playwright/test";
import { gotoApp, seedSession } from "./helpers";

test.describe("inspector flows", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await seedSession(page, { role: "admin", name: "Inspector QA", initials: "IQ" });
    await gotoApp(page);
  });

  test("shows captured HTTP requests and request details", async ({ page }) => {
    await page.getByTestId("nav-inspector").click();

    await expect(page.locator(".inspector-toolbar-title")).toHaveText("Traffic inspector");
    await expect(page.locator(".inspector-subdomain")).toHaveText("alpha-demo");
    await expect(page.getByText("/api/tunnels", { exact: true })).toBeVisible();

    await page.getByText("/api/tunnels", { exact: true }).click();
    await expect(page.getByText("Response Body", { exact: true })).toBeVisible();
    await expect(page.locator(".inspector-body-pre")).toContainText("tun_live_1");

    await page.getByRole("button", { name: "Request Headers" }).click();
    await expect(page.locator(".inspector-headers-tbl")).toContainText("authorization");
  });

  test("clears request history for the selected tunnel", async ({ page }) => {
    await page.getByTestId("nav-inspector").click();
    await expect(page.getByText("/api/health", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("Waiting for HTTP requests...")).toBeVisible();
  });

  test("updates inspector list in real time when a new request arrives", async ({ page, request }) => {
    await page.getByTestId("nav-inspector").click();

    await request.post("http://127.0.0.1:4010/__test/inspect/request", {
      data: {
        subdomain: "alpha-demo",
        id: "req_live_1",
        method: "PATCH",
        path: "/api/live-check",
        statusCode: 202,
        responseBodyBase64: Buffer.from(JSON.stringify({ accepted: true }, null, 2)).toString("base64"),
      },
    });

    await expect(page.getByText("/api/live-check", { exact: true })).toBeVisible();
  });
});
