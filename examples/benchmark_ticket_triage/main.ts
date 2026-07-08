import { Workflow, ai } from "../../src";
import { AICallRequest, AICallResponse } from "../../src/types";
import { parseArgs } from "node:util";
import fs from "fs";
import crypto from "crypto";
import path from "path";

// Langchain imports
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const PROMPTS = JSON.parse(fs.readFileSync(path.join(__dirname, "prompts.json"), "utf-8"));

const AVAILABLE_INTENTS = [
    "cancel_order", "change_order", "change_shipping_address",
    "check_cancellation_fee", "check_invoice", "check_payment_methods",
    "check_refund_policy", "complaint", "contact_customer_service",
    "contact_human_agent", "create_account", "delete_account",
    "delivery_options", "delivery_period", "edit_account", "get_invoice",
    "get_refund", "newsletter_subscription", "payment_issue",
    "place_order", "recover_password", "registration_problems",
    "review", "set_up_shipping_address", "switch_account",
    "track_order", "track_refund"
];

const INTENT_LIST_STR = AVAILABLE_INTENTS.join(", ");

function getMockUserProfile(utterance: string) {
    const token = crypto.createHash('md5').update(utterance).digest('hex').substring(0, 16);
    return {
        user_email: "customer@example.com",
        account_status: "active",
        metadata: {
            security_token: token,
            session_id: "sess_" + token.substring(0, 8)
        },
        loyalty: { tier: "gold", points: 1450 },
        preferences: { language: "en", notifications: true }
    };
}

function getTruePolicy(intent: string) {
    const escalate_intents = ["complaint", "payment_issue", "contact_human_agent"];
    const reject_intents = ["cancel_order", "get_refund"];
    
    if (escalate_intents.includes(intent)) return "escalate";
    if (reject_intents.includes(intent)) return "reject";
    return "standard_process";
}

async function evaluateResponse(utterance: string, intent: string, policy: string, email: string, expected_token: string) {
    if (!email || !email.includes(expected_token)) return false;
    const client = new ai.GeminiClient({ model: "gemini-3.5-flash" });
    const prompt = `You are a strict Judge evaluating a customer support email.
UTTERANCE: '${utterance}'
EXPECTED INTENT: '${intent}'
EXPECTED POLICY ACTION: '${policy}'
DRAFT EMAIL TO EVALUATE: '${email}'

Does the draft email politely address the user's utterance, reflect the expected intent, and follow the expected policy action?
Respond with exactly one word: PASS or FAIL.`;
    const res = await client.call({ messages: [{ role: "user", content: prompt }], temperature: 0 });
    return res.text.toUpperCase().includes("PASS");
}

class TrackingGeminiClient extends ai.GeminiClient {
    totalTokens = 0;
    async call(req: AICallRequest, signal?: AbortSignal): Promise<AICallResponse> {
        const res = await super.call(req, signal);
        const raw = res.raw as any;
        if (raw?.usageMetadata) {
            this.totalTokens += (raw.usageMetadata.promptTokenCount || 0) + (raw.usageMetadata.candidatesTokenCount || 0);
        }
        return res;
    }
}

function buildSparsiGraph() {
    const wf = new Workflow();
    const utterance = wf.input<string>("utterance");
    
    const user_profile = wf.op({ utterance }, ({ utterance }) => getMockUserProfile(utterance), { name: "FetchUserContextOp" });

    function extractJson(inputNode: ReturnType<typeof wf.input> | ReturnType<typeof wf.op>, opts: { name: string, operation: string, schema?: any }) {
        return wf.op({ input: inputNode }, async ({ input }, ctx) => {
            const prompt = `You are an expert data extractor.\n\nExtract the requested information from the following text.\n\nInput Text: ${input}\n\nOperation: ${opts.operation}\n\nRespond with ONLY a JSON object. No markdown, no explanation.`;
            let res: any;
            for (let i = 0; i < 3; i++) {
                try {
                    const aiRes = await ctx.ai!.call({
                        messages: [{ role: "user", content: prompt }],
                        model: "gemini-3.1-flash-lite",
                        temperature: 0
                    });
                    const text = aiRes.text.replace(/```json/g, "").replace(/```/g, "").trim();
                    res = JSON.parse(text);
                    break;
                } catch (e) {
                    if (i === 2) throw e;
                }
            }
            return res;
        }, { name: opts.name });
    }

    const sentiment_json = extractJson(utterance, {
        operation: PROMPTS.sparsi_sentiment,
        name: "AnalyzeSentimentOp"
    });

    const intent_ctx = wf.op({ utterance, profile: user_profile, sentiment: sentiment_json }, 
        ({ utterance, profile, sentiment }) => `UTTERANCE: ${utterance}\nPROFILE: ${JSON.stringify(profile)}\nSENTIMENT: ${JSON.stringify(sentiment)}`,
        { name: "FormatIntentContextOp" }
    );

    const intent_json = extractJson(intent_ctx, {
        operation: PROMPTS.sparsi_intent.replace("{INTENT_LIST_STR}", INTENT_LIST_STR),
        name: "ClassifyIntentOp"
    });

    const policy_json = wf.op({ intent_json }, ({ intent_json }) => ({ policy_action: getTruePolicy(intent_json.intent as string) }), { name: "DeterministicPolicyOp" });

    const draft_ctx = wf.op({ utterance, intent: intent_json, policy: policy_json, profile: user_profile },
        ({ utterance, intent, policy, profile }) => `UTTERANCE: ${utterance}\nINTENT: ${JSON.stringify(intent)}\nPOLICY: ${JSON.stringify(policy)}\nPROFILE: ${JSON.stringify(profile)}`,
        { name: "FormatDraftContextOp" }
    );

    const draft_json = extractJson(draft_ctx, {
        operation: PROMPTS.sparsi_draft,
        name: "DraftResponseOp"
    });

    const final_result = wf.op({ intent_json, policy_json, draft_json, user_profile },
        ({ intent_json, policy_json, draft_json, user_profile }) => ({
            intent: intent_json.intent,
            policy_action: policy_json.policy_action,
            draft_email: draft_json.draft_email,
            user_profile
        }),
        { name: "SendEmailOp" }
    );

    return { wf, final_result };
}

