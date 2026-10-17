package workbuddy

import "path/filepath"

// Keep import locations aligned with TokenFlow's desktop login detection.
func localWorkBuddyAuthPaths(platform, home string, env func(string) string) []string {
	return localWorkBuddyAuthPathsFor(platform, home, env, false)
}

// localWorkBuddyAuthPathsFor returns the domestic WorkBuddy login, or the international WorkBuddyAI one
// stored beside it as workbuddy-desktop-ai.info.
func localWorkBuddyAuthPathsFor(platform, home string, env func(string) string, overseas bool) []string {
	var base string
	switch platform {
	case "darwin":
		base = filepath.Join(home, "Library", "Application Support")
	case "windows":
		base = env("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
	case "linux":
		base = env("XDG_DATA_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "share")
		}
	default:
		return nil
	}
	file := "workbuddy-desktop.info"
	if overseas {
		file = "workbuddy-desktop-ai.info"
	}
	var paths []string
	for _, name := range []string{"CodeBuddyExtension", "WorkBuddyExtension"} {
		paths = append(paths, filepath.Join(base, name, "Data", "Public", "auth", file))
	}
	return paths
}
