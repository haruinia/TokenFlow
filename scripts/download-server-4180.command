#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
site_dir="$repo_dir/analysis-corpus/sites/tokenflow-story-4180/dist"
label="com.tokenflow.downloads4180"
domain="gui/$(id -u)"
plist_path="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/TokenFlow"

case "${1:-start}" in
  start|restart)
    [[ -f "$site_dir/index.html" ]] || { print -u2 'Download site directory is missing.'; exit 1; }
    mkdir -p "${plist_path:h}" "$log_dir"
    /usr/bin/python3 - "$plist_path" "$site_dir" "$log_dir" "$label" <<'PY'
import os, plistlib, sys
destination, site, logs, label = sys.argv[1:]
payload = {
    'Label': label,
    'ProgramArguments': ['/usr/bin/python3', '-u', '-m', 'http.server', '4180', '--bind', '0.0.0.0', '--directory', site],
    'WorkingDirectory': site,
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'ProcessType': 'Background',
    'StandardOutPath': os.path.join(logs, 'downloads-4180.log'),
    'StandardErrorPath': os.path.join(logs, 'downloads-4180-error.log'),
}
with open(destination + '.tmp', 'wb') as stream:
    plistlib.dump(payload, stream)
os.replace(destination + '.tmp', destination)
PY
    launchctl bootout "$domain/$label" 2>/dev/null || true
    launchctl enable "$domain/$label"
    launchctl bootstrap "$domain" "$plist_path"
    launchctl kickstart "$domain/$label"
    for attempt in {1..30}; do
      if /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:4180/ -o /dev/null 2>/dev/null; then
        print 'Download server started on port 4180; launchd keeps it running after this terminal closes.'
        exit 0
      fi
      sleep 0.2
    done
    print -u2 "Server did not become ready; inspect $log_dir/downloads-4180-error.log"
    exit 1
    ;;
  stop)
    launchctl bootout "$domain/$label"
    ;;
  status)
    launchctl print "$domain/$label"
    ;;
  *) print -u2 "Usage: $0 [start|restart|stop|status]"; exit 2 ;;
esac
