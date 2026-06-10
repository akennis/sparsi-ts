/**
 * Boolean op catalog: not / and / or.
 *
 * The `*Description` constants are the user-facing op docs.
 */

export const BoolNotOpDescription =
  "BoolNotOp: logical NOT. Input: Value *bool. Output: Result bool.";
export const BoolAndOpDescription =
  "BoolAndOp: logical AND. Inputs: A *bool, B *bool. Output: Result bool.";
export const BoolOrOpDescription =
  "BoolOrOp: logical OR. Inputs: A *bool, B *bool. Output: Result bool.";

export const boolNot = (value: boolean): boolean => !value;
export const boolAnd = (a: boolean, b: boolean): boolean => a && b;
export const boolOr = (a: boolean, b: boolean): boolean => a || b;
