package api

import (
	"github.com/appthrust/tracker/cmd/server/internal/domain"
)

type peopleResponse struct {
	Items  []domain.Person `json:"items"`
	Source string          `json:"source"`
}

func (a *API) people(s *request) (any, int, error) {
	q := s.r.URL.Query().Get("q")
	if !domain.Text(q, 0, 4096) {
		return nil, 0, invalid("Search text must be at most 4096 characters")
	}
	list, err := a.directory.Search(s.r.Context(), s.bearer, q)
	if err != nil {
		return peopleResponse{Items: []domain.Person{}, Source: "unavailable"}, 200, nil
	}
	return peopleResponse{Items: list, Source: "directory"}, 200, nil
}

// Enrich outside the database transaction: Directory is optional and must never
// turn a committed Tracker mutation into a failed response.
func (a *API) enrich(s *request, body any) {
	type resolution struct {
		person   domain.Person
		fallback bool
	}
	resolved := map[string]resolution{}
	person := func(p *domain.Person) {
		if p == nil || domain.ActorKind(p.Sub) == "agent" {
			return
		}
		if value, ok := resolved[p.Sub]; ok {
			if !value.fallback {
				*p = value.person
			}
			return
		}
		snapshot := *p
		*p = a.directory.Enrich(s.r.Context(), s.bearer, snapshot)
		resolved[p.Sub] = resolution{person: *p, fallback: *p == snapshot}
	}
	projection := responseActors(body)
	for _, p := range projection.people {
		person(p)
	}
	projection.apply()
}
