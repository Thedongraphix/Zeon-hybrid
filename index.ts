import "dotenv/config";
import express, { Request, Response } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import * as fs from "fs";
import cors from "cors";

// XMTP and LangChain/AgentKit related imports
import { Client, DecodedMessage, type Conversation, type XmtpEnv } from "@xmtp/node-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
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
import { createSigner } from "./helpers/client.js";

// --- Pre-compile contract to avoid doing it on every request ---
import sbt from "./helpers/CrowdFund.json" with { type: "json" };
const contractAbi = sbt.abi;
const contractBytecode = sbt.bytecode;
// --- End pre-compilation ---

// --- Environment Variable Validation ---
const {
  WALLET_KEY,
  ENCRYPTION_KEY,
  XMTP_ENV,
  OPENROUTER_API_KEY,
} = process.env;

if (!WALLET_KEY || !ENCRYPTION_KEY || !XMTP_ENV || !OPENROUTER_API_KEY) {
  console.error("FATAL: Missing one or more required environment variables (WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV, OPENROUTER_API_KEY).");
  process.exit(1);
}

// --- Agent and State Management ---
type Agent = ReturnType<typeof createReactAgent>;
interface AgentConfig {
  configurable: {
    thread_id: string;
  };
}
const agentStore: Record<string, Agent> = {};
const memoryStore: Record<string, MemorySaver> = {};

// --- Agent and Tool Definitions ---

function createCustomAgent(llm: ChatOpenAI, tools: any[], memory: MemorySaver, systemMessage: string): Agent {
  return createReactAgent({
    llm,
    tools,
    checkpointSaver: memory,
    messageModifier: systemMessage,
  });
}

async function initializeAgentForUser(userId: string): Promise<{ agent: Agent; config: AgentConfig }> {
    if (agentStore[userId]) {
        return {
            agent: agentStore[userId],
            config: { configurable: { thread_id: userId } }
        };
    }

    console.log(`🔧 Initializing new agent for user: ${userId}`);

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
    
    // Define all custom tools for the agent to use
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
                const tx = contract.deploymentTransaction();
                if (!tx) throw new Error("Deployment transaction failed.");
                
                await contract.waitForDeployment();
                const address = await contract.getAddress();
                const qrCode = await generateContributionQR(address, "0.01", fundraiserName);
                
                return formatDeployResponse(address, tx.hash, fundraiserName, goalAmount, qrCode);
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
    
    const tools = [deployFundraiserTool, getContributorsTool];
    const memory = new MemorySaver();
    const systemMessage = `You are Zeon, a friendly and helpful assistant for managing crypto fundraisers on the Base Sepolia network.
- Use emojis to make your responses engaging (🎉, 🚀, 💰, 🔍, ✅, ❌).
- Keep your responses clear, concise, and well-formatted using markdown.
- When you return the output from a tool, present it directly to the user without summarizing.
- If you need more information, ask the user for it clearly.`;

    const agent = createCustomAgent(llm, tools, memory, systemMessage);
    agentStore[userId] = agent;
    memoryStore[userId] = memory;

    return { agent, config: { configurable: { thread_id: userId } } };
}

async function processMessage(agent: Agent, config: AgentConfig, message: string): Promise<string> {
    try {
        console.log(`🤔 Processing: "${message}" for thread ${config.configurable.thread_id}`);
        const response = await agent.invoke({ messages: [new HumanMessage(message)] }, config);
        const responseContent = response.messages[response.messages.length - 1].content as string;
        console.log(`🤖 Response generated: ${responseContent.slice(0, 100)}...`);
        return responseContent;
    } catch (error: any) {
        console.error("Error processing message:", error);
        return `❌ Sorry, I encountered an error: ${error.message}.`;
    }
}

// --- XMTP Client and Message Handling ---
async function initializeXmtpClient() {
    const signer = createSigner(WALLET_KEY!);
    const xmtp = await Client.create(signer, {
        env: XMTP_ENV as XmtpEnv,
    });
    const identifier = await signer.getIdentifier();
    console.log(`🔥 XMTP client created for ${identifier.identifier}`);
    return xmtp;
}

async function handleXmtpMessage(message: DecodedMessage, client: Client<any>) {
    const senderAddress = (message as any).senderAddress;

    if (!senderAddress || senderAddress.toLowerCase() === (client as any).address.toLowerCase()) {
        return;
    }

    if (typeof (message as any).content !== 'string' || (message as any).content.trim() === "") {
        console.log(`Skipping non-text message from ${senderAddress}`);
        return;
    }
    
    console.log(`📩 Received message from ${senderAddress}: "${(message as any).content}"`);

    try {
        const { agent, config } = await initializeAgentForUser(senderAddress);
        const responseText = await processMessage(agent, config, (message as any).content);
        
        console.log(`📬 Sending response to ${senderAddress}: "${responseText}"`);
        await (message as any).conversation.send(responseText);
    } catch (error) {
        console.error(`Error handling message from ${senderAddress}:`, error);
        try {
            await (message as any).conversation.send("I encountered an error while processing your request. Please try again later.");
        } catch (sendError) {
            console.error(`Failed to send error message to ${senderAddress}:`, sendError);
        }
    }
}

async function startXmtpListener(client: Client<any>) {
    console.log("🚀 Starting XMTP message listener...");
    for await (const message of await client.conversations.streamAllMessages()) {
        if (!message) {
            continue;
        }
        await handleXmtpMessage(message, client);
    }
}


// --- Express API (for alternate interaction, e.g., web UI) ---
export const handleApiRequest = async (req: Request, res: Response) => {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
        return res.status(400).json({ error: "sessionId and message are required" });
    }
    
    try {
        const { agent, config } = await initializeAgentForUser(sessionId);
        const response = await processMessage(agent, config, message);
        res.json({ response });
    } catch (error) {
        console.error(`API Error for session ${sessionId}:`, error);
        res.status(500).json({ error: "Failed to process message." });
    }
};

const app = express();
app.use(express.json());
app.use(cors());
app.post("/api/message", handleApiRequest);
app.get("/", (req, res) => res.send("Zeon Hybrid Agent is running!"));

// --- Main Application Start ---
async function main() {
    const xmtpClient = await initializeXmtpClient();
    startXmtpListener(xmtpClient).catch(err => {
        console.error("XMTP Listener crashed:", err);
        process.exit(1);
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Server listening on port ${PORT}`);
    });
}

main().catch(err => {
    console.error("Application failed to start:", err);
    process.exit(1);
});