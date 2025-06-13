// Removed CDP imports as we're using direct ethers.js integration
import { createSigner, getEncryptionKeyFromHex, logAgentDetails, validateEnvironment, } from "./helpers/client.js";
import { AIMessage, HumanMessage, } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import fs from "node:fs";
import { Client } from "@xmtp/node-sdk";
import { ethers } from "ethers";
import contractArtifact from "./dist/CrowdFund.json" with { type: "json" };
import { generateBaseScanLink, isValidTxHash, isValidAddress, generateQRCode, generateContributionQR } from "./utils/blockchain.js";
const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV, NETWORK_ID, OPENROUTER_API_KEY, } = validateEnvironment([
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
const memoryStore = {};
const agentStore = {};
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
function saveWalletData(userId, walletData) {
    // NOTE: Using fs for storage is not suitable for Render's ephemeral filesystem.
    const localFilePath = `${WALLET_STORAGE_DIR}/${userId}.json`;
    try {
        if (!fs.existsSync(localFilePath)) {
            console.log(`💾 Wallet data saved for user ${userId}`);
            fs.writeFileSync(localFilePath, walletData);
        }
    }
    catch (error) {
        console.error(`Failed to save wallet data: ${error}`);
    }
}
function getWalletData(userId) {
    const localFilePath = `${WALLET_STORAGE_DIR}/${userId}.json`;
    try {
        if (fs.existsSync(localFilePath)) {
            return fs.readFileSync(localFilePath, "utf8");
        }
    }
    catch (error) {
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
        env: XMTP_ENV,
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
async function initializeAgent(userId, client) {
    try {
        const llm = new ChatOpenAI({
            modelName: "gpt-3.5-turbo",
            temperature: 0.7,
            maxRetries: 3,
            configuration: {
                baseURL: "https://openrouter.ai/api/v1",
                defaultHeaders: {
                    "HTTP-Referer": "https://github.com/yourusername/zeon-hybrid", // Replace with your site
                    "X-Title": "Zeon Hybrid Agent"
                }
            },
            apiKey: OPENROUTER_API_KEY
        });
        const tools = [];
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
                    // Validate contract address
                    if (!isValidAddress(contractAddress)) {
                        return `❌ Invalid contract address format: ${contractAddress}`;
                    }
                    const valueInWei = ethers.parseEther(amountInEth).toString();
                    const paymentData = `ethereum:${contractAddress}?value=${valueInWei}`;
                    // Generate QR code using utility function
                    const qrCode = await generateQRCode(paymentData, "Contribution QR Code");
                    // Add contract link
                    const contractScanLink = generateBaseScanLink(contractAddress, 'address');
                    return `Here is the QR code for contributing ${amountInEth} ETH to the fundraiser for "${fundraiserName}":

${qrCode}

You can scan this with your mobile wallet to contribute.

🔍 **View Contract:** [${contractAddress.slice(0, 10)}...${contractAddress.slice(-8)}](${contractScanLink})`;
                }
                catch (e) {
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
                fundraiserName: z.string().optional()
            }),
            func: async (input) => {
                try {
                    const { beneficiaryAddress, goalAmount, durationInSeconds, fundraiserName } = input;
                    // Validate beneficiary address
                    if (!isValidAddress(beneficiaryAddress)) {
                        return `❌ Invalid beneficiary address format: ${beneficiaryAddress}`;
                    }
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
                    // Generate contribution QR code for the new contract
                    const contributionQR = await generateContributionQR(contractAddress, "0.01", // Default contribution amount
                    fundraiserName || "Fundraiser");
                    return {
                        contractAddress: contractAddress,
                        transactionHash: tx.hash,
                        qrCode: contributionQR,
                        fundraiserName: fundraiserName || "Fundraiser"
                    };
                }
                catch (e) {
                    console.error("Error deploying contract:", e);
                    return `❌ Error deploying contract: ${e.message}`;
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
                    // Validate contract address
                    if (!isValidAddress(contractAddress)) {
                        return `❌ Invalid contract address format: ${contractAddress}`;
                    }
                    const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
                    const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);
                    const contributorAddresses = await fundraiserContract.getContributors();
                    if (contributorAddresses.length === 0) {
                        const contractScanLink = generateBaseScanLink(contractAddress, 'address');
                        return `No contributions have been made to this fundraiser yet.

🔍 **View Contract:** [${contractAddress.slice(0, 10)}...${contractAddress.slice(-8)}](${contractScanLink})`;
                    }
                    const contributorsWithEns = await Promise.all(contributorAddresses.map(async (address) => {
                        try {
                            // Use a generic provider for ENS lookup as it's on mainnet
                            const mainnetProvider = new ethers.JsonRpcProvider("https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161"); // public endpoint
                            const ensName = await mainnetProvider.lookupAddress(address);
                            return { address, ensName: ensName || "N/A" };
                        }
                        catch (e) {
                            console.warn(`Could not resolve ENS for ${address}:`, e);
                            return { address, ensName: "N/A" };
                        }
                    }));
                    const contributorList = contributorsWithEns.map(c => {
                        const addressScanLink = generateBaseScanLink(c.address, 'address');
                        return `- **${c.ensName}**: [\`${c.address}\`](${addressScanLink})`;
                    }).join('\n');
                    const contractScanLink = generateBaseScanLink(contractAddress, 'address');
                    return `**Contributors for fundraiser:**

${contributorList}

🔍 **View Contract:** [${contractAddress.slice(0, 10)}...${contractAddress.slice(-8)}](${contractScanLink})`;
                }
                catch (e) {
                    console.error("Error getting contributors:", e);
                    return `❌ Error getting contributors: ${e.message}`;
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
                    // Validate contract address
                    if (!isValidAddress(contractAddress)) {
                        return `❌ Invalid contract address format: ${contractAddress}`;
                    }
                    const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
                    const fundraiserContract = new ethers.Contract(contractAddress, contractAbi, provider);
                    const isActive = await fundraiserContract.isFundraiserActive();
                    const statusMessage = isActive
                        ? "✅ This fundraiser is still **active**."
                        : "❌ This fundraiser has **ended** and can no longer accept contributions.";
                    const contractScanLink = generateBaseScanLink(contractAddress, 'address');
                    return `**Fundraiser Status:**

${statusMessage}

🔍 **View Contract:** [${contractAddress.slice(0, 10)}...${contractAddress.slice(-8)}](${contractScanLink})`;
                }
                catch (e) {
                    console.error("Error checking fundraiser status:", e);
                    return `❌ Error checking status: ${e.message}`;
                }
            },
        });
        const checkWalletBalanceTool = new DynamicStructuredTool({
            name: "check_wallet_balance",
            description: "Checks the balance of an Ethereum wallet address",
            schema: z.object({
                address: z.string()
            }),
            func: async (input) => {
                try {
                    const { address } = input;
                    // Validate wallet address
                    if (!isValidAddress(address)) {
                        return `❌ Invalid wallet address format: ${address}`;
                    }
                    const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
                    const balance = await provider.getBalance(address);
                    const balanceInEth = ethers.formatEther(balance);
                    const addressScanLink = generateBaseScanLink(address, 'address');
                    return `**Wallet Balance:**

- **Address:** [\`${address}\`](${addressScanLink})
- **Balance:** \`${balanceInEth}\` ETH (on Base Sepolia)

🔍 **View on Block Explorer:** [${address.slice(0, 10)}...${address.slice(-8)}](${addressScanLink})`;
                }
                catch (e) {
                    console.error("Error checking wallet balance:", e);
                    return `❌ Error checking wallet balance: ${e.message}`;
                }
            },
        });
        tools.push(deployFundraiserTool, qrCodeTool, getFundraiserContributorsTool, checkFundraiserStatusTool, checkWalletBalanceTool);
        for (const tool of tools) {
            const originalInvoke = tool.invoke;
            tool.invoke = async (input) => {
                try {
                    const result = await originalInvoke.call(tool, input);
                    let txHash;
                    // Special handling for our custom deploy tool
                    if (tool.name === 'deploy_fundraiser_contract' && typeof result === 'object' && result !== null && 'contractAddress' in result && 'transactionHash' in result) {
                        const txHashValue = result.transactionHash;
                        // Validate transaction hash
                        if (!isValidTxHash(txHashValue)) {
                            return `❌ Invalid transaction hash received: ${txHashValue}`;
                        }
                        const txScannerUrl = generateBaseScanLink(txHashValue, 'tx');
                        const contractScannerUrl = generateBaseScanLink(result.contractAddress, 'address');
                        const shortTxHash = `${txHashValue.slice(0, 10)}...${txHashValue.slice(-8)}`;
                        let response = `🎉 Successfully deployed the fundraiser contract!

**Contract Address:** [\`${result.contractAddress}\`](${contractScannerUrl})

**Transaction Hash:** [\`${shortTxHash}\`](${txScannerUrl})

🔍 **View on Base Sepolia Scan:**
- [Contract Details](${contractScannerUrl})
- [Deployment Transaction](${txScannerUrl})`;
                        // Include QR code if available
                        if ('qrCode' in result && result.qrCode) {
                            response += `\n\n${result.qrCode}`;
                        }
                        return response;
                    }
                    // Generic handling for AgentKit and other tools
                    let resultString = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                    // Extract transaction hash from various possible formats
                    if (typeof result === 'object' && result !== null && 'transactionHash' in result) {
                        txHash = result.transactionHash;
                    }
                    else if (typeof result === 'string' && result.startsWith('0x') && result.length === 66) {
                        txHash = result;
                    }
                    else if (typeof result === 'object' && result !== null && 'tx_hash' in result) {
                        txHash = result.tx_hash;
                    }
                    // Add transaction link if valid hash found
                    if (txHash && isValidTxHash(txHash)) {
                        const scannerUrl = generateBaseScanLink(txHash, 'tx');
                        const shortTxHash = `${txHash.slice(0, 10)}...${txHash.slice(-8)}`;
                        resultString += `\n\n🔍 **View on Base Sepolia Scan:** [${shortTxHash}](${scannerUrl})`;
                    }
                    return resultString;
                }
                catch (e) {
                    console.error(`Error in tool ${tool.name}:`, e);
                    return `❌ Error executing tool ${tool.name}: ${e.message}`;
                }
            };
        }
        memoryStore[userId] = new MemorySaver();
        const agentConfig = {
            configurable: { thread_id: userId },
        };
        const agent = await createReactAgent({
            llm,
            tools
        });
        return { agent, config: agentConfig };
    }
    catch (error) {
        console.error("Failed to initialize agent:", error);
        throw error;
    }
}
// Process messages with better error handling
async function processMessage(agent, config, message, history = []) {
    try {
        console.log(`🤔 Processing: "${message}" with history of length ${history.length}`);
        const messages = history.map((msg) => msg.role === "user"
            ? new HumanMessage(msg.content)
            : new AIMessage(msg.content));
        messages.push(new HumanMessage(message));
        const response = (await agent.invoke({ messages }, config));
        const responseContent = response.messages[response.messages.length - 1].content;
        console.log(`🤖 Response generated: ${responseContent.slice(0, 100)}...`);
        return responseContent;
    }
    catch (error) {
        console.error("Error processing message:", error);
        if (error.message.includes("401")) {
            console.error("OpenRouter authentication error:", error);
            return `❌ Authentication error with AI service. Please check the API configuration.`;
        }
        else if (error.message.includes("insufficient funds")) {
            return `❌ Insufficient funds! Please make sure you have enough ETH in your wallet for this transaction. You can get testnet ETH from the Base Sepolia faucet.`;
        }
        else if (error.message.includes("invalid address")) {
            return `❌ Invalid address format! Please provide a valid Ethereum address (starting with 0x) or ENS name.`;
        }
        else if (error.message.includes("network")) {
            return `❌ Network error! Please check your connection and try again.`;
        }
        return `❌ Sorry, I encountered an error: ${error.message}. Please try again or rephrase your request.`;
    }
}
// Handle incoming messages as a request/response function
async function handleMessage(messageContent, senderAddress, client, history = []) {
    let conversation = null;
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
        }
        else {
            config = { configurable: { thread_id: senderAddress } };
        }
        // Process the message
        const response = await processMessage(agent, config, messageContent, history);
        console.log(`🤖 Sending response to ${senderAddress}`);
        return response;
    }
    catch (error) {
        console.error("Error handling message:", error);
        // Try to send error message back to user
        try {
            if (conversation) {
                await conversation.send("❌ Sorry, I'm having technical difficulties. Please try again in a moment!");
            }
        }
        catch (sendError) {
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
            handleMessage: (message, userId, history = []) => handleMessage(message, userId, client, history),
        };
    }
    catch (error) {
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
