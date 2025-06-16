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
import express from 'express';
import cors from 'cors';

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

// NEW: Agent will be initialized in the background after the server starts.
// This is to prevent Render health check timeouts.
let agent: Awaited<ReturnType<typeof startAgent>> | null = null;

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
      temperature: 0.3, // Lower temperature for more consistent tool usage
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
    
    // QR Code Generation Tool - STYLED
    const qrCodeTool = new DynamicStructuredTool({
      name: "generate_contribution_qr_code",
      description: "Generates a QR code for contributing to a fundraiser",
      schema: z.object({
        contractAddress: z.string(),
        amountInEth: z.string(),
        fundraiserName: z.string(),
      }),
      func: async (input: { contractAddress: string; amountInEth: string; fundraiserName: string; }) => {
        try {
          const { contractAddress, amountInEth, fundraiserName } = input;
          
          if (!isValidAddress(contractAddress)) {
            return `❌ **Invalid Address**
The contract address \`${contractAddress}\` is not valid. Please check and try again.`;
          }
          
          return await generateContributionQR(contractAddress, amountInEth, fundraiserName);
        } catch (e: any) {
          console.error("Error in generate_contribution_qr_code tool:", e);
          return `❌ **QR Code Error**
I encountered an error while generating the QR code: ${e.message}`;
        }
      },
    });

    // Deploy Fundraiser Tool - STYLED
    const deployFundraiserTool = new DynamicStructuredTool({
      name: "deploy_fundraiser_contract", 
      description: "Deploys a new fundraising smart contract and returns the contract address, transaction hash, and QR code for contributions. Use this tool when users want to create or deploy a fundraiser.",
      schema: z.object({
        beneficiaryAddress: z.string().describe("The Ethereum address that will receive the funds"),
        goalAmount: z.string().describe("The fundraising goal amount in ETH (e.g., '0.5')"),
        durationInSeconds: z.string().describe("Duration of the fundraiser in seconds (e.g., '2592000' for 30 days)"),
        fundraiserName: z.string().optional().default("My Fundraiser").describe("Name of the fundraiser")
      }),
      func: async (input: { beneficiaryAddress: string; goalAmount: string; durationInSeconds: string; fundraiserName?: string; }) => {
        try {
          console.log("🚀 Deploy fundraiser tool called with:", input);
          const { beneficiaryAddress, goalAmount, durationInSeconds, fundraiserName = "My Fundraiser" } = input;

          if (!isValidAddress(beneficiaryAddress)) {
            console.log("❌ Invalid beneficiary address:", beneficiaryAddress);
            return `❌ **Invalid Address**
The beneficiary address \`${beneficiaryAddress}\` is not valid. Please check and try again.`;
          }

          console.log("📋 Deploying contract with params:", { beneficiaryAddress, goalAmount, durationInSeconds, fundraiserName });

          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const wallet = new ethers.Wallet(WALLET_KEY!, provider);
          const factory = new ethers.ContractFactory(contractAbi, contractBytecode, wallet);

          const goalInWei = ethers.parseEther(goalAmount);
          console.log("💰 Goal in Wei:", goalInWei.toString());

          const deployedContract = await factory.deploy(beneficiaryAddress, goalInWei, durationInSeconds);
          const tx = deployedContract.deploymentTransaction();
          if (!tx) throw new Error("Deployment transaction could not be created.");
          
          console.log("⏳ Waiting for deployment...");
          await deployedContract.waitForDeployment();
          const contractAddress = await deployedContract.getAddress();
          
          console.log("✅ Contract deployed at:", contractAddress);
          console.log("🔗 Transaction hash:", tx.hash);

          console.log("📱 Generating QR code...");
          const contributionQR = await generateContributionQR(
            contractAddress,
            "0.01", // Default contribution amount for the QR code
            fundraiserName
          );

          console.log("📋 Formatting deployment response...");
          const response = formatDeployResponse(
            contractAddress,
            tx.hash,
            fundraiserName,
            goalAmount,
            contributionQR
          );

          console.log("✅ Deploy tool response generated successfully");
          return response;
        } catch (e: any) {
          console.error("❌ Error deploying contract:", e);
          console.error("📊 Full error details:", e.stack);
          return `❌ **Contract Deployment Failed**
I was unable to deploy the contract. Please ensure your wallet has enough funds and the parameters are correct.
*Error: ${e.message}*

*Debug info: Please check the server logs for more details.*`;
        }
      },
    });

    // Get Contributors Tool - STYLED
    const getFundraiserContributorsTool = new DynamicStructuredTool({
      name: "get_fundraiser_contributors",
      description: "Gets the list of contributors for a fundraiser",
      schema: z.object({
        contractAddress: z.string()
      }),
      func: async (input: { contractAddress: string; }) => {
        try {
          const { contractAddress } = input;
          
          if (!isValidAddress(contractAddress)) {
            return `❌ **Invalid Address**
The contract address \`${contractAddress}\` is not valid. Please check and try again.`;
          }
          
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);

          const contributorAddresses = await fundraiserContract.getContributors();
          const contractScanLink = generateBaseScanLink(contractAddress, 'address');
          
          if (contributorAddresses.length === 0) {
            return `🤔 **No Contributions Yet**
This fundraiser hasn't received any contributions. Be the first!

🔍 **View Contract:** [${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}](${contractScanLink})`;
          }

          const contributorsWithEns = await Promise.all(
            contributorAddresses.map(async (address: string) => {
              try {
                // Use a public ENS provider for lookups
                const mainnetProvider = new ethers.JsonRpcProvider("https://web3.ens.domains/v1/mainnet");
                const ensName = await mainnetProvider.lookupAddress(address);
                return { address, ensName: ensName || "N/A" };
              } catch (e) {
                return { address, ensName: "N/A" };
              }
            })
          );
          
          const contributorList = contributorsWithEns.map((c: { address: string; ensName: string; }) => {
            const addressScanLink = generateBaseScanLink(c.address, 'address');
            const shortAddress = `${c.address.slice(0, 6)}...${c.address.slice(-4)}`;
            return `- **${c.ensName === "N/A" ? shortAddress : c.ensName}**: [\`${shortAddress}\`](${addressScanLink})`;
          }).join('\\n');

          return `👥 **Contributors for Fundraiser**

Here are the amazing people who have contributed:
${contributorList}

---
🔍 **View Contract:** [${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}](${contractScanLink})`;
        } catch (e: any) {
          console.error("Error getting contributors:", e);
          return `❌ **Could Not Get Contributors**
I was unable to fetch the contributor list for this fundraiser.
*Error: ${e.message}*`;
        }
      },
    });
    
    // Check Status Tool - STYLED
    const checkFundraiserStatusTool = new DynamicStructuredTool({
      name: "check_fundraiser_status",
      description: "Checks if a fundraiser is still active",
      schema: z.object({
        contractAddress: z.string()
      }),
      func: async (input: { contractAddress: string; }) => {
        try {
          const { contractAddress } = input;
          
          if (!isValidAddress(contractAddress)) {
            return `❌ **Invalid Address**
The contract address \`${contractAddress}\` is not valid. Please check and try again.`;
          }
          
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);
          
          const isActive = await fundraiserContract.isFundraiserActive();
          const statusMessage = isActive 
            ? "✅ **Active**: This fundraiser is currently accepting contributions." 
            : "❌ **Ended**: This fundraiser has ended and can no longer accept contributions.";

          const contractScanLink = generateBaseScanLink(contractAddress, 'address');
          const shortContract = `${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;

          return `📊 **Fundraiser Status**

${statusMessage}

---
🔍 **View Contract:** [\`${shortContract}\`](${contractScanLink})`;
        } catch (e: any) {
          console.error("Error checking fundraiser status:", e);
          return `❌ **Could Not Check Status**
I was unable to check the status of this fundraiser.
*Error: ${e.message}*`;
        }
      },
    });

    // Check Balance Tool - STYLED
    const checkWalletBalanceTool = new DynamicStructuredTool({
      name: "check_wallet_balance",
      description: "Checks the balance of an Ethereum wallet address",
      schema: z.object({
        address: z.string()
      }),
      func: async (input: { address: string; }) => {
        try {
          const { address } = input;
          
          if (!isValidAddress(address)) {
            return `❌ **Invalid Address**
The wallet address \`${address}\` is not valid. Please check and try again.`;
          }
          
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const balance = await provider.getBalance(address);
          const balanceInEth = ethers.formatEther(balance);
          
          const addressScanLink = generateBaseScanLink(address, 'address');
          const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
          
          return `💰 **Wallet Balance**

- **Address:** [\`${shortAddress}\`](${addressScanLink})
- **Balance:** **${balanceInEth} ETH** (on Base Sepolia)`;
        } catch (e: any) {
          console.error("Error checking wallet balance:", e);
          return `❌ **Could Not Check Balance**
I was unable to check the balance of this wallet.
*Error: ${e.message}*`;
        }
      },
    });

  tools = [deployFundraiserTool, qrCodeTool, getFundraiserContributorsTool, checkFundraiserStatusTool, checkWalletBalanceTool];
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

    // Log all messages in the response for debugging
    console.log(`📊 Response has ${response.messages.length} messages`);
    response.messages.forEach((msg, index) => {
      console.log(`📝 Message ${index}: ${msg.constructor.name} - ${JSON.stringify(msg.content).slice(0, 100)}...`);
    });

    const responseContent =
      response.messages[response.messages.length - 1].content as string;
    console.log(`🤖 Final response: ${responseContent.slice(0, 200)}...`);

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
      agentStore[senderAddress] = agent;
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
    
    // The 'conversation' object is not available in this API context.
    // The error will be returned to the API caller in the main() function.
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

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cors());

  app.get('/', (req, res) => {
    // Return a status indicating if the agent is ready
    const status = agent 
      ? '✅ Zeon AI Agent is running and ready!' 
      : '🟡 Zeon AI Agent is initializing... please wait.';
    res.send(status);
  });

  // Dedicated health check endpoint with proper HTTP status codes
  app.get('/health', (req, res) => {
    if (agent) {
      res.status(200).json({ 
        status: 'healthy', 
        agent: 'ready',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({ 
        status: 'initializing', 
        agent: 'not_ready',
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Agent is now initialized in the background after server starts
  // const agent = await startAgent();

  // Chat endpoint handler function
  const handleChatRequest = async (req: any, res: any) => {
    // Debug logging
    console.log('📝 Request body:', JSON.stringify(req.body, null, 2));
    console.log('📝 Content-Type:', req.headers['content-type']);
    
    // Extract fields with fallbacks for different frontend formats
    let { message, sessionId } = req.body;
    
    // Handle different field name variations
    message = message || req.body.text || req.body.content || req.body.query;
    sessionId = sessionId || req.body.session_id || req.body.userId || req.body.user_id || req.body.id || 'default-session';
    
    // More detailed error message
    if (!message) {
      return res.status(400).send({ 
        error: 'message field is required (also accepts: text, content, query)',
        received: req.body
      });
    }
    
    // Auto-generate sessionId if still missing
    if (!sessionId || sessionId === 'default-session') {
      sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log(`🔄 Auto-generated sessionId: ${sessionId}`);
    }
    
    // Return 503 if agent isn't ready yet
    if (!agent) {
      return res.status(503).send({ error: 'Service Unavailable: Agent is initializing. Please try again in a moment.' });
    }
    
    try {
      const response = await agent.handleMessage(message, sessionId);
      res.send({ response });
    } catch (error) {
      console.error("Error handling API message:", error);
      res.status(500).send({ error: 'Failed to process message' });
    }
  };

  // Both endpoints for compatibility
  app.post('/api/message', handleChatRequest);
  app.post('/api/chat', handleChatRequest);

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => {
      console.log(`✅ API Server is live on port ${PORT}. Health checks should pass.`);
      
      // Now, initialize the agent in the background.
      console.log('⏳ Starting agent initialization in the background...');
      startAgent()
        .then(initializedAgent => {
          agent = initializedAgent;
          console.log('✅ Agent is fully initialized and ready to handle requests.');
        })
        .catch(err => {
          console.error('❌ FATAL: Agent initialization failed. The API will not be able to process messages.', err);
        });
  });
}

main().catch((error) => {
  console.error("❌ Failed to start main application:", error);
  process.exit(1);
});

// No longer needed
// export { startAgent, handleMessage };