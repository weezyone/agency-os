# Issue tracker: GitHub

Issues and specs for this repo live in [weezyone/agency-os GitHub Issues](https://github.com/weezyone/agency-os/issues).

Use the host's issue-creation tool when available. In CLI-only clients, use `gh issue create`. Use the `gh` CLI for the other operations below, with `--repo weezyone/agency-os` to keep the target explicit.

## Conventions

- **Create an issue**: follow any applicable template in `.github\ISSUE_TEMPLATE\` or `.github\ISSUE_TEMPLATE.md`. In CLI-only clients, use `gh issue create --repo weezyone/agency-os --title "..." --body-file <path>`.
- **Read an issue**: `gh issue view <number> --repo weezyone/agency-os --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --repo weezyone/agency-os --state open --json number,title,body,labels,comments`. Add appropriate label filters and paginate when the result exceeds the command's limit.
- **Comment**: `gh issue comment <number> --repo weezyone/agency-os --body-file <path>`.
- **Apply or remove labels**: `gh issue edit <number> --repo weezyone/agency-os --add-label "..."` or `--remove-label "..."`. Use the vocabulary in `docs\agents\triage-labels.md`.
- **Close**: `gh issue close <number> --repo weezyone/agency-os --comment "..."`.
- **Link a sub-issue**: obtain the child's database ID with `gh api repos/weezyone/agency-os/issues/<child> --jq .id`, then run `gh api --method POST repos/weezyone/agency-os/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. If sub-issues are unavailable, add the child to a task list in the parent and put `Part of #<parent>` at the top of the child body.

For multiline bodies on Windows, use a temporary UTF-8 file with `--body-file`, then remove that temporary file. Do not use shell heredoc syntax in PowerShell.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Triage issues, not external pull requests. If this flag is deliberately changed to `yes` later, use the corresponding `gh pr` operations and the same label vocabulary.

GitHub shares one number space across issues and pull requests. When a reference is ambiguous, resolve its type before updating it: try `gh pr view <number> --repo weezyone/agency-os`, then `gh issue view <number> --repo weezyone/agency-os` if it is not a pull request. Authentication or network errors do not establish the reference's type.

## When a skill says "publish to the issue tracker"

Create a GitHub issue using the conventions above.

## When a skill says "fetch the relevant ticket"

Read the GitHub issue, including its body, labels, and relevant comments.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog sections.
- **Child ticket**: link it as a sub-issue, or use the parent task-list fallback above. Use `wayfinder:<type>` labels for `research`, `prototype`, `grilling`, or `task`. Create missing wayfinding labels only when that workflow is requested; this setup creates only triage labels.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/weezyone/agency-os/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the blocker's numeric database ID with `gh api repos/weezyone/agency-os/issues/<blocker> --jq .id`; it is not the issue number or `node_id`. If native dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked only when every blocker is closed.
- **Frontier query**: enumerate all open children of the map in map order. Exclude assigned tickets and tickets with open blockers. For native dependencies, inspect `issue_dependencies_summary.blocked_by`; for fallback links, inspect each blocker's state. Choose the first remaining ticket. Do not treat the entire repository's open-issue list as the map's children.
- **Claim**: `gh issue edit <number> --repo weezyone/agency-os --add-assignee @me` is the driving session's first write to the selected ticket.
- **Resolve**: comment with the result, close the ticket, and append a durable context pointer to the map's Decisions-so-far section. Keep private repository content in the repository's access boundary.
