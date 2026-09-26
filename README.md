# @pipeworx/ncbi-variation

dbSNP refSNP records and HGVS ↔ SPDI ↔ rsID normalization from NCBI Variation
Services — the service that turns any spelling of a human genetic variant into
the canonical coordinates the rest of genomics keys on.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `variation_refsnp(rsid, assembly?, max_frequencies?)` — the full refSNP
  record: genomic placement on the build you ask for, HGVS genomic/transcript/
  protein forms, SPDI, gene context, ClinVar clinical significance, and
  population allele frequencies (gnomAD, ExAC, 1000 Genomes, TOPMED, ALFA).
  Answers "what is rs113488022".
- `variation_hgvs_to_spdi(hgvs)` — normalize an HGVS expression to contextual
  SPDI alleles, and validate that the HGVS is well-formed at all.
- `variation_spdi_to_rsids(spdi)` — the reverse: coordinate + alleles from a
  VCF or pipeline → the rsIDs other databases key on.

## Auth

Keyless. NCBI asks unauthenticated clients to stay under ~3 requests/second;
the pack sends an identifying User-Agent.

## Data sources

- <https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/{rsid}> — refSNP record.
- <https://api.ncbi.nlm.nih.gov/variation/v0/hgvs/{expr}/contextuals> — HGVS → SPDI.
- <https://api.ncbi.nlm.nih.gov/variation/v0/spdi/{spdi}/rsids> — SPDI → rsIDs.

## Traps

**GRCh37 vs GRCh38 is the whole game.** One refSNP carries placements on both
builds at *different* coordinates — rs113488022 (BRAF V600E) is 7:140753336 on
GRCh38 and 7:140453136 on GRCh37, 300kb apart. A caller who takes a coordinate
from one build into a dataset annotated on the other gets "not found", which
reads as "this variant does not exist". So `assembly` is an explicit argument
(default GRCh38), every response states `assembly_requested` and
`assemblies_available`, and an assembly with no placement says so in
`assembly_note` instead of coming back as an empty array.

**SPDI is 0-based, HGVS is 1-based.** `NC_000007.14:140753335:A:T` and
`NC_000007.14:g.140753336A>T` are the same variant. The off-by-one is the most
common reason `variation_spdi_to_rsids` returns nothing.

**A retired rsID is not an error.** dbSNP merges rsIDs; a merged one returns
`merged_snapshot_data` with no `primary_snapshot_data` at all. The pack detects
that and returns `status: "merged"` plus the rsID to re-query (rs3735962 →
rs328), rather than an empty record.

**Reference alleles are in the allele list.** dbSNP lists the reference as an
allele whose `deleted_sequence` equals its `inserted_sequence`. Filtering those
out is what separates `alternate_alleles` from noise.

**The raw record is huge.** rs328 carries thousands of citations and dozens of
placements. The pack summarizes and caps (`max_frequencies`, 25 citations) —
counts are always reported alongside so a truncation is visible.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ncbi-variation": {
      "url": "https://gateway.pipeworx.io/ncbi-variation/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ncbi-variation/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/variation_refsnp \
  -H 'Content-Type: application/json' \
  -d '{"rsid":"rs113488022","assembly":"GRCh38"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/variation_refsnp`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ncbi-variation": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ncbi-variation"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ncbi-variation
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ncbi Variation data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
