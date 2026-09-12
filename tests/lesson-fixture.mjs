// Synthetic source-grounded teaching for integration fixtures. These helpers use
// the production save/commit path so summaries cannot stand in for a lesson.
export function saveFixtureLesson(lesson, book, record, options = {}) {
  const learn = Array.isArray(record.objectives);
  if (learn) record.objectiveChecks ??= record.objectives.map(objective => ({ objective, checks: [...record.requiredChecks] }));
  const objectives = learn ? [...record.objectives] : [];
  const keyPoints = [...record.keyPoints];
  const sourcePages = options.sourcePages || [learn ? record.startPage : book.chapters.flatMap(chapter => chapter.sections).find(section => record.scope.sectionIds.includes(section.id))?.startPage || 1];
  lesson.saveLesson(record, book, {
    id: options.id || "fixture-explanation",
    title: options.title || "Interpreting the source model",
    markdown: options.markdown || "### Interpreting the source model\n\nA model connects an input to an observable result. Start by identifying what changes, then use the relation stated on the cited source page to predict which output changes.\n\nThe input represents the cause and the output represents the measured effect. To justify a prediction, state the relation and explain how the changed input affects that relation; a result without that connection does not show the reasoning.",
    objectives, keyPoints, sourcePages,
  });
  if (learn) {
    record.coveredObjectives = [...objectives];
    if (options.commit !== false) lesson.commitLesson(record, book);
  }
  return record;
}
