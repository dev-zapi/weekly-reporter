package db

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// 并发写者各自算 max(sequence)+1 再插入：BEGIN IMMEDIATE 必须把它们串行化，
// 不能出现重复序列号或 SQLITE_BUSY（这是 Go 服务与 Next 运行时共库的现场形状）。
func TestInImmediateTxSerializesSequenceAllocation(t *testing.T) {
	_, queries := openTestDB(t)

	const writers = 24
	var wait sync.WaitGroup
	errs := make(chan error, writers)
	sequences := make(chan int64, writers)

	for index := 0; index < writers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			err := queries.InImmediateTx(context.Background(), func(tx *Queries) error {
				var sequence int64
				if err := tx.db.QueryRowContext(context.Background(),
					`SELECT COALESCE(MAX(sequence), 0) + 1 FROM generation_message_parts WHERE session_id = 1`).
					Scan(&sequence); err != nil {
					return err
				}
				if _, err := tx.db.ExecContext(context.Background(),
					`INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, created_at)
					 VALUES (1, NULL, ?, 'assistant', 'text', 'x', 1700000000)`, sequence); err != nil {
					return err
				}
				sequences <- sequence
				return nil
			})
			if err != nil {
				errs <- err
			}
		}()
	}
	wait.Wait()
	close(errs)
	close(sequences)
	for err := range errs {
		t.Fatalf("writer failed: %v", err)
	}

	seen := map[int64]bool{}
	count := 0
	for sequence := range sequences {
		if seen[sequence] {
			t.Fatalf("duplicate sequence %d", sequence)
		}
		seen[sequence] = true
		count++
	}
	if count != writers {
		t.Fatalf("sequences = %d, want %d", count, writers)
	}
	for sequence := int64(1); sequence <= writers; sequence++ {
		if !seen[sequence] {
			t.Fatalf("missing sequence %d", sequence)
		}
	}
}

// fn 返回错误时必须整体回滚，不留下半个写事务。
func TestInImmediateTxRollsBackOnError(t *testing.T) {
	conn, queries := openTestDB(t)

	sentinel := errors.New("boom")
	err := queries.InImmediateTx(context.Background(), func(tx *Queries) error {
		if _, err := tx.db.ExecContext(context.Background(),
			`INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, created_at)
			 VALUES (1, NULL, 1, 'assistant', 'text', 'x', 1700000000)`); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want sentinel", err)
	}

	var count int64
	if err := conn.QueryRow(`SELECT COUNT(*) FROM generation_message_parts`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rows = %d, want 0 after rollback", count)
	}
}

// 已经在事务里（DBTX 不是 *sql.DB）时退化为直接执行，避免嵌套 BEGIN。
func TestInImmediateTxDegradesInsideTransaction(t *testing.T) {
	conn, queries := openTestDB(t)

	err := queries.InTx(context.Background(), func(tx *Queries) error {
		return tx.InImmediateTx(context.Background(), func(inner *Queries) error {
			_, err := inner.db.ExecContext(context.Background(),
				`INSERT INTO generation_message_parts (session_id, turn_id, sequence, role, part_type, content, created_at)
				 VALUES (1, NULL, 1, 'assistant', 'text', 'x', 1700000000)`)
			return err
		})
	})
	if err != nil {
		t.Fatalf("nested immediate tx: %v", err)
	}

	var count int64
	if err := conn.QueryRow(`SELECT COUNT(*) FROM generation_message_parts`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("rows = %d, want 1", count)
	}
}
