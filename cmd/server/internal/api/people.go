package api

import (
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
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
	issue := func(i *domain.IssueSummary) { person(&i.Reporter); person(i.Assignee) }
	valuePerson := func(value any) {
		m, ok := value.(map[string]any)
		if !ok {
			return
		}
		sub, ok := m["sub"].(string)
		if !ok {
			return
		}
		name, _ := m["name"].(string)
		p := domain.Person{Sub: sub, Name: name}
		person(&p)
		m["name"] = p.Name
		m["kind"] = domain.ActorKind(p.Sub)
		if p.Email != "" {
			m["email"] = p.Email
		}
		if p.AvatarURL != "" {
			m["avatarUrl"] = p.AvatarURL
		} else {
			delete(m, "avatarUrl")
		}
		if p.ProfileURL != "" {
			m["profileUrl"] = p.ProfileURL
		}
	}
	switch value := body.(type) {
	case *meResponse:
		person(&value.Person)
	case *domain.Issue:
		issue(&value.IssueSummary)
	case *store.Page:
		for i := range value.Items {
			issue(&value.Items[i])
		}
	case *domain.Comment:
		person(&value.Author)
	case *domain.Attachment:
		person(&value.Uploader)
	case *domain.View:
		person(&value.Owner)
	case *items[domain.View]:
		for i := range value.Items {
			person(&value.Items[i].Owner)
		}
	case *items[domain.TimelineItem]:
		for _, item := range value.Items {
			if item.Comment != nil {
				person(&item.Comment.Author)
			}
			if item.Activity != nil {
				person(&item.Activity.Actor)
				if item.Activity.Field == "assignee" {
					valuePerson(item.Activity.From)
					valuePerson(item.Activity.To)
				}
				if item.Activity.Field == "attachment" {
					for _, raw := range []any{item.Activity.From, item.Activity.To} {
						if attachment, ok := raw.(map[string]any); ok {
							valuePerson(attachment["uploader"])
						}
					}
				}
			}
		}
	}
}
