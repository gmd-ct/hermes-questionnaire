# hermes-questionnaire

A native questionnaire card for the **Hermes Desktop** app. Instead of generating
an HTML page, a browser round-trip and a paste-back, the assistant emits one
paragraph and the question round renders as a real form inside its own chat
message — the app's own buttons, checkboxes, text fields and theme.

```
::questionnaire{id="cnf-trading-name-1" data="eyJ0aXRsZSI6IkNOVyB0cmFkaW5nIG5hbWUi…"}
```

Answering it and pressing **Send to Hermes** submits the answers into that chat as
an ordinary user turn:

```
[questionnaire answers] id=cnf-trading-name-1 title=CNF trading name
{
  "answers": { "q1": "West Coast Developments", "q2": ["Yes", "Not yet"] },
  "notes": { "q2": "Prefer to borrow against the first build." },
  "unanswered": ["q5"]
}
```

## What it contributes

| Surface | What you get |
|---|---|
| Transcript directive `::questionnaire{…}` | the inline card: choices, multi-select, note fields, free text, progress, send/copy |
| Page + sidebar row **Questionnaires** | every round found in this window, plus a *Load a directive* box for rounds pasted from anywhere |
| Pop-out button on each card | the same form in a native modal, for long rounds |
| ⌘K command | *Questionnaires: open the board* |
| Status-bar chip | how many rounds are still unanswered; click to open the board |

## Install

Hermes Desktop → **Capabilities → Plugins → Install from Git**, with
`gmd-ct/hermes-questionnaire`, or use the one-click link (the app shows a
confirmation dialog and never auto-installs):

```
hermes://plugin/install?repo=gmd-ct/hermes-questionnaire&enable=1
```

Manual install (the desktop app's plugin root, on the machine running Electron —
not the backend):

```bash
git clone https://github.com/gmd-ct/hermes-questionnaire \
  ~/.hermes/desktop-plugins/hermes-questionnaire
```

The app watches that folder: the plugin loads within a few seconds and
hot-reloads on every save. If it does not appear, run ⌘K → **Reload desktop
plugins**. The folder name must equal the plugin `id` (`hermes-questionnaire`) —
the app enforces it.

## Emitting a round

Use the encoder — do not hand-write base64:

```bash
python3 scripts/questionnaire.py spec.json
cat spec.json | python3 scripts/questionnaire.py
python3 scripts/questionnaire.py --example        # a starter spec
python3 scripts/questionnaire.py --print-limits   # the parser limits it respects
```

Spec: only `questions[].id` and `questions[].q` are required.

```json
{
  "id": "cnf-trading-name-1",
  "title": "CNF trading name",
  "context": "One line of why this round matters.",
  "questions": [
    { "id": "q1", "q": "Which trading name should CNF market under?",
      "options": ["West Coast Developments", "CNF Developments", "Other"], "recommended": 0 },
    { "id": "q2", "q": "Which markets should it cover?", "options": ["WA", "National", "WA + overseas"], "multi": true },
    { "id": "q3", "q": "Anything else worth recording?", "long": true }
  ]
}
```

Paste the printed block into the reply **as-is**: one directive per line, a blank
line between parts. A directive only renders when it is a whole paragraph made of
a single line — that is the app's rule, not this plugin's.

Long rounds are chunked automatically (`part="1/3"`, `"2/3"`, …). Part 1 draws the
card, the rest render nothing, and the card shows *Assembling questionnaire 2/3…*
until every part has arrived. A 24-question round is ~10 parts; keep rounds around
10–25 questions so a round lands in one reply.

## How it behaves

- **Answers persist** per round (`ctx.storage`), so a hot reload, a scroll or a
  reopen keeps them. *Reopen* clears the sent flag to edit and resend.
- **Partial rounds are allowed** — send what is answered; the payload lists
  `unanswered` instead of inventing answers.
- **Fail-closed submission.** `host.composer.submit` is answered only by the
  mounted composer that owns the session. When nothing can receive it, the answer
  block goes to the clipboard and a toast says so — it never claims a write that
  did not land.
- **A round is untrusted model output.** Every field is validated and clamped
  before it renders; a malformed payload shows a small failure card instead of
  throwing. The directive stays plain text when the plugin is disabled.
- No hardcoded colours: structure is injected CSS using `--ui-*` / `--chrome-*`
  theme variables, so the card repaints with every theme.

## Verification

```bash
npm install      # react + react-dom + jsdom, for the harness only
npm run verify   # 17 checks
```

`tests/run.mjs` stands the app up in miniature (jsdom + real React + a stub SDK)
and exercises directive parsing, chunk assembly, the form's answer state, the
submitted payload, persistence across a reload, the clipboard fallback, the page,
the chip and the ⌘K command — and checks every emitted directive against the
app's own `DIRECTIVE_RE`/`ATTR_RE` read straight out of
`apps/desktop/src/lib/transcript-directives.ts`.

It cannot prove the app's own components render it, or that Electron loads it.
Only the desktop app can prove that.

## Layout

```
plugin.js                  the plugin (single ESM file, no build step)
scripts/questionnaire.py   spec → directive encoder (stdlib only)
tests/run.mjs              offline verification harness
tests/sdk-stub.js          stand-in for @hermes/plugin-sdk, harness only
```
