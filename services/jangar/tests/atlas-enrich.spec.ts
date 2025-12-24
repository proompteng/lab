import { expect, test } from '@playwright/test'

test.describe('atlas enrichment', () => {
  test('shows repository enrichment action', async ({ page }) => {
    await page.goto('/atlas/enrich')

    await expect(page.getByRole('heading', { name: 'Enrichment' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Repository enrichment' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Enrich repository files' })).toBeVisible()
  })
})
