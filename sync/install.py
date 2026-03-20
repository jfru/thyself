#!/usr/bin/env python3
"""
Install or uninstall the thyself hourly sync launchd job.

Generates the plist dynamically based on the current installation paths
so it works on any machine without hardcoded user paths.

Usage:
    python sync/install.py install    # Generate plist, install, and load
    python sync/install.py uninstall  # Unload and remove the plist
    python sync/install.py status     # Check if installed and running
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

PLIST_NAME = "com.thyself.sync.plist"
LAUNCH_AGENTS_DIR = Path.home() / "Library" / "LaunchAgents"
INSTALLED_PLIST = LAUNCH_AGENTS_DIR / PLIST_NAME

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SYNC_SCRIPT = PROJECT_ROOT / "sync" / "run_sync.sh"
LOG_DIR = Path.home() / "Library" / "Application Support" / "Thyself" / "logs"


def generate_plist() -> str:
    """Generate the launchd plist XML with paths for the current installation."""
    path_parts = []
    pyenv_shims = Path.home() / ".pyenv" / "shims"
    if pyenv_shims.exists():
        path_parts.append(str(pyenv_shims))
    path_parts.extend(["/usr/local/bin", "/usr/bin", "/bin"])
    path_str = ":".join(path_parts)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.thyself.sync</string>

    <key>ProgramArguments</key>
    <array>
        <string>{SYNC_SCRIPT}</string>
    </array>

    <key>StartInterval</key>
    <integer>3600</integer>

    <key>StandardOutPath</key>
    <string>{LOG_DIR}/sync-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{LOG_DIR}/sync-stderr.log</string>

    <key>WorkingDirectory</key>
    <string>{PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{path_str}</string>
    </dict>
</dict>
</plist>
"""


def install():
    LAUNCH_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    os.chmod(SYNC_SCRIPT, 0o755)

    plist_content = generate_plist()
    INSTALLED_PLIST.write_text(plist_content)
    print(f"Generated and wrote plist to {INSTALLED_PLIST}")

    subprocess.run(
        ["launchctl", "unload", str(INSTALLED_PLIST)],
        capture_output=True,
    )

    result = subprocess.run(
        ["launchctl", "load", str(INSTALLED_PLIST)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Error loading plist: {result.stderr}")
        sys.exit(1)

    print("Installed and loaded com.thyself.sync")
    print("Sync will run every hour")
    print(f"  Script: {SYNC_SCRIPT}")
    print(f"  Logs:   {LOG_DIR}/sync-*.log")


def uninstall():
    if INSTALLED_PLIST.exists():
        subprocess.run(
            ["launchctl", "unload", str(INSTALLED_PLIST)],
            capture_output=True,
        )
        INSTALLED_PLIST.unlink()
        print("Unloaded and removed com.thyself.sync")
    else:
        print("Not installed")


def status():
    result = subprocess.run(
        ["launchctl", "list", "com.thyself.sync"],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        print("Status: INSTALLED and LOADED")
        print(result.stdout)
    else:
        if INSTALLED_PLIST.exists():
            print("Status: plist exists but not loaded")
        else:
            print("Status: NOT INSTALLED")


def main():
    parser = argparse.ArgumentParser(description="Manage thyself hourly sync launchd job")
    parser.add_argument("action", choices=["install", "uninstall", "status"])
    args = parser.parse_args()

    {"install": install, "uninstall": uninstall, "status": status}[args.action]()


if __name__ == "__main__":
    main()
