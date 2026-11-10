package domain

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/oklog/ulid/v2"
)

var keyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,5}$`)
var Categories = []string{"backlog", "unstarted", "started", "completed", "canceled"}
var Priorities = []string{"urgent", "high", "medium", "low", "none"}
var Types = []string{"epic", "story", "bug", "feature", "task"}
var Surfaces = []string{"dashboard", "platform-api", "apth", "builder-console", "console-app", "cluster", "other"}
var Colors = []string{"gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink"}

func ValidKey(key string) bool { return keyPattern.MatchString(key) }
func ValidID(id string) bool   { _, err := ulid.ParseStrict(id); return err == nil }
func FormatIdentifier(key string, number int64) string {
	return key + "-" + strconv.FormatInt(number, 10)
}
func ParseIdentifier(raw string) (string, int64, error) {
	key, value, ok := strings.Cut(strings.ToUpper(raw), "-")
	if !ok || !ValidKey(key) || value == "" || value[0] == '0' {
		return "", 0, errors.New("Invalid issue identifier")
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return "", 0, errors.New("Invalid issue identifier")
		}
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number < 1 {
		return "", 0, errors.New("Invalid issue identifier")
	}
	return key, number, nil
}
func DefaultStatuses() []Status {
	return []Status{
		{Name: "Backlog", Category: "backlog", Position: 0, Color: "gray"},
		{Name: "Todo", Category: "unstarted", Position: 1, Color: "gray"},
		{Name: "In Progress", Category: "started", Position: 2, Color: "yellow"},
		{Name: "In Review", Category: "started", Position: 3, Color: "blue"},
		{Name: "Done", Category: "completed", Position: 4, Color: "green"},
		{Name: "Canceled", Category: "canceled", Position: 5, Color: "gray"},
	}
}

// TransitionCompletedAt is applied only when an issue's status changes.
func TransitionCompletedAt(category string, now time.Time) *time.Time {
	if category != "completed" && category != "canceled" {
		return nil
	}
	now = now.UTC()
	return &now
}

type Action string

const (
	Read             Action = "read"
	Create           Action = "create"
	EditIssue        Action = "edit_issue"
	ManageWorkspace  Action = "manage_workspace"
	DeleteIssue      Action = "delete_issue"
	EditComment      Action = "edit_comment"
	DeleteComment    Action = "delete_comment"
	DeleteAttachment Action = "delete_attachment"
	CreateView       Action = "create_view"
	ManageView       Action = "manage_view"
	CreateProject    Action = "create_project"
	EditProject      Action = "edit_project"
	ArchiveProject   Action = "archive_project"
	DeleteProject    Action = "delete_project"
)

type Target struct {
	OwnerSub string
	Shared   bool
}

func Can(actor Actor, action Action, target Target) bool {
	if actor.Sub == "" {
		return false
	}
	admin := actor.Role == "Admin"
	switch action {
	case Read, Create, EditIssue, CreateProject, EditProject:
		return true
	case ManageWorkspace, DeleteIssue, ArchiveProject, DeleteProject:
		return admin
	case EditComment:
		return actor.Sub == target.OwnerSub
	case DeleteComment, DeleteAttachment:
		return admin || actor.Sub == target.OwnerSub
	case CreateView:
		return !target.Shared || admin
	case ManageView:
		if target.Shared {
			return admin
		}
		return actor.Sub == target.OwnerSub
	default:
		return false
	}
}
func ParentCycle(id, parent string, parents map[string]string) bool {
	seen := map[string]bool{id: true}
	for parent != "" {
		if seen[parent] {
			return true
		}
		seen[parent] = true
		parent = parents[parent]
	}
	return false
}

func Level(kind string) int {
	switch kind {
	case "epic":
		return 2
	case "story":
		return 1
	default:
		return 0
	}
}

// ValidateHierarchy treats an empty parent type as no parent.
func ValidateHierarchy(childType, parentType string) error {
	if parentType == "" || Level(childType) == 0 || Level(parentType) > Level(childType) {
		return nil
	}
	if childType == "epic" {
		return errors.New("Epics cannot have a parent")
	}
	return errors.New("Stories can only have an epic parent")
}
func Text(value string, min, max int) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(strings.TrimSpace(value)) >= min && utf8.RuneCountInString(value) <= max
}
func ValidateReport(kind string, report *Report) error {
	if (kind == "bug") != (report != nil) {
		return errors.New("Report is required if and only if type is bug")
	}
	if report == nil {
		return nil
	}
	if !Text(report.Environment, 1, 4096) || !slices.Contains(Surfaces, report.Surface) {
		return errors.New("Report requires an environment and a valid surface")
	}
	for _, value := range []string{report.Version, report.Steps, report.Expected, report.Actual} {
		if !Text(value, 0, 4096) {
			return errors.New("Report text must be at most 4096 characters")
		}
	}
	return nil
}
func ValidateIssue(issue Issue) error {
	if !Text(issue.Title, 1, 200) {
		return errors.New("Title must contain 1 to 200 characters")
	}
	if !utf8.ValidString(issue.Description) || len(issue.Description) > 50<<10 {
		return errors.New("Description must be valid UTF-8 and at most 50 KiB")
	}
	if !slices.Contains(Types, issue.Type) || !slices.Contains(Priorities, issue.Priority) {
		return errors.New("Invalid issue type or priority")
	}
	if issue.DueOn != nil {
		if _, err := time.Parse("2006-01-02", *issue.DueOn); err != nil {
			return errors.New("Due date must be YYYY-MM-DD")
		}
	}
	return ValidateReport(issue.Type, issue.Report)
}

// FieldError identifies invalid input at the API boundary.
type FieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func (e *FieldError) Error() string { return e.Message }

func ValidateProject(project Project) error {
	if !Text(project.Name, 1, 60) {
		return errors.New("Project name must contain 1 to 60 characters")
	}
	if !utf8.ValidString(project.Description) || len(project.Description) > 4096 {
		return errors.New("Project description must be valid UTF-8 and at most 4096 bytes")
	}
	if !slices.Contains(Colors, project.Color) {
		return errors.New("Project color must be in the palette")
	}
	return nil
}
func ValidateFilter(filter Filter) error {
	for _, field := range []struct {
		name            string
		values, allowed []string
	}{
		{"category", filter.Category, Categories}, {"type", filter.Type, Types}, {"priority", filter.Priority, Priorities}, {"surface", filter.Surface, Surfaces},
	} {
		for _, value := range field.values {
			if !slices.Contains(field.allowed, value) {
				return fmt.Errorf("Invalid %s filter", field.name)
			}
		}
	}
	for _, ids := range [][]string{filter.Status, filter.Label} {
		for _, id := range ids {
			if !ValidID(id) {
				return errors.New("Filter contains an invalid resource ID")
			}
		}
	}
	for _, id := range filter.Project {
		if id != "none" && !ValidID(id) {
			return errors.New("Invalid project filter")
		}
	}
	for _, field := range []struct {
		name string
		ids  []string
	}{{"epic", filter.Epic}, {"story", filter.Story}} {
		for _, id := range field.ids {
			if id != "none" && !ValidID(id) {
				return &FieldError{Path: "filter." + field.name, Message: "Filter must contain issue IDs or none"}
			}
		}
	}
	if len(filter.Reporter) > 20 {
		return &FieldError{Path: "filter.reporter", Message: "Reporter filter must contain at most 20 entries"}
	}
	for _, sub := range filter.Reporter {
		if !Text(sub, 1, 4096) {
			return &FieldError{Path: "filter.reporter", Message: "Filter values must contain 1 to 4096 characters"}
		}
		if sub == "none" {
			return &FieldError{Path: "filter.reporter", Message: "Reporter filter does not support none"}
		}
	}
	for _, values := range [][]string{filter.Assignee, filter.Environment} {
		for _, value := range values {
			if !Text(value, 1, 4096) {
				return errors.New("Filter values must contain 1 to 4096 characters")
			}
		}
	}
	if filter.Parent != "" && filter.Parent != "none" && !ValidID(filter.Parent) {
		return errors.New("Invalid parent filter")
	}
	if filter.CreatedAfter != "" {
		if _, err := time.Parse(time.RFC3339, filter.CreatedAfter); err != nil {
			return errors.New("createdAfter must be RFC3339")
		}
	}
	if !Text(filter.Q, 0, 4096) {
		return errors.New("Search text must be at most 4096 characters")
	}
	return nil
}
func ValidSort(sort Sort) bool {
	return sort == SortUpdated || sort == SortCreated || sort == SortPriority || sort == SortNumber
}
func ValidateView(view View) error {
	if !Text(view.Name, 1, 60) {
		return errors.New("View name must contain 1 to 60 characters")
	}
	if view.Layout != "list" && view.Layout != "board" {
		return errors.New("Layout must be list or board")
	}
	if view.GroupBy != "none" && view.GroupBy != "epic" && view.GroupBy != "story" {
		return &FieldError{Path: "groupBy", Message: "Group by must be none, epic, or story"}
	}
	if !ValidSort(view.Sort) {
		return errors.New("Invalid sort")
	}
	return ValidateFilter(view.Filter)
}
func ValidateAttachment(filename, mediaType string, size int) error {
	if !Text(filename, 1, 200) || strings.ContainsAny(filename, "\r\n\x00") {
		return errors.New("Invalid attachment filename")
	}
	if !slices.Contains([]string{"image/png", "image/jpeg", "image/webp", "text/plain", "application/json"}, mediaType) {
		return errors.New("Unsupported attachment media type")
	}
	if size < 1 || size > 2<<20 {
		return errors.New("Attachment must contain 1 byte to 2 MiB")
	}
	return nil
}
