# The code index

An agent step starts in a worktree it has never seen. Before it walks files, it can search the
codebase: `ff index search "<what you need>"` answers with `path:line` hits. This module builds and
keeps those indexes.

The design is a clean-room recreation of the one Cursor's client uses (the reverse-engineering notes
behind issue #4): content-hash manifests, a Merkle handshake, per-file updates, keyword + vector
search. The upload service is replaced by local files: the factory has no indexing service, and the
index must work inside Docker with no network, so the whole pipeline runs locally on Node built-ins
only (the module has no dependencies and is loaded by both the factory and the ticket sandboxes).

## What mirrors Cursor's client, and what is a local choice

| Cursor's client (from the REA notes; observed unless marked) | Here | Where |
|---|---|---|
| Every uploaded file carries its SHA-256; ancestor directories roll children up; the handshake compares `root_hash` | The same tree: per-file content hashes, sorted-name rollups, one root hash; identical content hashes identically on every machine | `merkle.ts` |
| `FastRepoInitHandshakeV2` answers UP_TO_DATE / OUT_OF_SYNC / FAILURE / EMPTY | The same statuses: `checkIndex` walks only when it must, and one root-hash comparison answers "already indexed" | `sync.ts` (`checkIndex`) |
| `FastUpdateFileV2` uploads only changed files (with the ancestor spline) | Only changed files are read, chunked and embedded; every other chunk and vector is kept | `sync.ts` (`updateIndex`) |
| Files over 10 MiB are not uploaded | `INDEX_MAX_FILE_BYTES` defaults to 10 MiB; binary files and dependency/build directories are skipped; git's own ignore rules decide, and a git answer that fails counts as "not ignored" | `walk.ts` |
| `semSearchFast`: a query returns reranked code results with per-stage latencies | BM25 (k1 1.2, b 0.75) and cosine similarity over the chunk vectors are fused with reciprocal rank fusion (1/(60+rank)); each stage's time is reported | `search.ts` |
| The client uploads whole files; Cursor's service splits and embeds them | The split (`INDEX_CHUNK_LINES`/`INDEX_CHUNK_OVERLAP`, 1-based inclusive line ranges) and the embedding happen here; the built-in embedder is deterministic feature hashing, and `INDEX_EMBED=http` speaks to any OpenAI-compatible endpoint instead | `chunk.ts`, `embed.ts` |
| `getHighLevelFolderDescription`: an LLM writes the folder summary | The code map is generated deterministically (top level, entry points, biggest files): no model call, no hallucination, regenerated on every change | `map.ts` |
| Uploads encrypt paths (aes-256-ctr) | No encryption: the index never leaves the machine it was built on | — |
| The service refreshes the index server-side ("refreshed from git diff") | `INDEX_REF` follows a ref (e.g. `origin/main`) through a hidden snapshot worktree, advancing by `git diff --name-status <from> <to>`; the checkout itself is followed by size/mtime + content hash | `source.ts`, `sync.ts` |

Where the observation was of a client-side shape only (what is uploaded, when a handshake runs), the
module copies that shape. Where the research was a hypothesis about the service side, the module
makes its own choice and this table says so (embedding, chunking, ranking constants, the code map).

## What it will not do

- **Never index what an agent may not read.** The index is readable by every agent, so it must not
  become a way around the secret rule in `roles.ts`: `.env` and the secret paths are skipped, while
  `.env.example` and friends stay. This is a deliberate difference from Cursor, which has no such
  rule.
- **Never write inside a sandbox.** Ticket containers get the index folder mounted read-only with
  `INDEX_DIR` (and `INDEX_SCOPE`, their ticket's own store). Builds and refreshes run on the host,
  where the factory already has the repo and the writes.

## Where it lives

```
state/index/<repoId>/             the repo's own index (the checkout, or INDEX_REF)
state/index/<repoId>-<scope>/     a ticket's index (scope = the ticket id, lowercased/sanitized)
    meta.json                     root hash, source ref/commit, embedder, counts, timestamps
    manifest.json                 per file: content hash, size, mtime, chunk count, simhash
    chunks.jsonl                  per chunk: path, 1-based line range, text
    vectors.f32                   chunk vectors, little-endian float32, chunks.jsonl order
    description.txt               the generated code map
    snapshot/                     the hidden worktree, only when INDEX_REF is used
```

`repoId` comes from the origin URL (name slug + short hash of the URL), so a clone and every
worktree of it resolve to the same identity, on any machine and inside any container. Writes are
tmp-file + rename; a torn read (root hash vs manifest, vectors vs chunks) is answered with "no
index" so the next update rebuilds it. One update at a time per store (`.lock`).

## A ticket's index

The repo index alone is stale the moment a ticket writes code, but a full second index per ticket
would re-embed code the run never touched. So a ticket's store starts as a byte copy of the repo's
(its worktree is cut from that code), the copy's meta is patched to the worktree (commit pinned to
null so the handshake cannot trust the base's stamps), and the first update walks the worktree: the
copy's chunks and vectors are reused for every file whose content hash still matches, and only the
ticket's changes are embedded. A read that finds no ticket store yet falls back to the repo's and
says so (`meta.note`).

## Refreshes

`scheduleIndexUpdate` is the factory's stand-in for Cursor's indexing watcher: one chain per store,
debounced (`INDEX_MIN_INTERVAL`), never throwing, and a ticket's first update waits for the repo's
when one is queued (it seeds from it). It is called:

- when `ff serve` starts (the repo index warms up),
- after a ticket's worktree is prepared (the fetch may have moved the base branch), and
- at every agent step start, on the ticket's own scope, so the code the run generated so far is
  searchable before the next agent looks for it.

`INDEX_AUTO=0` turns all of this off; `ff index` still works by hand.

## Commands

```
ff index build [--full] [--json]     build or refresh (INDEX_REF: of that ref)
ff index update                      same, incremental by default
ff index status [--json]             what the store holds, and whether it matches the code
ff index search <query> [--k N] [--path P] [--json]
ff index map                         the generated code map
ff index bench [query...]            search versus reading the whole tree: timings and bytes
ff index clean                       remove the store (of INDEX_SCOPE, when set)
```

Settings are documented in `config.example.env` (`INDEX_*`). Nothing is required: with no settings
at all the index builds offline with the hash embedder.

## Tests

`durable/test/index.test.ts`: the Merkle tree, the chunker's line ranges, what the walk skips,
the delta update, search (paths, lines, filters), the ticket scope seeded from the repo's,
`INDEX_REF` through a snapshot, and the failure modes. `durable/test/docker.test.ts` adds the
in-container search against the read-only mount (needs the image; skipped without Docker).
