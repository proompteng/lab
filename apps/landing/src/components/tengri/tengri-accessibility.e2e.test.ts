import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { desktopDock, desktopWindow, visitDesktop } from './tengri-desktop.fixture'

test('exposes the separate Tengri app, connection state, and accessible controls', async ({ page }) => {
  await visitDesktop(page)
  const agent = desktopWindow(page, 'Tengri')
  await expect(agent).toBeVisible()
  await expect(page.getByText('Connected', { exact: true })).toBeAttached()
  await expect(page.getByLabel('Agent status')).toHaveText('Ready')
  await expect(agent.getByRole('textbox', { name: 'Message your agent' })).toBeFocused()
  const seriousViolations = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(seriousViolations).toEqual([])
  await agent.getByRole('button', { name: 'Close Tengri', exact: true }).click()
  await expect(agent).toHaveCount(0)
  const launcher = desktopDock(page).getByRole('button', { name: 'Open Tengri' })
  await launcher.click()
  await expect(agent.getByRole('textbox', { name: 'Message your agent' })).toBeFocused()
  await launcher.hover()
  await expect(launcher.getByRole('tooltip', { includeHidden: true })).toHaveCSS('opacity', '1')
})
