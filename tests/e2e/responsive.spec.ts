import { expect, test } from "@playwright/test";
import { gotoApp, seedSession } from "./helpers";

const viewports = [
  { name: "mobile-390", width: 390, height: 844 },
  { name: "mobile-430", width: 430, height: 932 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1280, height: 900 },
];

test.describe("responsive layout checks", () => {
  for (const viewport of viewports) {
    test(`${viewport.name} renders the tunnel dashboard shell`, async ({ page, request }) => {
      await request.post("http://127.0.0.1:4010/__test/reset");
      await seedSession(page, { role: "admin" });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await gotoApp(page);

      await expect(page.getByText("Tunnel sessions")).toBeVisible();
      await expect(page.getByTestId("new-tunnel-button")).toBeVisible();

      if (viewport.width < 768) {
        await expect(page.getByRole("button", { name: "More" })).toBeVisible();
        await expect(page.getByTestId("new-tunnel-button")).toBeVisible();
      } else {
        await expect(page.getByText("Workspace")).toBeVisible();
        await expect(page.getByText("Administration")).toBeVisible();
      }
    });
  }
});
