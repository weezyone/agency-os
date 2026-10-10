# Domain Docs

This repository uses a single-context domain-documentation layout. The type-based folders under `src\`, such as `lib`, `repositories`, and `services`, are not separate domain contexts.

## Before exploring, read these

- **`GLOSSARY.md`** at the repository root: use its domain terms and definitions.
- **`docs\adr\`**: read architecture decision records relevant to the area you are about to work in.

If these files or directories do not exist, **proceed silently**. Do not flag their absence or suggest creating them upfront. `/domain-modeling`, reached through skills such as `/grill-with-docs` and `/improve-codebase-architecture`, creates them lazily when terms or decisions are actually resolved.

## File structure

```text
repository root
|-- GLOSSARY.md
|-- docs
|   `-- adr
|       `-- NNNN-decision-title.md
`-- src
```

This describes the convention; setup does not create empty glossary or ADR placeholders.

If the repository later adopts multiple domain contexts and adds a root `GLOSSARY-MAP.md`, follow that map to the relevant context glossaries. Read system-wide ADRs in `docs\adr\` and relevant context-specific ADRs in `src\<context>\docs\adr\`.

## Use the glossary's vocabulary

When naming a domain concept in an issue title, refactor proposal, hypothesis, or test, use the term defined in `GLOSSARY.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the proposed language matches the project. Note genuine terminology gaps for `/domain-modeling` rather than inventing competing definitions.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the decision and explain why it may need to be reconsidered. Do not silently override it.
