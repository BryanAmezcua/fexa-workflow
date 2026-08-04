#!/usr/bin/env python3
"""post-review.py — Validate findings against the diff and post one GitHub review.

Reads from the work dir produced by pr-context.sh:
    meta.json      (for headRefOid)
    anchors.json   (legal inline anchors)
    findings.json  (written by the skill, edited by the human)
    body.md        (review summary + AC table, written by the skill)

Writes payload.json into the work dir and, with --confirm, POSTs it as a single
review with event=COMMENT.

Any finding whose anchor is not a legal diff line is DEMOTED into the review
body rather than dropped — one bad anchor 422s the entire review.

Usage:
    post-review.py <work-dir>            # dry run: validate + write payload.json
    post-review.py <work-dir> --confirm  # actually post
"""

import json
import subprocess
import sys
from pathlib import Path

SEV_ORDER = {"blocker": 0, "should-fix": 1, "nit": 2}
SEV_LABEL = {"blocker": "Blockers", "should-fix": "Should fix", "nit": "Nits"}


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def load(work, name):
    p = work / name
    if not p.exists():
        die(f"missing {p}")
    text = p.read_text()
    return json.loads(text) if name.endswith(".json") else text


def comment_body(f):
    sev = f.get("severity", "should-fix")
    cat = f.get("category", "review")
    parts = [f"**[{sev} · {cat}]** {f.get('title', '').strip()}", "", f.get("body", "").strip()]
    if f.get("failure_scenario"):
        parts += ["", f"_Fails when:_ {f['failure_scenario'].strip()}"]
    if f.get("verdict") == "PLAUSIBLE":
        parts += ["", "_Not fully verified — flagging for your judgement._"]
    return "\n".join(parts).strip()


def legal(anchors, path, line, side="RIGHT"):
    return line is not None and line in set(anchors.get(path, {}).get(side, []))


def main():
    if len(sys.argv) < 2:
        die("usage: post-review.py <work-dir> [--confirm]")

    work = Path(sys.argv[1]).expanduser()
    confirm = "--confirm" in sys.argv[2:]
    if not work.is_dir():
        die(f"not a directory: {work}")

    meta = load(work, "meta.json")
    anchors = load(work, "anchors.json")
    findings = load(work, "findings.json")
    body_md = load(work, "body.md")

    if not isinstance(findings, list):
        die("findings.json must be a JSON array")

    findings = sorted(findings, key=lambda f: (SEV_ORDER.get(f.get("severity"), 9), f.get("path", "")))

    inline, demoted, body_only = [], [], []

    for f in findings:
        if not f.get("title") or not f.get("body"):
            die(f"finding {f.get('id', '?')} is missing title or body")
        if not f.get("failure_scenario"):
            die(f"finding {f.get('id', '?')} has no failure_scenario — drop it or justify it")

        path = f.get("path")
        line = f.get("line")
        start = f.get("start_line")

        if f.get("anchor") == "body" or line is None:
            body_only.append(f)
            continue

        if not legal(anchors, path, line) or (start is not None and not legal(anchors, path, start)):
            f["_demote_reason"] = f"line {start or line}{'-' + str(line) if start else ''} is not in the diff"
            demoted.append(f)
            continue

        c = {"path": path, "line": line, "side": "RIGHT", "body": comment_body(f)}
        if start is not None and start < line:
            c["start_line"] = start
            c["start_side"] = "RIGHT"
        inline.append(c)

    # ── assemble the review body ──────────────────────────────────────────────
    extra = body_only + demoted
    body = body_md.rstrip()
    if extra:
        body += f"\n\n### Not anchored to a line ({len(extra)})\n"
        for f in extra:
            note = f" — _{f['_demote_reason']}_" if f.get("_demote_reason") else ""
            loc = f.get("path") or "(no file)"
            if f.get("line"):
                loc += f":{f['line']}"
            body += f"\n**[{f.get('severity')} · {f.get('category')}]** `{loc}`{note}\n"
            body += f"{f.get('title', '').strip()}\n\n{f.get('body', '').strip()}\n"
            if f.get("failure_scenario"):
                body += f"\n_Fails when:_ {f['failure_scenario'].strip()}\n"

    payload = {
        "commit_id": meta["headRefOid"],
        "event": "COMMENT",
        "body": body,
        "comments": inline,
    }
    (work / "payload.json").write_text(json.dumps(payload, indent=2) + "\n")

    # ── report ────────────────────────────────────────────────────────────────
    counts = {}
    for f in findings:
        counts[f.get("severity", "?")] = counts.get(f.get("severity", "?"), 0) + 1
    summary = ", ".join(f"{v} {k}" for k, v in sorted(counts.items(), key=lambda kv: SEV_ORDER.get(kv[0], 9)))

    print(f"PR:       #{meta['number']} {meta['title']}")
    print(f"repo:     {meta['url'].split('/pull/')[0]}")
    print(f"head:     {meta['headRefOid'][:7]}")
    print(f"findings: {len(findings)}  ({summary or 'none'})")
    print(f"inline:   {len(inline)}")
    print(f"in body:  {len(extra)}  ({len(demoted)} demoted for being outside the diff)")
    for f in demoted:
        print(f"          ! {f.get('path')}:{f.get('line')} — {f['_demote_reason']}")
    print(f"payload:  {work / 'payload.json'}")

    if not confirm:
        print("\nDry run. Re-run with --confirm to post.")
        return

    repo = meta["url"].split("/pull/")[0].replace("https://github.com/", "")
    cmd = ["gh", "api", f"repos/{repo}/pulls/{meta['number']}/reviews",
           "--input", str(work / "payload.json")]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stdout, file=sys.stderr)
        die(f"post failed:\n{res.stderr.strip()}")
    posted = json.loads(res.stdout)
    print(f"\nPosted: {posted.get('html_url')}")


if __name__ == "__main__":
    main()
