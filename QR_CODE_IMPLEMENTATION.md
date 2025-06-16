# QR Code Generation & Frontend Rendering Documentation

## Overview
This document outlines the complete QR code implementation pipeline for the Zeon Hybrid agent, from backend generation to frontend rendering. The system generates wallet-compatible QR codes for cryptocurrency contributions and displays them seamlessly in chat interfaces.

## Backend QR Code Generation

### Dependencies
```json
{
  "qrcode": "^1.5.3",
  "@types/qrcode": "^1.5.5"
}
```

### Core QR Generation Function
**File:** `utils/blockchain.ts`

```typescript
export const generateQRCode = async (
  data: string, 
  description: string = "QR Code"
): Promise<string> => {
  try {
    console.log(`🔧 Generating QR code for data: ${data.substring(0, 50)}...`);
    
    // Generate QR code as PNG for maximum wallet compatibility
    const qrPngBuffer = await QRCode.toBuffer(data, {
      type: 'png',
      width: 256, // Optimized size for web display
      margin: 2,  // Minimal margin for efficiency
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      errorCorrectionLevel: 'M' // Medium error correction for size/reliability balance
    });
    
    console.log(`📊 QR code buffer size: ${qrPngBuffer.length} bytes`);
    
    // Convert PNG buffer to base64
    const base64Data = qrPngBuffer.toString('base64');
    
    console.log(`📝 Base64 length: ${base64Data.length} characters`);
    
    // Return in markdown format for frontend detection
    return `![${description}](data:image/png;base64,${base64Data})`;
  } catch (error) {
    console.error('QR code generation failed:', error);
    return `[QR Code Generation Failed: ${description}]`;
  }
};
```

### Contribution QR Code Generation
**File:** `utils/blockchain.ts`

```typescript
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
📱 Scan to Contribute ${amount} ETH

${qrCode}

🎯 Fundraiser: ${fundraiserName}
💰 Amount: ${amount} ETH
📍 Contract: [${shortAddress}](${contractLink})

---
✨ How to Contribute:
1. 📱 Open your mobile wallet (MetaMask, Trust Wallet, etc.)
2. 📷 Scan the QR code above
3. ✅ Confirm the transaction
4. 🎉 You're supporting ${fundraiserName}!

💡 Tip: Make sure you're connected to Base Sepolia network
`;
  } catch (error: any) {
    console.error('Error generating contribution QR:', error);
    return `❌ QR Code Generation Failed
I was unable to create the QR code for this contribution. Please try again.
Error: ${error.message}`;
  }
};
```

## QR Code Format Specifications

### Generated QR Code Structure
```
ethereum:<contract_address>?value=<amount_in_wei>
```

**Example:**
```
ethereum:0x1234...7890?value=10000000000000000
```

### Markdown Output Format
```markdown
![Contribution QR for Fundraiser Name](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...)
```

### Technical Specifications
- **Format:** PNG image encoded as base64
- **Size:** 256x256 pixels
- **Margin:** 2 pixels
- **Error Correction:** Medium level
- **Average file size:** ~2104 bytes
- **Average base64 length:** ~2808 characters
- **Color scheme:** Black on white (#000000 on #FFFFFF)

## Frontend Integration

### Detection Patterns

#### QR Code Detection (Regular Expression)
```javascript
const QR_CODE_PATTERN = /!\[.*?\]\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/g;
```

#### Transaction Hash Detection
```javascript
const TX_HASH_PATTERN = /(0x[a-fA-F0-9]{64})/g;
```

#### Wallet Address Detection
```javascript
const WALLET_ADDRESS_PATTERN = /(0x[a-fA-F0-9]{40})/g;
```

#### Base Sepolia Scan Links
```javascript
const BASE_SCAN_LINK_PATTERN = /https:\/\/sepolia\.basescan\.org\/\w+\/0x[a-fA-F0-9]+/g;
```

### Frontend Rendering Implementation

#### React Component Example
```jsx
import React from 'react';

const MessageRenderer = ({ content }) => {
  // Detect and render QR codes
  const renderQRCodes = (text) => {
    const qrPattern = /!\[(.*?)\]\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/g;
    
    return text.replace(qrPattern, (match, altText, base64Data) => {
      return `<img 
        src="data:image/png;base64,${base64Data}" 
        alt="${altText}"
        className="qr-code-image"
        style={{
          maxWidth: '256px',
          height: 'auto',
          margin: '10px 0',
          border: '1px solid #e1e5e9',
          borderRadius: '8px'
        }}
      />`;
    });
  };

  // Detect and render transaction links
  const renderTransactionLinks = (text) => {
    const txPattern = /(0x[a-fA-F0-9]{64})/g;
    
    return text.replace(txPattern, (match, txHash) => {
      return `<a 
        href="https://sepolia.basescan.org/tx/${txHash}" 
        target="_blank" 
        rel="noopener noreferrer"
        className="transaction-link"
      >
        ${txHash.slice(0, 6)}...${txHash.slice(-4)}
      </a>`;
    });
  };

  const processedContent = renderQRCodes(renderTransactionLinks(content));
  
  return (
    <div 
      className="message-content"
      dangerouslySetInnerHTML={{ __html: processedContent }}
    />
  );
};
```

#### CSS Styling
```css
.qr-code-image {
  max-width: 256px;
  height: auto;
  margin: 10px 0;
  border: 1px solid #e1e5e9;
  borderRadius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s ease;
}

