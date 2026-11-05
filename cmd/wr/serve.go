package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/dev-zapi/weekly-reporter/internal/api"
	"github.com/dev-zapi/weekly-reporter/internal/auth"
	"github.com/dev-zapi/weekly-reporter/internal/buildinfo"
	"github.com/dev-zapi/weekly-reporter/internal/db"
	"github.com/dev-zapi/weekly-reporter/internal/migrate"
	"github.com/dev-zapi/weekly-reporter/web"
)

// 默认值与 weekly-reporter.service / .env.example 同名同值。
const (
	defaultPort     = "6868"
	defaultHostname = "0.0.0.0"
)

// config 是 serve 的运行时配置。全部来自环境变量，语义与 TS 侧同名同值（蓝图 §2.6）：
// WR_AUTH_DISABLED='1' / XDG_DATA_HOME / XDG_CONFIG_HOME / PORT / HOSTNAME。
type config struct {
	AuthDisabled bool
	DataDir      string
	ConfigDir    string
	DBPath       string
	AuthPath     string
	Port         string
	Hostname     string
}

func loadConfig() (config, error) {
	dataDir, err := appDataDir()
	if err != nil {
		return config{}, fmt.Errorf("resolve home directory: %w", err)
	}
	configDir, err := appConfigDir()
	if err != nil {
		return config{}, fmt.Errorf("resolve home directory: %w", err)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}
	hostname := os.Getenv("HOSTNAME")
	if hostname == "" {
		hostname = defaultHostname
	}

	return config{
		// 严格等于 "1"：与 isAuthDisabled() 一致，其它值不放行。
		AuthDisabled: os.Getenv("WR_AUTH_DISABLED") == "1",
		DataDir:      dataDir,
		ConfigDir:    configDir,
		DBPath:       filepath.Join(dataDir, "reports.db"),
		AuthPath:     filepath.Join(configDir, "auth.json"),
		Port:         port,
		Hostname:     hostname,
	}, nil
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	info := buildinfo.Current()
	log.Printf("wr serve: commit=%s built=%s", info.CommitHash, info.BuildTime)
	log.Printf("wr serve: data=%s config=%s authDisabled=%t", cfg.DataDir, cfg.ConfigDir, cfg.AuthDisabled)

	conn, err := db.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database %s: %w", cfg.DBPath, err)
	}
	defer conn.Close()
	// 单连接：SQLite 写串行是既有行为，连接池多开只会把写冲突变成 SQLITE_BUSY。
	conn.SetMaxOpenConns(1)

	// ---- 账本校验（ADR-0026，蓝图 §4 启动序列）----
	// 读 env 之后、挂路由与 embed 之前：只读校验 __drizzle_migrations 的已应用集合
	// 等于冻结头部（41/41），容忍历史怪癖；失败 fail closed 拒启，绝不执行迁移 SQL。
	// 显式迁移只在 `wr db migrate`。
	if err := validateLedger(conn); err != nil {
		return fmt.Errorf("migration ledger verification failed: %w", err)
	}
	// ---------------------------------------------

	spa, err := web.Handler()
	if err != nil {
		return fmt.Errorf("embed web/dist: %w", err)
	}

	router := api.NewRouter(api.Options{
		Auth: auth.Options{
			Disabled:     cfg.AuthDisabled,
			PasswordPath: cfg.AuthPath,
			Store:        auth.QueriesStore{Queries: db.New(conn)},
		},
		SPA: spa,
	})

	server := &http.Server{
		Addr:              cfg.Hostname + ":" + cfg.Port,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("wr serve: listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// validateLedger 是 serve 启动路径的账本接线点（#98 提供 internal/migrate）。
// 独立函数保留启动序列的形状：接线只改函数体、不动调用位置。
func validateLedger(conn *sql.DB) error {
	return migrate.Verify(context.Background(), conn)
}
