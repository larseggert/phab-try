# phab-try

Firefox extension that surfaces [Treeherder](https://treeherder.mozilla.org) try push status directly on [Phabricator](https://phabricator.services.mozilla.com) revision pages and [Bugzilla](https://bugzilla.mozilla.org) bug pages, and adds back-links from Treeherder try pages to the corresponding revision and bug.

## What it does

### Try Pushes panel (Phabricator and Bugzilla)

Adds a **Try Pushes** panel above the Details section on Phabricator D* pages and above the comments on Bugzilla bug pages. For each try push associated with the revision or bug it shows:

- Timestamp
- Short revision hash (links to Treeherder)
- Build / Lint / Tests status badges
- Job count summary (completed, failed, running, pending)

On Bugzilla pages where a bug has **multiple Phabricator revisions**, each push row is labelled with the D-number it belongs to, so you can see at a glance which revision each try run covers.

The panel refreshes automatically every two minutes while any push has jobs still running.

### Attachment annotation (Bugzilla)

On Bugzilla bug pages, each Phabricator revision attachment in the Attachments table is annotated with its D-number as a link directly to the Phabricator revision.

### Back-links (Treeherder)

On Treeherder try job pages (`/jobs?repo=try&revision=…`), links to the corresponding Phabricator revision(s) and Bugzilla bug are injected into the push header. When a commit message omits the `Differential Revision:` trailer, the extension looks up the correct revision via the Bugzilla attachment API and Phabricator title matching.

## How it works

A content script extracts the D-number or bug number from the page and asks the background worker — which handles all network requests to avoid CORS — to search Treeherder. The background fetches the author's try push history and matches pushes by looking for the D-number or bug number in commit messages. For `mach try auto` pushes (where the tip commit has a generic message), it walks one level up the Mercurial commit graph via `hg.mozilla.org` to find the patch commit's `Differential Revision:` trailer.

Each matched push is enriched with a build/lint/test health summary from Treeherder. Results are cached for two minutes and auto-refreshed every two minutes while jobs are still running.

## Settings

Open the extension preferences (via `about:addons` → phab-try → Preferences) to set your Treeherder / Bugzilla email address. When set, the extension searches your push history directly instead of discovering your email from recent pushes, which is faster and works for pushes older than the default 200-push discovery window.

## Installation

Install from [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/phab-try/), or load temporarily via `about:debugging` → Load Temporary Add-on → select `manifest.json`.
