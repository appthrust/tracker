package domain

import (
	"errors"
	"math"
	"time"
)

// SizePoints is a fixed scale: changing it would invalidate ledger history.
func SizePoints(size string) int {
	switch size {
	case "XS":
		return 1
	case "S":
		return 2
	case "M":
		return 3
	case "L":
		return 5
	case "XL":
		return 8
	default:
		return 0
	}
}

type SprintStanding struct {
	SprintID string
	Size     string
	Category string
	Deleted  bool
}
type SprintTally = Tally

type SprintEvent struct {
	At time.Time
	SprintTally
}
type Date = time.Time
type SprintSpan struct{ StartsOn, EndsOn Date }

// Day supplies all clock, timezone and unit decisions to the pure calculation.
// Until is exclusive. Events must be ordered by At and days by Date.
type Day struct {
	Date   Date
	Until  time.Time
	Future bool
	Unit   string
}

func Contribution(s SprintStanding) SprintTally {
	if s.SprintID == "" || s.Deleted || s.Category == "canceled" {
		return SprintTally{}
	}
	tally := SprintTally{ScopePoints: SizePoints(s.Size), ScopeIssues: 1}
	if s.Category == "completed" {
		tally.DonePoints, tally.DoneIssues = tally.ScopePoints, 1
	}
	return tally
}
func SprintDeltas(before, after SprintStanding) map[string]SprintTally {
	old, next := Contribution(before), Contribution(after)
	deltas := make(map[string]SprintTally, 2)
	if before.SprintID != "" {
		deltas[before.SprintID] = SprintTally{-old.ScopePoints, -old.ScopeIssues, -old.DonePoints, -old.DoneIssues}
	}
	if after.SprintID != "" {
		d := deltas[after.SprintID]
		d.ScopePoints += next.ScopePoints
		d.ScopeIssues += next.ScopeIssues
		d.DonePoints += next.DonePoints
		d.DoneIssues += next.DoneIssues
		deltas[after.SprintID] = d
	}
	for id, d := range deltas {
		if d == (SprintTally{}) {
			delete(deltas, id)
		}
	}
	return deltas
}

func Burndown(baseline SprintTally, events []SprintEvent, days []Day) []BurndownPoint {
	points := make([]BurndownPoint, 0, len(days))
	steps := 0
	for i, day := range days {
		if i > 0 && weekday(day.Date) {
			steps++
		}
	}
	elapsed, event := 0, 0
	var tally SprintTally
	for i, day := range days {
		if i > 0 && weekday(day.Date) {
			elapsed++
		}
		remaining := baseline.ScopePoints - baseline.DonePoints
		if day.Unit == "issues" {
			remaining = baseline.ScopeIssues - baseline.DoneIssues
		}
		ideal := float64(remaining)
		if steps > 0 {
			ideal *= float64(steps-elapsed) / float64(steps)
		}
		ideal = math.Round(ideal*100) / 100
		point := BurndownPoint{Day: day.Date.Format("2006-01-02"), Ideal: ideal}
		if !day.Future {
			for event < len(events) && events[event].At.Before(day.Until) {
				d := events[event].SprintTally
				tally.ScopePoints += d.ScopePoints
				tally.ScopeIssues += d.ScopeIssues
				tally.DonePoints += d.DonePoints
				tally.DoneIssues += d.DoneIssues
				event++
			}
			scope, done := tally.ScopePoints, tally.DonePoints
			if day.Unit == "issues" {
				scope, done = tally.ScopeIssues, tally.DoneIssues
			}
			rest := scope - done
			point.Scope, point.Done, point.Remaining = &scope, &done, &rest
		}
		points = append(points, point)
	}
	return points
}
func weekday(date Date) bool { return date.Weekday() != time.Saturday && date.Weekday() != time.Sunday }

var ErrSprintOverlap = errors.New("Sprint dates overlap another non-closed sprint")

func ValidateSprintDates(startsOn Date, lengthWeeks int, others []SprintSpan) error {
	if startsOn.IsZero() {
		return &FieldError{Path: "startsOn", Message: "Start date must be YYYY-MM-DD"}
	}
	if lengthWeeks != 1 && lengthWeeks != 2 {
		return &FieldError{Path: "lengthWeeks", Message: "Sprint length must be 1 or 2 weeks"}
	}
	endsOn := startsOn.AddDate(0, 0, 7*lengthWeeks-1)
	for _, other := range others {
		if !startsOn.After(other.EndsOn) && !endsOn.Before(other.StartsOn) {
			return ErrSprintOverlap
		}
	}
	return nil
}
func ValidateMembership(issueType string, sprintState string, lineageMembers int) error {
	if issueType == "epic" {
		return &FieldError{Path: "sprintId", Message: "Epics cannot belong to a sprint"}
	}
	if sprintState != "planned" && sprintState != "active" {
		return &FieldError{Path: "sprintId", Message: "Sprint must be planned or active in this workspace"}
	}
	if lineageMembers != 0 {
		return &FieldError{Path: "sprintId", Message: "An ancestor or descendant already belongs to this sprint"}
	}
	return nil
}
