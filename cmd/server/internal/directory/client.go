// Package directory adapts peerbonus's caller-scoped Directory link client.
package directory

import (
	"context"
	"crypto/sha256"
	"fmt"
	"mime"
	"net/url"
	"strings"
	"sync"
	"time"

	contract "github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
)

type cacheKey struct {
	Bearer [32]byte
	Query  string
}
type cacheEntry struct {
	People  []domain.Person
	Expires time.Time
}
type Client struct {
	links     *link.Client
	publicURL string
	mu        sync.Mutex
	cache     map[cacheKey]cacheEntry
}

func New(links *link.Client, publicURL string) *Client {
	return &Client{links: links, publicURL: strings.TrimRight(publicURL, "/"), cache: map[cacheKey]cacheEntry{}}
}
func (c *Client) Search(ctx context.Context, bearer, q string) ([]domain.Person, error) {
	return c.list(ctx, bearer, url.Values{"q": {q}, "limit": {"20"}})
}
func (c *Client) Enrich(ctx context.Context, bearer string, snapshot domain.Person) domain.Person {
	if snapshot.Sub == "" {
		return snapshot
	}
	people, err := c.list(ctx, bearer, url.Values{"subject": {snapshot.Sub}, "limit": {"20"}})
	if err == nil {
		for _, person := range people {
			if person.Sub == snapshot.Sub {
				return person
			}
		}
	}
	return snapshot
}
func (c *Client) list(ctx context.Context, bearer string, query url.Values) ([]domain.Person, error) {
	if c == nil || c.links == nil {
		return nil, link.ErrAbsent
	}
	key := cacheKey{sha256.Sum256([]byte(bearer)), query.Encode()}
	now := time.Now()
	c.mu.Lock()
	entry, found := c.cache[key]
	c.mu.Unlock()
	if found && now.Before(entry.Expires) {
		return entry.People, nil
	}
	var response contract.PersonList
	if err := c.links.Do(ctx, bearer, contract.ListPeople, link.Params{Query: query}, nil, &response); err != nil {
		return nil, err
	}
	people := make([]domain.Person, 0, min(20, len(response.Items)))
	for _, person := range response.Items {
		if person.Subject == nil || *person.Subject == "" {
			continue
		}
		projected := domain.Person{Sub: *person.Subject, Name: person.DisplayName, Email: person.Email}
		if projected.Name == "" {
			projected.Name = projected.Sub
		}
		if c.publicURL != "" {
			projected.ProfileURL = c.publicURL + "/people/" + url.PathEscape(person.ID)
		}
		if person.AvatarVersion != nil {
			projected.AvatarURL = "/api/tracker/v1/people/" + url.PathEscape(person.ID) + "/avatar?v=" + url.QueryEscape(person.AvatarVersion.Format(time.RFC3339Nano))
		}
		people = append(people, projected)
		if len(people) == 20 {
			break
		}
	}
	c.mu.Lock()
	for key, entry := range c.cache {
		if !now.Before(entry.Expires) {
			delete(c.cache, key)
		}
	}
	// Bound caller/query cardinality without storing bearer secrets.
	if len(c.cache) >= 256 {
		for oldest := range c.cache {
			delete(c.cache, oldest)
			break
		}
	}
	c.cache[key] = cacheEntry{people, now.Add(60 * time.Second)}
	c.mu.Unlock()
	return people, nil
}

// Avatar uses the same internal binding and caller bearer as people reads.
// Fetch refuses redirects and limits transport reads to 4 MiB; the stricter
// Directory photo limit is checked before the handler sends any image bytes.
func (c *Client) Avatar(ctx context.Context, bearer, personID, version string) ([]byte, string, error) {
	if c == nil || c.links == nil {
		return nil, "", link.ErrAbsent
	}
	data, contentType, err := c.links.Fetch(ctx, bearer, link.Operation{
		Definition: "directory", Method: "GET", Base: "/api/directory/v1", Path: "/people/{id}/avatar",
	}, link.Params{Path: map[string]string{"id": personID}, Query: url.Values{"v": {version}}})
	if err != nil {
		return nil, "", err
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || (mediaType != "image/png" && mediaType != "image/jpeg" && mediaType != "image/webp") {
		return nil, "", fmt.Errorf("%w: invalid avatar content type", link.ErrUnavailable)
	}
	if len(data) == 0 || len(data) > 512<<10 {
		return nil, "", fmt.Errorf("%w: avatar must contain 1 byte to 512 KiB", link.ErrUnavailable)
	}
	return data, mediaType, nil
}
