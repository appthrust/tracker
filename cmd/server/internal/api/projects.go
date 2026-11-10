package api

import (
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

func (a *API) projectList(s *request) (any, int, error) {
	includeArchived := false
	if s.r.URL.Query().Has("includeArchived") {
		switch s.r.URL.Query().Get("includeArchived") {
		case "true":
			includeArchived = true
		case "false":
		default:
			return nil, 0, invalid("includeArchived must be true or false")
		}
	}
	list, err := s.tx.Projects(includeArchived)
	return items[domain.Project]{list}, 200, err
}

func (a *API) projectGet(s *request) (any, int, error) {
	item, err := s.tx.Project(s.r.PathValue("id"))
	return item, 200, err
}

func (a *API) projectCreate(s *request) (any, int, error) {
	var input store.ProjectCreate
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateProject(input, s.actor)
	return item, 201, err
}

func (a *API) projectPatch(s *request) (any, int, error) {
	var input store.ProjectPatch
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchProject(s.r.PathValue("id"), input, s.actor)
	return item, 200, err
}

func (a *API) projectDelete(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteProject(s.r.PathValue("id"), s.actor)
}
