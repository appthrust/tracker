package api

import (
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

type meResponse struct {
	domain.Person
	Role    string `json:"role"`
	IsAdmin bool   `json:"isAdmin"`
}

func (a *API) me(s *request) (any, int, error) {
	return &meResponse{Person: s.actor.Person, Role: s.actor.Role, IsAdmin: s.actor.Role == "Admin"}, 200, nil
}
func (a *API) workspaceGet(s *request) (any, int, error) {
	item, err := s.tx.Workspace()
	return item, 200, err
}
func (a *API) workspacePatch(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input struct {
		Key  *string `json:"key"`
		Name *string `json:"name"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchWorkspace(input.Key, input.Name)
	return item, 200, err
}
func (a *API) statusList(s *request) (any, int, error) {
	list, err := s.tx.Statuses()
	return items[domain.Status]{list}, 200, err
}
func (a *API) statusCreate(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input struct {
		Name     string `json:"name"`
		Category string `json:"category"`
		Color    string `json:"color"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateStatus(input.Name, input.Category, input.Color)
	return item, 201, err
}
func (a *API) statusPatch(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input struct {
		Name  *string `json:"name"`
		Color *string `json:"color"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchStatus(s.r.PathValue("id"), input.Name, input.Color)
	return item, 200, err
}
func (a *API) statusDelete(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	return nil, 204, s.tx.DeleteStatus(s.r.PathValue("id"))
}
func (a *API) statusOrder(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input struct {
		IDs []string `json:"ids"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	list, err := s.tx.OrderStatuses(input.IDs)
	return items[domain.Status]{list}, 200, err
}
func (a *API) labelList(s *request) (any, int, error) {
	list, err := s.tx.Labels()
	return items[domain.Label]{list}, 200, err
}
func (a *API) labelCreate(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateLabel(input.Name, input.Color)
	return item, 201, err
}
func (a *API) labelPatch(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	var input struct {
		Name  *string `json:"name"`
		Color *string `json:"color"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchLabel(s.r.PathValue("id"), input.Name, input.Color)
	return item, 200, err
}
func (a *API) labelDelete(s *request) (any, int, error) {
	if err := admin(s); err != nil {
		return nil, 0, err
	}
	return nil, 204, s.tx.DeleteLabel(s.r.PathValue("id"))
}
func (a *API) viewList(s *request) (any, int, error) {
	list, err := s.tx.Views(s.actor.Sub)
	return &items[domain.View]{list}, 200, err
}
func (a *API) viewCreate(s *request) (any, int, error) {
	var input store.ViewCreate
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateView(input, s.actor)
	return &item, 201, err
}
func (a *API) viewPatch(s *request) (any, int, error) {
	var input store.ViewPatch
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchView(s.r.PathValue("id"), input, s.actor)
	return &item, 200, err
}
func (a *API) viewDelete(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteView(s.r.PathValue("id"), s.actor)
}
