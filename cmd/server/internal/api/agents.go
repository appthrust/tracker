package api

import (
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

func (a *API) agentList(s *request) (any, int, error) {
	list, err := s.tx.Agents()
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
	return item, 201, err
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
	return item, 201, err
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
	return item, 200, err
}

func (a *API) runFinish(s *request) (any, int, error) {
	var input store.RunFinish
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.FinishRun(s.r.PathValue("id"), input, s.actor)
	return item, 200, err
}

func (a *API) runCancel(s *request) (any, int, error) {
	item, err := s.tx.CancelRun(s.r.PathValue("id"), s.actor)
	return item, 200, err
}

func (a *API) requestCreate(s *request) (any, int, error) {
	var input store.RequestCreate
	if err := decode(s, &input, "to", "runId"); err != nil {
		return nil, 0, err
	}
	to, err := a.assignee(s, input.To)
	if err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateRequest(s.r.PathValue("id"), input, s.actor, to)
	return item, 201, err
}

func (a *API) requestAnswer(s *request) (any, int, error) {
	var input store.RequestAnswer
	if err := decode(s, &input, "option"); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.AnswerRequest(s.r.PathValue("id"), input, s.actor)
	return item, 200, err
}
