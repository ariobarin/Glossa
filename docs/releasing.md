# Releasing the CLI

## Verify before publishing

Keep release preparation in reviewed pull requests. The `CLI release` workflow has a manual verification route that runs the same checks as a tagged release without publishing anything:

```shell
gh workflow run publish-cli.yml --ref YOUR_REVIEW_BRANCH
```

Replace `YOUR_REVIEW_BRANCH` with the branch containing the complete candidate. Inspect that run's exact commit and job results, not just the branch name. GitHub must already know this workflow on the default branch for manual dispatch to be available.

The run checks the package version and runs `npm run check`, which builds the npm bundle and smoke-tests its help, version, argument handling and update notices. CI also runs the full check on Windows for every pull request.

Both publishing jobs must be **skipped** on a manual run, even when dispatching against a tag. Their conditions require a `push` event for a `cli-v*` tag. Verification jobs have read-only repository permissions and no npm identity-token permission.

## Prepare the version

After the candidate's changes are agreed, prepare its next patch version with the existing helper:

```shell
npm run cli:prepare -- 0.2.5
```

This changes package metadata, runs repository checks and dry-runs npm packing. It does not create a tag or publish. Review the version diff and rerun candidate verification on the resulting commit.

## Publish only after approval

A pushed `cli-v<VERSION>` tag starts the publishing path. The tag must exactly match `packages/cli/package.json`. Repository checks must succeed before npm publishing, and a notes-only GitHub release follows it. Prerelease versions use the npm `beta` channel, and stable versions use `latest`.

Only the GitHub-release job receives repository write permission, and only the npm-publish job receives identity-token permission. A failed prerequisite prevents downstream publication. Do not bypass these checks with a direct package publish.

A CLI release is separate from hosted relay deployment and from approval or scanning of changed ChatGPT tool metadata. Keep the relay compatible with the currently approved schemas while metadata updates are pending.
