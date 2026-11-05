package main

import (
	"os"
	"path/filepath"
)

// appDirName 是数据/配置目录下的应用子目录，与 weekly-reporter.service /
// .env.example 同名同值。
const appDirName = "weekly-reporter"

// xdgHomes 是 XDG 目录解析的唯一实现，语义对齐 src/lib/paths.ts：
// $XDG_DATA_HOME（缺省 ~/.local/share）与 $XDG_CONFIG_HOME（缺省 ~/.config）。
// serve 的 loadConfig 与 db migrate 都从这里取路径，避免两份规则漂移。
func xdgHomes() (dataHome, configHome string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	dataHome = os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	configHome = os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	return dataHome, configHome, nil
}

func appDataDir() (string, error) {
	dataHome, _, err := xdgHomes()
	if err != nil {
		return "", err
	}
	return filepath.Join(dataHome, appDirName), nil
}

func appConfigDir() (string, error) {
	_, configHome, err := xdgHomes()
	if err != nil {
		return "", err
	}
	return filepath.Join(configHome, appDirName), nil
}

// databasePath 是默认 SQLite 路径 <data dir>/reports.db。
func databasePath() (string, error) {
	dataDir, err := appDataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dataDir, "reports.db"), nil
}
