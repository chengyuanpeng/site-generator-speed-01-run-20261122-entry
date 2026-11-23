# site-generator-speed-01 — a faster drop-in for makefun-site 1.0.0

[![bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/chengyuanpeng/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/chengyuanpeng/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An entry for the make.fun bounty [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122):
answer every case exactly as make.fun's own makefun-site 1.0.0 answers it — the
same output tree (every page's `index.html`, the index and tag pages,
`build-report.txt` and each static file), byte for byte — and do it in less
CPU time than the reference.

## How it works

`solve.js` is a dependency-free ES module exporting `run(input)`. It follows
the reference build step for step — source ordering, template parsing,
front-matter refusals in their exact order and wording, permalinks,
Markdown, collections, tags, layouts and the report — but spends its CPU
differently:

- slugs and long dates are memoised, because titles, tag names and
  headings repeat across a site, and a pure-ASCII slug skips Unicode
  normalisation entirely;
- front matter is split by scanning for the closing fence first (the
  reference's refusal order), without splitting the whole body;
- Markdown renders in one pass over the lines, and inline text is
  escaped in whole runs between the few active characters instead of
  character by character;
- each page's card is built once and shared by the index, tag and
  recent lists;
- templates are compiled once into plain JavaScript functions, so
  rendering hundreds of pages through the same layouts is ordinary
  function calls rather than a tree walk (a tree-walking renderer is
  kept as a fallback).

`main.ts` is the harness driver: it reads `/input/cases.json`, answers each
case with `run`, and writes `/output/answers.json`.

## Layout

- `main.ts` — the driver the harness runs (`node main.ts`, Node 22)
- `solve.js` — the generator itself
- `LICENSE` — MIT
