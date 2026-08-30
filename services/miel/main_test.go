package main

import "testing"

func TestNormalizeAddr(t *testing.T) {
	if got := normalizeAddr(":8080"); got != ":8080" {
		t.Fatalf("expected :8080, got %s", got)
	}
	if got := normalizeAddr("8080"); got != ":8080" {
		t.Fatalf("expected :8080, got %s", got)
	}
}
