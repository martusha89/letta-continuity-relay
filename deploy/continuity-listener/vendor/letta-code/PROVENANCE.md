# Vendored Letta Code runtime

This directory contains a custom patched build of `@letta-ai/letta-code` 0.34.24. It is derived from the upstream Letta Code tag `v0.34.24` at commit `6f4e4886c`; it is not the npm registry artifact.

The redistributed files are:

- `letta-ai-letta-code-0.34.24.tgz` — the custom patched package archive.
- `git-diff.patch` — the exact source patch represented by that build.
- `SHA256SUMS` — SHA-256 checksums for the archive and patch.
- `provenance.json` — machine-readable source and artifact provenance.
- `LICENSE` — the package's Apache License 2.0 terms, copied from the archive so they are visible without extraction.

The archive includes `npm-shrinkwrap.json`. Both listener Dockerfiles verify `SHA256SUMS` and install the tarball directly with npm, so npm honors that packaged shrinkwrap when resolving the runtime dependency tree.

The repository's top-level `LICENSE` remains the separate MIT license for the continuity relay. It does not replace or alter the vendored package's Apache-2.0 terms or its brand-assets exclusion.
