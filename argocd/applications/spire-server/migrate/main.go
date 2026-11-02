// spire-migrate copies an offline SQLite snapshot into an unused PostgreSQL database.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
	"github.com/sirupsen/logrus"
	"github.com/spiffe/spire/pkg/server/datastore/sqlstore"
)

func main() {
	source := flag.String("source", "", "offline SQLite snapshot (created with sqlite backup API)")
	flag.Parse()
	dsn := os.Getenv("SPIRE_MIGRATION_DSN")
	if *source == "" || dsn == "" {
		fmt.Fprintln(os.Stderr, "require -source and SPIRE_MIGRATION_DSN; stop all SPIRE writers first")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := migrate(ctx, *source, dsn); err != nil {
		// Driver errors can include credentials or row data. Keep those out of logs.
		fmt.Fprintln(os.Stderr, err.Error()+"; destination data transaction was not committed")
		os.Exit(1)
	}
	fmt.Println("all tables verified; migration committed")
}

type migrationError struct {
	stage string
	cause error
}

func (e *migrationError) Error() string { return "migration failed during " + e.stage }
func (e *migrationError) Unwrap() error { return e.cause }

func migrate(ctx context.Context, path, dsn string) (err error) {
	stage := "source snapshot validation"
	defer func() {
		if err != nil {
			err = &migrationError{stage: stage, cause: err}
		}
	}()
	if _, err := os.Stat(path); err != nil {
		return err
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	src, err := sql.Open("sqlite3", u.String())
	if err != nil {
		return err
	}
	defer src.Close()
	src.SetMaxOpenConns(1)
	var integrity string
	if err := src.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return errors.New("invalid source snapshot")
	}
	var version string
	if err := src.QueryRowContext(ctx, "SELECT code_version FROM migrations").Scan(&version); err != nil || version != "1.15.3" {
		return errors.New("source must match pinned SPIRE version")
	}
	stage = "destination connection and emptiness checks"
	dst, err := sql.Open("postgres", dsn)
	if err != nil {
		return err
	}
	defer dst.Close()
	// An advisory lock also prevents a second migration process from racing the emptiness check.
	conn, err := dst.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var locked bool
	if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(741529830)").Scan(&locked); err != nil || !locked {
		return errors.New("another migration is active")
	}
	defer conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(741529830)")
	var existing int
	if err := conn.QueryRowContext(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'").Scan(&existing); err != nil || existing != 0 {
		return errors.New("destination must be a new empty database")
	}
	// Use the exact server's own schema migrations, rather than translating SQLite DDL.
	stage = "SPIRE PostgreSQL schema initialization"
	log := logrus.New()
	log.SetOutput(io.Discard)
	plugin := sqlstore.New(log)
	if err := plugin.Configure(ctx, fmt.Sprintf("database_type = %q\nconnection_string = %q", "postgres", dsn)); err != nil {
		return err
	}
	if err := plugin.Close(); err != nil {
		return err
	}
	stage = "schema compatibility checks"
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	sourceTables, err := tables(ctx, src, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return err
	}
	targetTables, err := tables(ctx, tx, "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
	if err != nil {
		return err
	}
	if strings.Join(sourceTables, ",") != strings.Join(targetTables, ",") {
		return errors.New("schema table mismatch")
	}
	quoted := make([]string, len(targetTables))
	for i, table := range targetTables {
		quoted[i] = pq.QuoteIdentifier(table)
	}
	if _, err := tx.ExecContext(ctx, "TRUNCATE "+strings.Join(quoted, ",")+" RESTART IDENTITY"); err != nil {
		return err
	}
	for _, table := range sourceTables {
		stage = "copy and verification of table " + table
		if err := copyTable(ctx, src, tx, table); err != nil {
			return err
		}
	}
	stage = "verified data commit"
	return tx.Commit()
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func tables(ctx context.Context, db queryer, query string) ([]string, error) {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		result = append(result, name)
	}
	return result, rows.Err()
}

func copyTable(ctx context.Context, src *sql.DB, tx *sql.Tx, table string) error {
	metadata, err := tx.QueryContext(ctx, "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", table)
	if err != nil {
		return err
	}
	var names, types, quoted, placeholders []string
	for metadata.Next() {
		var name, typ string
		if err := metadata.Scan(&name, &typ); err != nil {
			metadata.Close()
			return err
		}
		names = append(names, name)
		types = append(types, typ)
		quoted = append(quoted, pq.QuoteIdentifier(name))
		placeholders = append(placeholders, fmt.Sprintf("$%d", len(names)))
	}
	if err := metadata.Err(); err != nil {
		metadata.Close()
		return err
	}
	metadata.Close()
	t := pq.QuoteIdentifier(table)
	all, err := src.QueryContext(ctx, "SELECT * FROM "+t+" LIMIT 0")
	if err != nil {
		return err
	}
	allCols, err := all.Columns()
	all.Close()
	if err != nil {
		return err
	}
	expectedCols := append([]string(nil), names...)
	sort.Strings(allCols)
	sort.Strings(expectedCols)
	if strings.Join(allCols, ",") != strings.Join(expectedCols, ",") {
		return errors.New("source column mismatch")
	}
	query := "SELECT " + strings.Join(quoted, ",") + " FROM " + t
	sourceRows, err := src.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer sourceRows.Close()
	cols, err := sourceRows.Columns()
	if err != nil || len(cols) != len(names) {
		return errors.New("column mismatch")
	}
	// Also reject extra source columns: selecting only target columns could silently lose data.
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO "+t+" ("+strings.Join(quoted, ",")+") VALUES ("+strings.Join(placeholders, ",")+")")
	if err != nil {
		return err
	}
	defer stmt.Close()
	var hashes []string
	for sourceRows.Next() {
		values := make([]any, len(names))
		ptrs := make([]any, len(names))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := sourceRows.Scan(ptrs...); err != nil {
			return err
		}
		for i, typ := range types {
			values[i], err = normalize(values[i], typ)
			if err != nil {
				return err
			}
		}
		if _, err := stmt.ExecContext(ctx, values...); err != nil {
			return err
		}
		hash, err := rowHash(values, types)
		if err != nil {
			return err
		}
		hashes = append(hashes, hash)
	}
	if err := sourceRows.Err(); err != nil {
		return err
	}
	sourceRows.Close()
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	var got []string
	for rows.Next() {
		values := make([]any, len(names))
		ptrs := make([]any, len(names))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			rows.Close()
			return err
		}
		hash, err := rowHash(values, types)
		if err != nil {
			rows.Close()
			return err
		}
		got = append(got, hash)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	sort.Strings(hashes)
	sort.Strings(got)
	if strings.Join(hashes, ",") != strings.Join(got, ",") {
		return errors.New("row verification failed")
	}
	for _, name := range names {
		var seq sql.NullString
		if err := tx.QueryRowContext(ctx, "SELECT pg_get_serial_sequence($1,$2)", table, name).Scan(&seq); err != nil {
			return err
		}
		if seq.Valid {
			_, err := tx.ExecContext(ctx, "SELECT setval($1::regclass, COALESCE(MAX("+pq.QuoteIdentifier(name)+"),1), COUNT(*)>0) FROM "+t, seq.String)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func normalize(value any, typ string) (any, error) {
	if value == nil {
		return nil, nil
	}
	if typ == "boolean" {
		switch v := value.(type) {
		case int64:
			if v == 0 || v == 1 {
				return v == 1, nil
			}
		case bool:
			return v, nil
		}
		return nil, errors.New("invalid boolean")
	}
	if strings.HasPrefix(typ, "timestamp") {
		if v, ok := value.(time.Time); ok {
			return v.UTC().Round(time.Microsecond), nil
		}
		return nil, errors.New("invalid timestamp")
	}
	if b, ok := value.([]byte); ok && typ != "bytea" {
		return string(b), nil
	}
	return value, nil
}

func rowHash(values []any, types []string) (string, error) {
	canonical := make([]any, len(values))
	for i, v := range values {
		var err error
		canonical[i], err = normalize(v, types[i])
		if err != nil {
			return "", err
		}
	}
	data, err := json.Marshal(canonical)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(data)), nil
}
