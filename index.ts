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

// Helper function to parse amount from user input
function parseAmountFromInput(input: string): string {
  console.log(`🔍 Parsing amount from: "${input}"`);
  
  // More comprehensive patterns for various amount formats
  const patterns = [
    // "100 usdc worth of eth", "50 dollars worth", etc.
    /(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\s*(?:worth|of|in)\s*(?:eth)?/i,
    // Direct ETH amounts: "0.5 ETH", "2 eth"
    /(\d+(?:\.\d+)?)\s*eth/i,
    // "worth X USDC", "worth X dollars"
    /worth\s*(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)/i,
    // "fundraiser for X USDC"
    /fundraiser\s*(?:for|worth|of)\s*(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)/i,
    // Just numbers followed by currency
    /(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)/i,
  ];
  
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      const amount = parseFloat(match[1]);
      console.log(`💡 Found amount: ${amount} from pattern: ${pattern}`);
      
      // If it's USD/USDC, convert to ETH equivalent (assuming ~$2000/ETH)
      if (input.toLowerCase().includes('usd') || input.toLowerCase().includes('dollar')) {
        const ethAmount = (amount / 2000).toFixed(6);
        console.log(`💱 Converted ${amount} USD to ${ethAmount} ETH`);
        return ethAmount;
      }
      return amount.toString();
    }
  }
  
  console.log(`⚠️ No amount pattern found in input`);
  throw new Error(`Could not parse amount from: "${input}". Please specify the amount clearly (e.g., "0.1 ETH" or "100 USDC worth of ETH").`);
}

