// Removed CDP imports as we're using direct ethers.js integration
import {
  createSigner,
  getEncryptionKeyFromHex,
  logAgentDetails,
  validateEnvironment,
} from "./helpers/client.js";

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import fs from "node:fs";
import { Client, XmtpEnv } from "@xmtp/node-sdk";
import { ethers } from "ethers";
import contractArtifact from "./dist/CrowdFund.json" with { type: "json" };
import {
  generateBaseScanLink,
  isValidTxHash,
  isValidAddress,
  generateQRCode,
  generateContributionQR,
  formatTransactionResponse,
  formatDeployResponse
} from "./utils/blockchain.js";

const {
  WALLET_KEY,
  ENCRYPTION_KEY,
  XMTP_ENV,
  NETWORK_ID,
  OPENROUTER_API_KEY,
} = validateEnvironment([
  "WALLET_KEY",
  "ENCRYPTION_KEY",
  "XMTP_ENV",
  "NETWORK_ID",
  "OPENROUTER_API_KEY",
]);

// Storage constants
const XMTP_STORAGE_DIR = ".data/xmtp";
const WALLET_STORAGE_DIR = ".data/wallet";

// Global stores
const memoryStore: Record<string, MemorySaver> = {};
const agentStore: Record<string, any> = {};

// Global, shared components to reduce initialization latency
let llm: ChatOpenAI;
let tools: any[] = [];
let sharedComponentsInitialized = false;

interface AgentConfig {
  configurable: {
    thread_id: string;
  };
}

type Agent = ReturnType<typeof createReactAgent>;

// Ensure storage directories exist
function ensureLocalStorage() {
  // NOTE: Using fs for storage is not suitable for Render's ephemeral filesystem.
  // Data written here will be lost on service restarts.
  // Consider using Render Disks or a managed database for persistent storage.
  if (!fs.existsSync(XMTP_STORAGE_DIR)) {
    fs.mkdirSync(XMTP_STORAGE_DIR, { recursive: true });
  }
  if (!fs.existsSync(WALLET_STORAGE_DIR)) {
    fs.mkdirSync(WALLET_STORAGE_DIR, { recursive: true });
  }
}

// Wallet storage functions
function saveWalletData(userId: string, walletData: string) {
  // NOTE: Using fs for storage is not suitable for Render's ephemeral filesystem.
  const localFilePath = `${WALLET_STORAGE_DIR}/${userId}.json`;
  try {
    if (!fs.existsSync(localFilePath)) {
      console.log(`💾 Wallet data saved for user ${userId}`);
      fs.writeFileSync(localFilePath, walletData);
    }
  } catch (error) {
    console.error(`Failed to save wallet data: ${error}`);
  }
}

function getWalletData(userId: string): string | null {
  const localFilePath = `${WALLET_STORAGE_DIR}/${userId}.json`;
  try {
    if (fs.existsSync(localFilePath)) {
      return fs.readFileSync(localFilePath, "utf8");
    }
  } catch (error) {
    console.warn(`Could not read wallet data: ${error}`);
  }
  return null;
}

// Initialize XMTP client
async function initializeXmtpClient() {
  const signer = createSigner(WALLET_KEY);
  const dbEncryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);
  const identifier = await signer.getIdentifier();
  const address = identifier.identifier;

  const client = await Client.create(signer, {
    dbEncryptionKey,
    env: XMTP_ENV as XmtpEnv,
    dbPath: XMTP_STORAGE_DIR + `/${XMTP_ENV}-${address}`,
  });

  await logAgentDetails(client);
  console.log("✓ Syncing conversations...");
  await client.conversations.sync();
  return client;
}

// --- Contract Artifacts ---
const contractAbi = contractArtifact.abi;
const contractBytecode = contractArtifact.bytecode;
// --- End pre-compilation ---

