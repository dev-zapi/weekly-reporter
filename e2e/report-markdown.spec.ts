import { test, expect } from '@playwright/test'

test('Final preview renders ordered Markdown items with visible numbers', async ({ page, request }) => {
  const response = await request.post('/api/reports', {
    data: {
      title: 'Ordered list preview regression',
      weekStart: '2027-04-05T00:00:00.000Z',
      weekEnd: '2027-04-11T00:00:00.000Z',
    },
  })
  expect(response.status()).toBe(201)
  const payload = (await response.json()) as { report: { id: number } }
  const reportId = payload.report.id

  try {
    const save = await request.put(`/api/reports/${reportId}/final`, {
      data: {
        variant: 'personal',
        content: '# Final report\n\n1. First completed item\n2. Second completed item',
      },
    })
    expect(save.ok()).toBeTruthy()

    await page.goto(`/reports/${reportId}`)
    const body = page.getByTestId('final-report-body')
    const list = body.getByRole('list').filter({ has: page.getByText('First completed item') })
    await expect(list).toBeVisible()
    await expect(list).toHaveCSS('list-style-type', 'decimal')
  } finally {
    await request.delete(`/api/reports/${reportId}`)
  }
})
