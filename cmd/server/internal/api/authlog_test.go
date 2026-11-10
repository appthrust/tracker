package api

import (
	"encoding/base64"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDescribeRejection(t *testing.T) {
	segment := func(json string) string { return base64.RawURLEncoding.EncodeToString([]byte(json)) }
	token := segment(`{"alg":"RS256","kid":"key-1","typ":"JWT"}`) + "." +
		segment(`{"iss":"https://iam.example/realms/a","aud":["account"],"azp":"edge","exp":1700000300,"iat":1700000000,"groups":"/teams/a","sub":"subject-secret","email":"person@example.test","name":"Person Name"}`) +
		".c2lnbmF0dXJlLXNlY3JldA"
	for _, tc := range []struct {
		name, header string
		err          error
		contains     []string
	}{
		{"scalar groups", "Bearer " + token, errors.New("oidc: failed to unmarshal claims: json: cannot unmarshal string into Go struct field userClaims.groups of type []string"), []string{"reason=claims_shape", `kid="key-1"`, `aud=["account"]`, `azp="edge"`, "exp=1700000300", "groups=string", "sub=present", "email=present"}},
		{"audience", "Bearer " + token, errors.New("untrusted JWT audience"), []string{"reason=audience", `iss="https://iam.example/realms/a"`}},
		{"expired", "Bearer " + token, errors.New("oidc: token is expired (Token Expiry: 2026-01-01)"), []string{"reason=expired_or_not_yet_valid"}},
		{"signature", "Bearer " + token, errors.New("failed to verify signature: fetching keys oidc: get keys failed"), []string{"reason=signature_or_keys"}},
		{"missing", "", errors.New("bearer token required"), []string{"reason=missing_bearer", "token=absent"}},
		{"opaque", "Bearer opaque-secret-value", errors.New("invalid JWT"), []string{"reason=malformed_jwt", "token=not_jwt segments=1"}},
		{"unknown", "Bearer " + token, errors.New("something new"), []string{"reason=other", `detail="something new"`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			line := describeRejection(tc.header, tc.err)
			for _, want := range tc.contains {
				require.Contains(t, line, want)
			}
			for _, secret := range []string{token, "c2lnbmF0dXJlLXNlY3JldA", "subject-secret", "person@example.test", "Person Name", "opaque-secret-value", "/teams/a"} {
				require.NotContains(t, line, secret)
			}
		})
	}
}
