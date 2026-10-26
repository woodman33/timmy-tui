#!/usr/bin/env bash
# Double-click (macOS): opens the Timmy app of this review package (./timmy-app) in a Terminal window of its own; q stops it.
cd "$(dirname "$0")" && exec ./timmy-app
