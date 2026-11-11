package domain

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCollaborationAuthorization(t *testing.T) {
	person := Actor{Person: Person{Sub: "pat"}, Kind: "person"}
	agent := Actor{Person: Person{Sub: "agent:a"}, Kind: "agent", AgentID: "a", Key: true}
	admin := person
	admin.Role = "Admin"
	key := admin
	key.Key = true
	for _, tc := range []struct {
		name   string
		actor  Actor
		action Action
		target Target
		want   bool
	}{
		{"person completes", person, SetStatus, Target{Category: "completed", AgentCompletion: "review"}, true},
		{"agent cannot complete", agent, SetStatus, Target{Category: "completed", AgentCompletion: "review"}, false},
		{"direct completion", agent, SetStatus, Target{Category: "completed", AgentCompletion: "direct"}, true},
		{"other status", agent, SetStatus, Target{Category: "started", AgentCompletion: "review"}, true},
		{"self assignment own report", agent, AssignAgent, Target{OwnerSub: "agent:a", ReporterSub: "agent:a"}, true},
		{"cannot pull backlog", agent, AssignAgent, Target{OwnerSub: "agent:a", ReporterSub: "pat"}, false},
		{"cannot assign another agent", agent, AssignAgent, Target{OwnerSub: "agent:b", ReporterSub: "agent:a"}, false},
		{"start assigned", agent, StartRun, Target{OwnerSub: "agent:a"}, true},
		{"start unassigned", agent, StartRun, Target{OwnerSub: "agent:b"}, false},
		{"person cannot start", person, StartRun, Target{OwnerSub: "pat"}, false},
		{"heartbeat owner", agent, HeartbeatRun, Target{OwnerSub: "agent:a"}, true},
		{"heartbeat other", agent, HeartbeatRun, Target{OwnerSub: "agent:b"}, false},
		{"finish owner", agent, FinishRun, Target{OwnerSub: "agent:a"}, true},
		{"finish other", agent, FinishRun, Target{OwnerSub: "agent:b"}, false},
		{"person cancel", person, CancelRun, Target{OwnerSub: "agent:a"}, true},
		{"agent cancel own", agent, CancelRun, Target{OwnerSub: "agent:a"}, true},
		{"agent cancel other", agent, CancelRun, Target{OwnerSub: "agent:b"}, false},
		{"agent question", agent, AnswerRequest, Target{OwnerSub: "agent:a", RequestKind: "question"}, true},
		{"agent not any person", agent, AnswerRequest, Target{RequestKind: "question"}, false},
		{"agent never approves", agent, AnswerRequest, Target{OwnerSub: "agent:a", RequestKind: "approval"}, false},
		{"agent never reviews", agent, AnswerRequest, Target{OwnerSub: "agent:a", RequestKind: "review"}, false},
		{"person addressed", person, AnswerRequest, Target{OwnerSub: "pat", RequestKind: "review"}, true},
		{"person not addressed", person, AnswerRequest, Target{OwnerSub: "other", RequestKind: "review"}, false},
		{"any person", person, AnswerRequest, Target{RequestKind: "approval"}, true},
		{"admin override", admin, AnswerRequest, Target{OwnerSub: "other", RequestKind: "review"}, true},
		{"admin management", admin, ManageWorkspace, Target{}, true},
		{"key never admin", key, ManageWorkspace, Target{}, false},
		{"agent never admin", agent, ManageWorkspace, Target{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) { require.Equal(t, tc.want, Can(tc.actor, tc.action, tc.target)) })
	}
}

func TestRunLeaseDerivation(t *testing.T) {
	now := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	for _, state := range []string{"running", "waiting", "succeeded", "failed", "canceled"} {
		for _, delta := range []time.Duration{-time.Nanosecond, 0, time.Nanosecond} {
			want := state
			if LiveRun(state) && delta < 0 {
				want = "stalled"
			}
			require.Equal(t, want, RunState(state, now.Add(delta), now))
		}
	}
	require.False(t, LiveRun("stalled"))
}

func TestActionable(t *testing.T) {
	for _, tc := range []struct {
		input ActionableInput
		want  bool
	}{
		{ActionableInput{Category: "unstarted"}, true},
		{ActionableInput{Category: "started"}, true},
		{ActionableInput{Category: "backlog"}, false},
		{ActionableInput{Category: "completed"}, false},
		{ActionableInput{Category: "canceled"}, false},
		{ActionableInput{Category: "started", Deleted: true}, false},
		{ActionableInput{Category: "started", OtherActiveRun: true}, false},
		{ActionableInput{Category: "started", OwnOpenRequest: true}, false},
		{ActionableInput{Category: "started", UnfinishedBlock: true}, false},
	} {
		require.Equal(t, tc.want, Actionable(tc.input))
	}
}

func TestPersonWireKind(t *testing.T) {
	for _, sub := range []string{"pat", "agent:a"} {
		data, err := json.Marshal(Person{Sub: sub, Name: sub})
		require.NoError(t, err)
		var wire map[string]any
		require.NoError(t, json.Unmarshal(data, &wire))
		require.Equal(t, ActorKind(sub), wire["kind"])
	}
}
