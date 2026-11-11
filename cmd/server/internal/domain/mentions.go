package domain

import (
	"regexp"
	"unicode"
	"unicode/utf8"
)

var mentionToken = regexp.MustCompile(`@[a-z][a-z0-9-]*`)

// MentionHandles recognizes standalone, case-sensitive handles, not email
// addresses or prefixes of longer tokens. Repeated mentions have one target.
func MentionHandles(body string) []string {
	handles := []string{}
	seen := map[string]bool{}
	word := func(r rune) bool {
		return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-' || r == '@' || r == '.'
	}
	for _, at := range mentionToken.FindAllStringIndex(body, -1) {
		if at[0] > 0 {
			r, _ := utf8.DecodeLastRuneInString(body[:at[0]])
			if word(r) {
				continue
			}
		}
		if at[1] < len(body) {
			r, _ := utf8.DecodeRuneInString(body[at[1]:])
			if unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-' {
				continue
			}
		}
		handle := body[at[0]+1 : at[1]]
		if len(handle) >= 2 && len(handle) <= 31 && !seen[handle] {
			seen[handle] = true
			handles = append(handles, handle)
		}
	}
	return handles
}
