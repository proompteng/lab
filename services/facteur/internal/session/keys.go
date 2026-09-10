package session

import "fmt"

// DispatchKey returns the Redis key used to persist the last dispatch metadata for a user.
func DispatchKey(userID string) string {
	return fmt.Sprintf("dispatch:%s", userID)
}
