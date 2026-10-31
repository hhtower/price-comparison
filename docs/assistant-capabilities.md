# Assistant capability evidence and candidates

The assistant maintains a small reviewed list in `apps/api/src/assistant/assistant-capabilities.ts`.
It makes no model calls and does not fetch provider pages at runtime.

## Reviewed sources

The following official pages returned HTTP 200 and were read directly with Node fetch
on **2026-10-31**. Review is due **2026-11-07 00:00 UTC**; at that instant the records
stop qualifying. Statements deliberately avoid model version names, prices, unlimited
usage claims and unverified performance comparisons.

| Canonical platform / product / tier | Verified claim and limitations | Official source |
| --- | --- | --- |
| `anthropic / claude / pro` | Pro includes Claude Code access. Supported locations and usage limits apply. Claude Console API usage is separate. | `https://support.claude.com/en/articles/8325606-what-is-the-pro-plan` |
| `google / gemini / pro` | Google AI Pro provides more Deep Research access in Gemini Apps. The page requires sign-in and age 18 or older for this feature. Availability and usage restrictions apply; generated research can be inaccurate. | `https://support.google.com/googleone/answer/14534406?hl=en` |
| `youtube / youtube / individual` | Full YouTube Premium supports offline video downloads and background playback in supported mobile apps when signed into the membership account. Content, device and location restrictions apply. This claim does not cover Premium Lite. | `https://support.google.com/youtube/answer/6308116?hl=en` |

Identity spellings follow `apps/api/src/standardization/identity-policy.ts`, including
the finite catalog entries `anthropic/claude`, `google/gemini`, and `youtube/youtube`.
The database resolver compares **canonical_platform**, **canonical_product**, and
**canonical_tier** exactly. Display names, platform groups, aliases and substring
matches are not identities. No deployment-specific numeric IDs are stored here.
Source-code identity support does not prove that a deployment currently has a public
listing. No live catalog database was consulted during source verification.

## Exports and caller responsibilities

- `CapabilityEvidence`: `id`, `identity`, `purposes`, `statement`, `sourceUrl`,
  `checkedAt`, `reviewAfter`.
- `ASSISTANT_CAPABILITIES`: the bounded curated records for prompting.
- `selectCapabilities(purpose, now)`: current records whose explicit purpose terms
  match; never falls back to a popular product. English terms match word boundaries.
- `capabilitySupportsPurpose(evidence, purpose, now)`: the same time and term check,
  also used by candidate filtering and fictional unit fixtures.
- `CatalogService.resolvePublicProductIdentity(identity)`: exactly one public
  canonical identity returns `PublicCatalogProduct`; zero or ambiguous public matches
  return null. The repository reuses the existing public visibility predicate.
  All three public metadata queries (`getProducts`, `getProduct`, identity resolution)
  return `platformGroup` from the same `catalogPlatformGroup()` SQL expression used
  by catalog filtering. It includes canonical family/product overrides for `other`,
  `email` and `ip`; display platform aliases alone cannot reconstruct it.
  Candidate group requests prefer this metadata, while exact platform requests use
  the raw display platform just like the catalog query. The parent service's platform
  browsing branch must load metadata with `getProduct` for its at most five product IDs
  rather than constructing metadata from `CatalogItem`. The type is optional for
  compatibility with older callers; when absent, the shared display-alias grouping
  helper is the fallback. It cannot recover canonical overrides, so production
  callers must preserve the SQL-computed field. This is an additive enumerable
  field in repository/service metadata; `CatalogController` must strip it from
  public HTTP responses to preserve the existing API shape.
- `AssistantCandidate`: `{ standardProduct, offer, capabilityEvidence }`.
- `selectCandidates(candidates, needs, now)`: filters, orders, deduplicates source
  offers by shop/product identity, and returns at most three.
- `candidateEvidence(candidate)`: `{ id, text }[]` containing scoped price,
  availability, actual tags, warranty notes and capability statements.
  IDs hash the candidate identity and complete fact, stay under 128 characters,
  and are stable when tags or capability records are reordered. Text is ready for
  verbatim display and stays under 240 characters. Sources and review dates remain
  in the capability records; rendered text contains no source URLs. Oversized or
  linked merchant text becomes an explicit request to check the complete detail,
  never a truncated promise. These IDs populate the explanation parser's whitelist.

The assistant service must resolve each selected capability identity through the public
resolver and associate only that identity's evidence with the resulting product.
`PublicCatalogProduct` intentionally exposes display metadata without canonical
fields, so the pure candidate selector cannot reconstruct or verify that association.
Query **at most five** resolved products and **twenty offers per product**, using
`getCatalog({ standardProductId, currency, detailKind: 'offers',
detailPage: 0, detailPageSize: 20, offerSort: 'price' })`. Use detail entries, since
preview offers collapse shop winners and can omit an eligible SKU.
Report this bounded coverage instead of claiming a catalog-wide best price.
The selector does not silently truncate an arbitrary input list before eligibility
checks; query bounds belong to the service that performs retrieval.

Both price and inventory expiry must be strictly later than `now`. Verified price,
nonstale inventory, current stock, explicit currency and settlement quantity one
are required. Explicit bulk minimum tags also disqualify an offer. Money comparison
uses integer cents. All hard tags and warranty days must come from the same offer;
conflicting values are unknown. Monthly budgets require exactly `duration=1 month`.
There is no exchange-rate conversion or annual-price division.

Preferences apply in their given order. Known warranty days outrank unknown days;
explicit warranty denial cannot supply warranty days. Price ordering groups by
currency and known duration before comparing amounts, so unrelated payment scopes
are never labeled cheaper. Unknown duration follows known duration and is not treated
as a zero-length subscription. Stable product/shop/source IDs break remaining ties.
`simple_setup` only reads an explicit nonnegative integer `setup_steps` tag; unknown,
malformed or conflicting counts rank after known counts. No step count is inferred
from delivery, verification or account tags. The canonical tag policy currently does
not publish `setup_steps`, so current real offers remain tied on that preference.
If operation counts are introduced later, coordinate that tag-policy addition with
its owner; the assistant does not change the shared policy.

Purpose matching is a bounded vocabulary lookup, not semantic understanding. It does
not interpret negation, suitability, geographic eligibility or multiple simultaneous
goals. The understanding/service layer must clarify those cases. Unsupported purposes,
expired evidence and unresolved identities remain unknown. Provider functionality does
not establish that a merchant's shared account or particular region includes access.
Show source limitations, warranty scope and exclusion tags rather than promising access
or coverage from a day count alone.

Run the selector again after explanation generation using a fresh clock, and re-read
public products and offers before assembling the final reply. Selection alone cannot
detect a listing disabled after retrieval. Evidence text is untrusted data for the
model; evidence IDs scope attribution, not execution or safety. The assistant explanation
validator remains responsible for rejecting invented claims and links.
It should select at most four reason and four caveat facts, with at most eight distinct
evidence IDs per card. Card title truncation to 240 characters belongs to assembly in
the assistant service; the candidate selector does not alter the catalog product title.

## Validation

Unit fixtures describe fictional products and use reserved `.invalid` addresses.
They cover offer qualification, same-offer requirements, monthly budgets, preference
order, unknown facts, expiry boundaries, deduplication and evidence scope.

`apps/api/test/assistant-catalog.integration-spec.ts` requires `TEST_DATABASE_URL`.
It creates and removes a unique schema, runs the real migrations, and checks public
identity boundaries and same-SKU warranty/budget behavior. With no explicit test URL
the suite skips; it never connects through the configured production `DATABASE_URL`.
