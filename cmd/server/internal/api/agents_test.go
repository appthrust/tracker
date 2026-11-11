package api

import (
	"testing"
	"time"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestExternalKeyPreservesProjectScopeAndViewerBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, project, subject string
		scopes                 []string
		mutation               bool
		code                   int
	}{
		{"external", "pj", "external:poc-astra", []string{scopeRead}, false, 200},
		{"user", "pj", "user:pat", []string{scopeWrite}, true, 200},
		{"project", "other", "external:poc-astra", []string{scopeRead}, false, 401},
		{"scope", "pj", "external:poc-astra", []string{scopeRead}, true, 403},
		{"component", "pj", "component:web", []string{scopeRead}, false, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actor, err := keyActor(accesskey.Principal{Project: tc.project, Subject: tc.subject, Scopes: tc.scopes}, "pj", tc.mutation)
			if tc.code == 200 {
				require.NoError(t, err)
				require.Equal(t, "Viewer", actor.Role)
				require.True(t, actor.Key)
				require.False(t, domain.Can(actor, domain.ManageWorkspace, domain.Target{}))
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestAgentLeaseWaitingAndDisabledBoundaries(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	h.database.Now = func() time.Time { return now }
	h.database.RunLease = time.Minute
	a := call[domain.Agent](h, "admin", "POST", "/agents", store.AgentCreate{Handle: "astra", Name: "Astra", KeySubject: "poc-astra", OwnerSub: "owner"}, 201)
	sub := "agent:" + a.ID
	statuses := call[items[domain.Status]](h, "admin", "GET", "/statuses", nil, 200)
	unstarted := ""
	for _, status := range statuses.Items {
		if status.Category == "unstarted" {
			unstarted = status.ID
			break
		}
	}
	assigned := call[domain.Issue](h, "admin", "POST", "/issues", map[string]string{"title": "Delegated", "type": "task", "assigneeSub": sub, "statusId": unstarted}, 201)
	require.Equal(t, "admin", assigned.Delegator.Sub)
	person := domain.Actor{Person: domain.Person{Sub: "admin", Name: "admin"}, Kind: "person", Role: "Admin"}
	var run domain.Run
	var first, second domain.Request
	write := func(fn func(*store.Tx) error) {
		require.NoError(t, h.database.InWorkspace(t.Context(), "pj-test", true, fn))
	}
	write(func(tx *store.Tx) error {
		actor, err := tx.AgentBySubject("poc-astra")
		require.NoError(t, err)
		run, err = tx.StartRun(assigned.ID, store.RunStart{}, actor)
		require.NoError(t, err)
		input := store.RequestCreate{Kind: "question", Title: "Decision?", RunID: &run.ID}
		first, err = tx.CreateRequest(assigned.ID, input, actor, nil)
		require.NoError(t, err)
		second, err = tx.CreateRequest(assigned.ID, input, actor, nil)
		require.NoError(t, err)
		_, err = tx.AnswerRequest(first.ID, store.RequestAnswer{Body: "First"}, person)
		require.NoError(t, err)
		current, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "waiting", current.State, "one open request still holds the run")
		_, err = tx.AnswerRequest(second.ID, store.RequestAnswer{Body: "Second"}, person)
		require.NoError(t, err)
		current, err = tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "running", current.State)
		first, err = tx.CreateRequest(assigned.ID, input, actor, nil)
		require.NoError(t, err)
		inbox, err := tx.Inbox(actor)
		require.NoError(t, err)
		for _, item := range inbox {
			require.NotEqual(t, "assignment", item.Kind, "waiting on a live request is not actionable")
		}
		return nil
	})
	now = now.Add(time.Minute)
	write(func(tx *store.Tx) error {
		current, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "waiting", current.State, "lease equality is still live")
		return nil
	})
	now = now.Add(time.Microsecond)
	write(func(tx *store.Tx) error {
		actor, err := tx.AgentBySubject("poc-astra")
		require.NoError(t, err)
		current, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "stalled", current.State)
		inbox, err := tx.Inbox(actor)
		require.NoError(t, err)
		assignments := 0
		for _, item := range inbox {
			if item.Kind == "assignment" && item.Issue.ID == assigned.ID {
				assignments++
			}
		}
		require.Equal(t, 1, assignments, "an expired run and its pending request must not hide recovery work")
		_, err = tx.HeartbeatRun(run.ID, nil, actor)
		require.ErrorContains(t, err, "lease has expired")
		_, err = tx.FinishRun(run.ID, store.RunFinish{Outcome: "succeeded"}, actor)
		require.ErrorContains(t, err, "lease has expired")
		next, err := tx.StartRun(assigned.ID, store.RunStart{}, actor)
		require.NoError(t, err)
		old, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "failed", old.State)
		require.Equal(t, "lease_expired", *old.Reason)
		_, err = tx.CancelRun(next.ID, person)
		require.NoError(t, err)
		next, err = tx.StartRun(assigned.ID, store.RunStart{}, actor)
		require.NoError(t, err)
		pending, err := tx.CreateRequest(assigned.ID, store.RequestCreate{Kind: "question", Title: "Before reassignment", RunID: &next.ID}, actor, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(assigned.ID, store.IssuePatch{AssigneeSub: store.Field[string]{Present: true}}, person.Person, nil)
		require.NoError(t, err)
		canceled, err := tx.Run(next.ID)
		require.NoError(t, err)
		require.Equal(t, "canceled", canceled.State)
		require.Equal(t, "reassigned", *canceled.Reason)
		withdrawn, err := tx.Request(pending.ID)
		require.NoError(t, err)
		require.Equal(t, "withdrawn", withdrawn.State)
		return nil
	})
	cleared := call[domain.Issue](h, "admin", "PATCH", "/issues/"+assigned.ID, map[string]any{"assigneeSub": nil}, 200)
	require.Nil(t, cleared.Delegator)
	write(func(tx *store.Tx) error { return tx.Exec(`UPDATE tracker_agent SET disabled=true WHERE id=$1`, a.ID) })
	write(func(tx *store.Tx) error {
		_, err := tx.AgentBySubject("poc-astra")
		require.ErrorContains(t, err, "active registered agent")
		return nil
	})
	for _, target := range []string{sub, "agent:unknown"} {
		response := call[map[string]any](h, "admin", "PATCH", "/issues/"+assigned.ID, map[string]string{"assigneeSub": target}, 400)
		issues := response["issues"].([]any)
		require.Equal(t, "assigneeSub", issues[0].(map[string]any)["path"])
	}
}
