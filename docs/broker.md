# Gist operations through the proposal broker

The existing `propose` tool supports gist reads, updates, comments and creation,
as well as pull requests. The broker in root is the only holder of the configured
GitHub machine-account token. Tier 1 receives operation results, never that token.
This implementation does not provision an account, mint a token or enable a live
GitHub deployment.

## Proposal shapes

| `kind`         | Fields                                               | Effect                                                                                      |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `gist_read`    | `id`                                                 | Read a complete bounded gist as untrusted data                                              |
| `gist_update`  | `id`, nonempty `files`, optional `title`             | Update supplied files of a gist owned by the machine account; title changes its description |
| `gist_comment` | `id`, nonempty `body`                                | Post a review comment, including on another user's gist                                     |
| `gist`         | `title`, `body`, nonempty `files`, optional `public` | Create a gist; body supplies `README.md` when nonempty                                      |
| `pr`           | Existing repository, branch and file/worktree fields | Use the existing PR broker                                                                  |

`id` accepts a hex gist ID or an HTTPS `gist.github.com` URL, with or without its
owner path. The broker normalizes it to an ID. Navigational query/fragment data
is not forwarded. Revision paths, raw-content URLs and other hosts are refused;
the broker constructs requests against its configured GitHub API rather than
fetching a caller-supplied URL. Unknown fields are refused. The new read, update
and comment kinds also refuse fields belonging to another operation.
Unspecified files are not implicitly deleted by an update.

Example read and review proposals:

```json
{"kind":"gist_read","id":"https://gist.github.com/account/abcdef1234567890abcdef1234567890ab"}
```

```json
{"kind":"gist_comment","id":"abcdef1234567890abcdef1234567890ab","body":"The example needs a test for the empty result."}
```

Gist creation stays **secret/unlisted by default**. Only explicit `public: true`
creates a public gist; the model-facing schema presents this boolean as `yes` or
`no` and converts it back before validation. The flag is valid only on creation.
A secret gist is not private: anyone with its URL can read it. Updates and comments
still publish content, regardless of a gist's listing status.

## Credentials, screening and limits

Set `broker.tokenFile` to an owner-controlled token file for writes. Root and the
Act verify `GET /user` against configured `broker.botLogin` and forbidden logins.
A gist update additionally fetches ownership metadata and compares its owner to
the authenticated account before PATCH. Comments do not require ownership of
the target gist. Existing PR identity, repository and fork checks are unchanged.

With `broker.tokenFile: null`, writes stay disabled and `gist_read` uses the public
API without an Authorization header or account lookup. A configured but unreadable,
empty or invalid token causes refusal; it does not fall back to anonymous access.
Successful reads count against the existing per-thread proposal quota, just like
successful writes. Root records that counter and returns the result; this is not
a new durable action journal.

Writes pass deterministic redaction, then the existing enabled guard-out review,
before any publishing Act. The content published is the content that passed that
review. Read request metadata invokes no guard-out model. Instead, the broker
scrubs the exact configured token and known credential patterns from fetched data,
then uses root's existing guard-in screen. Rewrites are scrubbed and validated
again before return. Errors are scrubbed and bounded too.

New gist reads use the global `guard.enable` setting, independently of the optional
legacy `ghScreen` switch. With the global guard enabled, unavailable, rejected or
invalid screening results are withheld from both the caller and transcript.
Explicit global guard-off mode skips the model screen but retains deterministic
redaction and untrusted marking. The existing `gh_read` tool keeps its separate
legacy behavior.

A successful read returns a typed gist value with `untrusted: true`, canonical
ID/URL, description, nullable owner login, revision and files. This provenance
wrapper is reconstructed by the broker, not supplied by a guard rewrite. Root
records only the processed result in `gh_transcript`, marking whether model
screening ran. Fetched text is peer data, never permission to act.

The read API response and final model-facing value each have a **65,536-byte**
UTF-8 JSON limit. The API reader counts streamed bytes, including when Content-Length
is missing or inaccurate. Oversized, malformed or incomplete reads are refused;
so are truncated file lists and truncated individual files. No `raw_url` fetch or
clone fallback is attempted. Update/comment metadata has a separate **1,048,576-byte**
bound and does not enter model context. Requests retain explicit timeouts,
redirect refusal and no automatic retries. A failed write response can be
uncertain; inspect the target before retrying a non-idempotent creation or comment.

