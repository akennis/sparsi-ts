/**
 * Boolean op catalog: not / and / or.
 *
 * The `*Description` constants are the user-facing op docs.
 */

export const BoolNotOpDescription =
  "BoolNotOp: logical NOT. Input: Value boolean. Output: Result boolean.";
export const BoolAndOpDescription =
  "BoolAndOp: logical AND. Inputs: A boolean, B boolean. Output: Result boolean.";
export const BoolOrOpDescription =
  "BoolOrOp: logical OR. Inputs: A boolean, B boolean. Output: Result boolean.";

export const boolNot = (value: boolean): boolean => !value;
export const boolAnd = (a: boolean, b: boolean): boolean => a && b;
export const boolOr = (a: boolean, b: boolean): boolean => a || b;
