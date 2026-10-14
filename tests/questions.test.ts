import { test } from "node:test";
import assert from "node:assert/strict";
import { questionAnswers } from "../src/renderer/questions.ts";

test("multiple offered choices remain an offered answer rather than custom text", () => {
  const result = questionAnswers(
    [
      {
        question: "Which checks?",
        multiSelect: true,
        options: [{ label: "Build" }, { label: "Tests" }],
      },
    ],
    { 0: ["Build", "Tests"] },
    {},
  );
  assert.deepEqual(result, [
    { question: "Which checks?", answer: "Build, Tests", isOther: false },
  ]);
});
test("typed answers preserve custom intent even when the text matches an option", () => {
  const questions = [
    {
      question: "Which check?",
      options: [{ label: "Build" }, { label: "Tests" }],
    },
  ];
  assert.equal(questionAnswers(questions, {}, { 0: "Build" })[0].isOther, true);
  assert.equal(
    questionAnswers(questions, { 0: ["Build", "Tests"] }, {})[0].answer,
    "Build",
  );
});
