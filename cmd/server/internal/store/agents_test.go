package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func collaborationFixture(t *testing.T) (*Store, domain.Actor, domain.Actor, domain.Issue) {
	t.Helper()
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "agents"))
	person := domain.Actor{Person: domain.Person{Sub: "pat", Name: "Pat"}, Kind: "person", Role: "Admin"}
	var agent domain.Actor
	var issue domain.Issue
	require.NoError(t, db.InWorkspace(t.Context(), "agents", true, func(tx *Tx) error {
		a, err := tx.CreateAgent(AgentCreate{Handle: "astra", Name: "Astra", OwnerSub: person.Sub}, person.Person, person)
		if err != nil {
			return err
		}
		agent = domain.Actor{Person: a.Person(), Kind: "agent", AgentID: a.ID, Key: true}
		issue, err = tx.CreateIssue(IssueCreate{Title: "Assigned backlog", Type: "task"}, person.Person, &agent.Person)
		return err
	}))
	return db, person, agent, issue
}

func TestConcurrentStartsHaveOneLiveRun(t *testing.T) {
	db, _, agent, issue := collaborationFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan error, 12)
	for range 12 {
		go func() {
			<-start
			results <- db.InWorkspace(ctx, "agents", true, func(tx *Tx) error { _, err := tx.StartRun(issue.ID, RunStart{}, agent); return err })
		}()
	}
	close(start)
	wins := 0
	for range 12 {
		err := <-results
		if err == nil {
			wins++
			continue
		}
		var response *httpx.Error
		require.ErrorAs(t, err, &response)
		require.Equal(t, 409, response.Status)
	}
	require.Equal(t, 1, wins)
	require.NoError(t, db.InWorkspace(ctx, "agents", false, func(tx *Tx) error {
		runs, err := tx.Runs(issue.ID)
		require.NoError(t, err)
		require.Len(t, runs, 1)
		events, err := tx.Events(new(int64(0)), 500)
		require.NoError(t, err)
		require.Len(t, events.Items, 2)
		require.Equal(t, "run.started", events.Items[1].Type)
		return nil
	}))
}

func TestConcurrentEventCursorHasNoGapsOrLateRows(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "events"))
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	const writers = 32
	rollback := errors.New("deliberate rollback")
	results := make(chan error, writers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- db.InWorkspace(ctx, "events", true, func(tx *Tx) error {
				_, err := tx.CreateIssue(IssueCreate{Title: fmt.Sprintf("writer %d", i), Type: "task"}, domain.Person{Sub: "pat", Name: "Pat"}, nil)
				if err == nil && i%4 == 0 {
					return rollback
				}
				return err
			})
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	close(start)
	cursor := int64(0)
	seen := map[string]bool{}
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		err := db.InWorkspace(ctx, "events", false, func(tx *Tx) error {
			page, err := tx.Events(&cursor, 3)
			if err != nil {
				return err
			}
			for _, event := range page.Items {
				require.Equal(t, cursor+1, event.Seq)
				require.Equal(t, "issue.created", event.Type)
				require.Equal(t, fmt.Sprintf("APT-%d", event.Seq), event.Issue.Identifier, "issue and event allocation follow commit order")
				require.False(t, seen[event.Data.(string)])
				seen[event.Data.(string)] = true
				cursor = event.Seq
			}
			require.Equal(t, cursor, page.Next)
			return nil
		})
		require.NoError(t, err)
		if cursor == writers-writers/4 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	<-done
	for range writers {
		err := <-results
		if !errors.Is(err, rollback) {
			require.NoError(t, err)
		}
	}
	require.NoError(t, db.InWorkspace(ctx, "events", false, func(tx *Tx) error {
		page, err := tx.Events(&cursor, 500)
		require.NoError(t, err)
		require.Empty(t, page.Items)
		now, err := tx.Events(nil, 100)
		require.NoError(t, err)
		require.Empty(t, now.Items)
		require.Equal(t, cursor, now.Next)
		return nil
	}))
}

