// Skim Quiz Protocol v1 — parsing, validation, and scoring.
// The format itself is specified in SKIM-QUIZ-PROTOCOL.md (repo root, shipped
// with the extension). Quizzes live in `<!-- SKIM-QUIZ {json} -->` comments so
// they are invisible in every Markdown renderer; this module turns a raw
// Markdown source into normalized quiz objects the UI can trust blindly.
import { splitCode } from './render.js';

const QUIZ_MARKER = /<!--\s*SKIM-QUIZ\b([\s\S]*?)-->/g;
const LAYOUTS = new Set(['half', 'third', 'full']);

// Invalid quizzes are skipped, never fatal — a broken comment must not break
// the document. console.info (not warn/error) keeps authoring mistakes out of
// Chrome's extension-errors page while staying visible in the page console.
function skip(position, message) {
  try { console.info(`Skim quiz #${position} skipped: ${message}`); } catch { /* no console */ }
  return null;
}

function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.q !== 'string' || !raw.q.trim()) return null;
  const choices = Array.isArray(raw.choices) ? raw.choices : null;
  if (!choices || choices.length < 2 || choices.length > 10) return null;
  if (!choices.every((c) => typeof c === 'string' && c.trim())) return null;

  const inRange = (n) => Number.isInteger(n) && n >= 0 && n < choices.length;
  let answers;
  let multi;
  if (Array.isArray(raw.answer)) {
    if (!raw.answer.length || !raw.answer.every(inRange)) return null;
    answers = [...new Set(raw.answer)].sort((a, b) => a - b);
    multi = true;
  } else {
    if (!inRange(raw.answer)) return null;
    answers = [raw.answer];
    multi = false;
  }

  let hints = [];
  if (typeof raw.hint === 'string' && raw.hint.trim()) hints = [raw.hint];
  else if (Array.isArray(raw.hint)) hints = raw.hint.filter((h) => typeof h === 'string' && h.trim());

  return {
    q: raw.q,
    choices,
    answers,
    multi,
    hints,
    explain: typeof raw.explain === 'string' && raw.explain.trim() ? raw.explain : null,
  };
}

// One quiz comment body -> normalized quiz, or null when anything disqualifies
// it. `position` is the 1-based index of the comment in the document.
export function normalizeQuiz(jsonText, position) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    return skip(position, `invalid JSON (${e.message})`);
  }
  if (!data || typeof data !== 'object') return skip(position, 'not an object');
  if (data.skimQuiz !== 1) return skip(position, 'missing/unsupported "skimQuiz" version');
  if (typeof data.title !== 'string' || !data.title.trim()) return skip(position, 'missing "title"');
  if (!Array.isArray(data.questions) || !data.questions.length) return skip(position, 'missing "questions"');

  const questions = data.questions.map(normalizeQuestion);
  const bad = questions.indexOf(null);
  if (bad !== -1) return skip(position, `question ${bad + 1} is invalid`);

  return {
    id: typeof data.id === 'string' && /^[a-z0-9-]+$/.test(data.id) ? data.id : `quiz-${position}`,
    title: data.title.trim(),
    description: typeof data.description === 'string' ? data.description.trim() : '',
    layout: LAYOUTS.has(data.layout) ? data.layout : 'half',
    pass: typeof data.pass === 'number' && data.pass > 0 && data.pass <= 1 ? data.pass : null,
    shuffle: data.shuffle === true,
    questions,
  };
}

// All valid quizzes in a Markdown source, in document order. Code segments are
// excluded so protocol documentation (a quiz example inside a fence) does not
// count as a real quiz.
export function parseQuizzes(source) {
  const quizzes = [];
  let position = 0;
  for (const seg of splitCode(String(source ?? ''))) {
    if (seg.code) continue;
    QUIZ_MARKER.lastIndex = 0;
    let m;
    while ((m = QUIZ_MARKER.exec(seg.value))) {
      position++;
      const quiz = normalizeQuiz(m[1], position);
      if (quiz) quizzes.push(quiz);
    }
  }
  return quizzes;
}

// answers: per-question reader input — a choice index, an array of indices
// (multi-select), or null/undefined when unanswered.
export function scoreQuiz(quiz, answers) {
  const per = quiz.questions.map((question, i) => {
    const a = answers[i];
    const answered = Array.isArray(a) ? a.length > 0 : Number.isInteger(a);
    if (!answered) return { answered: false, correct: false };
    const got = (Array.isArray(a) ? [...new Set(a)] : [a]).sort((x, y) => x - y);
    const want = question.answers;
    const correct = got.length === want.length && got.every((v, j) => v === want[j]);
    return { answered: true, correct };
  });
  const correct = per.filter((p) => p.correct).length;
  return { correct, total: per.length, fraction: per.length ? correct / per.length : 0, per };
}
