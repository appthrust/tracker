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
		{"agent reads", agent, Read, Target{}, true},
		{"agent creates", agent, Create, Target{}, true},
		{"agent edits unrelated", agent, EditIssue, Target{}, true},
		{"agent controls assigned", agent, ControlIssue, Target{OwnerSub: agent.Sub}, true},
		{"agent controls reported", agent, ControlIssue, Target{ReporterSub: agent.Sub}, true},
		{"agent cannot control unrelated", agent, ControlIssue, Target{OwnerSub: person.Sub, ReporterSub: person.Sub}, false},
		{"person controls any", person, ControlIssue, Target{}, true},
		{"agent withdraws own", agent, WithdrawRequest, Target{OwnerSub: agent.Sub}, true},
		{"agent cannot withdraw other", agent, WithdrawRequest, Target{OwnerSub: person.Sub}, false},
		{"person withdraws own", person, WithdrawRequest, Target{OwnerSub: person.Sub}, true},
		{"admin cannot withdraw other", admin, WithdrawRequest, Target{OwnerSub: agent.Sub}, false},
		{"agent edits own comment", agent, EditComment, Target{OwnerSub: agent.Sub}, true},
		{"agent cannot edit other comment", agent, EditComment, Target{OwnerSub: person.Sub}, false},
		{"agent cannot delete issue", agent, DeleteIssue, Target{OwnerSub: agent.Sub}, false},
		{"agent cannot delete comment", agent, DeleteComment, Target{OwnerSub: agent.Sub}, false},
		{"agent cannot delete attachment", agent, DeleteAttachment, Target{OwnerSub: agent.Sub}, false},
		{"agent cannot delete private view", agent, DeleteView, Target{OwnerSub: agent.Sub}, false},
		{"person deletes private view", person, DeleteView, Target{OwnerSub: person.Sub}, true},
		{"agent private view", agent, CreateView, Target{}, true},
		{"agent no shared view", agent, CreateView, Target{Shared: true}, false},
		{"agent edits private view", agent, ManageView, Target{OwnerSub: agent.Sub}, true},
		{"agent cannot edit shared view", agent, ManageView, Target{OwnerSub: agent.Sub, Shared: true}, false},
		{"agent cannot start close sprint", agent, ManageSprint, Target{}, false},
		{"person starts closes sprint", person, ManageSprint, Target{}, true},
		{"key starts closes sprint", key, ManageSprint, Target{}, true},
		{"agent cannot archive project", agent, ArchiveProject, Target{}, false},
		{"agent cannot delete project", agent, DeleteProject, Target{}, false},
		{"key cannot delete issue", key, DeleteIssue, Target{}, false},
		{"key cannot share view", key, CreateView, Target{Shared: true}, false},
		{"key cannot override review addressee", key, AnswerRequest, Target{OwnerSub: "other", RequestKind: "review"}, false},
		{"person cannot drive run", person, HeartbeatRun, Target{OwnerSub: person.Sub}, false},
		{"person cannot finish run", person, FinishRun, Target{OwnerSub: person.Sub}, false},
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
		{ActionableInput{Category: "backlog"}, true},
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
