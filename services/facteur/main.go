package main

import (
	"log"

	"github.com/proompteng/lab/services/facteur/cmd/facteur"
)

func main() {
	if err := facteur.Execute(); err != nil {
		log.Fatalf("facteur: %v", err)
	}
}
