export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { installTraceConsolePatch } = await import('./src/lib/trace/console-patch')
      installTraceConsolePatch()
    } catch (error) {
      // trace 前缀是诊断辅助，安装失败不应阻断启动，只记日志
      console.error('Failed to install trace console patch:', error)
    }
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
