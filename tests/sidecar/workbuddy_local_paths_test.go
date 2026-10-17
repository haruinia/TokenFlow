package workbuddy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkBuddyLocalPaths(t *testing.T) {
	home := filepath.Join("root", "用户")
	for _, tc := range []struct{ platform, variable, value, base string }{
		{"darwin", "", "", filepath.Join(home, "Library", "Application Support")},
		{"windows", "LOCALAPPDATA", filepath.Join("custom", "local"), filepath.Join("custom", "local")},
		{"windows", "", "", filepath.Join(home, "AppData", "Local")},
		{"linux", "XDG_DATA_HOME", filepath.Join("custom", "data"), filepath.Join("custom", "data")},
		{"linux", "", "", filepath.Join(home, ".local", "share")},
	} {
		paths := localWorkBuddyAuthPaths(tc.platform, home, func(key string) string {
			if key == tc.variable {
				return tc.value
			}
			return ""
		})
		if len(paths) != 2 {
			t.Fatalf("%s: expected both extension directories", tc.platform)
		}
		for i, name := range []string{"CodeBuddyExtension", "WorkBuddyExtension"} {
			want := filepath.Join(tc.base, name, "Data", "Public", "auth", "workbuddy-desktop.info")
			if paths[i] != want {
				t.Errorf("%s: got %q want %q", tc.platform, paths[i], want)
			}
		}
	}
}
func TestWorkBuddyLocalImportReadsInternationalClientSeparately(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	for _, platform := range []string{"darwin", "windows", "linux"} {
		for _, path := range localWorkBuddyAuthPathsFor(platform, home, os.Getenv, true) {
			if filepath.Base(path) != "workbuddy-desktop-ai.info" {
				t.Fatalf("%s: international login read from %q", platform, path)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(`{"auth":{"accessToken":"fixture-overseas"},"account":{"uid":"overseas-user"}}`), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := ImportLocalAuth(); err == nil {
		t.Fatal("the domestic import must not pick up the international login")
	}
	token, err := ImportLocalAuthRegion(true)
	if err != nil || token.AccessToken != "fixture-overseas" || token.UID != "overseas-user" {
		t.Fatal("international login not imported")
	}
}

func TestWorkBuddyLocalImportIgnoresLoggedOutSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	// Populate all platforms so this regression runs unchanged on each OS.
	for _, platform := range []string{"darwin", "windows", "linux"} {
		for _, path := range localWorkBuddyAuthPaths(platform, home, os.Getenv) {
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(`{"auth":{"accessToken":"stale-secret"},"account":{"uid":"stale-user"}}`), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path+".logged-out", []byte(`true`), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := ImportLocalAuth(); err == nil {
		t.Fatal("must not import a logged-out session")
	}
}
