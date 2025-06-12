import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { startAgent } from '../index.js';
const app = express();
const port = process.env.PORT || 3001;
app.get('/', (_req, res) => {
    res.send('Zeon Hybrid API is live!');
});
app.use(cors());
app.use(bodyParser.json());
let agentHandler;
async function initialize() {
    console.log('Initializing agent for API...');
    const agent = await startAgent();
    if (agent) {
        agentHandler = agent.handleMessage;
        console.log('✅ Agent initialized and ready for API requests.');
    }
    else {
        console.error('❌ Agent initialization failed.');
        process.exit(1);
    }
}
app.post('/api/chat', async (req, res) => {
    const { message, history, walletAddress } = req.body;
    if (!message || !walletAddress) {
        return res
            .status(400)
            .json({ error: 'Message and walletAddress are required' });
    }
    if (!agentHandler) {
        return res.status(503).json({ error: 'Agent is not initialized yet.' });
    }
    try {
        const agentResponse = await agentHandler(message, walletAddress, history || []);
        res.json({ response: agentResponse });
    }
    catch (error) {
        console.error('Error processing chat message:', error);
        res.status(500).json({ error: 'Failed to process message' });
    }
});
app.get('/api/chat', (_req, res) => {
    res.status(200).json({ status: 'ok' });
});
app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
    initialize();
});
