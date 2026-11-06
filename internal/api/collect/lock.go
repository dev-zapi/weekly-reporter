package collect

import "sync"

// 本文件是 src/lib/collect/source-operation-lock.ts 的 Go 对应物：同一采集源同时
// 只允许一个仓库操作（手动 Fetch 与同步共享同一把锁），冲突时路由回 409 SOURCE_BUSY。
//
// TS 版把活跃集合放在模块作用域；Go 侧同样用包级 map + mutex（进程内语义，与
// Next 进程内的 AsyncLocalStorage/Set 等价）。

var (
	sourceOperationsMu sync.Mutex
	sourceOperations   = make(map[int64]struct{})
)

// acquireSourceOperation 尝试占用某采集源的操作槽位；已被占用时返回 false。
func acquireSourceOperation(sourceID int64) bool {
	sourceOperationsMu.Lock()
	defer sourceOperationsMu.Unlock()

	if _, busy := sourceOperations[sourceID]; busy {
		return false
	}
	sourceOperations[sourceID] = struct{}{}
	return true
}

// releaseSourceOperation 释放槽位（对应 finally 里的 delete）。
func releaseSourceOperation(sourceID int64) {
	sourceOperationsMu.Lock()
	defer sourceOperationsMu.Unlock()
	delete(sourceOperations, sourceID)
}
