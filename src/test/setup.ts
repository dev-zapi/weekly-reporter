import '@testing-library/jest-dom'

// 认证默认开启（Charter #4）。测试环境统一关闭，
// 这样既有测试无需逐个改造即可通过；认证开启时的行为由 src/lib/auth/*.test.ts 覆盖。
process.env.WR_AUTH_DISABLED = '1'

// Mock ResizeObserver for cmdk
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof window !== 'undefined') {
  window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}

// Mock scrollIntoView for cmdk
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function () {}
}
