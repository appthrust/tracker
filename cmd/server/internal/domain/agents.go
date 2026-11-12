package domain

import (
	"encoding/json"
	"strings"
	"time"
)

// ActorKind derives attribution for existing snapshots without rewriting history.
func ActorKind(sub string) string {
	if strings.HasPrefix(sub, "agent:") {
		return "agent"
	}
	return "person"
}

func (p Person) MarshalJSON() ([]byte, error) {
	type person Person
	return json.Marshal(struct {
		person
		Kind string `json:"kind"`
	}{person(p), ActorKind(p.Sub)})
}

type AgentIdentity struct {
	ID       string `json:"id"`
	Handle   string `json:"handle"`
	Owner    Person `json:"owner"`
	Disabled bool   `json:"disabled"`
}

type Agent struct {
	ID              string     `json:"id"`
	Handle          string     `json:"handle"`
	Name            string     `json:"name"`
	Description     string     `json:"description"`
	Owner           Person     `json:"owner"`
	Disabled        bool       `json:"disabled"`
	RegisteredByKey *string    `json:"registeredByKey"`
	ActiveRuns      int        `json:"activeRuns"`
	OpenRequests    int        `json:"openRequests"`
	LastSeenAt      *time.Time `json:"lastSeenAt"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

func (a Agent) Person() Person {
	return Person{Sub: "agent:" + a.ID, Name: a.Name, Agent: &AgentIdentity{ID: a.ID, Handle: a.Handle, Owner: a.Owner, Disabled: a.Disabled}}
}

type RunLink struct {
	Kind  string `json:"kind"`
	URL   string `json:"url"`
	Title string `json:"title"`
}

type Run struct {
	ID             string     `json:"id"`
	Issue          IssueRef   `json:"issue"`
	Agent          Person     `json:"agent"`
	State          string     `json:"state"`
	Reason         *string    `json:"reason"`
	Session        string     `json:"session"`
	Note           string     `json:"note"`
	Summary        string     `json:"summary"`
	Links          []RunLink  `json:"links"`
	StartedAt      time.Time  `json:"startedAt"`
	HeartbeatAt    time.Time  `json:"heartbeatAt"`
	LeaseExpiresAt time.Time  `json:"leaseExpiresAt"`
	FinishedAt     *time.Time `json:"finishedAt"`
}

func RunState(state string, leaseExpiresAt, now time.Time) string {
	if (state == "running" || state == "waiting") && leaseExpiresAt.Before(now) {
		return "stalled"
	}
	return state
}

// Expired leases cannot be revived. The next start closes the old run.
func LiveRun(state string) bool { return state == "running" || state == "waiting" }

type RequestAnswer struct {
	Option *string   `json:"option"`
	Body   string    `json:"body"`
	By     Person    `json:"by"`
	At     time.Time `json:"at"`
}

type Request struct {
	ID        string         `json:"id"`
	Issue     IssueRef       `json:"issue"`
	Kind      string         `json:"kind"`
	From      Person         `json:"from"`
	To        *Person        `json:"to"`
	Title     string         `json:"title"`
	Body      string         `json:"body"`
	Options   []string       `json:"options"`
	RunID     *string        `json:"runId"`
	State     string         `json:"state"`
	Answer    *RequestAnswer `json:"answer"`
	CreatedAt time.Time      `json:"createdAt"`
}

type InboxItem struct {
	Kind    string        `json:"kind"`
	Request *Request      `json:"request,omitempty"`
	Issue   *IssueSummary `json:"issue,omitempty"`
	Comment *Comment      `json:"comment,omitempty"`
}

func (i InboxItem) MarshalJSON() ([]byte, error) {
	type item InboxItem
	if i.Kind == "mention" {
		return json.Marshal(struct {
			Kind    string   `json:"kind"`
			Comment *Comment `json:"comment"`
			Issue   IssueRef `json:"issue"`
		}{i.Kind, i.Comment, IssueRef{ID: i.Issue.ID, Identifier: i.Issue.Identifier, Title: i.Issue.Title, StatusID: i.Issue.StatusID}})
	}
	return json.Marshal(item(i))
}

type ActionableInput struct {
	Deleted         bool
	Category        string
	OtherActiveRun  bool
	OwnOpenRequest  bool
	UnfinishedBlock bool
}

func Actionable(in ActionableInput) bool {
	return !in.Deleted && (in.Category == "backlog" || in.Category == "unstarted" || in.Category == "started") && !in.OtherActiveRun && !in.OwnOpenRequest && !in.UnfinishedBlock
}

type Event struct {
	Seq   int64     `json:"seq"`
	At    time.Time `json:"at"`
	Issue *IssueRef `json:"issue"`
	Actor Person    `json:"actor"`
	Type  string    `json:"type"`
	Data  any       `json:"data"`
}
