/**
 * #515: jsonb refuses the JSON escape of a lone UTF-16 surrogate, which JSON.stringify writes for a string cut mid-pair,
 * so one such stored string would 500 every read that casts its column. Our writers are JSON.stringify, which writes a
 * valid pair raw and never as escapes, so any surrogate escape in our text is a lone one: each real escape (its
 * backslash after an even run of backslashes, none included) reads as U+FFFD. An escaped valid pair from a foreign
 * writer reads as two U+FFFD, which is acceptable for the ids we read.
 */
const SURROGATE_ESCAPE = String.raw`'(?<=(?:^|[^\\])(?:\\\\)*)\\u[dD][89a-fA-F][0-9a-fA-F]{2}'`;

/** The SQL that reads a JSON text expression as jsonb, with every surrogate escape read as U+FFFD. */
export const jsonbOf = (expression: string): string =>
  `CAST(regexp_replace(${expression}, ${SURROGATE_ESCAPE}, '�', 'g') AS jsonb)`;