## Configuration and local verification

The Nix module exposes `services.genie-agent.broker.tokenFile`, `botLogin`,
`forbiddenLogins` and `maxProposalsPerThreadPerDay`; root JSON uses the same fields
under `broker`. Keep the actual token in its file. The owner selects and provisions
the machine account separately. These operations add no credential holder or bus protocol.

The portable tests exercise a fake GitHub API, fake guards and the actual model
argument converter:

```sh
node --test tests/broker.test.ts tests/gist.test.ts tests/pr.test.ts
node --test tests/root-gist.test.ts tests/gist-model.test.ts
```

Use the project's Node version with TypeScript stripping support, or its development
shell. The tests verify anonymous reads, ownership refusal, write guard order,
public opt-in through the model/root/API path, and screened transcript handling.
They do not establish a live account or a deployed GitHub action.

## Direct requests from a gateway service

The optional `broker.bridge` accepts the four gist proposal kinds over the existing
registered xmsg service, without starting a model conversation. Its default
allowlist is empty. The same proposal validation, redaction, guards, bot identity,
update ownership, daily quota and processed read transcript apply to direct requests.
Reads use the global inbound guard setting, including its explicit off mode.

**Granting a gateway principal send to the broker service grants it the broker’s gist operations.**
The allowlist matches the transport-attested service and node exactly; sender labels,
forwarded human names and body identity claims grant no authority. An instance or
anonymous sender cannot substitute for an allowed service.

For example, root JSON can include:

```json
{
  "broker": {
    "bridge": {
      "allowlist": [{ "service": "gateway", "node": "edge.example" }],
      "maxBodyBytes": 65536
    }
  }
}
```

This fragment extends the normal root configuration. The Nix module exposes the
same fields under `services.genie-agent.broker.bridge`; its default is `null`.
The bridge requires a bus that advertises its effective body, reply and
idempotency limits at registration. The complete serialized result is bounded by
the smaller of `maxBodyBytes` and the negotiated body limit. If the negotiated body
or replay limits change on reconnect, new requests receive durable refusals until root restarts and negotiates a fresh
contract. Already queued Acts remain held. Recorded replies can still be delivered
if their original immutable body fits the current bus limit; oversized results
remain held without rewriting their body or idempotency key. A gist that fits the
read limit can still produce an oversized Action wrapper: that request receives
an explicit result-too-large refusal rather than truncated JSON or files.

A gateway sends the existing strict Proposal JSON following its external-message
preamble. Root recognizes that framing and also direct typed gist proposals;
the preamble is data, not authority. PR proposals are outside this bridge.
Results use the existing Action JSON and a correlated reply to the original xmsg
message ID, with a stable reply idempotency key. Unknown or malformed callers
receive bounded refusals without GitHub or model calls.

Requests are persisted before their upstream ACK; a separate bounded worker
executes them while intake continues receiving guard responses. Records bind the
attested caller, original message ID and payload fingerprint. Duplicate deliveries
reuse the recorded result, and conflicting payloads are refused. Completed results
are persisted before replying. After a crash, reads can retry; a write that was
in progress becomes explicitly uncertain and is never automatically repeated.
The external-acceptance/crash window cannot establish exactly-once GitHub writes.
Unacknowledged or uncertain work remains held against the bounded record capacity;
replay lifetimes alone do not justify repeating it. When the bounded queue is full,
the next request remains unacknowledged. That FIFO head can delay guard responses
behind it; the existing finite guard deadline fails the affected operation closed
and releases worker capacity so intake can resume. No unreviewed Act or
unpersisted ACK is used to relieve backpressure.

Quota and transcript attribution use a stable root-derived caller context, never
a thread chosen by the requester. Direct traffic creates no pi session. Local
fixtures exercise this path without a GitHub account or live service:

```sh
node --test tests/root-broker-bridge.test.ts tests/broker-transport.test.ts
```
