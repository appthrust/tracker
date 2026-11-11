package api

import (
	"github.com/appthrust/appserver-go/appserver/httpx"
	"strconv"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

func (a *API) sprintList(s *request) (any, int, error) {
	if s.r.URL.Query().Has("state") && s.r.URL.Query().Get("state") == "" {
		return nil, 0, &domain.FieldError{Path: "state", Message: "State must be planned, active, or closed"}
	}
	list, err := s.tx.Sprints(s.r.URL.Query().Get("state"))
	return items[domain.Sprint]{list}, 200, err
}
func (a *API) sprintGet(s *request) (any, int, error) {
	item, err := s.tx.Sprint(s.r.PathValue("id"))
	return item, 200, err
}
func (a *API) sprintCreate(s *request) (any, int, error) {
	var input store.SprintCreate
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateSprint(input)
	return item, 201, err
}
func (a *API) sprintPatch(s *request) (any, int, error) {
	var input store.SprintPatch
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchSprint(s.r.PathValue("id"), input)
	return item, 200, err
}
func (a *API) sprintStart(s *request) (any, int, error) {
	if !domain.Can(s.actor, domain.ManageSprint, domain.Target{}) {
		return nil, 0, httpx.Forbidden()
	}
	item, err := s.tx.StartSprint(s.r.PathValue("id"))
	return item, 200, err
}
func (a *API) sprintClose(s *request) (any, int, error) {
	if !domain.Can(s.actor, domain.ManageSprint, domain.Target{}) {
		return nil, 0, httpx.Forbidden()
	}
	var input struct {
		MoveIncompleteTo store.Field[string] `json:"moveIncompleteTo"`
	}
	if err := decode(s, &input, "moveIncompleteTo"); err != nil {
		return nil, 0, err
	}
	if !input.MoveIncompleteTo.Present {
		return nil, 0, &domain.FieldError{Path: "moveIncompleteTo", Message: "Specify a planned sprint ID or null"}
	}
	item, err := s.tx.CloseSprint(s.r.PathValue("id"), input.MoveIncompleteTo.Value, s.actor.Person)
	return item, 200, err
}
func (a *API) sprintDelete(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteSprint(s.r.PathValue("id"), s.actor)
}
func (a *API) sprintBurndown(s *request) (any, int, error) {
	q := s.r.URL.Query()
	item, err := s.tx.Burndown(s.r.PathValue("id"), q.Get("unit"), q.Get("project"))
	return item, 200, err
}
func (a *API) velocity(s *request) (any, int, error) {
	q := s.r.URL.Query()
	limit := 8
	if q.Has("limit") {
		n, err := strconv.Atoi(q.Get("limit"))
		if err != nil || n < 1 || n > 26 {
			return nil, 0, &domain.FieldError{Path: "limit", Message: "Limit must be between 1 and 26"}
		}
		limit = n
	}
	item, err := s.tx.Velocity(q.Get("unit"), q.Get("project"), limit)
	return item, 200, err
}
