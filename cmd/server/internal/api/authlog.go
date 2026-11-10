package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// rejectionReason names why a bearer was refused, in terms an operator can act
// on. The SDK returns plain errors, so the mapping is by message; anything
// unrecognised stays "other" and the bounded detail carries the rest.
func rejectionReason(err error) string {
	message := strings.ToLower(err.Error())
	for _, rule := range []struct{ reason, needle string }{
		{"missing_bearer", "bearer token required"},
		{"raw_access_key", "raw_key_not_accepted"},
		{"issuer", "issuer"},
		{"audience", "audience"},
		{"expired_or_not_yet_valid", "expired"},
		{"expired_or_not_yet_valid", "not currently valid"},
		{"signature_or_keys", "signature"},
		{"signature_or_keys", "keys"},
		{"claims_shape", "unmarshal"},
		{"claims_shape", "claims"},
		{"malformed_jwt", "invalid jwt"},
		{"malformed_jwt", "malformed"},
	} {
		if strings.Contains(message, rule.needle) {
			return rule.reason
		}
	}
	return "other"
}

// describeRejection renders one log line for a refused Authorization header.
// It reports the unverified header and claim metadata that explains a
// rejection (issuer, audience, validity window, key id, and the JSON type of
// `groups`) and never the token, its signature, or a personal claim.
func describeRejection(header string, err error) string {
	detail := strings.Join(strings.Fields(err.Error()), " ")
	if len(detail) > 200 {
		detail = detail[:200]
	}
	line := fmt.Sprintf("reason=%s detail=%q", rejectionReason(err), detail)
	fields := strings.Fields(header)
	if len(fields) != 2 {
		return line + " token=absent"
	}
	parts := strings.Split(fields[1], ".")
	if len(parts) != 3 {
		return line + fmt.Sprintf(" token=not_jwt segments=%d", len(parts))
	}
	var head struct {
		Algorithm string `json:"alg"`
		KeyID     string `json:"kid"`
		Type      string `json:"typ"`
	}
	if raw, decodeErr := base64.RawURLEncoding.DecodeString(parts[0]); decodeErr == nil {
		_ = json.Unmarshal(raw, &head)
	}
	var claims map[string]json.RawMessage
	if raw, decodeErr := base64.RawURLEncoding.DecodeString(parts[1]); decodeErr != nil || json.Unmarshal(raw, &claims) != nil {
		return line + fmt.Sprintf(" alg=%q kid=%q typ=%q claims=undecodable", head.Algorithm, head.KeyID, head.Type)
	}
	line += fmt.Sprintf(" alg=%q kid=%q typ=%q", head.Algorithm, head.KeyID, head.Type)
	for _, name := range []string{"iss", "aud", "azp", "iat", "nbf", "exp"} {
		if value, ok := claims[name]; ok && len(value) <= 300 {
			line += fmt.Sprintf(" %s=%s", name, value)
		}
	}
	return line + " groups=" + jsonType(claims["groups"]) + " sub=" + presence(claims["sub"]) + " email=" + presence(claims["email"])
}

func presence(value json.RawMessage) string {
	if len(value) == 0 || string(value) == "null" || string(value) == `""` {
		return "absent"
	}
	return "present"
}

func jsonType(value json.RawMessage) string {
	if len(value) == 0 {
		return "absent"
	}
	switch value[0] {
	case '[':
		return "array"
	case '"':
		return "string"
	case '{':
		return "object"
	case 'n':
		return "null"
	default:
		return "scalar"
	}
}

// edgeSessionCookie matches the cookies the edge OIDC filter keeps for this
// host: its tokens, their HMAC and expiry, and the in-flight sign-in state.
var edgeSessionCookie = regexp.MustCompile(`^(IdToken|AccessToken|RefreshToken|OauthHMAC|OauthExpires|OauthNonce|CodeVerifier)(-[0-9a-f]+)?$`)

// expireEdgeSession drops the edge's session cookies from the browser and
// reports how many it expired. The edge only checks its own HMAC and expiry,
// so it keeps replaying a token this server refuses; without the cookies the
// next navigation runs sign-in again and mints a new token from the still
// valid SSO session, which a plain reload does not. Other apps' sessions and
// the SSO session itself are untouched.
func expireEdgeSession(w http.ResponseWriter, r *http.Request) int {
	expired := 0
	for _, cookie := range r.Cookies() {
		if edgeSessionCookie.MatchString(cookie.Name) {
			http.SetCookie(w, &http.Cookie{Name: cookie.Name, Path: "/", MaxAge: -1, Secure: true, HttpOnly: true})
			expired++
		}
	}
	return expired
}
