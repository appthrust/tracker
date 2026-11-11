package api

import (
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"strconv"
)

func (a *API) agentList(s *request) (any, int, error) {
	includeDisabled := false
	if s.r.URL.Query().Has("includeDisabled") {
		switch s.r.URL.Query().Get("includeDisabled") {
		case "true":
			includeDisabled = true
		case "false":
		default:
			return nil, 0, invalid("includeDisabled must be true or false")
		}
	}
	list, err := s.tx.Agents(includeDisabled)
	return items[domain.Agent]{Items: list}, 200, err
}

func (a *API) agentCreate(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input store.AgentCreate
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if domain.ActorKind(input.OwnerSub) != "person" {
		return nil, 0, invalid("An agent owner must be a person")
	}
	owner, err := a.assignee(s, &input.OwnerSub)
	if err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateAgent(input, *owner, s.actor)
	return &item, 201, err
}

func (a *API) inbox(s *request) (any, int, error) {
	list, err := s.tx.Inbox(s.actor)
	return items[domain.InboxItem]{Items: list}, 200, err
}

func (a *API) runStart(s *request) (any, int, error) {
	var input store.RunStart
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.StartRun(s.r.PathValue("id"), input, s.actor)
	return &item, 201, err
}

func (a *API) runList(s *request) (any, int, error) {
	list, err := s.tx.Runs(s.r.PathValue("id"))
	return items[domain.Run]{Items: list}, 200, err
}

func (a *API) runHeartbeat(s *request) (any, int, error) {
	var input struct {
		Note *string `json:"note"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.HeartbeatRun(s.r.PathValue("id"), input.Note, s.actor)
	return &item, 200, err
}

func (a *API) runFinish(s *request) (any, int, error) {
	var input struct {
		Outcome string           `json:"outcome"`
		Summary *string          `json:"summary"`
		Links   []domain.RunLink `json:"links"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if input.Summary == nil {
		return nil, 0, invalid("Summary is required")
	}
	item, err := s.tx.FinishRun(s.r.PathValue("id"), store.RunFinish{Outcome: input.Outcome, Summary: *input.Summary, Links: input.Links}, s.actor)
	return &item, 200, err
}

func (a *API) runCancel(s *request) (any, int, error) {
	item, err := s.tx.CancelRun(s.r.PathValue("id"), s.actor)
	return &item, 200, err
}

func (a *API) requestCreate(s *request) (any, int, error) {
	var input store.RequestCreate
	if err := decode(s, &input, "to", "runId"); err != nil {
		return nil, 0, err
	}
	to, err := a.assignee(s, input.To.Value)
	if err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateRequest(s.r.PathValue("id"), input, s.actor, to)
	return &item, 201, err
}

func (a *API) requestAnswer(s *request) (any, int, error) {
	var input store.RequestAnswer
	if err := decode(s, &input, "option"); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.AnswerRequest(s.r.PathValue("id"), input, s.actor)
	return &item, 200, err
}

func (a *API) agentPatch(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input store.AgentPatch
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if input.OwnerSub != nil && domain.ActorKind(*input.OwnerSub) != "person" {
		return nil, 0, invalid("An agent owner must be a person")
	}
	owner, err := a.assignee(s, input.OwnerSub)
	if err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchAgent(s.r.PathValue("id"), input, owner, s.actor)
	return &item, 200, err
}

func (a *API) inboxAck(s *request) (any, int, error) {
	var input store.InboxAck
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	return nil, 204, s.tx.AckInbox(input, s.actor)
}

func (a *API) events(s *request) (any, int, error) {
	q := s.r.URL.Query()
	var after *int64
	limit := 100
	if q.Has("after") {
		value, err := strconv.ParseInt(q.Get("after"), 10, 64)
		if err != nil || value < 0 {
			return nil, 0, invalid("After must be a nonnegative integer")
		}
		after = &value
	}
	if q.Has("limit") {
		value, err := strconv.Atoi(q.Get("limit"))
		if err != nil || value < 1 || value > 500 {
			return nil, 0, invalid("Limit must be between 1 and 500")
		}
		limit = value
	}
	page, err := s.tx.Events(after, limit)
	return &page, 200, err
}

func (a *API) runGet(s *request) (any, int, error) {
	item, err := s.tx.Run(s.r.PathValue("id"))
	return &item, 200, err
}

func (a *API) requestGet(s *request) (any, int, error) {
	item, err := s.tx.Request(s.r.PathValue("id"))
	return &item, 200, err
}

func (a *API) requestList(s *request) (any, int, error) {
	q := s.r.URL.Query()
	to := q.Get("to")
	if to == "me" {
		to = s.actor.Sub
	}
	list, err := s.tx.Requests(store.RequestFilter{State: q.Get("state"), To: to, Issue: q.Get("issue")})
	return items[domain.Request]{Items: list}, 200, err
}

func (a *API) requestWithdraw(s *request) (any, int, error) {
	item, err := s.tx.WithdrawRequest(s.r.PathValue("id"), s.actor)
	return &item, 200, err
}