// NEW: One-time initialization of shared components
async function initializeSharedComponents() {
  if (sharedComponentsInitialized) return;
  
  console.log("🔧 Initializing shared AI components...");
  
  llm = new ChatOpenAI({
      modelName: "gpt-4", 
      temperature: 0.2, // Better for following instructions precisely
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
      description: "Generates a QR code for contributing to a fundraiser. IMPORTANT: Return the EXACT output from this tool without any summarization or explanation.",
      schema: z.object({
        contractAddress: z.string(),
        amountInEth: z.string(),
        fundraiserName: z.string(),
      }),
      func: async (input: { contractAddress: string; amountInEth: string; fundraiserName: string; }) => {
        try {
          const { contractAddress, amountInEth, fundraiserName } = input;
          
          if (!isValidAddress(contractAddress)) {
            return `❌ Invalid Address
The contract address \`${contractAddress}\` is not valid. Please check and try again.`;
          }
          
          return await generateContributionQR(contractAddress, amountInEth, fundraiserName);
        } catch (e: any) {
          console.error("Error in generate_contribution_qr_code tool:", e);
          return `❌ QR Code Error
I encountered an error while generating the QR code: ${e.message}`;
        }
      },
    });

    // Deploy Fundraiser Tool - ENHANCED
    const deployFundraiserTool = new DynamicStructuredTool({
      name: "deploy_fundraiser_contract", 
      description: "Deploys a new fundraising smart contract and returns the contract address, transaction hash, and QR code for contributions. ALWAYS pass the original user message in originalUserInput for proper amount parsing. Extract goal amount from user input and convert USD/USDC to ETH. For '30 days' duration, use 2592000 seconds. Return the COMPLETE output exactly as provided.",
      schema: z.object({
        beneficiaryAddress: z.string().describe("The Ethereum address that will receive the funds"),
        goalAmount: z.string().describe("The fundraising goal amount in ETH - extract from user input and convert if needed"),
        durationInSeconds: z.string().describe("Duration of the fundraiser in seconds (30 days = 2592000 seconds)"),
        fundraiserName: z.string().optional().default("Fundraiser").describe("Name/purpose of the fundraiser extracted from user input"),
        originalUserInput: z.string().optional().describe("The original user message to help with amount parsing")
      }),
      func: async (input: { beneficiaryAddress: string; goalAmount: string; durationInSeconds: string; fundraiserName?: string; originalUserInput?: string; }) => {
        try {
          console.log("🚀 Deploy fundraiser tool called with:", input);
          const { beneficiaryAddress, goalAmount, durationInSeconds, fundraiserName = "Fundraiser", originalUserInput } = input;
          
          // Always use the original user input for better amount parsing
          let finalGoalAmount = goalAmount;
          if (originalUserInput) {
            const parsedAmount = parseAmountFromInput(originalUserInput);
            finalGoalAmount = parsedAmount;
            console.log(`💡 Using parsed amount: ${parsedAmount} ETH from "${originalUserInput}"`);
                     } else {
             // Also try parsing from the goalAmount parameter
             try {
               const parsedFromGoal = parseAmountFromInput(goalAmount);
               finalGoalAmount = parsedFromGoal;
             } catch (error) {
               console.log(`⚠️ Could not parse amount from goalAmount parameter: ${goalAmount}`);
               // Keep the original goalAmount if parsing fails
             }
           }

          if (!isValidAddress(beneficiaryAddress)) {
            console.log("❌ Invalid beneficiary address:", beneficiaryAddress);
            return `❌ Invalid Address
The beneficiary address \`${beneficiaryAddress}\` is not valid. Please check and try again.`;
          }

          console.log("📋 Deploying contract with params:", { beneficiaryAddress, finalGoalAmount, durationInSeconds, fundraiserName });

          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const wallet = new ethers.Wallet(WALLET_KEY!, provider);
          const factory = new ethers.ContractFactory(contractAbi, contractBytecode, wallet);

          const goalInWei = ethers.parseEther(finalGoalAmount);
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
          // Use 1% of goal amount as suggested contribution, with a minimum of 0.001 ETH and maximum of 0.1 ETH
          const goalInEth = parseFloat(finalGoalAmount);
          const suggestedAmount = Math.max(0.001, Math.min(0.1, goalInEth * 0.01));
          const contributionQR = await generateContributionQR(
            contractAddress,
            suggestedAmount.toString(),
            fundraiserName
          );

          console.log("📋 Formatting deployment response...");
          const response = formatDeployResponse(
            contractAddress,
            tx.hash,
            fundraiserName,
            finalGoalAmount,
            contributionQR
          );

          console.log("✅ Deploy tool response generated successfully");
          return response;
        } catch (e: any) {
          console.error("❌ Error deploying contract:", e);
          console.error("📊 Full error details:", e.stack);
          return `❌ Contract Deployment Failed
I was unable to deploy the contract. Please ensure your wallet has enough funds and the parameters are correct.
Error: ${e.message}

Debug info: Please check the server logs for more details.`;
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
            return `❌ Invalid Address
The contract address \`${contractAddress}\` is not valid. Please check and try again.`;
          }
          
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);

          const contributorAddresses = await fundraiserContract.getContributors();
          const contractScanLink = generateBaseScanLink(contractAddress, 'address');
          
          if (contributorAddresses.length === 0) {
            return `🤔 No Contributions Yet
This fundraiser hasn't received any contributions. Be the first!

🔍 View Contract: [${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}](${contractScanLink})`;
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
            return `- ${c.ensName === "N/A" ? shortAddress : c.ensName}: [\`${shortAddress}\`](${addressScanLink})`;
          }).join('\\n');

          return `👥 Contributors for Fundraiser

Here are the amazing people who have contributed:
${contributorList}

---
🔍 View Contract: [${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}](${contractScanLink})`;
        } catch (e: any) {
          console.error("Error getting contributors:", e);
          return `❌ Could Not Get Contributors
I was unable to fetch the contributor list for this fundraiser.
Error: ${e.message}`;
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
            return `❌ Invalid Address
The contract address \`${contractAddress}\` is not valid. Please check and try again.`;
          }
          
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);
          
          const isActive = await fundraiserContract.isFundraiserActive();
          const statusMessage = isActive 
            ? "✅ Active: This fundraiser is currently accepting contributions." 
            : "❌ Ended: This fundraiser has ended and can no longer accept contributions.";

          const contractScanLink = generateBaseScanLink(contractAddress, 'address');
          const shortContract = `${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;

          return `📊 Fundraiser Status

${statusMessage}