let lcProfile: any = null;

const fetch_user_context = tool(
  async ({ utterance }) => {
    return JSON.stringify(getMockUserProfile(utterance));
  },
  {
    name: "fetch_user_context",
    description: "Fetch the complex JSON user profile for the customer using their utterance.",
    schema: z.object({
      utterance: z.string().describe("The raw utterance")
    })
  }
);

const send_email = tool(
  async ({ body, user_profile }) => {
    lcProfile = user_profile;
    return "Email sent successfully.";
  },
  {
    name: "send_email",
    description: "Send the drafted email to the customer. You MUST pass the exact user_profile dictionary you fetched.",
    schema: z.object({
      body: z.string().describe("The drafted email"),
      user_profile: z.any().describe("The user profile fetched")
    })
  }
);

async function fetchDataset(samples: number) {
    const batch = [];
    let offset = 0;
    while (batch.length < samples) {
        let length = 100;
        if (samples - batch.length < 100) length = samples - batch.length;
        const res = await fetch(`https://datasets-server.huggingface.co/rows?dataset=bitext%2FBitext-customer-support-llm-chatbot-training-dataset&config=default&split=train&offset=${offset}&length=${length}`);
        const data = await res.json();
        for (const row of data.rows) {
            batch.push({
                utterance: row.row.instruction,
                true_intent: row.row.intent
            });
        }
        offset += 100;
    }
    return batch;
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: { samples: { type: "string" } }
    });
    const samples = parseInt(values.samples || "10", 10);

    console.log(`Loading ${samples} samples from bitext/Bitext-customer-support-llm-chatbot-training-dataset...`);
    const testBatch = await fetchDataset(samples);

    console.log("Initializing systems...");
    const { wf, final_result } = buildSparsiGraph();

    const llm = new ChatGoogleGenerativeAI({
        model: "gemini-3.1-flash-lite",
        temperature: 0,
        apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
    });
    
    const tools = [fetch_user_context, send_email];
    const llmWithTools = llm.bindTools(tools);

    const results = {
        sparsi: { correct: 0, total_time: 0, failures: 0, wall_time: 0, tokens: 0 },
        langchain: { correct: 0, total_time: 0, failures: 0, wall_time: 0, tokens: 0 }
    };

    const runSparsiItem = async (item: any, trackingAi: TrackingGeminiClient) => {
        const start = Date.now();
        try {
            const res = await wf.run({ ai: trackingAi, values: { utterance: item.utterance } });
            const result = res.get(final_result) as any;
            const elapsed = (Date.now() - start) / 1000;

            const predicted_intent = result.intent || "";
            const predicted_policy = result.policy_action || "";
            const predicted_email = result.draft_email || "";
            const true_intent = item.true_intent;
            const true_policy = getTruePolicy(true_intent);
            
            const intent_correct = predicted_intent === true_intent;
            const policy_correct = predicted_policy === true_policy;
            const true_profile = getMockUserProfile(item.utterance);
            const profile_correct = result.user_profile && result.user_profile.user_email === "customer@example.com";
            
            const response_correct = await evaluateResponse(item.utterance, true_intent, true_policy, predicted_email, true_profile.metadata.security_token);
            
            const pipeline_correct = intent_correct && policy_correct && response_correct && profile_correct;
            console.log(`Sparsi [Intent: ${intent_correct}] [Policy: ${policy_correct}] [Profile: ${profile_correct}] [Response: ${response_correct}]`);
            return { elapsed, correct: pipeline_correct ? 1 : 0, failure: 0 };
        } catch (e) {
            console.error("Sparsi error:", e);
            return { elapsed: (Date.now() - start) / 1000, correct: 0, failure: 1 };
        }
    };

    console.log("\\n--- Running Sparsi Benchmark ---");
    const sparsiWallStart = Date.now();
    const trackingAi = new TrackingGeminiClient();
    for (const item of testBatch) {
        const res = await runSparsiItem(item, trackingAi);
        results.sparsi.total_time += res.elapsed;
        results.sparsi.correct += res.correct;
        results.sparsi.failures += res.failure;
    }
    results.sparsi.tokens = trackingAi.totalTokens;
    results.sparsi.wall_time = (Date.now() - sparsiWallStart) / 1000;

    const runLcItem = async (item: any) => {
        const start = Date.now();
        lcProfile = null;
        try {
            const promptStr = PROMPTS.langchain_prompt.replace("{utterance}", item.utterance).replace("{INTENT_LIST_STR}", INTENT_LIST_STR);
            const messages: any[] = [["user", promptStr]];
            let finalResponse = "";
            let tokens = 0;
            
            for (let i = 0; i < 7; i++) {
                const aiMsg = await llmWithTools.invoke(messages);
                if (aiMsg.usage_metadata) {
                    tokens += (aiMsg.usage_metadata.input_tokens || 0) + (aiMsg.usage_metadata.output_tokens || 0);
                }
                messages.push(aiMsg);
                if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
                    for (const tc of aiMsg.tool_calls) {
                        const tool = tools.find(t => t.name === tc.name);
                        const res = await tool?.invoke(tc.args);
                        messages.push({ role: "tool", name: tc.name, tool_call_id: tc.id, content: typeof res === "string" ? res : JSON.stringify(res) });
                    }
                } else {
                    finalResponse = typeof aiMsg.content === "string" ? aiMsg.content : JSON.stringify(aiMsg.content);
                    break;
                }
            }
            
            const elapsed = (Date.now() - start) / 1000;
            
            let predicted_intent = "";
            for (const intent of AVAILABLE_INTENTS) {
                if (finalResponse.includes(intent)) {
                    predicted_intent = intent;
                    break;
                }
            }
            let predicted_policy = "";
            for (const policy of ["escalate", "standard_process", "reject"]) {
                if (finalResponse.includes(policy)) {
                    predicted_policy = policy;
                    break;
                }
            }
            
            let predicted_email = "";
            const startIdx = finalResponse.indexOf("{");
            const endIdx = finalResponse.lastIndexOf("}");
            if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
                try {
                    const parsed = JSON.parse(finalResponse.substring(startIdx, endIdx + 1));
                    predicted_email = parsed.draft_email || "";
                } catch { predicted_email = finalResponse; }
            } else {
                predicted_email = finalResponse;
            }
            
            const true_intent = item.true_intent;
            const true_policy = getTruePolicy(true_intent);
            const intent_correct = predicted_intent === true_intent;
            const policy_correct = predicted_policy === true_policy;
            
            const true_profile = getMockUserProfile(item.utterance);
            let checkProfile = lcProfile;
            if (typeof lcProfile === "string") {
                try { checkProfile = JSON.parse(lcProfile); } catch(e) {}
            }
            const profile_correct = checkProfile && checkProfile.user_email === "customer@example.com";
            
            const response_correct = await evaluateResponse(item.utterance, true_intent, true_policy, predicted_email, true_profile.metadata.security_token);
            
            const pipeline_correct = intent_correct && policy_correct && response_correct && profile_correct;
            console.log(`LC [Intent: ${intent_correct}] [Policy: ${policy_correct}] [Profile: ${profile_correct}] [Response: ${response_correct}]`);
            return { elapsed, correct: pipeline_correct ? 1 : 0, failure: 0, tokens };
        } catch (e) {
            console.error("LC error:", e);
            return { elapsed: (Date.now() - start) / 1000, correct: 0, failure: 1, tokens: 0 };
        }
    };

    console.log("\\n--- Running LangChain Benchmark ---");
    const lcWallStart = Date.now();
    for (const item of testBatch) {
        const res = await runLcItem(item);
        results.langchain.total_time += res.elapsed;
        results.langchain.correct += res.correct;
        results.langchain.failures += res.failure;
        results.langchain.tokens += res.tokens;
    }
    results.langchain.wall_time = (Date.now() - lcWallStart) / 1000;

    console.log("\\n\\n==========================================");
    console.log("             BENCHMARK RESULTS            ");
    console.log("==========================================");
    
    console.log(`System                         Accuracy   Avg Latency(s)  Wall Time(s)    Total Tokens    Failures  `);
    console.log(`----------------------------------------------------------------------------------------------------`);
    const sAcc = (results.sparsi.correct / samples * 100).toFixed(2);
    const sLat = (results.sparsi.total_time / samples).toFixed(2);
    const sWall = results.sparsi.wall_time.toFixed(2);
    console.log(`Sparsi (Multi-Step DAG)        ${sAcc}%      ${sLat}            ${sWall}           ${results.sparsi.tokens}            ${results.sparsi.failures}         `);
    
    const lAcc = (results.langchain.correct / samples * 100).toFixed(2);
    const lLat = (results.langchain.total_time / samples).toFixed(2);
    const lWall = results.langchain.wall_time.toFixed(2);
    console.log(`LangChain (ReAct Agent)        ${lAcc}%      ${lLat}            ${lWall}           ${results.langchain.tokens}           ${results.langchain.failures}         `);
    console.log(`==========================================`);
}

main().catch(console.error);
