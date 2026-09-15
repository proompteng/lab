package main

func sequenceBefore(sequence uint64) uint64 {
	if sequence == 0 {
		return 0
	}

	return sequence - 1
}
