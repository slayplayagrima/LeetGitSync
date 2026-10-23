# LeetGitSync

A personal Chrome extension (Manifest V3) that saves your **accepted** LeetCode submissions to a GitHub repository you control.

You solve and submit a problem on leetcode.com as usual. When LeetCode reports **Accepted**, the extension reads that exact submission back from LeetCode, writes it to your repository in a single commit, and shows a small notification on the page. Nothing is faked: no backdating, no empty commits, no commits when the code has not changed.

This is a local, unpacked extension for personal use. It is not published in the Chrome Web Store.

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Install in Chrome](#install-in-chrome)
- [GitHub setup](#github-setup)
- [Sync behaviour](#sync-behaviour)
- [File organization](#file-organization)
- [Duplicate prevention](#duplicate-prevention)
- [Security and privacy](#security-and-privacy)
- [Contribution graph caveats](#contribution-graph-caveats)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Manual test checklist](#manual-test-checklist)
- [Known limitations](#known-limitations)
- [Revoking access](#revoking-access)

---

## Features

- Detects accepted submissions on leetcode.com, including single-page navigation, without a page reload.
- Saves the **exact accepted code**, read from LeetCode's submission record for that submission id, never from the editor.
- Rejected, pending, compiling, runtime-error and "Run code" results are never saved.
- One commit per change, with the solution file and optional JSON metadata written together.
- Deterministic paths such as `python/0001-two-sum.py`; all LeetCode languages supported (unknown ones are kept as `.txt`).
- Optional comment header with problem number, title, URL, language, submission id, submission time, runtime and memory.
- Idempotent: the same submission, or identical code, never creates another commit.
- Durable queue in `chrome.storage.local`; survives service-worker restarts and page reloads.
- Automatic retries with exponential backoff for network errors, GitHub 5xx and rate limits; no retries for auth or permission errors.
- Automatic or manual sync mode; "update file" or "keep each distinct submission" history policy.
- Popup with connection status, latest result, counts, recent history, retry and a **Sync this accepted submission** fallback.
- Settings page with repository, branch, token management, connection test, file conventions, history and setup guide.

## Architecture

```
manifest.json
scripts/
  build.mjs            esbuild bundle → dist/
  verify-dist.mjs      checks manifest files, permissions, no secrets in dist/
  make-icons.mjs       regenerates icons/*.png
src/
  background/service-worker.ts   message routing, badge, alarms, tab bookkeeping
  content/page-hook.ts           MAIN-world observer of LeetCode's judge responses
  content/leetcode-content.ts    isolated-world script: confirm + read submission
  content/toast.ts               in-page notification (shadow DOM)
  popup/                         popup UI
  options/                       settings page
  ui/                            shared styles and UI helpers
  lib/
    detection.ts       turns judge-status hints into one event per submission
    leetcode-client.ts LeetCode GraphQL reads (isolated, documented below)
    github-client.ts   GitHub REST: repo, branch, contents, Git Data API commit
    sync-service.ts    queue, state machine, idempotent writes, retries
    deduplication.ts   submission-id and code-hash duplicate checks
    file-content.ts    header, metadata JSON, code extraction
    filename.ts        title normalization and path building
    languages.ts       LeetCode language → folder, extension, comment syntax
    validation.ts      settings and response validation
    errors.ts          error codes, GitHub error mapping, backoff
    storage.ts         chrome.storage wrapper with serialized updates
    redact.ts, log.ts  credential redaction for anything logged
test/                  Vitest unit + integration tests with an in-memory GitHub
```

### How a submission flows

1. **Observe.** `page-hook.js` runs in the page's own JavaScript world and wraps `fetch`/`XMLHttpRequest`. When LeetCode's app polls `/submissions/detail/<id>/v2/check/`, the hook forwards only `state`, `status_code`, `status_msg` and the id to the content script. It makes no requests and changes nothing.
2. **Decide.** The content script treats only `state: SUCCESS` with `status_code: 10` and a numeric submission id as accepted, once per id.
3. **Record.** The service worker stores the submission as *waiting for details* (durable, so a reload does not lose it).
4. **Confirm and read.** The content script asks LeetCode's GraphQL endpoint for `submissionDetails(<id>)` (same-origin, your existing session) and the public `question(titleSlug)` for number/title/difficulty. The worker re-checks that the status is Accepted, the code is non-empty and the problem matches.
5. **Write.** The worker checks the repository and branch, reads the existing file, skips if the code is identical, otherwise creates one commit (Git Data API, non-forced ref update) and records the result.
6. **Report.** A toast on the LeetCode tab, the toolbar badge, and the popup show the outcome.

The GitHub token exists only in the service worker and extension pages. Content scripts and LeetCode never see it.

### Sync states

`detected → waiting_details → ready → syncing → synced`, with `failed` (retrying or needing you) and `needs_review` (details unavailable, not accepted, empty code, or a mismatch).

## Prerequisites

- macOS with Google Chrome 111 or newer.
- Node.js 20+ and npm (only to build).
- A GitHub account and a repository you own.

## Build

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs the typecheck, the tests, the production build and the dist verification. Individually:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

The loadable extension is written to `dist/`.

## Install in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `dist/` folder.
5. Pin LeetGitSync from the puzzle-piece menu if you like.
6. The settings page opens on first install (or right-click the icon → **Options**).
7. Enter the repository owner, name and branch, then **Save settings**.
8. Paste your fine-grained token and click **Save token**; the connection is tested automatically.
9. Open a problem on leetcode.com, submit a solution yourself, and watch for the notification.

**After changing code:** run `npm run build` (or keep `npm run watch` running), then click the reload icon on the LeetGitSync card in `chrome://extensions` and reload any open LeetCode tabs.

**Logs:**
- Service worker: `chrome://extensions` → LeetGitSync → **service worker** link → Console.
- Content script: open DevTools on the LeetCode tab → Console (messages are prefixed `[LeetGitSync]`; pick the extension in the context dropdown to see isolated-world logs).
- Popup: right-click inside the popup → **Inspect**.

## GitHub setup

### 1. Create the repository

Create `leetcode-solutions` (or any name) under your account, public or private, and tick **Add a README file** so the default branch exists. LeetGitSync never creates repositories and refuses to write to an empty one.

### 2. Create a fine-grained token

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([direct link](https://github.com/settings/personal-access-tokens/new)).
2. **Resource owner:** your personal account.
3. **Expiration:** pick one (you can regenerate later).
4. **Repository access:** *Only select repositories* → choose only the destination repository.
5. **Repository permissions:** **Contents → Read and write**. Leave everything else at *No access* (GitHub adds *Metadata: Read-only* automatically).
6. Generate and copy the token (starts with `github_pat_`).

### 3. Save and test

Paste it into **Settings → Fine-grained personal access token → Save token**. Do not paste it anywhere else: not in chat, not in source files, not in `.env`.

### Required permissions summary

| Where | Permission | Why |
| --- | --- | --- |
| GitHub token | Contents: Read and write (one repository) | read existing files, create commits |
| Chrome | `storage` | settings, token, sync history |
| Chrome | `alarms` | wake the worker for backoff retries |
| Chrome | host `https://api.github.com/*` | the only place the token is sent |
| Chrome | content scripts on `https://leetcode.com/*` | detect accepted submissions, read that submission back |

No `tabs`, `cookies`, `history`, `notifications`, `downloads`, `clipboard` or `<all_urls>` permissions are requested.

## Sync behaviour

- **Automatic** (default): every accepted submission is synced.
- **Manual**: accepted submissions are queued as *Ready to sync*; click **Sync now** in the popup or settings.
- **Sync this accepted submission** (popup, on a LeetCode tab): reads the submission open in the URL (`/problems/<slug>/submissions/<id>/`) or the last one accepted on that tab, then queues it. Useful for older submissions or if automatic detection missed one.

History policy when a later accepted submission for the same problem and language has **different** code:

- **Update** (default): overwrite `python/0001-two-sum.py`. Every previous version stays in the Git history.
- **Separate**: save `python/0001-two-sum/<submission-id>.py` for each distinct solution.

## File organization

```
leetcode-solutions/
├── README.md
├── python/
│   ├── 0001-two-sum.py
│   └── 0020-valid-parentheses.py
├── cpp/
├── java/
└── metadata/            (only if the JSON sidecar is enabled)
    └── python/0001-two-sum.json
```

- Filename styles: `0001-two-sum`, `0001.two-sum`, `two-sum`.
- An optional root folder (e.g. `leetcode/`) prefixes everything.
- Each language folder can be renamed in Settings → Files → Language folders.

Example file:

```python
# LeetCode 1. Two Sum
# https://leetcode.com/problems/two-sum/
# Difficulty: Easy
# Language: Python3
# Submission: 1234567890
# Submitted: 2026-10-23 17:20:00 UTC
# Runtime: 0 ms, Memory: 18.1 MB

class Solution:
    ...
```

The header ends at the first blank line; everything after it is your submitted code, byte for byte (a final newline is added only if missing). Runtime and memory appear only when LeetCode reports them.

## Duplicate prevention

- The LeetCode **submission id** is the key. Repeated status polls, re-renders, reloads and repeated reports of the same id never queue it twice.
- Before writing, the worker compares the code with what is already in the repository (and with a local SHA-256 of the last synced code). Identical code → *Already synced*, no commit.
- Writes use a non-forced branch update. If the branch moved meanwhile, GitHub rejects the update, nothing changes, and the worker re-reads and tries again.
- If the response to a successful write is lost, the retry finds the code already present and records *Already synced* instead of committing again.
- Clearing local history does not cause duplicates either, because GitHub is always checked first.

## Security and privacy

- The token is stored in `chrome.storage.local` for this Chrome profile only. It is never hard-coded, logged, shown in the UI, included in error messages, or sent anywhere except `https://api.github.com` in an `Authorization` header.
- Extension pages use a strict CSP that only allows connections to `api.github.com`.
- Messages that touch the token or settings are accepted only from the extension's own pages; content scripts can only report submissions.
- The LeetCode page hook only forwards judge-status fields. Anything it sends is treated as a hint and verified by reading the submission back from LeetCode.
- No backend, no analytics, no third-party services.
- **Limitation:** a token stored by a browser extension is protected by your macOS account and Chrome profile, not by a secret the extension controls. Anyone with access to this profile (or malware running as you) could extract it. Keep it limited to one repository, set an expiration, and revoke it if in doubt. A stronger setup would need a backend or OS keychain helper; that is intentionally not included.
- The automated tests use an in-memory GitHub and mocked LeetCode responses. They never contact GitHub or LeetCode.

## Contribution graph caveats

Synced solutions are real commits, made by the account that owns the token, at the time of syncing. Whether a commit shows as a green square is decided by GitHub, not by this extension. Commonly:

- The commit must be on the repository's **default branch** (LeetGitSync warns if you target a different branch).
- The commit email must be linked to your GitHub account (commits made through the API with your token are attributed to you).
- Private-repository contributions only appear if you enable *Private contributions* on your profile.
- A sync that finds identical code makes no commit, so it adds nothing to the graph, by design.

LeetGitSync never backdates, never makes empty commits, and never rewrites files without a real change.

## Development

```bash
npm run watch
```

Rebuilds `dist/` on every change (then reload the extension). Tests live in `test/`; `test/fake-github.ts` is an in-memory implementation of the GitHub endpoints used, so pipeline behaviour (conflicts, lost responses, rate limits, restarts) can be tested without network access.

To regenerate icons:

```bash
node scripts/make-icons.mjs
```

### LeetCode interfaces used (undocumented)

LeetCode has no public API. LeetGitSync depends on:

| Interface | Used for | Isolated in |
| --- | --- | --- |
| Responses to `GET /submissions/detail/<id>/v2/check/` (legacy `/check/`; fields `state`, `status_code`, optional `status_msg`) | knowing a submission was accepted | `src/content/page-hook.ts`, `parseCheckPayload` in `src/lib/validation.ts` |
| Response to `POST /problems/<slug>/submit/` (field `submission_id`) | linking the id to the problem | `src/content/page-hook.ts` |
| GraphQL `submissionDetails(submissionId)` | exact code, language, status, problem | `src/lib/leetcode-client.ts`, `parseSubmissionDetails` |
| GraphQL `question(titleSlug)` | number, title, difficulty | `src/lib/leetcode-client.ts`, `parseQuestion` |

The GraphQL field names were checked against LeetCode's live schema on 2026-10-23 (an unknown field is rejected by the server; the fields used are accepted). The `submissionDetails` response for a signed-in user could not be inspected without an account session, so it is validated defensively: missing code, language, problem or status leads to *Needs manual review*, never to a guessed file. If LeetCode changes any of these, only the two files above need updating.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| *GitHub authorization failed* | Token invalid, expired or revoked. Create a new one and save it. |
| *Permission denied* | The token does not include this repository, or Contents is not *Read and write*. Edit the token on GitHub. |
| *Repository not found* | Owner/name typo, or the token cannot see the repository. |
| *Repository is empty* | Add a README on GitHub to create the first commit and branch. |
| *Branch not found* | Branch name in Settings does not exist. Use the default branch (usually `main`). |
| *Rate limit reached* | The worker waits until GitHub's reset time and retries automatically. |
| *Details unavailable* | Not signed in to leetcode.com, or LeetCode's API changed. Sign in, open the submission, and use **Sync this accepted submission**. |
| *Manual review required* | The submission was not accepted, had empty code, or belonged to another problem. Check it on LeetCode. |
| Popup says detection is not active | Reload the LeetCode tab. If it persists after reloading the extension, LeetCode's page may have changed. |
| Nothing happens after Accepted | Make sure the extension was reloaded *before* the LeetCode tab was opened; content scripts attach only to pages loaded afterwards. |
| No green square | See [Contribution graph caveats](#contribution-graph-caveats). |

## Manual test checklist

1. `npm run check` passes; load `dist/` unpacked; no errors on the extension card.
2. Settings: save owner/repo/branch; save the token; the status shows **Connected**.
3. Open a LeetCode problem; the popup's *This page* card does not warn that detection is inactive.
4. Submit a **wrong** solution: nothing is synced.
5. Submit a **correct** solution: a toast says it was saved; the file appears at the expected path.
6. Compare the file on GitHub with the code shown on LeetCode's submission page: identical below the header.
7. Check the commit is on the default branch and authored by you.
8. Reload the page and submit the same code again: *Already synced*, no new commit.
9. Submit different correct code: one new commit updating the file (or a new file with the *Separate* policy).
10. Submit in a second language: a file in that language's folder.
11. Temporarily set a wrong branch: the sync fails with *Branch not found*; fix it and **Retry**.
12. Revoke the token on GitHub, submit again: *GitHub authorization failed*, no retries; remove the token in Settings.
13. Check your contribution graph the next day (GitHub can take time to update).

## Known limitations

- Only `leetcode.com` is supported (not `leetcode.cn`, which uses different APIs).
- Detection relies on LeetCode's undocumented judge-status responses and GraphQL queries (see above). End-to-end behaviour was verified in Chromium against **mocked** LeetCode and GitHub responses, not against a live LeetCode account; complete the manual checklist with a real submission.
- Submissions made while the extension is disabled or before a tab was reloaded after installing are not detected automatically; sync them from their submission page.
- Contest submissions and problems without a number are saved by slug.
- Files larger than 1 MB in the repository are not compared by content (GitHub does not return their content), so a sync over one would rewrite it.
- The token is stored unencrypted in the Chrome profile (see [Security and privacy](#security-and-privacy)).

## Revoking access

1. GitHub → **Settings → Developer settings → Fine-grained tokens** ([link](https://github.com/settings/personal-access-tokens)) → select the token → **Revoke**.
2. LeetGitSync → Settings → **Remove stored token** (or **Disconnect GitHub**).
3. Optionally remove the extension in `chrome://extensions`. Removing it deletes its local storage. Files already in your repository are never deleted by LeetGitSync.
