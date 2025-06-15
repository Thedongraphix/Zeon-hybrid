import "dotenv/config";
import express, { Request, Response } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import cors from "cors";

// XMTP and LangChain/AgentKit related imports
import { Client, DecodedMessage, type XmtpEnv } from "@xmtp/node-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

// Local utilities
import {
  generateBaseScanLink,
  isValidAddress,
  generateContributionQR,
  formatDeployResponse,
} from "./utils/blockchain.js";
import { createSigner, logAgentDetails, getDbPath } from "./helpers/client.js";
import sbt from "./helpers/CrowdFund.json" with { type: "json" };

// --- Environment Variable Validation ---
const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV, OPENROUTER_API_KEY } = process.env;
if (!WALLET_KEY || !ENCRYPTION_KEY || !XMTP_ENV || !OPENROUTER_API_KEY) {
  throw new Error("Missing one or more required environment variables.");
}
const contractAbi = sbt.abi;
const contractBytecode = sbt.bytecode;

// --- SINGLE, GLOBAL INITIALIZATION OF AGENT ---
console.log("🛠️  Initializing Agent and Tools...");

const llm = new ChatOpenAI({
    modelName: "gpt-3.5-turbo",
    temperature: 0.7,
    maxRetries: 3,
    configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
            "HTTP-Referer": "https://zeon-hybrid.onrender.com/",
            "X-Title": "Zeon Hybrid Agent"
        }
    },
    apiKey: OPENROUTER_API_KEY
});

const deployFundraiserTool = new DynamicStructuredTool({
    name: "deploy_fundraiser_contract",
    description: "Deploys a new fundraising smart contract.",
    schema: z.object({
        beneficiaryAddress: z.string().describe("The wallet address that will receive the funds."),
        goalAmount: z.string().describe("The fundraising goal in ETH (e.g., '0.5')."),
        durationInSeconds: z.string().describe("The duration of the fundraiser in seconds."),
        fundraiserName: z.string().optional().default("My Awesome Fundraiser").describe("A descriptive name for the fundraiser.")
    }),
    func: async ({ beneficiaryAddress, goalAmount, durationInSeconds, fundraiserName }) => {
        try {
            if (!isValidAddress(beneficiaryAddress)) return `❌ **Invalid Address:** The beneficiary address is not valid.`;
            const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
            const wallet = new ethers.Wallet(WALLET_KEY!, provider);
            const factory = new ethers.ContractFactory(contractAbi, contractBytecode, wallet);
            const goalInWei = ethers.parseEther(goalAmount);
            const contract = await factory.deploy(beneficiaryAddress, goalInWei, Number(durationInSeconds));
            await contract.waitForDeployment();
            const address = await contract.getAddress();
            const qrCode = await generateContributionQR(address, "0.01", fundraiserName);
            return formatDeployResponse(address, contract.deploymentTransaction()!.hash, fundraiserName, goalAmount, qrCode);
        } catch (e: any) {
            console.error("Error deploying contract:", e);
            return `❌ **Deployment Failed:** Could not deploy contract. Error: ${e.message}`;
        }
    },
});

const getContributorsTool = new DynamicStructuredTool({
    name: "get_fundraiser_contributors",
    description: "Gets the list of contributors for a given fundraiser contract address.",
    schema: z.object({ contractAddress: z.string() }),
    func: async ({ contractAddress }) => {
        try {
            if (!isValidAddress(contractAddress)) return `❌ **Invalid Address:** The contract address is not valid.`;
            const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
            const contract = new ethers.Contract(contractAddress, contractAbi, provider);
            const contributors = await contract.getContributors();
            const scanLink = generateBaseScanLink(contractAddress, 'address');
            if (contributors.length === 0) return `🤔 **No Contributions Yet.** [View Contract](${scanLink})`;
            const list = contributors.map((addr: string) => `- [\`${addr}\`](${generateBaseScanLink(addr, 'address')})`).join('\n');
            return `👥 **Contributors:**\n${list}\n\n[View Contract](${scanLink})`;
        } catch (e: any) {
            console.error("Error getting contributors:", e);
            return `❌ **Fetch Failed:** Could not get contributors. Error: ${e.message}`;
        }
    },
});

