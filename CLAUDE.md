# PDF Rendering Engine - replacing PDF.js plugin

## Context
This is a research project.

### Goal
Investigate the possibility / viability of replacing upstream dependencies of a
downstream software with an AI-generated bespoke implementation to eliminate inherited
vulnerabilities.

### Case Study Details
* **Upstream dependency**: PDF.js plugin
* **Downstream software**: gogs

### Hard Constraints
* The bespoke implementation should only contain in-house code and logic
* The bespoke implementation should not use logic on functions from outside the
repository (no external imports to implement the custom PDF.js library)
* Testing should use different PDF corpus to cover all equivalent classes of test cases.
  - PDF corpus will reside in `tests/corpus/`.
  - PDF corpus covers the following cases:
    1. text-only.pdf: basic rendering, font handling
    2. images.pdf: Raster image rendering
    3. mixed.pdf: Text + images + basic layout
    4. links.pdf: External links (should not auto-follow)
    5. poc.pdf: security gate - safely handle malformed inputs.
    6. malformed.pdf: negative test case - corrupted/truncated malformed, must not crash.
* The bespoke implementation should meet all functional requirements of gogs
  - Passing all unit, integration, regression, and interaction tests.
* The bespoke implementation should meet all security requirements
  - It should safely handle all PDFs in the test corpus including malformed inputs

