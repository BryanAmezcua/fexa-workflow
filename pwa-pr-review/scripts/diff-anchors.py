#!/usr/bin/env python3
"""diff-anchors.py — Parse a unified diff into the set of lines GitHub will
accept as inline review-comment anchors.

GitHub's pulls/{n}/reviews API rejects the ENTIRE review (422) if any single
comment targets a line outside the diff hunks. So we build the legal set up
front and validate against it before posting.

Rules:
  RIGHT side — added ('+') and context (' ') lines, numbered in the new file.
  LEFT  side — removed ('-') and context (' ') lines, numbered in the old file.

Usage: diff-anchors.py < diff.patch > anchors.json
Output: {"<path>": {"RIGHT": [12, 13, 14], "LEFT": [9, 10]}, ...}
"""

import json
import re
import sys

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse(stream):
    files = {}
    path = None
    old_ln = new_ln = 0

    for raw in stream:
        line = raw.rstrip("\n")

        if line.startswith("diff --git "):
            path = None
            continue

        # +++ b/<path> is authoritative for the new-file path (handles renames).
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target == "/dev/null":
                path = None
            else:
                path = target[2:] if target.startswith(("a/", "b/")) else target
                files.setdefault(path, {"RIGHT": [], "LEFT": []})
            continue

        if line.startswith("--- "):
            continue

        m = HUNK.match(line)
        if m:
            old_ln = int(m.group(1))
            new_ln = int(m.group(3))
            continue

        if path is None or not line:
            continue

        head = line[0]
        if head == "+":
            files[path]["RIGHT"].append(new_ln)
            new_ln += 1
        elif head == "-":
            files[path]["LEFT"].append(old_ln)
            old_ln += 1
        elif head == " ":
            files[path]["RIGHT"].append(new_ln)
            files[path]["LEFT"].append(old_ln)
            new_ln += 1
            old_ln += 1
        # '\' (No newline at end of file) and anything else: ignore.

    return files


if __name__ == "__main__":
    json.dump(parse(sys.stdin), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
