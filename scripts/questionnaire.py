#!/usr/bin/env python3
"""Encode a questionnaire spec as ::questionnaire directives for Hermes Desktop.

The desktop plugin `hermes-questionnaire` renders those directives as a native
form inside the assistant's chat message. This script is the encoder: it
validates the spec, compacts it to JSON, base64urls it, and chunks it so every
emitted directive stays inside the transcript-directive parser's limits.

Usage
-----
    python3 question.py spec.json
    cat spec.json | python3 question.py
    python3 question.py --example          # print a starter spec, unchanged
    python3 question.py --print-limits     # what the chunker is respecting

Spec shape (only `questions[].id` and `questions[].q` are required):

    {
      "id": "cnf-trading-name-1",        # optional stable id; derived if omitted
      "title": "CNF trading name",
      "context": "One line of why this matters.",
      "questions": [
        {
          "id": "q1",
          "q": "Which trading name should CNF market under?",
          "detail": "Optional consequence line.",
          "options": ["Option A", "Option B"],   # omit for a free-text question
          "recommended": 1,                      # index into options
          "multi": false,                         # multi-select
          "note": true,                           # show a note field (default true)
          "long": false                           # multi-line free text
        }
      ]
    }

The output is a block of paragraphs separated by blank lines — one directive per
paragraph, because the parser only claims a directive that is a whole,
single-line paragraph. Paste the whole block into the chat reply, or hand it to
the desktop app's Questionnaires page ("Load a directive").
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sys

# The transcript-directive parser (apps/desktop/src/lib/transcript-directives.ts):
#   DIRECTIVE_RE = /^::([a-z][a-z0-9-]{0,63})(?:\{([^{}]{0,1024})\})?$/
#   trimmed.length > 1200  -> rejected;  a "\n" anywhere -> rejected
# So: one line, no braces inside the attr body, body <= 1024 chars.
BODY_LIMIT = 1024
DIRECTIVE_LIMIT = 1200
CHUNK_MAX = 900  # base64url chars per part, well inside BODY_LIMIT for short ids

OPTION_LIMIT = 12
OPTION_CHARS = 220
PROMPT_CHARS = 600


def _clean(value: object, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value if value is not None else "")).strip()
    return text[:limit]


def _die(message: str) -> None:
    print(f"questionnaire: {message}", file=sys.stderr)
    raise SystemExit(2)


def normalize(spec: object) -> dict:
    if not isinstance(spec, dict):
        _die("the spec must be a JSON object")

    raw_questions = spec.get("questions")
    if not isinstance(raw_questions, list) or not raw_questions:
        _die("the spec needs a non-empty 'questions' array")

    questions: list[dict] = []
    seen: set[str] = set()

    for index, entry in enumerate(raw_questions):
        if not isinstance(entry, dict):
            _die(f"questions[{index}] must be an object")

        qid = _clean(entry.get("id"), 64)
        prompt = _clean(entry.get("q") or entry.get("question"), PROMPT_CHARS)

        if not qid:
            _die(f"questions[{index}] needs an 'id'")
        if not prompt:
            _die(f"questions[{index}] ({qid}) needs 'q'")
        if qid in seen:
            _die(f"duplicate question id {qid!r}")
        seen.add(qid)

        options = entry.get("options") or []
        if options and not isinstance(options, list):
            _die(f"questions[{index}].options must be an array")
        options = [_clean(option, OPTION_CHARS) for option in options]
        options = [option for option in options if option][:OPTION_LIMIT]

        question: dict = {"id": qid, "q": prompt}

        detail = _clean(entry.get("detail"), 400)
        if detail:
            question["detail"] = detail
        if options:
            question["options"] = options
            recommended = entry.get("recommended")
            if isinstance(recommended, bool):
                recommended = 0 if recommended else None
            if isinstance(recommended, int) and 0 <= recommended < len(options):
                question["recommended"] = recommended
            if entry.get("multi"):
                question["multi"] = True
        else:
            question["freeText"] = True
        if entry.get("long"):
            question["long"] = True
        if entry.get("note") is False:
            question["note"] = False
        if entry.get("required"):
            question["required"] = True

        questions.append(question)

    out: dict = {}
    title = _clean(spec.get("title"), 200)
    context = _clean(spec.get("context"), 600)
    if title:
        out["title"] = title
    if context:
        out["context"] = context
    out["questions"] = questions
    return out


def encode_payload(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def derive_id(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return "q" + hashlib.sha1(raw).hexdigest()[:10]


def chunk(encoded: str, size: int) -> list[str]:
    return [encoded[i : i + size] for i in range(0, len(encoded), size)] or [""]


def render(form_id: str, body: str, index: int, total: int) -> str:
    part = f' part="{index}/{total}"' if total > 1 else ""
    directive = f'::questionnaire{{id="{form_id}"{part} data="{body}"}}'

    if len(directive) > DIRECTIVE_LIMIT:
        _die(f"the emitted directive is {len(directive)} chars (limit {DIRECTIVE_LIMIT}); shorten the content")
    if len(body) + len(form_id) + len(part) + 12 > BODY_LIMIT:
        _die("an attribute body overflowed the parser's 1024-char cap; lower CHUNK_MAX")

    return directive


def build(spec: dict) -> list[str]:
    payload = normalize(spec)
    encoded = encode_payload(payload)
    form_id = _clean(spec.get("id"), 64) or derive_id(payload)

    # Keep every attribute body inside the parser cap, with the id counted.
    budget = max(64, BODY_LIMIT - len(form_id) - 24)
    parts = chunk(encoded, min(CHUNK_MAX, budget))

    return [render(form_id, body, index + 1, len(parts)) for index, body in enumerate(parts)]


EXAMPLE = {
    "id": "example-1",
    "title": "Example round",
    "context": "One line of why these questions matter.",
    "questions": [
        {
            "id": "q1",
            "q": "Pick one of these.",
            "options": ["Recommended option", "Second option", "Third option"],
            "recommended": 0,
        },
        {
            "id": "q2",
            "q": "Pick any that apply.",
            "options": ["Alpha", "Beta", "Gamma"],
            "multi": True,
        },
        {"id": "q3", "q": "Anything else worth recording?", "long": True},
    ],
}


def main(argv: list[str]) -> int:
    args = [arg for arg in argv[1:] if arg != "--"]

    if "--print-limits" in args:
        print(
            json.dumps(
                {
                    "attr_body_limit": BODY_LIMIT,
                    "directive_limit": DIRECTIVE_LIMIT,
                    "chunk_max": CHUNK_MAX,
                    "note": "directives must be one line each, separated by a blank line",
                },
                indent=2,
            )
        )
        return 0

    if "--example" in args:
        print(json.dumps(EXAMPLE, indent=2))
        return 0

    positional = [arg for arg in args if not arg.startswith("-")]

    try:
        if positional:
            with open(positional[0], "r", encoding="utf-8") as handle:
                spec = json.load(handle)
        else:
            if sys.stdin.isatty():
                _die("give a spec file, pipe one on stdin, or pass --example")
            spec = json.load(sys.stdin)
    except FileNotFoundError:
        _die(f"no such spec file: {positional[0]}")
    except json.JSONDecodeError as error:
        _die(f"the spec is not valid JSON: {error}")

    directives = build(spec)
    print("\n\n".join(directives))

    if "-q" not in args and "--quiet" not in args:
        total_chars = sum(len(part) for part in directives)
        print(
            f"\n# {len(directives)} directive(s), {total_chars} chars of payload. "
            "Paste the block above as-is (one line per paragraph, blank line between).",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