### PDF Render path in Gogs
1. `/src/*`` routes to repo.Home via `internal/cmd/web.go:610`.
2. `repo.Home` resolves the tree entry, then calls `renderFile` for files at `internal/route/repo/view.go:269`.
3. `renderFile` sets `RawFileLink` to `RepoLink + "/raw/" + branch + tree` path at `internal/route/repo/view.go:135`.
4. If blob bytes sniff as PDF, it sets `c.Data["IsPDFFile"] = true` at `internal/route/repo/view.go:204`.
5. The template checks `.IsPDFFile` and emits an `iframe` using bundled PDF.js at `templates/repo/view_file.tmpl:83`:

```
<iframe width="100%" height="600px" src="{{AppSubURL}}/plugins/pdfjs-1.4.20/web/viewer.html?file={{EscapePound $.RawFileLink}}"></iframe>
```

`AppSubURL` is the configured application subpath, returned from `conf.Server.Subpath` at `internal/template/template.go:55`,
and it prefixes the static PDF.js viewer location. The actual PDF URL passed to PDF.js is `$.RawFileLink`,
e.g. `/<user>/<repo>/raw/<branch>/<path>.pdf`.

That raw link is handled separately: `/raw/*` routes to `repo.SingleDownload` at `internal/cmd/web.go:611`. `SingleDownload`
loads the blob and writes the bytes in `internal/route/repo/download.go:51`. For PDFs, `serveData` treats them as
non-text and non-image, so it sets `Content-Disposition: attachment` and writes the raw bytes at
`internal/route/repo/download.go:27`.

### Environment
* Gogs version: **0.13.2**
* Vulnerable file location: `public/plugins/pdfjs-1.4.20/`
* Replacement target path: `public/plugins/custom-pdf-render/`
* Test environment: `Docker (gogs/gogs:0.13.2)`

## Workflow
1. Analysis / Planning Phase - An analysis agent that:
    - performs feature mapping of how PDF.js is used in Gogs.
    - identifies functional requirements and features that should be implemented in custom
  pdf renderer to replace pdf.js' functional role in Gogs.
    - plans the development and implementation phases for the custom pdf renderer.
    - outputs: `agents-memory/analyzer/analysis.md` that details the implementer phase
  structure, component breakdown, and agent sequence.

2. Implementation Phase (sequential) - multiple implementer agents that:
    - Read `agents-memory/analyzer/analysis.md` before starting
    - Read the previous agent's handoff at `agents-memory/handoffs/<agent-name>.md`
    - Implement their assigned phase
    - Write a handoff to `agents-memory/handoffs/<agent-name>.md` before terminating
    - Run tests against `tests/corpus/` before considering their phase complete

3. Final Integration Testing - An integration testing agent that performs:
    - Regression tests on real PDFs
    - Security Fuzzing

4. Manual Intervention
    - Manual vulnerability review
    - Static analysis
    - Performance and correctness verification

## Expected Output
* A self-contained directory `public/plugins/custom-pdf-render/`.
* Must contain a `web/viewer.html` entry point accepting a `?file=` query parameter
* Must be servable as static files — no server-side runtime dependencies
* The iframe in `templates/repo/view_file.tmpl` should require only a path change
  from `pdfjs-1.4.20` to `pdfjs-bespoke` to use the replacement


## Code exploration — prefer `ast-outline` over full reads

For `.cs`, `.cpp`, `.cc`, `.cxx`, `.h`, `.hpp`, `.hh`, `.py`, `.pyi`,
`.ts`, `.tsx`, `.js`, `.jsx`, `.java`, `.kt`, `.kts`, `.scala`, `.sc`,
`.go`, `.rs`, `.php`, `.phtml`, `.rb`, `.rake`, `.gemspec`, `.lua`,
`.swift`, `.css`, `.scss`, `.sql`, `.html`, `.htm`, `.md`, and
`.yaml`/`.yml` files, read structure with `ast-outline` before opening
full contents.

Pick the smallest of these that answers your question — they're a
broad-to-narrow menu, not a sequence; skip straight to `show` when
you already know the symbol:

1. **Unfamiliar directory** — `ast-outline digest <paths…>`: one-page map
   of every file's types and public methods. Each file is tagged with a
   size label — `[tiny]` / `[medium]` / `[large]` / `[huge]` — plus
   `[broken]` when parse errors may have left the outline partial.
   `[huge]` files (≥100k tokens) collapse to header-only in the digest;
   call `ast-outline outline <path>` on them when you need full structure.
   Tune density with `--format=names|compact|default|wide` (alias
   `--oneline`=`names`) — `wide` adds private members and fields.

2. **File-level shape** — `ast-outline <paths…>`: signatures with line
   ranges, no bodies (2–10× smaller than a full read on non-trivial
   files). A `# WARNING: N parse errors` line in the header means the
   outline is partial — read the source for the affected region.

3. **One method, type, markdown heading, or yaml key** —
   `ast-outline show <file> <Symbol>`. Suffix matching: `TakeDamage`
   for one method; `User` for an entire type — class, struct, interface,
   trait, enum (whole body, useful when a file holds several types);
   `Player.TakeDamage` when ambiguous. Multiple at once:
   `ast-outline show Player.cs TakeDamage Heal Die`.
   For markdown, the symbol is heading text and matching is
   case-insensitive substring — `"installation"` finds
   `"2.1 Installation (macOS / Linux)"`. For yaml, the symbol is a
   dotted key path (`spec.containers[0].image`) — `show` matches keys,
   not values, so for free-text search inside values use `grep`.
   For css/scss, the symbol is a selector token (`.btn-primary`,
   `$var`) — pseudos and attribute filters are stripped, so
   `.btn-primary` finds the rule even when it carries `:hover` or
   nests in `.modal`.
   For html, the symbol is a CSS-selector token (`#hero`, `.site-nav`,
   `form`, `section#hero`, `[rel=stylesheet]`) — same vocabulary as
   css/scss; pseudo-classes and descendant combinators aren't
   supported (use the tag/id/class/attribute form the outline shows).
   For sql, the symbol is a table or column name (`users`,
   `users.email`) — `show users` returns the table definition,
   `show users.email` returns one column line.
   Add `--signature` to `show` (only there) to return header only
   (docs + attrs + signature, no body) — useful after `digest`, when
   you have the name and want the contract, not the implementation.

4. **Where a symbol appears** —
   `ast-outline grep <pattern> <paths…>`: matches grouped by enclosing
   class/function. Definitions are tagged `[def]`, imports `[import]`;
   calls and refs carry no tag (inferable from `(` after symbol).
   Use for "where is X defined", "who calls Y", "is Z dead code" —
   scope in the output spares follow-up reads. Comments and strings
   filtered. Batch via repeatable `-e`:
   `ast-outline grep User.save -e User.load -e User.delete src/`.
   Narrow by classification with `--kind def|call|ref|import` (also
   accepts `--kind def,call`) — drops the post-filter step when you
   only want definitions, only call sites, etc.
   POSIX flags `-w` (whole word), `-l` (paths only), `-c` (counts),
   `-m N` (cap per file) work as in `grep` / `rg`. For non-symbol
   patterns use your default search strategy.

`outline` and `digest` accept multiple paths in one call (files and
directories, mixed languages OK) — batch instead of looping. Type
headers in both renderers carry inheritance as `: Base, Trait`, so the
shape of class hierarchies is visible without a separate query.

Narrow the walk with repeatable `--exclude <glob>`
(`.gitignore`-syntax, anchored at the project root) on `outline` /
`digest` / `grep` — e.g. `--exclude tests/ --exclude '*.gen.*'` to
skip test trees and generated files in one call. `!pattern` negates;
`.gitignore` is still honored by default — `--exclude` adds to it.

When you need to know **what a file pulls in** or **where a referenced
type / function comes from**, add `--imports` to `outline` or `digest`.
The file header gets an `imports:` line listing every
`import` / `use` / `using` statement verbatim in the language's native
syntax — `from .core import X`, `use foo::Bar`,
`import { X } from './foo'`, `use App\Foo`, `require_once 'config.php'`,
`require "json"`.
Read the imports, then call `outline` / `show` on the source file
instead of grepping for the definition. Skip the flag for routine
structure reads — it adds one line per file.

A trailing `[+ N conditional includes]` on the imports line means
N more dependencies live inside `if` / `try` / loop / function bodies
— read the file directly when you need the full dependency picture.

Fall back to a full read only when you need context beyond the body
`show` returned. `ast-outline help` for flags.

## Project-Specific File Reading Rules

The following files must never be read in full under any circumstances —
use `ast-outline` or `ast-outline show <symbol>` only:

* `public/plugins/pdfjs-1.4.20/build/pdf.js`
* `public/plugins/pdfjs-1.4.20/build/pdf.worker.js`
* `public/plugins/pdfjs-1.4.20/web/viewer.js`

These are minified build artifacts. Their internals are not relevant
to this project. Read `viewer.html` and `viewer.js` in full if needed —
they are small and contain the relevant integration surface.
