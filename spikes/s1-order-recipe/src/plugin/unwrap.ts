import { isGraphQlErrorResult } from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';

export function unwrap<T>(result: T): Exclude<T, GraphQLErrorResult> {
  if (isGraphQlErrorResult(result)) throw result;
  return result as Exclude<T, GraphQLErrorResult>;
}
