export interface Question {
  question: string;
  multiSelect?: boolean;
  options: { label: string }[];
}

export function questionAnswers(
  questions: Question[],
  selected: Record<number, string[]>,
  custom: Record<number, string>,
): { question: string; answer: string; isOther: boolean }[] {
  return questions.map((question, index) => {
    if (custom[index]?.trim())
      return {
        question: question.question,
        answer: custom[index].trim(),
        isOther: true,
      };
    const offered = new Set(question.options.map((option) => option.label));
    const labels = (selected[index] || []).filter((label) =>
      offered.has(label),
    );
    return {
      question: question.question,
      answer: (question.multiSelect ? labels : labels.slice(0, 1)).join(", "),
      isOther: false,
    };
  });
}
