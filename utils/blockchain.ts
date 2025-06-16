import QRCode from 'qrcode';
import { ethers } from "ethers";

// Helper function to generate Base Sepolia scan links
export const generateBaseScanLink = (
  hash: string, 
  type: 'tx' | 'address' | 'token' = 'tx'
): string => {
  const baseUrl = 'https://sepolia.basescan.org';
  switch (type) {
    case 'tx':
      return `${baseUrl}/tx/${hash}`;
    case 'address':
      return `${baseUrl}/address/${hash}`;
    case 'token':
      return `${baseUrl}/token/${hash}`;
    default:
      return `${baseUrl}/search?q=${hash}`;
  }
};

// Validate transaction hash format
export const isValidTxHash = (hash: string): boolean => {
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
};

// Validate Ethereum address format
export const isValidAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

// Core QR Code Generation Function - PNG FORMAT FOR WALLET COMPATIBILITY
export const generateQRCode = async (
  data: string, 
  description: string = "QR Code"
): Promise<string> => {
  try {
    // Generate QR code as PNG for maximum wallet compatibility
    const qrPngBuffer = await QRCode.toBuffer(data, {
      type: 'png',
      width: 300,
      margin: 4,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      errorCorrectionLevel: 'H' // High error correction for reliability
    });
    
    // Convert PNG buffer to base64
    const base64Data = qrPngBuffer.toString('base64');
    
    // Return in markdown format for frontend detection
    return `![${description}](data:image/png;base64,${base64Data})`;
  } catch (error) {
    console.error('QR code generation failed:', error);
    return `[QR Code Generation Failed: ${description}]`;
  }
};

// Wallet Contribution QR Code - ENHANCED WITH EMOJIS & PNG FORMAT
export const generateContributionQR = async (
  walletAddress: string, 
  amount: string, 
  fundraiserName: string
): Promise<string> => {
  try {
    const amountInWei = ethers.parseEther(amount).toString();
    const paymentData = `ethereum:${walletAddress}?value=${amountInWei}`;
    const description = `Contribution QR for ${fundraiserName}`;
    
    const qrCode = await generateQRCode(paymentData, description);
    const contractLink = generateBaseScanLink(walletAddress, 'address');
    const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    
    return `
📱 **Scan to Contribute ${amount} ETH**

${qrCode}

🎯 **Fundraiser:** ${fundraiserName}
💰 **Amount:** ${amount} ETH
📍 **Contract:** [${shortAddress}](${contractLink})

---
✨ **How to Contribute:**
1. 📱 Open your mobile wallet (MetaMask, Trust Wallet, etc.)
2. 📷 Scan the QR code above
3. ✅ Confirm the transaction
4. 🎉 You're supporting ${fundraiserName}!

💡 **Tip:** Make sure you're connected to Base Sepolia network
`;
  } catch (error: any) {
    console.error('Error generating contribution QR:', error);
    return `❌ **QR Code Generation Failed**
I was unable to create the QR code for this contribution. Please try again.
*Error: ${error.message}*`;
  }
};

// Contract Interaction QR Code
export const generateContractQR = async (
  contractAddress: string,
  functionData: string,
  value?: string
): Promise<string> => {
  let ethData = `ethereum:${contractAddress}`;
  
  const params = [];
  if (functionData) params.push(`data=${functionData}`);
  if (value) params.push(`value=${value}`);
  
  if (params.length > 0) {
    ethData += `?${params.join('&')}`;
  }
  
  const qrCode = await generateQRCode(ethData, "Contract Interaction QR Code");
  
  return `Scan this QR code to interact with the contract:

${qrCode}

Contract Address: \`${contractAddress}\``;
};

// Transaction Response Formatting - STYLED
export const formatTransactionResponse = (
  txHash: string,
  action: string,
  details?: {
    blockNumber?: number;
    gasUsed?: string;
    gasPrice?: string;
    from?: string;
    to?: string;
    value?: string;
  }
): string => {
  if (!isValidTxHash(txHash)) {
    return `❌ **Invalid Transaction Hash**
The transaction hash \`${txHash}\` appears to be invalid.`;
  }

  const scanLink = generateBaseScanLink(txHash, 'tx');
  const shortHash = `${txHash.slice(0, 6)}...${txHash.slice(-4)}`;
  
  let response = `✅ **${action} Successful!**

🔗 **Transaction Hash:** \`${txHash}\`
   [View on Base Sepolia Scan](${scanLink})`;

  if (details) {
    response += `\n\n📋 **Transaction Details:**`;
    if (details.blockNumber) response += `\n- **Block Number**: ${details.blockNumber}`;
    if (details.gasUsed) response += `\n- **Gas Used**: ${details.gasUsed}`;
    if (details.gasPrice) response += `\n- **Gas Price**: ${details.gasPrice} gwei`;
    if (details.from) response += `\n- **From**: \`${details.from}\``;
    if (details.to) response += `\n- **To**: \`${details.to}\``;
    if (details.value) response += `\n- **Value**: ${details.value} ETH`;
  }

  return response;
};

// NEW: Deployment Response Formatter - ENHANCED WITH EMOJIS
export const formatDeployResponse = (
  contractAddress: string,
  txHash: string,
  fundraiserName: string,
  goalAmount: string,
  qrCode: string
): string => {
  const contractUrl = generateBaseScanLink(contractAddress, 'address');
  const txUrl = generateBaseScanLink(txHash, 'tx');
  const shortContract = `${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;
  const shortTx = `${txHash.slice(0, 6)}...${txHash.slice(-4)}`;

  return `
🎉 **"${fundraiserName}" Fundraiser is Live!**

Your fundraising smart contract has been successfully deployed on Base Sepolia! 🚀

---

📋 **Fundraiser Details:**
🎯 **Goal:** ${goalAmount} ETH
📄 **Contract:** [${shortContract}](${contractUrl})
🔗 **Transaction:** [${shortTx}](${txUrl})
🌐 **Network:** Base Sepolia

---

${qrCode}

---

🚀 **Next Steps:**
1. 📱 Share the QR code with potential contributors
2. 📊 Monitor contributions on [Base Sepolia Scan](${contractUrl})
3. 💬 Spread the word about your cause!

💡 **Pro Tip:** Contributors need Base Sepolia ETH. They can get it from faucets like [Base Sepolia Faucet](https://bridge.base.org/deposit).
  `;
}; 