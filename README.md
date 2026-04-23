# phab-try

Firefox extension that surfaces [Treeherder](https://treeherder.mozilla.org) try push status directly on [Phabricator](https://phabricator.services.mozilla.com) revision pages and [Bugzilla](https://bugzilla.mozilla.org) bug pages.

## What it does

Adds a **Try Pushes** panel above the Details section on Phabricator D* pages and above the comments on Bugzilla bug pages. For each try push associated with the revision or bug it shows:

- Timestamp
- Short revision hash (links to Treeherder)
- Build / Lint / Tests status badges
- Job count summary (completed, failed, running, pending)

The panel refreshes automatically every 60 seconds while any push has jobs still running.

## Installation

Install from [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/phab-try/), or load temporarily via `about:debugging` → Load Temporary Add-on → select `manifest.json`.
