# Contributing

Thank you for helping improve the WebMCP consent gate.

## Before opening a pull request

1. Create a focused branch from `main`.
2. Run `npm ci --ignore-scripts`.
3. Run `npm run check`. While iterating, `npm test` builds and runs just the
   behavioral suite.
4. Confirm the change introduces no runtime dependency, secret, private
   application code, Big Mama prompt or voice asset, or user data.
5. Add a `Signed-off-by` trailer to every commit to certify the
   [Developer Certificate of Origin](https://developercertificate.org/):

   ```text
   Signed-off-by: Your Name <your-email@example.com>
   ```

Use `git commit -s` to add the trailer automatically.

## Compatibility contract

Tool names and schemas are a public compatibility surface. Do not edit a
published schema in place. A breaking contract change must introduce a new
versioned path, such as `schemas/v2/`, and preserve the prior version for
existing clients.

Pull requests must explain whether they change runtime behavior, a published
schema, or documentation only. Consequential tools must remain fail-closed and
must never gain a trusted-caller or consent-bypass option.

## Security reports

Do not disclose a vulnerability in a public issue. Follow
[SECURITY.md](./SECURITY.md).

## Public CI and DCO

The Package checks workflow runs the full gate and verifies `Signed-off-by`
trailers on PR commits, alongside the existing Buildkite pipeline. Hosted run
results are the evidence that these checks executed. Maintainers can require
`package` and `dco` in branch protection after the checks have reported once.
This workflow checks the DCO trailer; it does not verify the signer's identity.

A second code owner must be a maintainer with repository write access who has
accepted that responsibility. Do not add a placeholder account. The DCO GitHub
App is an optional alternative if Actions capacity becomes unavailable.
