package alpaca

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	marketdata "github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
)

var timeframePattern = regexp.MustCompile(`^(?i)(\d+)(min|minute|m|hour|hr|h|day|d|week|wk|w|month|mo)$`)

// ParseTimeFrame converts a human-friendly string (e.g. "5Min", "1Day")
// into an Alpaca marketdata.TimeFrame value.
func ParseTimeFrame(input string) (marketdata.TimeFrame, error) {
	matches := timeframePattern.FindStringSubmatch(strings.TrimSpace(input))
	if len(matches) != 3 {
		return marketdata.TimeFrame{}, fmt.Errorf("invalid timeframe: %s", input)
	}

	n, err := strconv.Atoi(matches[1])
	if err != nil || n <= 0 {
		return marketdata.TimeFrame{}, fmt.Errorf("invalid timeframe multiplier: %s", matches[1])
	}

	unit := mapTimeFrameUnit(matches[2])
	if unit == "" {
		return marketdata.TimeFrame{}, fmt.Errorf("unsupported timeframe unit: %s", matches[2])
	}

	return marketdata.NewTimeFrame(n, unit), nil
}

func mapTimeFrameUnit(token string) marketdata.TimeFrameUnit {
	switch strings.ToLower(token) {
	case "min", "minute", "m", "minutes":
		return marketdata.Min
	case "hour", "hr", "h", "hours":
		return marketdata.Hour
	case "day", "d", "days":
		return marketdata.Day
	case "week", "wk", "w", "weeks":
		return marketdata.Week
	case "month", "mo", "months":
		return marketdata.Month
	default:
		return ""
	}
}
