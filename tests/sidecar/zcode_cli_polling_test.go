package zcode

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type cliTransport func(*http.Request) (*http.Response, error)

func (f cliTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestTokenFlowZCodeCLIPolling(t *testing.T) {
	var pollToken string
	status := "pending"
	businessOK := false
	auth := NewZCodeAuth(nil)
	auth.httpClient.Transport = cliTransport(func(req *http.Request) (*http.Response, error) {
		var body string
		switch req.URL.String() {
		case ZCodeInitURL:
			pollToken = strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
			if len(pollToken) != 64 {
				t.Fatal("missing private polling token")
			}
			body = fmt.Sprintf(`{"code":0,"data":{"flow_id":"fixture-flow","authorize_url":"https://chat.z.ai/api/oauth/authorize?state=fixture-state&redirect_uri=https%%3A%%2F%%2Fzcode.z.ai%%2Fapi%%2Fv1%%2Foauth%%2Fcli%%2Fcallback%%2Fzai","expires_at":%d,"poll_interval_sec":2}}`, time.Now().Add(time.Minute).Unix())
		case ZCodePollURL + "/fixture-flow":
			if req.Header.Get("Authorization") != "Bearer "+pollToken {
				t.Fatal("polling token changed")
			}
			body = fmt.Sprintf(`{"code":0,"data":{"status":%q,"token":"zcode-jwt","zai":{"access_token":"chat-oauth"},"user":{"user_id":"test-user","email":"user@example.test"}}}`, status)
		case ZCodeBusinessLoginURL:
			var input map[string]string
			if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input["token"] != "chat-oauth" || req.Header.Get("Authorization") != "" {
				t.Fatal("incorrect business-token exchange")
			}
			body = `{"code":401,"success":false,"data":{"access_token":"must-not-save"}}`
			if businessOK {
				body = `{"code":200,"data":{"access_token":"model-business-token","expires_in":3600}}`
			}
		default:
			t.Fatalf("unexpected endpoint %s", req.URL.Host)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	flow, err := auth.StartCLIFlow(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if flow.State != "fixture-state" || flow.Interval != 2*time.Second {
		t.Fatal("incorrect session")
	}
	if _, err := auth.PollCLIFlow(context.Background(), flow); err != ErrDeviceFlowPending {
		t.Fatal("pending must not create credentials")
	}
	status = "ready"
	if _, err := auth.PollCLIFlow(context.Background(), flow); err == nil {
		t.Fatal("failed business exchange must not save chat OAuth as a model token")
	}
	businessOK = true
	storage, err := auth.PollCLIFlow(context.Background(), flow)
	if err != nil {
		t.Fatal(err)
	}
	if storage.AccessToken != "model-business-token" || storage.JWT != "zcode-jwt" || storage.UID != "test-user" || storage.Expired == "" {
		t.Fatal("incorrect saved credentials")
	}
	flow.ExpiresAt = time.Now().Add(-time.Second)
	if _, err := auth.PollCLIFlow(context.Background(), flow); err == nil {
		t.Fatal("expired flow accepted")
	}
}

func TestTokenFlowZCodeSharedCredentialsImport(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	write := func(body string) {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	auth := NewZCodeAuth(nil)
	auth.httpClient.Transport = cliTransport(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != ZCodeBusinessLoginURL {
			t.Fatalf("unexpected endpoint %s", req.URL.Host)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"code":200,"data":{"access_token":"fixture-business-token","expires_in":60}}`)), Header: make(http.Header)}, nil
	})

	if storage, err := auth.importSharedCLICredentials(path); storage != nil || err != nil {
		t.Fatal("a missing shared file must fall through to older locations")
	}
	write(`{"oauth:active_provider":"bigmodel","oauth:bigmodel:access_token":"fixture-bigmodel-access","oauth:bigmodel:refresh_token":"fixture-refresh","oauth:bigmodel:user_info":"{\"user_id\":\"u-1\",\"email\":\"user@example.test\"}","zcodejwttoken":"a.b.c"}`)
	storage, err := auth.importSharedCLICredentials(path)
	if err != nil || storage.Provider != "bigmodel" || storage.AccessToken != "fixture-bigmodel-access" || storage.RefreshToken != "fixture-refresh" || storage.UID != "u-1" || storage.Email != "user@example.test" {
		t.Fatal("BigModel shared credentials imported incorrectly")
	}
	write(`{"oauth:active_provider":"zai","oauth:zai:access_token":"fixture-zai-chat-token","zcodejwttoken":"a.b.c"}`)
	storage, err = auth.importSharedCLICredentials(path)
	if err != nil || storage.Provider != "zai" || storage.AccessToken != "fixture-business-token" || storage.Expired == "" {
		t.Fatal("Z.ai shared credentials must go through the business-token exchange")
	}
	write(`{"oauth:active_provider":"zai","oauth:zai:access_token":"v1:not a plain token","zcodejwttoken":"opaque"}`)
	if _, err := auth.importSharedCLICredentials(path); err == nil {
		t.Fatal("ciphertext must not be imported as a token")
	}
}

func TestTokenFlowZCodeBigModelCLIPolling(t *testing.T) {
	authorizeURL := "https://bigmodel.cn/login?redirect_uri=https%%3A%%2F%%2Fzcode.z.ai%%2Fapi%%2Fv1%%2Foauth%%2Fcli%%2Fcallback%%2Fbigmodel"
	auth := NewZCodeAuth(nil)
	auth.httpClient.Transport = cliTransport(func(req *http.Request) (*http.Response, error) {
		var body string
		switch req.URL.String() {
		case ZCodeInitURL:
			var input map[string]string
			if err := json.NewDecoder(req.Body).Decode(&input); err != nil || input["provider"] != "bigmodel" {
				t.Fatal("BigModel login must request the bigmodel provider")
			}
			body = fmt.Sprintf(`{"code":0,"data":{"flow_id":"bigmodel-flow","authorize_url":"`+authorizeURL+`","expires_at":%d,"poll_interval_sec":2}}`, time.Now().Add(time.Minute).Unix())
		case ZCodePollURL + "/bigmodel-flow":
			body = `{"code":0,"data":{"status":"ready","token":"zcode-jwt","zai":{"access_token":"wrong-family"},"bigmodel":{"accessToken":"bigmodel-token","refreshToken":"bigmodel-refresh","expires_in":600},"user":{"user_id":"test-user"}}}`
		default:
			t.Fatalf("BigModel login must not call %s", req.URL.Host)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	flow, err := auth.StartCLIFlowFor(context.Background(), "bigmodel")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(flow.State, "zcode-") {
		t.Fatal("BigModel session needs a generated state")
	}
	storage, err := auth.PollCLIFlow(context.Background(), flow)
	if err != nil {
		t.Fatal(err)
	}
	if storage.Provider != "bigmodel" || storage.AccessToken != "bigmodel-token" || storage.RefreshToken != "bigmodel-refresh" || storage.Expired == "" {
		t.Fatal("incorrect BigModel credentials")
	}
	auth.httpClient.Transport = cliTransport(func(*http.Request) (*http.Response, error) {
		body := fmt.Sprintf(`{"code":0,"data":{"flow_id":"x","authorize_url":"https://bigmodel.cn.evil.test/login?redirect_uri=https%%3A%%2F%%2Fzcode.z.ai%%2Fapi%%2Fv1%%2Foauth%%2Fcli%%2Fcallback%%2Fbigmodel","expires_at":%d,"poll_interval_sec":2}}`, time.Now().Add(time.Minute).Unix())
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	if _, err := auth.StartCLIFlowFor(context.Background(), "bigmodel"); err == nil {
		t.Fatal("foreign BigModel login host accepted")
	}
}
