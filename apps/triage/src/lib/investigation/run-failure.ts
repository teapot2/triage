// Why a run failed, in words a person reads: the incident's failure notice,
// the incidents list's headline and the sidebar's hover card. Safe to import
// in the browser.

// The error a run that ends without an accepted report records: out of
// steps, or the model stopped answering with text after its nudges with
// steps to spare (agent-loop.ts).
export function noReportError(steps: number, maxSteps: number): string {
  return steps >= maxSteps
    ? `No accepted report after ${steps} model steps`
    : `The model stopped without submitting a report after ${steps} steps`;
}

// What a failure means, as one plain title. `detail`, the raw error, only
// when it says something the title can't: an unrecognized failure, or the
// model's own message about why it refused.
export function explainFailure(error: string): { title: string; detail?: string } {
  if (/^Triage restarted/.test(error)) return { title: "The run stopped when Triage restarted" };
  if (/no accepted report/i.test(error)) return { title: "The agent ran out of steps before finishing its report" };
  if (/stopped without submitting a report/.test(error)) return { title: "The model stopped without submitting a report" };
  // The retrying fetch's and the run budget's sentences (lib/models).
  if (/ran past its .* limit|didn't answer within|didn't start its answer|stopped sending/.test(error)) {
    return { title: "The model didn't answer in time", detail: error };
  }
  if (/rate-limiting/.test(error)) return { title: "The model's API is rate-limiting this key", detail: error };
  if (/answered HTTP 5\d\d/.test(error)) return { title: "The model's API is overloaded", detail: error };
  if (/tool_choice|fetch|network|ECONN|reach|timed? ?out|HTTP \d|api key|unauthor/i.test(error)) {
    return { title: "Couldn't reach the model", detail: error };
  }
  return { title: "The investigation failed", detail: error };
}
