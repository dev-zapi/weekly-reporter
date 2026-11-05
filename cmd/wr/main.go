// Command wr 是迁移后的单二进制入口（ADR-0025）。
//
// B0 子命令：serve（#97 骨架）与 db migrate（#98 迁移器）。
// `wr db new` 是切换后项，不在 B0。
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
	case "db":
		os.Exit(runDB(os.Args[2:]))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: wr serve")
	fmt.Fprintln(os.Stderr, "       wr db migrate")
}
