import { getRandomValues } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fromString, toString } from "uint8arrays";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toBytes } from "./encoding.js";
export const createUser = (key) => {
    const account = privateKeyToAccount(key);
    return {
        key: key,
        account,
        wallet: createWalletClient({
            account,
            chain: base,
            transport: http(),
        }),
    };
};
export const createSigner = (key) => {
    const sanitizedKey = key.startsWith("0x") ? key : `0x${key}`;
    const user = createUser(sanitizedKey);
    const address = user.account.address.toLowerCase();
    return {
        type: "EOA",
        async signMessage(message) {
            const signature = await user.wallet.signMessage({
                message,
                account: user.account,
            });
            return toBytes(signature);
        },
        async getIdentifier() {
            return {
                identifierKind: 0 /* IdentifierKind.Ethereum */,
                identifier: address
            };
        }
    };
};
/**
 * Generate a random encryption key
 * @returns The encryption key as a hex string with 0x prefix
 */
export const generateEncryptionKeyHex = () => {
    /* Generate a random 32-byte encryption key */
    const uint8Array = getRandomValues(new Uint8Array(32));
    /* Convert the encryption key to a hex string */
    const hex = toString(uint8Array, "hex");
    return `0x${hex}`;
};
/**
 * Get the encryption key from a hex string
 * @param hex - The hex string
 * @returns The encryption key
 * @throws Error if the key is not exactly 32 bytes (64 hex characters without 0x prefix)
 */
export const getEncryptionKeyFromHex = (hex) => {
    /* Clean and convert the hex string to lowercase */
    const cleanHex = hex.trim().toLowerCase();
    const sanitizedHex = cleanHex.startsWith("0x") ? cleanHex.slice(2) : cleanHex;
    /* Validate hex string length (32 bytes = 64 hex characters) */
    if (sanitizedHex.length !== 64) {
        throw new Error(`Encryption key must be exactly 32 bytes (64 hex characters). Got ${sanitizedHex.length} characters.`);
    }
    /* Validate that it's a valid hex string */
    if (!/^[0-9a-f]{64}$/.test(sanitizedHex)) {
        throw new Error("Invalid hexadecimal characters in encryption key");
    }
    /* Convert the hex string to an encryption key */
    return fromString(sanitizedHex, "hex");
};
export const getDbPath = (description = "xmtp") => {
    //Checks if the environment is a Railway deployment
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";
    // Create database directory if it doesn't exist
    if (!fs.existsSync(volumePath)) {
        fs.mkdirSync(volumePath, { recursive: true });
    }
    return `${volumePath}/${description}.db3`;
};
export const logAgentDetails = async (clients) => {
    const clientArray = Array.isArray(clients) ? clients : [clients];
    const clientsByAddress = clientArray.reduce((acc, client) => {
        const address = client.accountIdentifier?.identifier;
        acc[address] = acc[address] ?? [];
        acc[address].push(client);
        return acc;
    }, {});
    for (const [address, clientGroup] of Object.entries(clientsByAddress)) {
        const firstClient = clientGroup[0];
        const inboxId = firstClient.inboxId;
        const environments = clientGroup
            .map((c) => c.options?.env ?? "dev")
            .join(", ");
        console.log(`\x1b[38;2;252;76;52m
        ██╗  ██╗███╗   ███╗████████╗██████╗ 
        ╚██╗██╔╝████╗ ████║╚══██╔══╝██╔══██╗
         ╚███╔╝ ██╔████╔██║   ██║   ██████╔╝
         ██╔██╗ ██║╚██╔╝██║   ██║   ██╔═══╝ 
        ██╔╝ ██╗██║ ╚═╝ ██║   ██║   ██║     
        ╚═╝  ╚═╝╚═╝     ╚═╝   ╚═╝   ╚═╝     
      \x1b[0m`);
        const urls = [`http://xmtp.chat/dm/${address}`];
        const conversations = await firstClient.conversations.list();
        const installations = await firstClient.preferences.inboxState();
        console.log(`
    ✓ XMTP Client:
    • Address: ${address}
    • Installations: ${installations.installations.length}
    • Conversations: ${conversations.length}
    • InboxId: ${inboxId}
    • Networks: ${environments}
    ${urls.map((url) => `• URL: ${url}`).join("\n")}`);
    }
};
export function validateEnvironment(vars) {
    const missing = vars.filter((v) => !process.env[v]);
    if (missing.length) {
        try {
            const envPath = path.resolve(process.cwd(), ".env");
            if (fs.existsSync(envPath)) {
                const envVars = fs
                    .readFileSync(envPath, "utf-8")
                    .split("\n")
                    .filter((line) => line.trim() && !line.startsWith("#"))
                    .reduce((acc, line) => {
                    const [key, ...val] = line.split("=");
                    if (key && val.length)
                        acc[key.trim()] = val.join("=").trim();
                    return acc;
                }, {});
                missing.forEach((v) => {
                    if (envVars[v])
                        process.env[v] = envVars[v];
                });
            }
        }
        catch (e) {
            console.error(e);
            /* ignore errors */
        }
        const stillMissing = vars.filter((v) => !process.env[v]);
        if (stillMissing.length) {
            console.error("Missing env vars:", stillMissing.join(", "));
            process.exit(1);
        }
    }
    return vars.reduce((acc, key) => {
        acc[key] = process.env[key];
        return acc;
    }, {});
}
