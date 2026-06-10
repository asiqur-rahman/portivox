import { expect, test } from "@playwright/test";
import { disableMotion, gotoApp, gotoAuth, prepareVisualUi, seedSession } from "./helpers";

test.describe("visual baselines", () => {
  test("auth screen stays visually consistent", async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await prepareVisualUi(page);
    await gotoAuth(page);
    await disableMotion(page);

    await expect(page.locator("#screen-auth")).toHaveScreenshot("auth-shell.png", {
      animations: "disabled",
      caret: "hide",
    });
  });

  test("customer tunnel dashboard stays visually consistent", async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await prepareVisualUi(page);
    await seedSession(page, { role: "owner", name: "Asiqur Rahman", initials: "AR" });
    await gotoApp(page);
    await expect(page.locator(".tbl").getByText("alpha-demo", { exact: true }).first()).toBeVisible();
    await disableMotion(page);

    await expect(page.locator("#screen-app .content-inner")).toHaveScreenshot("customer-dashboard.png", {
      animations: "disabled",
      caret: "hide",
    });
  });

  test("admin overview stays visually consistent", async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await prepareVisualUi(page);
    await seedSession(page, { role: "admin", name: "Admin Operator", initials: "AO" });
    await gotoApp(page);
    await page.getByTestId("nav-admin-overview").click();
    await expect(page.locator(".tbl").getByText("tunnel created", { exact: true }).first()).toBeVisible();
    await disableMotion(page);

    await expect(page.locator("#screen-app .content-inner")).toHaveScreenshot("admin-overview.png", {
      animations: "disabled",
      caret: "hide",
    });
  });

  test("inspector desktop layout stays visually consistent", async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await prepareVisualUi(page);
    await seedSession(page, { role: "admin", name: "Inspector QA", initials: "IQ" });
    await gotoApp(page);
    await page.getByTestId("nav-inspector").click();
    await expect(page.getByText("/api/health", { exact: true })).toBeVisible();
    await disableMotion(page);

    await expect(page.locator("#screen-app .content-inner")).toHaveScreenshot("inspector-desktop.png", {
      animations: "disabled",
      caret: "hide",
    });
  });

  test("customer dashboard mobile layout stays visually consistent", async ({ page, request }) => {
    await request.post("http://127.0.0.1:4010/__test/reset");
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareVisualUi(page);
    await seedSession(page, { role: "owner", name: "Asiqur Rahman", initials: "AR" });
    await gotoApp(page);
    await expect(page.locator(".mobile-card-list").getByText("alpha-demo", { exact: true }).first()).toBeVisible();
    await disableMotion(page);

    await expect(page.locator("#screen-app .content-inner")).toHaveScreenshot("customer-dashboard-mobile.png", {
      animations: "disabled",
      caret: "hide",
    });
  });
});
