package migrations

import "embed"

// Files exposes the embedded SQL migrations.
//
//go:embed *.sql
var Files embed.FS