const agent = createReactAgent({
    llm,
    tools: [deployFundraiserTool, getContributorsTool],
    checkpointSaver: new MemorySaver(),
    messageModifier: `You are Zeon, a friendly and helpful assistant for managing crypto fundraisers on the Base Sepolia network.
- Use emojis to make your responses engaging (🎉, 🚀, 💰, 🔍, ✅, ❌).
- Keep your responses clear, concise, and well-formatted using markdown.
- When you return the output from a tool, present it directly to the user without summarizing.
- If you need more information, ask the user for it clearly.`,
});

console.log("✅ Agent and Tools initialized.");

// --- AGENT MESSAGE PROCESSING ---
async function processAgentMessage(messageContent: string, threadId: string): Promise<string> {
    try {
        console.log(`🤔 Processing: "${messageContent}" for thread ${threadId}`);
        const config = { configurable: { thread_id: threadId } };
        const response = await agent.invoke({ messages: [new HumanMessage(messageContent)] }, config);
        const responseContent = response.messages[response.messages.length - 1].content as string;
        console.log(`🤖 Response generated for ${threadId}: ${responseContent.slice(0, 100)}...`);
        return responseContent;
    } catch (error: any) {
        console.error(`Error processing message for ${threadId}:`, error);
        return `❌ Sorry, I encountered an error: ${error.message}.`;
    }
}

// --- XMTP CLIENT AND MESSAGE HANDLING ---
async function initializeXmtpClient() {
    const signer = createSigner(WALLET_KEY!);
    return Client.create(signer, {
        env: XMTP_ENV as XmtpEnv,
        dbPath: getDbPath(`xmtp-${XMTP_ENV}.db3`),
    });
}

async function handleXmtpMessage(message: DecodedMessage, client: Client) {
    const senderAddress = (message as any).senderAddress;
    const clientAddress = (client as any).address;

    if (senderAddress.toLowerCase() === clientAddress.toLowerCase()) return;
    if (typeof message.content !== 'string' || message.content.trim() === "") return;

    console.log(`📩 Received message from ${senderAddress}: "${message.content}"`);
    try {
        const responseText = await processAgentMessage(message.content, senderAddress);
        console.log(`📬 Sending response to ${senderAddress}: "${responseText}"`);
        await (message as any).conversation.send(responseText);
    } catch (error) {
        console.error(`Error handling message from ${senderAddress}:`, error);
    }
}

async function startXmtpListener(client: Client) {
    console.log("🚀 Starting XMTP message listener...");
    for await (const message of await client.conversations.streamAllMessages()) {
        if (!message) continue;
        // Don't await handleXmtpMessage to avoid blocking the stream
        handleXmtpMessage(message, client).catch(err => {
            console.error("Error in message handler:", err);
        });
    }
}

// --- EXPRESS API (for web UI and health checks) ---
const app = express();
app.use(express.json());
app.use(cors());

app.get("/", (req, res) => res.send("Zeon Hybrid Agent is running!"));

app.post("/api/message", async (req: Request, res: Response) => {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
        return res.status(400).json({ error: "sessionId and message are required" });
    }
    try {
        const response = await processAgentMessage(message, sessionId);
        res.json({ response });
    } catch (error) {
        console.error(`API Error for session ${sessionId}:`, error);
        res.status(500).json({ error: "Failed to process message." });
    }
});

// --- MAIN APPLICATION START ---
function main() {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`✅ API Server listening on port ${PORT}. Service is live.`);
        
        // Defer XMTP initialization to the next tick of the event loop.
        // This ensures the server is fully responsive before starting the long-running task.
        setImmediate(() => {
            console.log("⏳ Initializing XMTP client in the background...");
            initializeXmtpClient()
                .then(xmtpClient => {
                    console.log("✅ XMTP client initialized.");
                    logAgentDetails(xmtpClient).catch(console.warn);
                    return startXmtpListener(xmtpClient);
                })
                .catch(err => {
                    console.error("🚨 Critical: XMTP client or listener failed to start.", err);
                });
        });
    });
}

main();