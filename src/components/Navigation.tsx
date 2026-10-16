'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Clock, FileText, FileStack, Cloud, BookOpen, MessageSquare, CalendarCheck } from 'lucide-react'
import { ThemeSwitcher } from './ThemeSwitcher'
import { SettingsButton } from './Settings'
import { SyncAllSourcesButton } from './SyncAllSources'

const NAV_ITEMS = [
  { href: '/', label: 'Timeline', icon: Clock },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/plans', label: 'Plans', icon: CalendarCheck },
  { href: '/templates', label: 'Templates', icon: FileStack },
  { href: '/prompts', label: 'Prompts', icon: MessageSquare },
  { href: '/collect', label: 'Sources', icon: Cloud },
]

export function Navigation() {
  const pathname = usePathname()
  
  return (
    <nav className="border-b">
      <div className="container mx-auto px-4">
        <div className="flex h-16 items-center gap-4 overflow-x-auto scrollbar-none">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = pathname === item.href ||
              (item.href !== '/' && pathname.startsWith(item.href))

            return (
              <Link key={item.href} href={item.href}>
                <Button
                  variant={isActive ? 'default' : 'ghost'}
                  size="sm"
                  className="gap-2 focus-visible:ring-0 whitespace-nowrap"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Button>
              </Link>
            )
          })}

          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            {pathname !== '/collect' && <SyncAllSourcesButton />}
            <SettingsButton />
            <ThemeSwitcher />
            <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground max-[720px]:hidden">
              <BookOpen className="h-4 w-4" />
              <span>Weekly Reporter</span>
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
