# Main branch ruleset

The local Git hooks are defense-in-depth only. GitHub's protected-branch ruleset is the authoritative control that prevents unvalidated commits from entering `main`.

In the repository on GitHub, open **Settings → Rules → Rulesets → New ruleset → New branch ruleset** and configure:

- **Ruleset name:** `Protect main`
- **Enforcement status:** `Active`
- **Bypass list:** empty; do not add administrators, repository roles, teams, or integrations that can normally bypass the ruleset
- **Target branches:** include the exact branch `main`

Enable these rules:

1. **Restrict deletions**
2. **Block force pushes**
3. **Require a pull request before merging**
4. **Require status checks to pass**
   - Add the required status check named `validate`, produced by `.github/workflows/validate-main.yml`.
   - Enable **Require branches to be up to date before merging** so validation runs against the current `main` base.

Do not add a bypass actor for routine development. Repository administrators should also follow the pull-request path; if the GitHub plan or repository ownership model exposes a separate option to allow administrators to bypass protections, leave that option disabled.

The required development flow is:

1. Create a feature branch.
2. Push the feature branch.
3. Open a pull request targeting `main`.
4. Wait for the `validate` check to pass.
5. Merge only after GitHub marks every required rule as satisfied.

With this active ruleset, a failed or missing `validate` check blocks the pull request, direct pushes cannot update `main`, force pushes and branch deletion are blocked, and `main` remains unchanged.
