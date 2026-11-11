import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '@/lib/utils'
import styles from './WorkbenchLayout.module.css'

/**
 * Shared workbench layout (body-cap rail, see ADR 0033).
 *
 * The component owns the two-column grid and the section/aside semantics; the
 * primary content is capped at `--wr-body-max`, the rail keeps at least
 * `--wr-rail-min` and absorbs the remaining width. Both columns collapse into a
 * single stacked column at <=960px for every workbench page.
 *
 * Page-specific surface layers (background, padding, min-height, bleed margins)
 * stay in the page's own CSS module and are passed through `className`.
 *
 *   <WorkbenchLayout>
 *     <WorkbenchLayout.Primary>…</WorkbenchLayout.Primary>
 *     <WorkbenchLayout.Rail label="Timeline context">…</WorkbenchLayout.Rail>
 *   </WorkbenchLayout>
 */

type WorkbenchLayoutProps = ComponentPropsWithoutRef<'div'>

export function WorkbenchLayout({ className, ...props }: WorkbenchLayoutProps) {
  return <div {...props} className={cn(styles.layout, className)} />
}

type PrimaryProps = ComponentPropsWithoutRef<'section'>

export function WorkbenchLayoutPrimary({ className, ...props }: PrimaryProps) {
  return <section {...props} className={cn(styles.primary, className)} />
}

type RailProps = ComponentPropsWithoutRef<'aside'> & {
  /**
   * Convenience accessible name for the rail; maps to the aside's aria-label.
   * An explicit `aria-label` or `aria-labelledby` passed through props wins.
   */
  label?: string
}

export function WorkbenchLayoutRail({
  className,
  label,
  'aria-label': ariaLabel,
  ...props
}: RailProps) {
  const accessibleName =
    ariaLabel ?? (props['aria-labelledby'] && label ? undefined : label)
  return (
    <aside {...props} aria-label={accessibleName} className={cn(styles.rail, className)} />
  )
}

WorkbenchLayout.Primary = WorkbenchLayoutPrimary
WorkbenchLayout.Rail = WorkbenchLayoutRail
