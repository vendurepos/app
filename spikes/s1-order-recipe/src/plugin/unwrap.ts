import { isGraphQlErrorResult } from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';

export class BusinessRejection extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function unwrap<T>(result: T): Exclude<T, GraphQLErrorResult> {
  if (isGraphQlErrorResult(result)) {
    const error = result as GraphQLErrorResult;
    throw new BusinessRejection(error.errorCode, error.message);
  }
  return result as Exclude<T, GraphQLErrorResult>;
}
