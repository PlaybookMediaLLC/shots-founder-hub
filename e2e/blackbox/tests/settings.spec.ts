import { $, browser, expect } from "@wdio/globals";

describe("Desktop settings", () => {
  it("persists an appearance setting after restarting the app", async () => {
    await openAppearanceSettings();
    const selectedTheme = await $(
      '//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and @aria-checked="true"]',
    );
    await selectedTheme.waitForExist({ timeout: 10000 });
    const selectedLabel = (await selectedTheme.getText())
      .split("\n", 1)[0]
      ?.trim();
    const targetLabel = selectedLabel === "Light" ? "Dark" : "Light";
    const targetTheme = await $(
      `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio"][contains(normalize-space(.), "${targetLabel}")]`,
    );
    await targetTheme.waitForExist({ timeout: 10000 });
    await targetTheme.click();
    await browser.waitUntil(
      async () => (await targetTheme.getAttribute("aria-checked")) === "true",
      { timeout: 10000 },
    );

    await browser.reloadSession();
    await openAppearanceSettings();

    const restoredTheme = await $(
      `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio"][contains(normalize-space(.), "${targetLabel}")]`,
    );
    await restoredTheme.waitForExist({ timeout: 10000 });
    expect(await restoredTheme.getAttribute("aria-checked")).toBe("true");

    if (selectedLabel) {
      const originalTheme = await $(
        `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio"][contains(normalize-space(.), "${selectedLabel}")]`,
      );
      await originalTheme.click();
      await browser.waitUntil(
        async () =>
          (await originalTheme.getAttribute("aria-checked")) === "true",
        { timeout: 10000 },
      );
    }
  });
});

async function openAppearanceSettings() {
  await $('[data-testid="main-app-shell"]').waitForExist({ timeout: 30000 });
  const appearance = $('[data-testid="settings-nav-icon-appearance"]');
  if (!(await appearance.isExisting())) {
    await $('//button[.//span[normalize-space()="Settings"]]').click();
    await appearance.waitForExist({ timeout: 30000 });
  }
  await appearance.click();
}
