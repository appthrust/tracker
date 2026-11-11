package api

import (
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

type actorProjection struct {
	people []*domain.Person
	values []struct {
		person *domain.Person
		value  map[string]any
	}
}

func responseActors(body any) actorProjection {
	var p actorProjection
	person := func(person *domain.Person) {
		if person != nil {
			p.people = append(p.people, person)
			if person.Agent != nil {
				p.people = append(p.people, &person.Agent.Owner)
			}
		}
	}
	run := func(run *domain.Run) {
		if run != nil {
			person(&run.Agent)
		}
	}
	request := func(r *domain.Request) {
		if r != nil {
			person(&r.From)
			person(r.To)
			if r.Answer != nil {
				person(&r.Answer.By)
			}
		}
	}
	comment := func(c *domain.Comment) {
		if c != nil {
			person(&c.Author)
			for i := range c.Mentions {
				person(&c.Mentions[i])
			}
		}
	}
	issue := func(i *domain.IssueSummary) {
		if i != nil {
			person(&i.Reporter)
			person(i.Assignee)
			person(i.Delegator)
			run(i.ActiveRun)
		}
	}
	value := func(raw any) {
		m, ok := raw.(map[string]any)
		if !ok {
			return
		}
		sub, ok := m["sub"].(string)
		if !ok {
			return
		}
		name, _ := m["name"].(string)
		who := &domain.Person{Sub: sub, Name: name}
		person(who)
		p.values = append(p.values, struct {
			person *domain.Person
			value  map[string]any
		}{who, m})
	}
	switch v := body.(type) {
	case *meResponse:
		person(&v.Person)
	case *domain.Agent:
		person(&v.Owner)
	case items[domain.Agent]:
		for i := range v.Items {
			person(&v.Items[i].Owner)
		}
	case *domain.Issue:
		issue(&v.IssueSummary)
	case *store.Page:
		for i := range v.Items {
			issue(&v.Items[i])
		}
	case *domain.Comment:
		comment(v)
	case *domain.Attachment:
		person(&v.Uploader)
	case *domain.Run:
		run(v)
	case items[domain.Run]:
		for i := range v.Items {
			run(&v.Items[i])
		}
	case *domain.Request:
		request(v)
	case items[domain.Request]:
		for i := range v.Items {
			request(&v.Items[i])
		}
	case items[domain.InboxItem]:
		for i := range v.Items {
			item := &v.Items[i]
			request(item.Request)
			comment(item.Comment)
			issue(item.Issue)
		}
	case *store.EventPage:
		for i := range v.Items {
			person(&v.Items[i].Actor)
		}
	case *domain.View:
		person(&v.Owner)
	case *items[domain.View]:
		for i := range v.Items {
			person(&v.Items[i].Owner)
		}
	case *items[domain.TimelineItem]:
		for i := range v.Items {
			item := &v.Items[i]
			comment(item.Comment)
			run(item.Run)
			request(item.Request)
			if item.Activity != nil {
				person(&item.Activity.Actor)
				if item.Activity.Field == "assignee" || item.Activity.Field == "delegator" {
					value(item.Activity.From)
					value(item.Activity.To)
				}
				if item.Activity.Field == "attachment" {
					for _, raw := range []any{item.Activity.From, item.Activity.To} {
						if attachment, ok := raw.(map[string]any); ok {
							value(attachment["uploader"])
						}
					}
				}
			}
		}
	}
	return p
}

func (p actorProjection) apply() {
	for _, ref := range p.values {
		who, m := ref.person, ref.value
		m["name"], m["kind"] = who.Name, domain.ActorKind(who.Sub)
		if who.Agent != nil {
			m["agent"] = who.Agent
		}
		if who.Email != "" {
			m["email"] = who.Email
		}
		if who.AvatarURL != "" {
			m["avatarUrl"] = who.AvatarURL
		} else {
			delete(m, "avatarUrl")
		}
		if who.ProfileURL != "" {
			m["profileUrl"] = who.ProfileURL
		}
	}
}
