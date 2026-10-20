export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { initializeSnippets } = await import('./src/lib/init-snippets')
      await initializeSnippets()
    } catch (error) {
      console.error('Failed to initialize built-in snippets:', error)
    }
    try {
      const { ensureStartupPassword } = await import('./src/lib/auth/password')
      await ensureStartupPassword()
    } catch (error) {
      // 认证侧必须容忍密码文件缺失（返回 401 而非 500），故此处只记日志不抛出
      console.error('Failed to initialize startup password:', error)
    }
  }
}