---
🔍 View Contract: [\`${shortContract}\`](${contractScanLink})`;
        } catch (e: any) {
          console.error("Error checking fundraiser status:", e);
          return `❌ Could Not Check Status
I was unable to check the status of this fundraiser.
Error: ${e.message}`;
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
            return `❌ Invalid Address
The wallet address \`${address}\` is not valid. Please check and try again.`;
          }
          
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const balance = await provider.getBalance(address);
          const balanceInEth = ethers.formatEther(balance);
          
          const addressScanLink = generateBaseScanLink(address, 'address');
          const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
          
          return `💰 Wallet Balance

- Address: [\`${shortAddress}\`](${addressScanLink})
- Balance: ${balanceInEth} ETH (on Base Sepolia)`;
        } catch (e: any) {
          console.error("Error checking wallet balance:", e);
          return `❌ Could Not Check Balance
I was unable to check the balance of this wallet.
Error: ${e.message}`;
        }
      },
    });

    // NEW: Send Funds Tool - STYLED
    const sendFundsTool = new DynamicStructuredTool({
      name: "send_funds_to_address_or_ens",
      description: "Sends ETH to a given address or ENS/.base name. Example: 'Send 0.1 ETH to iamchris.base.eth'. CRITICAL: Return the COMPLETE output from this tool exactly as provided.",
      schema: z.object({
        recipient: z.string().describe("The recipient's wallet address or ENS/.base name (e.g., 'iamchris.base.eth')"),
        amountInEth: z.string().describe("The amount of ETH to send (e.g., '0.1')"),
      }),
      func: async (input: { recipient: string; amountInEth: string; }) => {
        let { recipient, amountInEth } = input;
        
        // Try to parse amount if it looks like it might need conversion
        if (amountInEth.toLowerCase().includes('usd') || amountInEth.toLowerCase().includes('dollar')) {
          amountInEth = parseAmountFromInput(amountInEth);
        }
        
        console.log(`💸 Attempting to send ${amountInEth} ETH to ${recipient}`);

        try {
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const wallet = new ethers.Wallet(WALLET_KEY!, provider);
          
          let targetAddress: string | null = null;

          // Check if it's a potential ENS/.base name or a regular address
          if (recipient.includes('.')) {
            console.log(`🔍 Resolving ENS/base name: ${recipient}`);
            targetAddress = await provider.resolveName(recipient);
            if (!targetAddress) {
              return `❌ Name Not Found
I could not resolve the name \`${recipient}\`. Please ensure it's a valid and registered ENS or .base name on the correct network.`;
            }
            console.log(`✅ Resolved ${recipient} to ${targetAddress}`);
          } else if (isValidAddress(recipient)) {
            targetAddress = recipient;
          } else {
            return `❌ Invalid Recipient
The recipient \`${recipient}\` is not a valid wallet address or ENS/.base name. Please check and try again.`;
          }

          console.log(`📤 Preparing transaction to ${targetAddress} for ${amountInEth} ETH...`);
          const tx = {
            to: targetAddress,
            value: ethers.parseEther(amountInEth),
          };

          const txResponse = await wallet.sendTransaction(tx);
          console.log(`⏳ Transaction sent with hash: ${txResponse.hash}. Waiting for confirmation...`);
          await txResponse.wait(); // Wait for 1 confirmation
          console.log(`✅ Transaction confirmed!`);

          return formatTransactionResponse(txResponse.hash, "Send Funds", {
            from: wallet.address,
            to: targetAddress,
            value: amountInEth,
          });
        } catch (e: any) {
          console.error("❌ Error sending funds:", e);
          if (e.message.includes("insufficient funds")) {
            return `❌ Insufficient Funds
The wallet does not have enough ETH to complete this transaction (including gas fees).`;
          }
          return `❌ Transaction Failed
I encountered an error while trying to send the funds: ${e.message}`;
        }
      },
    });

  tools = [deployFundraiserTool, qrCodeTool, getFundraiserContributorsTool, checkFundraiserStatusTool, checkWalletBalanceTool, sendFundsTool];
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

    // Bind tools to the LLM for better tool calling
    const llmWithTools = llm.bindTools(tools);
    
    const agent = await createReactAgent({
      llm: llmWithTools,
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