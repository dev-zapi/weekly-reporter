// Command wr 是迁移后的单二进制入口（ADR-0025）。
//
// B0 只有 serve 子命令骨架；`wr db migrate|new` 由 B0 迁移器票（#98）接线，
// 本票不 import internal/migrate，避免两个实现互相耦合。
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "serve":
		if err := runServe(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "wr serve:", err)
			os.Exit(1)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: wr serve")
}
