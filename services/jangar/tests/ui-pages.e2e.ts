import { expect, test } from '@playwright/test'

test.describe('ui pages', () => {
  test('home', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Memories', level: 1 })).toBeVisible()
  })

  test('memories', async ({ page }) => {
    await page.goto('/memories')
    await expect(page.getByLabel('Namespace')).toBeVisible()
    await expect(page.getByLabel('Query')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
  })

  test('atlas search', async ({ page }) => {
    await page.goto('/atlas/search')
    await expect(page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible()
  })

  test('atlas indexed', async ({ page }) => {
    await page.goto('/atlas/indexed')
    await expect(page.getByRole('heading', { name: 'Indexed files', level: 1 })).toBeVisible()
  })

  test('atlas enrich', async ({ page }) => {
    await page.goto('/atlas/enrich')
    await expect(page.getByRole('heading', { name: 'Enrichment', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Repository enrichment', level: 2 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Enrich repository files' })).toBeVisible()
  })

  test('torghut symbols', async ({ page }) => {
    await page.goto('/torghut/symbols')
    await expect(page.getByRole('heading', { name: 'Symbols', level: 1 })).toBeVisible()
  })

  test('torghut visuals', async ({ page }) => {
    await page.goto('/torghut/visuals')
    await expect(page.getByRole('heading', { name: 'Visuals', level: 1 })).toBeVisible()
    const symbolSelect = page.locator('#torghut-symbol')
    await expect(symbolSelect).toBeVisible()
    const colorScheme = await symbolSelect.evaluate((element) => getComputedStyle(element).colorScheme)
    expect(colorScheme).toContain('dark')
  })
})