// NEW: One-time initialization of shared components
async function initializeSharedComponents() {
  if (sharedComponentsInitialized) return;
  
  console.log("🔧 Initializing shared AI components...");
  
  llm = new ChatOpenAI({
    modelName: "gpt-3.5-turbo",
    temperature: 0.7,
    maxRetries: 3,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/yourusername/zeon-hybrid",
        "X-Title": "Zeon Hybrid Agent"
      }
    },
    apiKey: OPENROUTER_API_KEY
  });

  const qrCodeTool = new DynamicStructuredTool({
    name: "generate_contribution_qr_code",
    description: "Generates a QR code as an SVG string for a contribution",
    schema: z.object({
      contractAddress: z.string(),
      amountInEth: z.string(),
      fundraiserName: z.string(),
    }),
    func: async (input) => {
      try {
        const { contractAddress, amountInEth, fundraiserName } = input;
        
        if (!isValidAddress(contractAddress)) {
          return `❌ Invalid contract address format: ${contractAddress}`;
        }
        
        const contributionQR = await generateContributionQR(
          contractAddress,
          amountInEth,
          fundraiserName
        );
        
        const contractScanLink = generateBaseScanLink(contractAddress, 'address');
        
        return `${contributionQR}

🔍 **View Contract:** [${contractAddress.slice(0, 10)}...${contractAddress.slice(-8)}](${contractScanLink})`;
      } catch (e: any) {
        console.error("Error generating QR code:", e);
        return `❌ Error generating QR code: ${e.message}`;
      }
    },
  });

  const deployFundraiserTool = new DynamicStructuredTool({
    name: "deploy_fundraiser_contract",
    description: "Deploys a fundraising contract",
    schema: z.object({
      beneficiaryAddress: z.string(),
      goalAmount: z.string(),
      durationInSeconds: z.string(),
      fundraiserName: z.string().optional().default("My Fundraiser")
    }),
    func: async (input) => {
      try {
        const { beneficiaryAddress, goalAmount, durationInSeconds, fundraiserName } = input;

        if (!isValidAddress(beneficiaryAddress)) {
          return `❌ Invalid beneficiary address format: ${beneficiaryAddress}`;
        }

        const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
        const wallet = new ethers.Wallet(WALLET_KEY, provider);
        const factory = new ethers.ContractFactory(contractAbi, contractBytecode, wallet);

        const goalInWei = ethers.parseEther(goalAmount);
        const deployedContract = await factory.deploy(beneficiaryAddress, goalInWei, durationInSeconds);
        const tx = deployedContract.deploymentTransaction();
        if (!tx) throw new Error("Deployment transaction not found.");
        
        await deployedContract.waitForDeployment();
        const contractAddress = await deployedContract.getAddress();

        const contributionQR = await generateContributionQR(
          contractAddress,
          "0.01", // Default contribution amount
          fundraiserName
        );

        // Use the new formatter to prevent incorrect links
        return formatDeployResponse(
          contractAddress,
          tx.hash,
          fundraiserName,
          goalAmount,
          contributionQR
        );
      } catch (e: any) {
        console.error("Error deploying contract:", e);
        return `❌ Error deploying contract: ${e.message}`;
      }
    },
  });

  // Add all your other tools here (getFundraiserContributorsTool, checkFundraiserStatusTool, checkWalletBalanceTool)
  // ...

  tools = [deployFundraiserTool, qrCodeTool /* ...other tools... */];
  sharedComponentsInitialized = true;
  console.log("✅ Shared components initialized");
}

