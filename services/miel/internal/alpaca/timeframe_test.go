package alpaca

import (
	"testing"

	marketdata "github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
)

func TestParseTimeFrameValid(t *testing.T) {
	cases := map[string]marketdata.TimeFrame{
		"1Min":  marketdata.NewTimeFrame(1, marketdata.Min),
		"15m":   marketdata.NewTimeFrame(15, marketdata.Min),
		"2Hour": marketdata.NewTimeFrame(2, marketdata.Hour),
		"3day":  marketdata.NewTimeFrame(3, marketdata.Day),
		"4WK":   marketdata.NewTimeFrame(4, marketdata.Week),
		"6mo":   marketdata.NewTimeFrame(6, marketdata.Month),
	}

	for input, expected := range cases {
		tf, err := ParseTimeFrame(input)
		if err != nil {
			t.Fatalf("ParseTimeFrame(%s) returned error: %v", input, err)
		}
		if tf.N != expected.N || tf.Unit != expected.Unit {
			t.Fatalf("ParseTimeFrame(%s) = %+v, expected %+v", input, tf, expected)
		}
	}
}

func TestParseTimeFrameInvalid(t *testing.T) {
	cases := []string{"", "abc", "0Min", "-5Min", "1Century"}

	for _, input := range cases {
		if _, err := ParseTimeFrame(input); err == nil {
			t.Fatalf("expected error for ParseTimeFrame(%s)", input)
		}
	}
}
