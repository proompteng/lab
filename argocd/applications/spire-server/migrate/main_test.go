package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/sirupsen/logrus"
	"github.com/spiffe/spire/pkg/server/datastore/sqlstore"
)

func TestNormalize(t *testing.T) {
	for _, v := range []int64{0, 1} {
		got, err := normalize(v, "boolean")
		if err != nil || got != (v == 1) {
			t.Fatal("boolean conversion")
		}
	}
	if _, err := normalize(int64(2), "boolean"); err == nil {
		t.Fatal("invalid boolean accepted")
	}
	now := time.Date(2026, 10, 7, 1, 2, 3, 123456789, time.FixedZone("fixture", 3600))
	got, err := normalize(now, "timestamp with time zone")
	if err != nil || !got.(time.Time).Equal(now.Round(time.Microsecond)) || got.(time.Time).Location() != time.UTC {
		t.Fatal("timestamp conversion")
	}
	data := []byte{0, 255, 1}
	h1, _ := rowHash([]any{data, int64(1), now}, []string{"bytea", "boolean", "timestamp with time zone"})
	h2, _ := rowHash([]any{data, true, now.Round(time.Microsecond)}, []string{"bytea", "boolean", "timestamp with time zone"})
	if h1 != h2 {
		t.Fatal("round trip normalization")
	}
}

func TestMigrationRoundTrip(t *testing.T) {
	base := os.Getenv("SPIRE_MIGRATION_TEST_DSN")
	if base == "" {
		t.Skip("set SPIRE_MIGRATION_TEST_DSN for real PostgreSQL integration")
	}
	ctx := context.Background()
	admin, err := sql.Open("postgres", base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	name := fmt.Sprintf("spire_migration_%d", time.Now().UnixNano())
	if _, err = admin.ExecContext(ctx, "CREATE DATABASE "+pq.QuoteIdentifier(name)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.ExecContext(ctx, "DROP DATABASE "+pq.QuoteIdentifier(name)+" WITH (FORCE)") })
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	dsn := u.String()
	path := filepath.Join(t.TempDir(), "snapshot.sqlite3")
	log := logrus.New()
	log.SetOutput(io.Discard)
	p := sqlstore.New(log)
	if err = p.Configure(ctx, fmt.Sprintf("database_type=%q\nconnection_string=%q", "sqlite3", path)); err != nil {
		t.Fatal(err)
	}
	if err = p.Close(); err != nil {
		t.Fatal(err)
	}
	src, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 7, 1, 2, 3, 123456789, time.UTC)
	_, err = src.ExecContext(ctx, "INSERT INTO bundles (id,created_at,updated_at,trust_domain,data) VALUES (41,?,?,?,?)", now, now, "proompteng.ai", []byte{0, 255, 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = src.ExecContext(ctx, "INSERT INTO attested_node_entries (id,created_at,updated_at,spiffe_id,can_reattest,expires_at) VALUES (72,?,?,?,?,?)", now, now, "spiffe://proompteng.ai/spire/agent/test", true, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	_, err = src.ExecContext(ctx, "INSERT INTO registered_entries (id,entry_id,spiffe_id,parent_id,ttl,admin,downstream,store_svid) VALUES (901,'entry-fixture','spiffe://proompteng.ai/workload','spiffe://proompteng.ai/spire/agent/test',120,0,0,0)")
	if err != nil {
		t.Fatal(err)
	}
	_, err = src.ExecContext(ctx, "INSERT INTO selectors (id,registered_entry_id,type,value) VALUES (51,901,'unix','uid:1000')")
	if err != nil {
		t.Fatal(err)
	}
	src.Close()
	if err = migrate(ctx, path, dsn); err != nil {
		t.Fatal(err)
	}
	dst, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer dst.Close()
	var data []byte
	var when time.Time
	if err = dst.QueryRowContext(ctx, "SELECT data,created_at FROM bundles WHERE id=41").Scan(&data, &when); err != nil {
		t.Fatal(err)
	}
	if string(data) != string([]byte{0, 255, 1}) || !when.Equal(now.Round(time.Microsecond)) {
		t.Fatal("bundle changed")
	}
	var allowed bool
	if err = dst.QueryRowContext(ctx, "SELECT can_reattest FROM attested_node_entries WHERE id=72").Scan(&allowed); err != nil || !allowed {
		t.Fatal("agent changed")
	}
	var next int
	if err = dst.QueryRowContext(ctx, "INSERT INTO bundles (trust_domain) VALUES ('sequence.test') RETURNING id").Scan(&next); err != nil || next != 42 {
		t.Fatalf("sequence not reset: %d, %v", next, err)
	}
	if err = migrate(ctx, path, dsn); err == nil {
		t.Fatal("nonempty target overwritten")
	}
	var count int
	if err = dst.QueryRowContext(ctx, "SELECT count(*) FROM bundles").Scan(&count); err != nil || count != 2 {
		t.Fatal("destination changed on rejected rerun")
	}
	// An invalid boolean must abort the import without retaining any copied rows.
	failedName := name + "_failed"
	if _, err = admin.ExecContext(ctx, "CREATE DATABASE "+pq.QuoteIdentifier(failedName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.ExecContext(ctx, "DROP DATABASE "+pq.QuoteIdentifier(failedName)+" WITH (FORCE)") })
	u.Path = "/" + failedName
	badDSN := u.String()
	src, err = sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = src.ExecContext(ctx, "UPDATE attested_node_entries SET can_reattest=2")
	src.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, path, badDSN); err == nil {
		t.Fatal("invalid source boolean imported")
	}
	failed, err := sql.Open("postgres", badDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer failed.Close()
	if err = failed.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM bundles)+(SELECT count(*) FROM attested_node_entries)+(SELECT count(*) FROM registered_entries)").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed import retained copied rows")
	}
}
