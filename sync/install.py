#!/usr/bin/env python3
"""
Install or uninstall the thyself weekly sync launchd job.

Usage:
    python sync/install.py install    # Install and load the plist
    python sync/install.py uninstall  # Unload and remove the plist
    python sync/install.py status     # Check if installed and running
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

PLIST_NAME = "com.thyself.weekly-sync.plist"
LAUNCH_AGENTS_DIR = Path.home() / "Library" / "LaunchAgents"
SOURCE_PLIST = Path(__file__).resolve().parent.parent / PLIST_NAME
INSTALLED_PLIST = LAUNCH_AGENTS_DIR / PLIST_NAME
SYNC_SCRIPT = Path(__file__).resolve().parent / "run_sync.sh"


def install():
    if not SOURCE_PLIST.exists():
        print(f"Error: plist not found at {SOURCE_PLIST}")
        sys.exit(1)

    LAUNCH_AGENTS_DIR.mkdir(parents=True, exist_ok=True)

    os.chmod(SYNC_SCRIPT, 0o755)

    shutil.copy2(SOURCE_PLIST, INSTALLED_PLIST)
    print(f"Copied plist to {INSTALLED_PLIST}")

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

    print("Installed and loaded com.thyself.weekly-sync")
    print("Sync will run every Sunday at 3:00 AM")


def uninstall():
    if INSTALLED_PLIST.exists():
        subprocess.run(
            ["launchctl", "unload", str(INSTALLED_PLIST)],
            capture_output=True,
        )
        INSTALLED_PLIST.unlink()
        print("Unloaded and removed com.thyself.weekly-sync")
    else:
        print("Not installed")


def status():
    result = subprocess.run(
        ["launchctl", "list", "com.thyself.weekly-sync"],
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
    parser = argparse.ArgumentParser(description="Manage thyself weekly sync launchd job")
    parser.add_argument("action", choices=["install", "uninstall", "status"])
    args = parser.parse_args()

    {"install": install, "uninstall": uninstall, "status": status}[args.action]()


if __name__ == "__main__":
    main()
