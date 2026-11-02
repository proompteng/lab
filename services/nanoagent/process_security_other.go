//go:build !linux

package main

func hardenProcessMemory() error {
	return nil
}
