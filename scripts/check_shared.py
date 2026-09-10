#!/usr/bin/env python3
"""
Guard the cross-project invariants CLAUDE.md declares but nothing enforced.

Three rules live here, and all three exist because the same arithmetic is
written twice in this repository:

  1. Files copied verbatim from front to mobile must still be verbatim.
  2. Files that deliberately diverge must be declared, so "we meant that" and
     "nobody noticed" cannot look the same.
  3. front/src/lib/money.ts and back/services/invoice_service.py implement the
     same money rules in two languages. Nothing can prove they agree, but a
     commit touching one and not the other is worth stopping.

── Why the pairs are listed here and not read out of the files ───────────────

Each copied file carries a header naming its own proof, e.g.

    diff <(tail -n +11 src/lib/weeklySummary.ts) ../front/src/lib/weeklySummary.ts

Scraping that offset out of the comment was the obvious design, and it is
wrong. While writing this check, a regex doing exactly that silently returned
nothing for weeklySummary.ts while working on its two neighbours — the file was
fine; the parser was not. A guard that reports "no banner, skipping" when it
fails to parse is a guard that passes forever, and it passes loudest at the
moment it is most needed.

So the manifest below is the authority. A file in it that cannot be read is a
failure, never a skip. The banner is still cross-checked, because a header that
disagrees with reality misleads the next reader.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# name -> lines of mobile-only header before the copied body starts.
# 1 means the whole file is byte-identical, header included.
COPIES: dict[str, int] = {
    "money.ts": 1,
    "taskPaste.ts": 1,
    "trackerName.ts": 1,
    "week.ts": 14,
    "weeklySummary.ts": 11,
    "regenerate.ts": 11,
}

# Present in both, deliberately different. Listed so an undeclared shared file
# is caught below rather than assumed intentional.
DIVERGENT: set[str] = {"types.ts"}

BANNER = re.compile(r"tail -n \+(\d+)")
failures: list[str] = []
notes: list[str] = []


def check_copies() -> None:
    for name, offset in COPIES.items():
        front = ROOT / "front" / "src" / "lib" / name
        mobile = ROOT / "mobile" / "src" / "lib" / name

        # Missing is a failure, not a skip: a copied file that disappeared is
        # exactly the drift this exists to catch.
        for p in (front, mobile):
            if not p.is_file():
                failures.append(f"{name}: declared as a shared copy but {p.relative_to(ROOT)} is missing")
                break
        else:
            body = mobile.read_text().splitlines(keepends=True)[offset - 1 :]
            if "".join(body) != front.read_text():
                failures.append(
                    f"{name}: mobile copy has drifted from front\n"
                    f"      diff <(tail -n +{offset} mobile/src/lib/{name}) front/src/lib/{name}"
                )
                continue

            # The header is documentation for humans; if it lies, say so.
            if offset > 1:
                head = "".join(mobile.read_text().splitlines(keepends=True)[:offset])
                m = BANNER.search(head)
                if not m:
                    notes.append(f"{name}: no `tail -n +N` proof in the header (manifest says {offset})")
                elif int(m.group(1)) != offset:
                    failures.append(
                        f"{name}: header claims tail -n +{m.group(1)}, manifest says +{offset} — one is wrong"
                    )


def check_undeclared() -> None:
    """A file living in both lib dirs must be declared as copy or divergent."""
    front_lib = ROOT / "front" / "src" / "lib"
    mobile_lib = ROOT / "mobile" / "src" / "lib"
    if not front_lib.is_dir() or not mobile_lib.is_dir():
        failures.append("front/src/lib or mobile/src/lib is missing entirely")
        return
    shared = {p.name for p in front_lib.glob("*.ts")} & {p.name for p in mobile_lib.glob("*.ts")}
    for name in sorted(shared - set(COPIES) - DIVERGENT):
        failures.append(
            f"{name}: exists in front and mobile but is in neither COPIES nor DIVERGENT. "
            "Add it to one — silence is how a copy starts drifting."
        )


def check_money_pair(base: str | None, head: str) -> None:
    """
    money.ts and invoice_service.py must move together.

    Cannot be proved, only prompted. Skipped when there is no usable base — a
    first push or a force-push has nothing to compare against, and inventing a
    range there would fail every time rather than usefully.
    """
    if not base:
        notes.append("money-pair: no base commit to diff against, skipped")
        return
    try:
        out = subprocess.run(
            ["git", "diff", "--name-only", f"{base}..{head}"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.split()
    except subprocess.CalledProcessError:
        notes.append(f"money-pair: could not diff {base}..{head}, skipped")
        return

    ts = "front/src/lib/money.ts" in out
    py = "back/services/invoice_service.py" in out
    if ts != py:
        moved, still = ("money.ts", "invoice_service.py") if ts else ("invoice_service.py", "money.ts")
        failures.append(
            f"money-pair: {moved} changed but {still} did not.\n"
            "      These implement the same arithmetic in two languages (CLAUDE.md, Money rules).\n"
            "      Change both, or put [money-solo] in the commit message if this edit genuinely\n"
            "      does not affect the shared rules."
        )


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else None
    head = sys.argv[2] if len(sys.argv) > 2 else "HEAD"

    check_copies()
    check_undeclared()

    if base:
        msg = subprocess.run(
            ["git", "log", "-1", "--format=%B", head],
            cwd=ROOT, capture_output=True, text=True,
        ).stdout
        if "[money-solo]" in msg:
            notes.append("money-pair: waived by [money-solo] in the commit message")
        else:
            check_money_pair(base, head)

    for n in notes:
        print(f"note: {n}")
    if failures:
        print(f"\n{len(failures)} invariant failure(s):\n", file=sys.stderr)
        for f in failures:
            print(f"  ✗ {f}", file=sys.stderr)
        return 1

    print(f"ok: {len(COPIES)} shared copies verbatim, {len(DIVERGENT)} declared divergent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
