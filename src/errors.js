// Structured, aggregatable conversion errors with sheet!cell coordinates.

export class ConversionError extends Error {
  /** @param {Array<{message:string, location?:string}>} problems */
  constructor(problems, summary) {
    const list = Array.isArray(problems) ? problems : [problems];
    const msg =
      (summary ? `${summary}\n` : '') +
      list.map((p) => `  - ${p.location ? `[${p.location}] ` : ''}${p.message}`).join('\n');
    super(msg);
    this.name = 'ConversionError';
    this.problems = list;
  }
}

/** Collects problems and throws them together (fail-fast optional). */
export class ProblemCollector {
  constructor({ failFast = false } = {}) {
    this.problems = [];
    this.failFast = failFast;
  }
  add(message, location) {
    const problem = { message, location };
    this.problems.push(problem);
    if (this.failFast) throw new ConversionError([problem]);
    return this;
  }
  get hasErrors() {
    return this.problems.length > 0;
  }
  throwIfAny(summary) {
    if (this.hasErrors) throw new ConversionError(this.problems, summary);
  }
}