// Initialize CDP agent
async function initializeAgent(userId: string, client: Client): Promise<{ agent: Agent; config: AgentConfig }> {
  try {
    if (!sharedComponentsInitialized) {
      throw new Error("Shared components not initialized. Call initializeSharedComponents() first.");
    }

    memoryStore[userId] = new MemorySaver();

    const agentConfig: AgentConfig = {
      configurable: { thread_id: userId },
    };

    const agent = await createReactAgent({
      llm,
      tools,
    });

    return { agent, config: agentConfig };
  } catch (error: any) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

// Process messages with better error handling
async function processMessage(
  agent: Agent,
  config: AgentConfig,
  message: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<string> {
  try {
    console.log(
      `🤔 Processing: "${message}" with history of length ${history.length}`,
    );

    const messages: BaseMessage[] = history.map((msg) =>
      msg.role === "user"
        ? new HumanMessage(msg.content)
        : new AIMessage(msg.content),
    );
    messages.push(new HumanMessage(message));

    const response = (await agent.invoke({ messages }, config)) as {
      messages: BaseMessage[];
    };

    const responseContent =
      response.messages[response.messages.length - 1].content as string;
    console.log(`🤖 Response generated: ${responseContent.slice(0, 100)}...`);

    return responseContent;
  } catch (error: any) {
    console.error("Error processing message:", error);

    if (error.message.includes("401")) {
      console.error("OpenRouter authentication error:", error);
      return `❌ Authentication error with AI service. Please check the API configuration.`;
    } else if (error.message.includes("insufficient funds")) {
      return `❌ Insufficient funds! Please make sure you have enough ETH in your wallet for this transaction. You can get testnet ETH from the Base Sepolia faucet.`;
    } else if (error.message.includes("invalid address")) {
      return `❌ Invalid address format! Please provide a valid Ethereum address (starting with 0x) or ENS name.`;
    } else if (error.message.includes("network")) {
      return `❌ Network error! Please check your connection and try again.`;
    }

    return `❌ Sorry, I encountered an error: ${error.message}. Please try again or rephrase your request.`;
  }
}

// Handle incoming messages as a request/response function
async function handleMessage(
  messageContent: string,
  senderAddress: string,
  client: Client,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<string> {
  let conversation: any = null;
  try {
    const botAddress = client.inboxId.toLowerCase();
    
    console.log(`\n📨 Message from ${senderAddress}: ${messageContent}`);

    // Skip if it's from the agent itself
    if (senderAddress.toLowerCase() === botAddress) {
      console.log("Debug - Ignoring message from self");
      return "Ignoring message from self";
    }

    // Get or create agent for this user
    let agent = agentStore[senderAddress];
    let config;
    
    if (!agent) {
      console.log(`🚀 Initializing new agent for ${senderAddress}...`);
      const result = await initializeAgent(senderAddress, client);
      agent = result.agent;
      config = result.config;
      console.log(`✅ Agent initialized for ${senderAddress}`);
    } else {
      config = { configurable: { thread_id: senderAddress } };
    }

    // Process the message
    const response = await processMessage(
      agent,
      config,
      messageContent,
      history,
    );
    
    console.log(`🤖 Sending response to ${senderAddress}`);
    
    return response;

  } catch (error) {
    console.error("Error handling message:", error);
    
    // Try to send error message back to user
    try {
      if (conversation) {
        await conversation.send("❌ Sorry, I'm having technical difficulties. Please try again in a moment!");
      }
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
    return "❌ Sorry, I'm having technical difficulties. Please try again in a moment!";
  }
}

// Start the agent
async function startAgent() {
  console.log(`
🚀 Starting XMTP Crypto Agent...
  `);
  
  try {
    ensureLocalStorage();
    
    // Initialize shared components first
    await initializeSharedComponents();
    
    console.log("🔧 Initializing XMTP Client...");
    const client = await initializeXmtpClient();
    
    console.log("🎯 Agent is ready and listening for API requests!");
    console.log(`📍 Agent address: ${client.inboxId}`);
    console.log(`🌐 Network: ${XMTP_ENV}`);
    console.log(`⛓️  Blockchain: ${NETWORK_ID}`);
    
    // Return the client and handler for the API server
    return {
      client,
      handleMessage: (
        message: string,
        userId: string,
        history: { role: "user" | "assistant"; content: string }[] = [],
      ) => handleMessage(message, userId, client, history),
    };

  } catch (error) {
    console.error("❌ Failed to start agent:", error);
    process.exit(1);
  }
}

// This part will now be handled by the API server
// if (require.main === module) {
//   startAgent().catch((error) => {
//     console.error("Fatal error:", error);
//     process.exit(1);
//   });
// }

export { startAgent, handleMessage };