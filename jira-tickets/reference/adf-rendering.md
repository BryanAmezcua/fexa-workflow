# ADF → Markdown rendering rules

Jira descriptions and comment bodies arrive as Atlassian Document Format (ADF) — a
structured JSON tree, not markdown. Walk the tree and convert:

| ADF node | Markdown output |
|---|---|
| `paragraph` | text content, then a blank line |
| `heading` (level 1–6) | `#` / `##` / `###` matching the level |
| `bulletList` | `-` items; walk each `listItem` for content |
| `orderedList` | `1.` items; walk each `listItem` for content |
| `codeBlock` | fenced code block; use `attrs.language` if present |
| `blockquote` | `>` prefix on each line |
| `rule` | `---` |
| `text` with `marks: [{type: 'strong'}]` | `**text**` |
| `text` with `marks: [{type: 'em'}]` | `*text*` |
| `text` with `marks: [{type: 'code'}]` | `` `text` `` |
| `text` with `marks: [{type: 'link', attrs:{href}}]` | `[text](href)` |
| `mention` | `@<attrs.text \|\| attrs.displayName>` |
| `inlineCard` / `blockCard` | `[<attrs.url>](<attrs.url>)` |
| `media`, `mediaSingle`, `mediaGroup` | `[attachment: <attrs.alt \|\| 'image'>]` (placeholder) |
| Anything else | walk children, ignore the wrapper |

Preserve acceptance-criteria wording exactly — including quotes, em-dashes, and
typos. The AC text is load-bearing downstream (QA constants must match verbatim).
