import fs from 'fs';
import path from 'path';
import solc from 'solc';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const contractPath = path.resolve(__dirname, 'CrowdFund.sol');
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'CrowdFund.sol': {
      content: source,
    },
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['*'],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const contractArtifact = output.contracts['CrowdFund.sol']['CrowdFund'];

const artifact = {
  abi: contractArtifact.abi,
  bytecode: contractArtifact.evm.bytecode.object,
};

const artifactPath = path.resolve(__dirname, 'dist', 'CrowdFund.json');
const distDir = path.dirname(artifactPath);

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

console.log('✅ CrowdFund contract compiled and artifact saved to dist/CrowdFund.json'); 