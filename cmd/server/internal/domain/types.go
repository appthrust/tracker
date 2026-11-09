// Package domain defines Tracker's pure values and invariants. It performs no I/O.
package domain

import "time"

type Person struct {
	Sub        string `json:"sub"`
	Name       string `json:"name"`
	AvatarURL  string `json:"avatarUrl,omitempty"`
	Email      string `json:"email,omitempty"`
	ProfileURL string `json:"profileUrl,omitempty"`
}
type Actor struct {
	Person
	Role string
}
type Workspace struct {
	ID         string    `json:"id"`
	Key        string    `json:"key"`
	Name       string    `json:"name"`
	IssueCount int       `json:"issueCount"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}
type Status struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
	Position int    `json:"position"`
	Color    string `json:"color"`
}
type Label struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}
type Report struct {
	Environment string `json:"environment"`
	Surface     string `json:"surface"`
	Version     string `json:"version,omitempty"`
	Steps       string `json:"steps,omitempty"`
	Expected    string `json:"expected,omitempty"`
	Actual      string `json:"actual,omitempty"`
}
type IssueRef struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Title      string `json:"title"`
	StatusID   string `json:"statusId"`
}
type IssueSummary struct {
	ID              string     `json:"id"`
	Identifier      string     `json:"identifier"`
	Number          int64      `json:"number"`
	Title           string     `json:"title"`
	Type            string     `json:"type"`
	Priority        string     `json:"priority"`
	StatusID        string     `json:"statusId"`
	Assignee        *Person    `json:"assignee"`
	Reporter        Person     `json:"reporter"`
	LabelIDs        []string   `json:"labelIds"`
	Parent          *IssueRef  `json:"parent"`
	DueOn           *string    `json:"dueOn"`
	Report          *Report    `json:"report"`
	CommentCount    int        `json:"commentCount"`
	AttachmentCount int        `json:"attachmentCount"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	CompletedAt     *time.Time `json:"completedAt"`
}
type Issue struct {
	IssueSummary
	Description string     `json:"description"`
	Children    []IssueRef `json:"children"`
	Blocks      []IssueRef `json:"blocks"`
	BlockedBy   []IssueRef `json:"blockedBy"`
}
type Comment struct {
	ID        string     `json:"id"`
	IssueID   string     `json:"issueId"`
	Author    Person     `json:"author"`
	Body      string     `json:"body"`
	CreatedAt time.Time  `json:"createdAt"`
	EditedAt  *time.Time `json:"editedAt"`
}
type Attachment struct {
	ID        string    `json:"id"`
	IssueID   string    `json:"issueId"`
	Filename  string    `json:"filename"`
	MediaType string    `json:"mediaType"`
	Size      int       `json:"size"`
	URL       string    `json:"url"`
	Uploader  Person    `json:"uploader"`
	CreatedAt time.Time `json:"createdAt"`
}
type Activity struct {
	ID        string    `json:"id"`
	IssueID   string    `json:"issueId"`
	Actor     Person    `json:"actor"`
	Field     string    `json:"field"`
	From      any       `json:"from"`
	To        any       `json:"to"`
	CreatedAt time.Time `json:"createdAt"`
}
type TimelineItem struct {
	Kind     string    `json:"kind"`
	Activity *Activity `json:"activity,omitempty"`
	Comment  *Comment  `json:"comment,omitempty"`
}
type Filter struct {
	Status       []string `json:"status,omitempty"`
	Category     []string `json:"category,omitempty"`
	Assignee     []string `json:"assignee,omitempty"`
	Label        []string `json:"label,omitempty"`
	Type         []string `json:"type,omitempty"`
	Priority     []string `json:"priority,omitempty"`
	Q            string   `json:"q,omitempty"`
	CreatedAfter string   `json:"createdAfter,omitempty"`
	Environment  []string `json:"environment,omitempty"`
	Surface      []string `json:"surface,omitempty"`
	Parent       string   `json:"parent,omitempty"`
}
type Sort string

const (
	SortUpdated  Sort = "updated"
	SortCreated  Sort = "created"
	SortPriority Sort = "priority"
	SortNumber   Sort = "number"
)

type View struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Owner     Person    `json:"owner"`
	Shared    bool      `json:"shared"`
	Layout    string    `json:"layout"`
	Filter    Filter    `json:"filter"`
	Sort      Sort      `json:"sort"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
