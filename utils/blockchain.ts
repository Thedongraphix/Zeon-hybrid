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

// Core QR Code Generation Function - NOW USING PNG
export const generateQRCode = async (
  data: string, 
  description: string = "QR Code"
): Promise<string> => {
  try {
    // Generate QR code as PNG for better compatibility
    const qrPng = await QRCode.toDataURL(data, {
      type: 'image/png',
      width: 256,
      margin: 2,
      errorCorrectionLevel: 'M'
    });
    
    const base64Data = qrPng.split(',')[1];
    
    // Return as PNG image in markdown format
    return `![${description}](data:image/png;base64,${base64Data})`;
  } catch (error) {
    console.error('QR code generation failed:', error);
    return `[QR Code Generation Failed: ${description}]`;
  }
};

// Wallet Contribution QR Code - FIXED & STYLED
export const generateContributionQR = async (
  walletAddress: string, 
  amount: string, 
  fundraiserName: string
): Promise<string> => {
  const amountInWei = ethers.parseEther(amount).toString();
  const paymentData = `ethereum:${walletAddress}?value=${amountInWei}`;
  const description = `QR Code for ${fundraiserName} Contribution`;
  
  return generateQRCode(paymentData, description);
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

// Deployment Response Formatter - FIXED & STYLED
export const formatDeployResponse = (
  contractAddress: string,
  txHash: string,
  fundraiserName: string,
  goalAmount: string,
  qrCode: string
): string => {
  const contractUrl = generateBaseScanLink(contractAddress, 'address');
  const txUrl = generateBaseScanLink(txHash, 'tx');

  return `🎉 **Fundraiser "${fundraiserName}" is Live!**

Your new fundraising contract has been deployed.

**Details:**
- **Name:** ${fundraiserName}
- **Goal:** ${goalAmount} ETH
- **Contract:** [${contractAddress}](${contractUrl})
- **Transaction:** [${txHash}](${txUrl})

---

**Scan to Contribute**
${qrCode}

Share this QR code or the contract link to receive contributions.`;
}; 