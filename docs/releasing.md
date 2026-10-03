# Releasing the CLI

## Verify before publishing

Keep release preparation in reviewed pull requests. The `CLI release` workflow has a manual verification route that builds and smoke-tests the same executables as a tagged release without publishing anything:

```shell
gh workflow run publish-cli.yml --ref YOUR_REVIEW_BRANCH
```

Replace `YOUR_REVIEW_BRANCH` with the branch containing the complete candidate. Inspect that run's exact commit and job results, not just the branch name. GitHub must already know this workflow on the default branch for manual dispatch to be available.

The run checks the package version and repository checks, then builds Windows, macOS and Linux executables for x64 and ARM64. Each platform executes its binary, checks regex/glob matching and matcher timeout cleanup through that executable's embedded runtime, and exercises the direct installer against a local release server and temporary installation directory. The matcher probe loads the candidate's source fixture; the ordinary CLI smoke separately runs its compiled entrypoint. It does not replace the reviewer's installed CLI. Build artifacts and checksums are retained for seven days.

Both publishing jobs must be **skipped** on a manual run, even when dispatching against a tag. Their conditions require a `push` event for a `cli-v*` tag. Verification jobs have read-only repository permissions and no npm identity-token permission.

The native matrix is intentionally not part of every pull request. Use it for release candidates and changes to packaging, native execution or installers. Ordinary `npm run check` also runs the shared help/version/argument smoke against the built npm bundle, so a stale usage assertion fails before release day.

## Prepare the version

After the candidate's changes are agreed, prepare its next patch version with the existing helper:

```shell
npm run cli:prepare -- 0.2.5
```

This changes package metadata, runs repository checks and dry-runs npm packing. It does not create a tag or publish. Review the version diff and rerun candidate verification on the resulting commit.

## Publish only after approval

A pushed `cli-v<VERSION>` tag starts the publishing path. The tag must exactly match `packages/cli/package.json`. Repository checks and all six native targets must succeed before a GitHub release is created; npm publishing follows the GitHub release. Prerelease versions use the npm `beta` channel, and stable versions use `latest`.

Only the GitHub-release job receives repository write permission, and only the npm-publish job receives identity-token permission. A failed prerequisite prevents downstream publication. Do not bypass these checks with a direct package publish.

A CLI release is separate from hosted relay deployment and from approval or scanning of changed ChatGPT tool metadata. Keep the relay compatible with the currently approved schemas while metadata updates are pending.
