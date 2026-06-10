/**
 * Aggregates the catalog op descriptions into one formatted string, organized by
 * group. The AI, Retrieval, and MCP groups are contributed by their respective
 * modules (ai/, rag/, mcp/), which are REQUIRED dependencies — they are imported
 * unconditionally below, so this aggregator (and index.ts's allDescriptions) hard-
 * depends on them.
 *
 * The numeric op groups are collapsed under a single `number` type — there are no
 * separate int/float "Math", "Predicate", or select/default groups, because JS has
 * one numeric type.
 */

import * as num from "./num";
import * as text from "./text";
import * as bool from "./bool";
import * as predicate from "./predicate";
import * as select from "./select";
import * as slice from "./slice";
import * as time from "./time";
import * as io from "./io";
import * as json from "./json";
import * as ai from "../ai";
import * as rag from "../rag";
import * as mcp from "../mcp";

interface DescriptionGroup {
  header: string;
  descs: string[];
}

/** The deterministic op groups, in catalog order. */
export const descriptionGroups: DescriptionGroup[] = [
  {
    header: "## Math",
    descs: [
      num.AddOpDescription,
      num.SubOpDescription,
      num.MulOpDescription,
      num.DivOpDescription,
      num.PowOpDescription,
      num.ModOpDescription,
      num.RoundOpDescription,
      num.ClampOpDescription,
      num.TruncOpDescription,
      num.SumOpDescription,
      num.MinOpDescription,
      num.MaxOpDescription,
      num.PackMathOperandsOpDescription,
    ],
  },
  {
    header: "## String — cast",
    descs: [
      text.NumberToStringOpDescription,
      text.BoolToStringOpDescription,
      text.ToStringOpDescription,
    ],
  },
  {
    header: "## String",
    descs: [
      text.StringLookupOpDescription,
      text.StringToLowerOpDescription,
      text.StringConcatOpDescription,
      text.StringSplitOpDescription,
      text.RegexMatchOpDescription,
      text.RegexExtractOpDescription,
    ],
  },
  {
    header: "## Bool",
    descs: [
      bool.BoolNotOpDescription,
      bool.BoolAndOpDescription,
      bool.BoolOrOpDescription,
    ],
  },
  {
    header: "## Predicate — numeric",
    descs: [
      predicate.IfGtOpDescription,
      predicate.IfLtOpDescription,
      predicate.IfEqOpDescription,
      predicate.IfGeOpDescription,
      predicate.IfLeOpDescription,
    ],
  },
  {
    header: "## Predicate — string",
    descs: [
      predicate.IfStringContainsOpDescription,
      predicate.IfStringHasPrefixOpDescription,
      predicate.IfStringHasSuffixOpDescription,
      predicate.IfStringRegexMatchOpDescription,
      predicate.IfStringEqOpDescription,
    ],
  },
  {
    header: "## Predicate — empty / range",
    descs: [
      predicate.IfEmptyStringOpDescription,
      predicate.IfEmptySliceStringOpDescription,
      predicate.IfEmptySliceNumberOpDescription,
      predicate.BetweenOpDescription,
    ],
  },
  {
    header: "## Select / Switch / Default",
    descs: [
      select.SelectStringOpDescription,
      select.SelectNumberOpDescription,
      select.SelectBoolOpDescription,
      select.SwitchStringOpDescription,
      select.DefaultStringOpDescription,
      select.DefaultNumberOpDescription,
    ],
  },
  {
    header: "## Slice",
    descs: [
      slice.SliceLenOpDescription,
      slice.SliceAtOpDescription,
      slice.SliceFirstOpDescription,
      slice.SliceLastOpDescription,
      slice.SliceContainsOpDescription,
      slice.SliceJoinOpDescription,
      slice.SliceFilterEqOpDescription,
      slice.SliceTopKOpDescription,
    ],
  },
  {
    header: "## Retrieval",
    descs: [
      rag.RetrieveOpDescription,
      rag.RetrieveWithFiltersOpDescription,
      rag.ValidateCitationsOpDescription,
    ],
  },
  {
    header: "## AI",
    descs: [
      ai.ModeSelectOpDescription,
      ai.AIComputeStringToStringOpDescription,
      ai.AIComputeMathOperandsToFloat64OpDescription,
      ai.AIExtractStringSliceOpDescription,
      ai.AIExtractMapOpDescription,
      ai.AIParseNumberOpDescription,
      ai.AISummarizeOpDescription,
      ai.AIClassifyMultiLabelOpDescription,
      ai.AIScoreOpDescription,
      ai.AIBoolOpDescription,
      ai.AIBestMatchOpDescription,
      ai.AIRerankOpDescription,
      ai.WithRepairDescription,
    ],
  },
  {
    header: "## Time",
    descs: [time.CityTimeOpDescription],
  },
  {
    header: "## IO",
    descs: [io.FileReadOpDescription, io.EnvOpDescription, io.HTTPGetOpDescription],
  },
  {
    header: "## JSON",
    descs: [json.JSONExtractOpDescription],
  },
  {
    header: "## MCP",
    descs: [mcp.MCPCallOpDescription, mcp.MCPScriptOpDescription],
  },
];

/** Renders the given groups in the catalog format. */
export function renderDescriptions(groups: DescriptionGroup[]): string {
  let out = "";
  groups.forEach((g, i) => {
    if (i > 0) out += "\n\n";
    out += g.header + "\n";
    for (const d of g.descs) out += d + "\n";
  });
  return out;
}

/** Formatted string listing all deterministic library op descriptions, by group. */
export const allDescriptions = (): string => renderDescriptions(descriptionGroups);
