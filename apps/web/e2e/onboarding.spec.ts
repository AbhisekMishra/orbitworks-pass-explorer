import { expect, hooks, openApp, test, waitForTracks } from './fixtures';

test.describe('Onboarding, help and keyboard', () => {
  test('the first-run hint shows once and stays dismissed', async ({ page }) => {
    await page.goto('/');
    await waitForTracks(page);
    const hint = page.getByTestId('first-run-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Drag the blue window');
    await hint.getByRole('button', { name: 'Got it' }).click();
    await expect(hint).toHaveCount(0);

    await page.reload();
    await waitForTracks(page);
    await expect(page.getByTestId('first-run-hint')).toHaveCount(0);
  });

  test('help opens from "?" and the top bar, owns the keyboard, and closes with Escape', async ({ page }) => {
    await openApp(page);
    await page.locator('body').press('?');
    const dialog = page.getByRole('dialog', { name: 'How to use Pass Explorer' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Show only that satellite');
    await expect(dialog).toContainText('KB'); // what was downloaded

    // Shortcuts are suspended while the dialog is open.
    await page.keyboard.press('g');
    expect((await hooks.state(page)).projection).toBe('globe');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Help and keyboard shortcuts' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close help' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Space plays and pauses', async ({ page }) => {
    await openApp(page);
    await page.locator('body').press('Space');
    await expect.poll(async () => (await hooks.state(page)).playing).toBe(true);
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await page.locator('body').press('Space');
    await expect.poll(async () => (await hooks.state(page)).playing).toBe(false);
  });
});
