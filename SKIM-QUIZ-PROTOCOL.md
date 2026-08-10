# Skim Quiz Protocol — v1

A standard for embedding interactive choice quizzes inside any Markdown file.
Quizzes are **invisible in every Markdown renderer** (GitHub, VS Code, Obsidian,
Skim's own reading view, `cat`) because they live in HTML comments. A viewer
that understands the protocol — such as the Skim browser extension — offers to
render them on demand.

This document is written for both humans and AI agents. If you are an agent
asked to "add a quiz" to a Markdown file, follow it exactly.

## Embedding

Place one HTML comment per quiz, anywhere in the file (end of file is
conventional). The comment starts with the marker `SKIM-QUIZ` followed by one
JSON object:

```markdown
<!-- SKIM-QUIZ
{
  "skimQuiz": 1,
  "id": "compactness-basics",
  "title": "Compactness drill",
  "description": "CLASSIFY rows: closed, bounded, Weierstrass",
  "layout": "half",
  "questions": [
    {
      "q": "Which condition makes $\\{g \\le c\\}$ a **closed** set?",
      "choices": [
        "$g$ continuous and the inequality non-strict",
        "$g$ bounded",
        "$c > 0$",
        "The set is finite"
      ],
      "answer": 0,
      "hint": "Preimages of closed sets under continuous maps.",
      "explain": "A continuous $g$ pulls back the closed ray $(-\\infty, c]$ to a closed set."
    }
  ]
}
-->
```

A file may contain **any number** of quiz comments. Renderers list them all and
let the reader pick.

## Rules that keep the quiz invisible and parseable

1. **Never write the three-character sequence `-->` inside the JSON** — it would
   terminate the comment early in every renderer. If a string needs it, escape a
   dash as `-` (e.g. `"a --> b"`). Arrows in prose are better written
   with `→` or `$\to$` anyway.
2. The JSON must be strict JSON: double quotes, no trailing commas, no comments.
3. LaTeX backslashes must be JSON-escaped: `$\le$` is written `"$\\le$"`.
4. Keep the opening line exactly `<!-- SKIM-QUIZ` (case-sensitive marker; the
   JSON starts on the same or next line).

## Schema

Top-level object:

| Field         | Type    | Required | Meaning |
|---------------|---------|----------|---------|
| `skimQuiz`    | number  | yes      | Protocol version. Always `1`. |
| `id`          | string  | no       | Stable key for score history (`[a-z0-9-]+`, unique within the file). Defaults to the quiz's position. |
| `title`       | string  | yes      | Shown in the quiz header and the picker. |
| `description` | string  | no       | One line shown in the picker so readers can choose between quizzes. |
| `layout`      | string  | no       | Initial presentation: `"half"` (side pane, 1/2 width), `"third"` (side pane, 1/3), or `"full"` (fullscreen). Default `"half"`. Readers can resize/convert freely. |
| `pass`        | number  | no       | Pass threshold in `0..1` (e.g. `0.7`). When present the score screen shows pass/fail. |
| `shuffle`     | boolean | no       | Shuffle question order per attempt. Default `false`. Choice order is never shuffled (options like "All of the above" must stay last). |
| `questions`   | array   | yes      | 1 or more question objects. |

Question object:

| Field     | Type            | Required | Meaning |
|-----------|-----------------|----------|---------|
| `q`       | string          | yes      | The question. Markdown + inline/display LaTeX (`$...$`, `$$...$$`). |
| `choices` | array of string | yes      | 2–10 options, same formatting freedom. |
| `answer`  | number or array | yes      | 0-based index of the correct choice. An **array** of indices makes it a multi-select question (order irrelevant; the reader must match the set exactly). |
| `hint`    | string or array | no       | One hint, or an array of progressively stronger hints revealed one at a time. |
| `explain` | string          | no       | Shown next to the question in post-submit review. |

Unknown fields are ignored (forward compatibility). An invalid quiz (bad JSON,
missing required fields, out-of-range `answer`) is skipped by renderers and
reported to the page console — it never breaks the document.

## Content and direction

Question, choice, hint, and explanation strings are rendered as full Markdown
with LaTeX. Hebrew, English, and mixed-direction text all work: direction is
detected automatically per block, so never add manual RTL/LTR markers. Write
content in the language of the document.

## What a protocol-aware renderer does (Skim's behavior)

- A "Quiz" control appears on documents containing at least one valid quiz.
  One quiz opens directly; several open a picker showing each title,
  description, question count, and the reader's best score / attempts.
- The quiz renders in a resizable side pane (or fullscreen, per `layout`) with
  a numbered question palette, colored by answered state; hints reveal on
  demand; submit produces a score plus a review of missed questions with
  explanations; attempts can be retried.
- Browser Back closes the quiz (or steps back through visited questions
  first); Forward reopens it.
- Scores are stored locally per file and quiz `id` — stable `id`s keep
  history across file edits.

## Authoring checklist (for agents)

- [ ] One `<!-- SKIM-QUIZ ... -->` comment per quiz; strict JSON inside.
- [ ] `skimQuiz: 1`, non-empty `title`, `description` that distinguishes the quiz.
- [ ] Stable, kebab-case `id`, unique within the file.
- [ ] Every `answer` index exists in its `choices`; arrays only for genuine multi-select.
- [ ] LaTeX backslashes doubled for JSON; no literal `-->` anywhere in the JSON.
- [ ] Hints escalate; `explain` teaches, not just restates the answer.
- [ ] Quiz language matches the document language (Hebrew content in Hebrew).
- [ ] Verify the file still renders normally in a plain Markdown preview (the quiz must be invisible).
