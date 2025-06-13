import QRCode from 'qrcode';

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

// Core QR Code Generation Function
export const generateQRCode = async (
  data: string, 
  description: string = "QR Code"
): Promise<string> => {
  try {
    // Generate QR code as SVG for crisp display
    const qrSvg = await QRCode.toString(data, {
      type: 'svg',
      width: 256,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      errorCorrectionLevel: 'M'
    });
    
    // Convert SVG to base64
    const base64Data = Buffer.from(qrSvg).toString('base64');
    
    // Return in markdown format for frontend detection
    return `![${description}](data:image/svg+xml;base64,${base64Data})`;
  } catch (error) {
    console.error('QR code generation failed:', error);
    return `[QR Code Generation Failed: ${description}]`;
  }
};

// Wallet Contribution QR Code
export const generateContributionQR = async (
  walletAddress: string, 
  amount: string, 
  fundraiserName: string
): Promise<string> => {
  // EIP-681 format for wallet compatibility
  const paymentData = `ethereum:${walletAddress}?value=${amount}`;
  const description = `Contribution QR Code`;
  
  const qrCode = await generateQRCode(paymentData, description);
  
  return `Here is the QR code for contributing ${amount} ETH to the fundraiser for "${fundraiserName}":

${qrCode}

You can scan this with your mobile wallet to contribute.`;
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

// Transaction Response Formatting
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
    throw new Error('Invalid transaction hash format');
  }

  const scanLink = generateBaseScanLink(txHash, 'tx');
  const shortHash = `${txHash.slice(0, 10)}...${txHash.slice(-8)}`;
  
  let response = `✅ ${action} completed successfully!

**Transaction Hash:** \`${txHash}\`

🔍 **View on Base Sepolia Scan:** [${shortHash}](${scanLink})`;

  if (details) {
    response += `\n\n**Transaction Details:**`;
    if (details.blockNumber) response += `\n- **Block Number:** ${details.blockNumber}`;
    if (details.gasUsed) response += `\n- **Gas Used:** ${details.gasUsed}`;
    if (details.gasPrice) response += `\n- **Gas Price:** ${details.gasPrice} gwei`;
    if (details.from) response += `\n- **From:** \`${details.from}\``;
    if (details.to) response += `\n- **To:** \`${details.to}\``;
    if (details.value) response += `\n- **Value:** ${details.value} ETH`;
  }

  return response;
}; 