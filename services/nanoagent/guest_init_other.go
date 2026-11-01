//go:build !linux

package main

import (
	"errors"
	"log/slog"
)

func runGuestInit(*slog.Logger) error { return errors.New("guest init requires Linux") }
