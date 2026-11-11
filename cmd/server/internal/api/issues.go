package api

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

func (a *API) issueList(s *request) (any, int, error) {
	query := s.r.URL.Query()
	options := store.ListOptions{Limit: 50, Sort: domain.Sort(query.Get("sort")), Cursor: query.Get("cursor"), Subject: s.actor.Sub}
	if query.Has("limit") {
		limit, err := strconv.Atoi(query.Get("limit"))
		if err != nil || limit < 1 || limit > 200 {
			return nil, 0, invalid("Limit must be between 1 and 200")
		}
		options.Limit = limit
	}
	if query.Has("filter") {
		raw := strings.TrimSpace(query.Get("filter"))
		if len(raw) == 0 || raw[0] != '{' || len(raw) > 64<<10 {
			return nil, 0, invalid("Filter must be a JSON object")
		}
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&options.Filter) != nil || decoder.Decode(new(any)) != io.EOF {
			return nil, 0, invalid("Invalid filter")
		}
	}
	page, err := s.tx.ListIssues(options)
	return &page, 200, err
}
func (a *API) issueGet(s *request) (any, int, error) {
	item, err := s.tx.Issue(s.r.PathValue("id"))
	return &item, 200, err
}
func (a *API) assignee(s *request, sub *string) (*domain.Person, error) {
	if sub == nil {
		return nil, nil
	}
	if !domain.Text(*sub, 1, 4096) {
		return nil, invalid("Invalid assignee subject")
	}
	if domain.ActorKind(*sub) == "agent" {
		return s.tx.AgentAssignee(*sub)
	}
	person := domain.Person{Sub: *sub, Name: *sub}
	if *sub == s.actor.Sub {
		person = s.actor.Person
	}
	person = a.directory.Enrich(s.r.Context(), s.bearer, person)
	return &person, nil
}
func (a *API) issueCreate(s *request) (any, int, error) {
	var input store.IssueCreate
	if err := decode(s, &input, "assigneeSub", "projectId", "parentId", "dueOn", "report", "estimate", "sprintId"); err != nil {
		return nil, 0, err
	}
	assignee, err := a.assignee(s, input.AssigneeSub)
	if err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateIssue(input, s.actor.Person, assignee)
	return &item, 201, err
}
func (a *API) issuePatch(s *request) (any, int, error) {
	var input store.IssuePatch
	if err := decode(s, &input, "assigneeSub", "projectId", "parentId", "dueOn", "report", "estimate", "sprintId"); err != nil {
		return nil, 0, err
	}
	var assignee *domain.Person
	if input.AssigneeSub.Present {
		var err error
		assignee, err = a.assignee(s, input.AssigneeSub.Value)
		if err != nil {
			return nil, 0, err
		}
	}
	item, err := s.tx.PatchIssue(s.r.PathValue("id"), input, s.actor.Person, assignee)
	return &item, 200, err
}
func (a *API) issueDelete(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteIssue(s.r.PathValue("id"), s.actor)
}
func (a *API) timeline(s *request) (any, int, error) {
	list, err := s.tx.Timeline(s.r.PathValue("id"))
	return &items[domain.TimelineItem]{list}, 200, err
}
func (a *API) commentCreate(s *request) (any, int, error) {
	var input struct {
		Body string `json:"body"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.CreateComment(s.r.PathValue("id"), input.Body, s.actor.Person)
	return &item, 201, err
}
func (a *API) commentPatch(s *request) (any, int, error) {
	var input struct {
		Body string `json:"body"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	item, err := s.tx.PatchComment(s.r.PathValue("id"), input.Body, s.actor)
	return &item, 200, err
}
func (a *API) commentDelete(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteComment(s.r.PathValue("id"), s.actor)
}
func (a *API) attachmentCreate(s *request) (any, int, error) {
	s.r.Body = http.MaxBytesReader(s.w, s.r.Body, (2<<20)+(64<<10))
	reader, err := s.r.MultipartReader()
	if err != nil {
		return nil, 0, invalid("Expected a multipart file")
	}
	part, err := reader.NextPart()
	if err != nil {
		return nil, 0, invalid("Expected a multipart file")
	}
	defer part.Close()
	if part.FormName() != "file" || part.FileName() == "" {
		return nil, 0, invalid("Expected a multipart file named file")
	}
	mediaType, _, err := mime.ParseMediaType(part.Header.Get("Content-Type"))
	if err != nil {
		return nil, 0, invalid("Invalid attachment media type")
	}
	data, err := io.ReadAll(io.LimitReader(part, (2<<20)+1))
	if err != nil {
		return nil, 0, invalid("Could not read attachment")
	}
	if len(data) > 2<<20 {
		return nil, 0, invalid("Attachment must contain 1 byte to 2 MiB")
	}
	if _, err := reader.NextPart(); err != io.EOF {
		return nil, 0, invalid("Upload exactly one file")
	}
	// Treat the filename only as display metadata, never as a filesystem path.
	filename := filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
	item, err := s.tx.CreateAttachment(s.r.PathValue("id"), filename, mediaType, data, s.actor.Person)
	return &item, 201, err
}

type attachmentDownload struct {
	Attachment domain.Attachment
	Data       []byte
}

func (d attachmentDownload) write(w http.ResponseWriter) {
	w.Header().Set("Content-Type", d.Attachment.MediaType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": d.Attachment.Filename}))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(d.Data)))
	_, _ = io.Copy(w, bytes.NewReader(d.Data))
}
func (a *API) attachmentGet(s *request) (any, int, error) {
	item, data, err := s.tx.Attachment(s.r.PathValue("id"), true)
	return attachmentDownload{item, data}, 200, err
}
func (a *API) attachmentDelete(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteAttachment(s.r.PathValue("id"), s.actor)
}
