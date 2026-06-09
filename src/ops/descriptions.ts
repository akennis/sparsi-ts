/**
 * Faithful port of sparsi-go library/descriptions.go `AllDescriptions()`.
 *
 * Returns a formatted string listing all library op descriptions, organized by
 * group, in the exact order and format the Go library emits. The AI, Retrieval,
 * and MCP groups are contributed by their respective modules (ai/, rag/, mcp/)
 * and are spliced in at their Go positions once those modules are present.
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

/** The deterministic op groups, in the exact order Go's AllDescriptions lists them. */
export const descriptionGroups: DescriptionGroup[] = [
  {
    header: "## Math — float",
    descs: [
      num.AddFloatOpDescription,
      num.SubFloatOpDescription,
      num.MulFloatOpDescription,
      num.DivFloatOpDescription,
      num.PowFloatOpDescription,
      num.ModFloatOpDescription,
      num.RoundOpDescription,
      num.ClampFloatOpDescription,
      num.SumFloatOpDescription,
      num.MinFloatOpDescription,
      num.MaxFloatOpDescription,
      num.PackMathOperandsOpDescription,
    ],
  },
  {
    header: "## Math — int",
    descs: [
      num.AddIntOpDescription,
      num.SubIntOpDescription,
      num.MulIntOpDescription,
      num.DivIntOpDescription,
      num.PowIntOpDescription,
      num.ModIntOpDescription,
      num.SumIntOpDescription,
      num.ClampIntOpDescription,
      num.MinIntOpDescription,
      num.MaxIntOpDescription,
    ],
  },
  {
    header: "## Math — cast",
    descs: [num.IntToFloat64OpDescription, num.Float64ToIntOpDescription],
  },
  {
    header: "## String — cast",
    descs: [
      text.Float64ToStringOpDescription,
      text.IntToStringOpDescription,
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
    header: "## Predicate — float",
    descs: [
      predicate.IfFloatGtOpDescription,
      predicate.IfFloatLtOpDescription,
      predicate.IfFloatEqOpDescription,
      predicate.IfFloatGeOpDescription,
      predicate.IfFloatLeOpDescription,
    ],
  },
  {
    header: "## Predicate — int",
    descs: [
      predicate.IfIntGtOpDescription,
      predicate.IfIntLtOpDescription,
      predicate.IfIntEqOpDescription,
      predicate.IfIntGeOpDescription,
      predicate.IfIntLeOpDescription,
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
      predicate.IfEmptySliceFloat64OpDescription,
      predicate.BetweenFloatOpDescription,
    ],
  },
  {
    header: "## Select / Switch / Default",
    descs: [
      select.SelectStringOpDescription,
      select.SelectFloat64OpDescription,
      select.SelectIntOpDescription,
      select.SelectBoolOpDescription,
      select.SwitchStringOpDescription,
      select.DefaultStringOpDescription,
      select.DefaultFloat64OpDescription,
      select.DefaultIntOpDescription,
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

/** Renders the given groups in Go's AllDescriptions format. */
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
