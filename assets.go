// Package weeklyreporter 目前只承担一件事：把仓根的迁移语料内嵌进二进制。
//
// 为什么要放在仓根：go:embed 的 pattern 不能越过包目录（不允许 ".."），
// 唯一语料 drizzle/ 又在仓库根，所以内嵌的包必须自己就在仓根。
// 语料本身不动（drizzle-kit 的 out 配置与 Node 版路径都依赖原位），
// 解析与校验逻辑全部在 internal/migrate。
package weeklyreporter

import "embed"

// Migrations 内嵌迁移语料：41 个 .sql 加 meta/_journal.json。
//
// 这里用显式文件 pattern 而不是目录 pattern：embed 默认忽略以 "_" 开头的文件，
// 目录形式（drizzle、drizzle/meta）会漏掉 _journal.json；all:drizzle 又能吃进
// meta/ 下约 900K 的 snapshot（运行时用不到）。显式 glob 两个都要、且不多带。
//
//go:embed drizzle/*.sql drizzle/meta/_journal.json
var Migrations embed.FS