func TestReviewApprovalUpdatesPersonAttributionAndSprintLedger(t *testing.T) {
	db, person, agent, issue := collaborationFixture(t)
	now := time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC)
	db.Now = func() time.Time { return now }
	require.NoError(t, db.InWorkspace(t.Context(), "agents", true, func(tx *Tx) error {
		sprint, err := tx.CreateSprint(SprintCreate{StartsOn: new("2026-11-11"), LengthWeeks: new(1)})
		require.NoError(t, err)
		_, err = tx.PatchIssue(issue.ID, IssuePatch{Estimate: field("M"), SprintID: field(sprint.ID)}, person.Person, nil)
		require.NoError(t, err)
		_, err = tx.StartSprint(sprint.ID)
		require.NoError(t, err)
		run, err := tx.StartRun(issue.ID, RunStart{}, agent)
		require.NoError(t, err)
		approval, err := tx.CreateRequest(issue.ID, RequestCreate{Kind: "approval", Title: "Proceed?", RunID: &run.ID}, agent, nil)
		require.NoError(t, err)
		_, err = tx.FinishRun(run.ID, RunFinish{Outcome: "succeeded", Summary: "Ready"}, agent)
		require.ErrorContains(t, err, "open approvals")
		_, err = tx.WithdrawRequest(approval.ID, agent)
		require.NoError(t, err)
		question, err := tx.CreateRequest(issue.ID, RequestCreate{Kind: "question", Title: "Obsolete?", RunID: &run.ID}, agent, nil)
		require.NoError(t, err)
		_, err = tx.FinishRun(run.ID, RunFinish{Outcome: "succeeded", Summary: "Ready"}, agent)
		require.NoError(t, err)
		q, err := tx.Request(question.ID)
		require.NoError(t, err)
		require.Equal(t, "withdrawn", q.State)
		requests, err := tx.Requests(RequestFilter{State: "open", Issue: issue.ID})
		require.NoError(t, err)
		require.Len(t, requests, 1)
		review := requests[0]
		require.Equal(t, "review", review.Kind)
		require.Equal(t, "Ready", review.Body)
		before, err := tx.Sprint(sprint.ID)
		require.NoError(t, err)
		require.Zero(t, before.Current.DonePoints)
		_, err = tx.AnswerRequest(review.ID, RequestAnswer{Option: new("approve")}, agent)
		require.Error(t, err)
		_, err = tx.AnswerRequest(review.ID, RequestAnswer{Option: new("approve")}, person)
		require.NoError(t, err)
		after, err := tx.Sprint(sprint.ID)
		require.NoError(t, err)
		require.Equal(t, 3, after.Current.ScopePoints)
		require.Equal(t, 3, after.Current.DonePoints)
		require.Equal(t, 1, after.Current.DoneIssues)
		assertLedgerRecount(t, tx, sprint.ID)
		timeline, err := tx.Timeline(issue.ID)
		require.NoError(t, err)
		statusActors := []string{}
		for _, item := range timeline {
			if item.Activity != nil && item.Activity.Field == "status" {
				statusActors = append(statusActors, item.Activity.Actor.Sub)
			}
		}
		require.Equal(t, []string{person.Sub}, statusActors)
		events, err := tx.Events(new(int64(0)), 500)
		require.NoError(t, err)
		last := events.Items[len(events.Items)-2:]
		require.Equal(t, "issue.updated", last[0].Type)
		require.Equal(t, person.Sub, last[0].Actor.Sub)
		require.Equal(t, "request.answered", last[1].Type)
		return nil
	}))
}

func TestAgentFixtureAndReadFilters(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	now := time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC)
	db.Now = func() time.Time { return now }
	require.NoError(t, db.SeedDev(t.Context(), "seed"))
	require.NoError(t, db.InWorkspace(t.Context(), "seed", false, func(tx *Tx) error {
		agents, err := tx.Agents(true)
		require.NoError(t, err)
		require.Len(t, agents, 4)
		byHandle := map[string]domain.Agent{}
		for _, a := range agents {
			byHandle[a.Handle] = a
		}
		require.Equal(t, 1, byHandle["astra"].ActiveRuns)
		require.Equal(t, 1, byHandle["astra"].OpenRequests)
		require.Equal(t, 1, byHandle["opus-ui"].ActiveRuns)
		require.Equal(t, 1, byHandle["opus-ui"].OpenRequests)
		require.Equal(t, 0, byHandle["claude"].ActiveRuns)
		require.Equal(t, 1, byHandle["claude"].OpenRequests)
		require.True(t, byHandle["legacy-bot"].Disabled)
		actor, err := tx.AgentBySubject("astra")
		require.NoError(t, err)
		inbox, err := tx.Inbox(actor)
		require.NoError(t, err)
		assigned := []int64{}
		kinds := map[string]int{}
		for _, item := range inbox {
			kinds[item.Kind]++
			if item.Kind == "assignment" {
				assigned = append(assigned, item.Issue.Number)
			}
		}
		require.ElementsMatch(t, []int64{4, 9, 15, 19, 42}, assigned)
		require.Equal(t, 1, kinds["answer"])
		require.Equal(t, 1, kinds["mention"])
		for _, tc := range []struct {
			filter  domain.Filter
			numbers []int64
		}{
			{domain.Filter{Run: []string{"active"}}, []int64{15, 27}},
			{domain.Filter{Run: []string{"stalled"}}, []int64{9}},
			{domain.Filter{Request: []string{"mine"}}, []int64{16}},
			{domain.Filter{Request: []string{"open"}}, []int64{1, 16, 27}},
			{domain.Filter{Agent: []string{actor.AgentID}}, []int64{4, 9, 15, 16, 19, 42}},
		} {
			page, err := tx.ListIssues(ListOptions{Filter: tc.filter, Subject: actor.Sub, Sort: domain.SortNumber})
			require.NoError(t, err)
			numbers := []int64{}
			for _, i := range page.Items {
				numbers = append(numbers, i.Number)
			}
			require.Equal(t, tc.numbers, numbers)
		}
		return nil
	}))
}
