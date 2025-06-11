import {
  AgentKit,
  cdpApiActionProvider,
  cdpWalletActionProvider,
  CdpWalletProvider,
  erc20ActionProvider,
  walletActionProvider,
} from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import {
  createSigner,
  getEncryptionKeyFromHex,
  logAgentDetails,
  validateEnvironment,
} from "./helpers/client.js";

import { HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import fs from "node:fs";
import { Client, XmtpEnv } from "@xmtp/node-sdk";
import { ethers } from "ethers";
import QRCode from "qrcode";
import contractArtifact from "./dist/CrowdFund.json" with { type: "json" };

const {
  WALLET_KEY,
  ENCRYPTION_KEY,
  XMTP_ENV,
  CDP_API_KEY_NAME,
  CDP_API_KEY_PRIVATE_KEY,
  NETWORK_ID,
  OPENROUTER_API_KEY,
} = validateEnvironment([
  "WALLET_KEY",
  "ENCRYPTION_KEY",
  "XMTP_ENV",
  "CDP_API_KEY_NAME",
  "CDP_API_KEY_PRIVATE_KEY",
  "NETWORK_ID",
  "OPENROUTER_API_KEY",
]);

// Storage constants
const XMTP_STORAGE_DIR = ".data/xmtp";
const WALLET_STORAGE_DIR = ".data/wallet";

// Global stores
const memoryStore: Record<string, MemorySaver> = {};
const agentStore: Record<string, any> = {};

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

// Initialize CDP agent
async function initializeAgent(userId: string, client: Client): Promise<{ agent: Agent; config: AgentConfig }> {
  try {
    const llm = new ChatOpenAI({
      modelName: "gpt-3.5-turbo",
      temperature: 0.7,
      maxRetries: 3,
      apiKey: OPENROUTER_API_KEY,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
      },
    });

    const storedWalletData = getWalletData(userId);
    console.log(`Wallet data for ${userId}: ${storedWalletData ? "Found" : "Not found"}`);

    const config = {
      apiKeyName: CDP_API_KEY_NAME,
      apiKeyPrivateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n"),
      cdpWalletData: storedWalletData || undefined,
      networkId: NETWORK_ID || "base-sepolia",
      analytics: {
        disabled: true,
      },
    };

    const walletProvider = await CdpWalletProvider.configureWithWallet(config);
    const agentkit = await AgentKit.from({
      walletProvider,
      actionProviders: [
        walletActionProvider(),
        erc20ActionProvider(),
        cdpApiActionProvider({
          apiKeyName: CDP_API_KEY_NAME,
          apiKeyPrivateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
        cdpWalletActionProvider({
          apiKeyName: CDP_API_KEY_NAME,
          apiKeyPrivateKey: CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      ],
    });

    const tools = await getLangChainTools(agentkit);
    
    const qrCodeTool = new DynamicStructuredTool({
      name: "generate_contribution_qr_code",
      description: "Generates a QR code as an SVG string for a contribution",
      schema: z.object({
        contractAddress: z.string(),
        amountInEth: z.string()
      }),
      func: async (input) => {
        try {
          const { contractAddress, amountInEth } = input;
          const valueInWei = ethers.parseEther(amountInEth).toString();
          const data = `ethereum:${contractAddress}?value=${valueInWei}`;
          // Generate as an SVG string for crisp rendering
          return await QRCode.toString(data, {
            type: "svg",
            width: 256,
            margin: 1,
          });
        } catch (e: any) {
          console.error("Error generating QR code:", e);
          return `Error generating QR code: ${e.message}`;
        }
      },
    });

    const deployFundraiserTool = new DynamicStructuredTool({
      name: "deploy_fundraiser_contract",
      description: "Deploys a fundraising contract",
      schema: z.object({
        beneficiaryAddress: z.string(),
        goalAmount: z.string(),
        durationInSeconds: z.string()
      }),
      func: async (input) => {
        try {
          const { beneficiaryAddress, goalAmount, durationInSeconds } = input;

          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          const wallet = new ethers.Wallet(WALLET_KEY, provider);
          const factory = new ethers.ContractFactory(contractAbi, contractBytecode, wallet);

          const goalInWei = ethers.parseEther(goalAmount);
          const deployedContract = await factory.deploy(beneficiaryAddress, goalInWei, durationInSeconds);
          const tx = deployedContract.deploymentTransaction();
          if (!tx) {
            throw new Error("Deployment transaction not found.");
          }
          await deployedContract.waitForDeployment();
          const contractAddress = await deployedContract.getAddress();

          return {
            contractAddress: contractAddress,
            transactionHash: tx.hash,
          };
        } catch (e: any) {
          console.error("Error deploying contract:", e);
          return `Error deploying contract: ${e.message}`;
        }
      },
    });

    const getFundraiserContributorsTool = new DynamicStructuredTool({
      name: "get_fundraiser_contributors",
      description: "Get the list of contributors for a fundraiser",
      schema: z.object({
        contractAddress: z.string()
      }),
      func: async (input) => {
        try {
          const { contractAddress } = input;
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          
          const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);

          const contributorAddresses = await fundraiserContract.getContributors();
          
          if (contributorAddresses.length === 0) {
            return "No contributions have been made to this fundraiser yet.";
          }

          const contributorsWithEns = await Promise.all(
            contributorAddresses.map(async (address: string) => {
              try {
                // Use a generic provider for ENS lookup as it's on mainnet
                const mainnetProvider = new ethers.JsonRpcProvider("https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161"); // public endpoint
                const ensName = await mainnetProvider.lookupAddress(address);
                return { address, ensName: ensName || "No ENS name" };
              } catch (e) {
                console.warn(`Could not resolve ENS for ${address}:`, e);
                return { address, ensName: "No ENS name" };
              }
            })
          );
          
          return `Contributors:\n${contributorsWithEns.map(c => `- ${c.ensName} (${c.address})`).join('\n')}`;
        } catch (e: any) {
          console.error("Error getting contributors:", e);
          return `Error getting contributors: ${e.message}`;
        }
      },
    });
    
    const checkFundraiserStatusTool = new DynamicStructuredTool({
      name: "check_fundraiser_status",
      description: "Checks if a fundraiser is still active",
      schema: z.object({
        contractAddress: z.string()
      }),
      func: async (input) => {
        try {
          const { contractAddress } = input;
          const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
          
          const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);
          
          const isActive = await fundraiserContract.isFundraiserActive();
          return isActive ? "This fundraiser is still active." : "This fundraiser has ended and can no longer accept contributions.";
        } catch (e: any) {
          console.error("Error checking fundraiser status:", e);
          return `Error checking status: ${e.message}`;
        }
      },
    });

    tools.push(deployFundraiserTool, qrCodeTool, getFundraiserContributorsTool, checkFundraiserStatusTool);

    for (const tool of tools) {
      const originalInvoke = tool.invoke;
      tool.invoke = async (input: any) => {
        try {
          const result = await originalInvoke.call(tool, input);
          let txHash: string | undefined;

          // Special handling for our custom deploy tool
          if (tool.name === 'deploy_fundraiser_contract' && typeof result === 'object' && result !== null && 'contractAddress' in result && 'transactionHash' in result) {
            txHash = result.transactionHash;
            const scannerUrl = `https://sepolia.basescan.org/tx/${txHash}`;
            return `Successfully deployed fundraising contract. Address: ${result.contractAddress}\n\nView on block explorer: ${scannerUrl}`;
          }

          // Generic handling for AgentKit and other tools
          let resultString = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          
          if (typeof result === 'object' && result !== null && 'transactionHash' in result) {
            txHash = (result as { transactionHash: string }).transactionHash;
          } else if (typeof result === 'string' && result.startsWith('0x') && result.length === 66) {
            txHash = result;
          } else if (typeof result === 'object' && result !== null && 'tx_hash' in result) {
            txHash = (result as { tx_hash: string }).tx_hash;
          }
          
          if (txHash) {
              const scannerUrl = `https://sepolia.basescan.org/tx/${txHash}`;
              resultString += `\n\nView on block explorer: ${scannerUrl}`;
          }

          return resultString;
        } catch (e: any) {
          console.error(`Error in tool ${tool.name}:`, e);
          return `Error executing tool ${tool.name}: ${e.message}`;
        }
      };
    }

    memoryStore[userId] = new MemorySaver();

    const agentConfig: AgentConfig = {
      configurable: { thread_id: userId },
    };

    const agent = await createReactAgent({
      llm,
      tools
    });

    return { agent, config: agentConfig };
  } catch (error: any) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

// Process messages with better error handling
async function processMessage(agent: Agent, config: AgentConfig, message: string): Promise<string> {
  try {
    console.log(`🤔 Processing: "${message}"`);
    const response = await agent.invoke(
      { messages: [new HumanMessage(message)] },
      config,
    );
    
    const responseContent = response.messages[response.messages.length - 1].content as string;
    console.log(`🤖 Response generated: ${responseContent.slice(0, 100)}...`);
    
    return responseContent;
  } catch (error: any) {
    console.error("Error processing message:", error);
    
    if (error.message.includes('insufficient funds')) {
      return `❌ Insufficient funds! Please make sure you have enough ETH in your wallet for this transaction. You can get testnet ETH from the Base Sepolia faucet.`;
    } else if (error.message.includes('invalid address')) {
      return `❌ Invalid address format! Please provide a valid Ethereum address (starting with 0x) or ENS name.`;
    } else if (error.message.includes('network')) {
      return `❌ Network error! Please check your connection and try again.`;
    }
    
    return `❌ Sorry, I encountered an error: ${error.message}. Please try again or rephrase your request.`;
  }
}

// Handle incoming messages as a request/response function
async function handleMessage(messageContent: string, senderAddress: string, client: Client): Promise<string> {
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
    const response = await processMessage(agent, config, messageContent);
    
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
    
    console.log("🔧 Initializing XMTP Client...");
    const client = await initializeXmtpClient();
    
    console.log("🎯 Agent is ready and listening for API requests!");
    console.log(`📍 Agent address: ${client.inboxId}`);
    console.log(`🌐 Network: ${XMTP_ENV}`);
    console.log(`⛓️  Blockchain: ${NETWORK_ID}`);
    
    // Return the client and handler for the API server
    return {
      client,
      handleMessage: (message: string, userId: string) => handleMessage(message, userId, client),
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