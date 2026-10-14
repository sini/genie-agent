---
name: pin-container-images-by-digest
description: When adding or bumping a container image in Nix-managed Kubernetes manifests.
type: practice
---

**Rule:** Reference container images through the repo's tracked image-metadata files and a digest
accessor, never an inline tag. Let the updater tool re-resolve digests.

**Why:** An inline tag can name an image that does not exist. A deploy broke with `ImagePullBackOff`
because a GitHub *release* tag had no matching *container* tag; the registry only published a rolling
`develop` tag. A digest-pinned entry that an updater bumps makes even a rolling tag safe.

**How to apply:**

- One metadata file per image (name, tag, digest, hash, arch, os), at a path keyed `<ns>/<name>`.
  The manifest reads `image = { inherit (images."<ns>/<name>") repository digest; }`, which renders
  `repository@sha256:...` with no tag.
- Check the tool's output path. One updater's `init` wrote a three-level path that included the
  registry, which broke the two-level fold into accessor keys. Move the file, then verify the accessor
  resolves with `nix eval`.
- Single-segment official images (`alpine`) also break a two-level layout; use `library/<name>`.
- Validate that a rolling tag exists cheaply before the heavy init: `skopeo inspect docker://<ref>`.
- A tool that runs via `nix run .#tool` evaluates the whole flake first. One broken module mid-batch
  silently kills every later step, so fix eval before continuing. `git add` new metadata files
  before any eval, because flakes ignore untracked files.
- When the full environment build is already red for an unrelated reason, validate in isolation
  (evaluate the image-ref set and the rendered container image fields) and say so.

Related: \[[nix-flake-hygiene]\] \[[infra-changes-owner-deploys]\]