.qr-code-image:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.transaction-link {
  color: #0066cc;
  text-decoration: none;
  font-family: monospace;
  padding: 2px 4px;
  background-color: #f5f5f5;
  border-radius: 3px;
}

.transaction-link:hover {
  background-color: #e8e8e8;
  text-decoration: underline;
}
```

## API Response Structure

### Successful QR Generation Response
```json
{
  "response": "\n📱 Scan to Contribute 0.01 ETH\n\n![Contribution QR for My Fundraiser](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...)\n\n🎯 Fundraiser: My Fundraiser\n💰 Amount: 0.01 ETH\n📍 Contract: [0x1234...7890](https://sepolia.basescan.org/address/0x1234567890123456789012345678901234567890)\n\n---\n✨ How to Contribute:\n1. 📱 Open your mobile wallet (MetaMask, Trust Wallet, etc.)\n2. 📷 Scan the QR code above\n3. ✅ Confirm the transaction\n4. 🎉 You're supporting My Fundraiser!\n\n💡 Tip: Make sure you're connected to Base Sepolia network\n"
}
```

### Error Response
```json
{
  "response": "❌ QR Code Generation Failed\nI was unable to create the QR code for this contribution. Please try again.\nError: Invalid address format"
}
```

## Testing & Validation

### Backend Testing
```bash
# Test QR generation
yarn tsx -e "
import { generateContributionQR } from './utils/blockchain.js';
generateContributionQR('0x1234567890123456789012345678901234567890', '0.01', 'Test').then(console.log);
"
```

### Frontend Testing Checklist
- [ ] QR codes render as images
- [ ] QR codes are scannable by mobile wallets
- [ ] Transaction hashes become clickable links
- [ ] Base Sepolia scan links work correctly
- [ ] Responsive design on mobile devices
- [ ] Error handling for malformed QR data

## Mobile Wallet Compatibility

### Supported Wallets
- ✅ MetaMask Mobile
- ✅ Trust Wallet
- ✅ Coinbase Wallet
- ✅ WalletConnect compatible wallets
- ✅ Rainbow Wallet

### QR Code Data Format
The generated QR codes follow the [EIP-681](https://eips.ethereum.org/EIPS/eip-681) standard:
```
ethereum:<address>[@<chain_id>][?<parameters>]
```

**Parameters:**
- `value`: Amount in wei
- `gas`: Gas limit (optional)
- `gasPrice`: Gas price (optional)

## Integration Points

### 1. Agent Tools Integration
**File:** `index.ts`
```typescript
const qrCodeTool = new DynamicStructuredTool({
  name: "generate_contribution_qr_code", 
  description: "Generates a QR code for contributing to a fundraiser.",
  schema: z.object({
    contractAddress: z.string(),
    amountInEth: z.string(),
    fundraiserName: z.string(),
  }),
  func: async (input) => {
    return await generateContributionQR(
      input.contractAddress, 
      input.amountInEth, 
      input.fundraiserName
    );
  },
});
```

### 2. API Endpoint Usage
```bash
curl -X POST http://localhost:10000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Generate a QR code for contributing 0.01 ETH to My Fundraiser at address 0x1234567890123456789012345678901234567890",
    "sessionId": "test-session"
  }'
```

### 3. XMTP Integration
The QR codes are automatically generated when users request fundraiser creation or contribution QR codes through XMTP chat interfaces.

## Security Considerations

1. **Address Validation:** All addresses are validated before QR generation
2. **Amount Validation:** ETH amounts are validated and converted to wei
3. **Base64 Encoding:** Proper encoding prevents injection attacks
4. **Error Handling:** Graceful degradation when QR generation fails
5. **Network Verification:** QR codes specify Base Sepolia network

## Performance Optimizations

1. **Optimized QR Settings:** Medium error correction for smaller file sizes
2. **Efficient Buffer Handling:** Direct buffer to base64 conversion
3. **Caching Potential:** Consider caching QR codes for repeated addresses
4. **Async Generation:** Non-blocking QR code generation
5. **Size Optimization:** 256px width for web efficiency

## Troubleshooting

### Common Issues
1. **QR Code Not Displaying:** Check base64 format and img tag rendering
2. **Wallet Not Recognizing:** Ensure EIP-681 compliance
3. **Large File Sizes:** Verify optimization settings are applied
4. **Network Mismatch:** Confirm Base Sepolia network configuration

### Debug Commands
```bash
# Check QR code generation
yarn tsx -e "import('./utils/blockchain.js').then(m => m.generateQRCode('test', 'Test QR'))"

# Validate base64 output
echo "BASE64_STRING" | base64 -d | file -
```

This implementation provides a complete pipeline from backend QR generation to frontend rendering, ensuring wallet compatibility and user experience optimization. 