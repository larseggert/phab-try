# phab-try

Firefox extension that surfaces [Treeherder](https://treeherder.mozilla.org) try push status directly on [Phabricator](https://phabricator.services.mozilla.com) revision pages and [Bugzilla](https://bugzilla.mozilla.org) bug pages.

## What it does

Adds a **Try Pushes** panel above the Details section on Phabricator D* pages and above the comments on Bugzilla bug pages. For each try push associated with the revision or bug it shows:

- Timestamp
- Short revision hash (links to Treeherder)
- Build / Lint / Tests status badges
- Job count summary (completed, failed, running, pending)

The panel refreshes automatically every 60 seconds while any push has jobs still running.

## How the panel is produced

1. **Page detection.** When you open a Phabricator `D*` page or a Bugzilla `show_bug.cgi` page, a content script extracts the D-number (Phabricator) or bug number (Bugzilla) from the URL, and the assignee email or author hint from the page DOM.

2. **Try push search.** The content script asks the background worker to search Treeherder. To avoid CORS restrictions the background worker makes all network requests. It fetches up to 500 try pushes for the revision author via the [Treeherder API](https://treeherder.mozilla.org/docs/) and filters them by looking for the Phabricator D-number or bug number in each push's commit message. If a try push was made with `mach try auto` (which does not write the D-number into the commit message), the background falls back to walking one level up the Mercurial commit graph via `hg.mozilla.org`: the parent of the try tip commit is the user's patch commit, which carries the `Differential Revision:` trailer and therefore the D-number.

3. **Health enrichment.** For each matched push the background fetches its build/lint/test health summary from Treeherder and constructs an enriched push object. Up to five health fetches run concurrently.

4. **Panel render.** The enriched push list is returned to the content script, which inserts a styled panel into the page (Phabricator-style on Phabricator, Bugzilla module-style on Bugzilla). Results are cached for two minutes; the cache is bypassed on manual reload.

5. **Auto-refresh.** If any push has jobs still running, a 60-second interval fires, fetches fresh data, and updates the panel in place. The interval stops automatically once all jobs finish or the panel is removed from the DOM.

## Installation

Install from [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/phab-try/), or load temporarily via `about:debugging` → Load Temporary Add-on → select `manifest.json`.
