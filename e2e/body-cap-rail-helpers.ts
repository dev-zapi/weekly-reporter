import { expect, type Page } from '@playwright/test'

/**
 * Shared width-contract helpers for the body-cap rail specs.
 *
 * The only seam is the real page at a real viewport: assertions read computed
 * `grid-template-columns`, element boxes, and semantic roles — never class
 * names, component internals, or CSS-module implementation.
 *
 * Contract for viewport width W (AppShell expanded): the workbench body is
 * `W - 248px` (period rail) `- 24px` (gutter).
 *   - ≥1450: primary track ≤1000, rail ≥380 and growing with the viewport;
 *   - ~1000–1400: rail pinned at 380, primary absorbs the delta;
 *   - ≤960: single column (`display:block`, equal widths, stacked).
 */

export const BODY_MAX = 1000
export const RAIL_MIN = 380

/** Rail semantics: `<aside>` exposed as the complementary landmark. */
export function rail(page: Page, label: string) {
  return page.getByRole('complementary', { name: label })
}

/** Primary semantics: `<section>` exposed as a named region. */
export function primary(page: Page, name: string) {
  return page.getByRole('region', { name })
}

export async function readTracks(
  page: Page,
  railLabel: string,
): Promise<{ primary: number; rail: number }> {
  const columns = await rail(page, railLabel).evaluate(
    (el) => getComputedStyle(el.parentElement!).gridTemplateColumns,
  )
  const parts = columns.split(/\s+/).filter(Boolean).map((value) => Number.parseFloat(value))
  return { primary: parts[0], rail: parts[1] }
}

export async function readLayoutDisplay(page: Page, railLabel: string): Promise<string> {
  return rail(page, railLabel).evaluate((el) => getComputedStyle(el.parentElement!).display)
}

/** Number of distinct horizontal positions the rail's direct children occupy. */
export async function railChildColumns(page: Page, railLabel: string): Promise<number> {
  const xs = await rail(page, railLabel).evaluate((el) =>
    Array.from(el.children).map((child) => Math.round(child.getBoundingClientRect().x)),
  )
  return new Set(xs).size
}

/** Asserts the ≤960 single-column state: equal widths, rail below primary. */
export async function expectCollapsed(page: Page, railLabel: string, primaryName: string) {
  await expect.poll(() => readLayoutDisplay(page, railLabel)).toBe('block')

  const primaryBox = await primary(page, primaryName).boundingBox()
  const railBox = await rail(page, railLabel).boundingBox()
  expect(primaryBox).not.toBeNull()
  expect(railBox).not.toBeNull()

  expect(Math.abs(primaryBox!.width - railBox!.width)).toBeLessThanOrEqual(1)
  expect(railBox!.y).toBeGreaterThanOrEqual(primaryBox!.y + primaryBox!.height - 1)
}

/** Width of the route surface (AppShell renders it as `<main>`'s first child). */
export async function readSurfaceWidths(
  page: Page,
): Promise<{ main: number; surface: number }> {
  return page.evaluate(() => {
    const main = document.querySelector('main')
    if (!main || !main.firstElementChild) throw new Error('surface not found')
    return {
      main: main.clientWidth,
      surface: main.firstElementChild.getBoundingClientRect().width,
    }
  })
}
