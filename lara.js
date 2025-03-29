const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const http = require('http');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const child_process = require('child_process');
const crypto = require('crypto');
const glob = require('glob');

// =============================================
// FUNÇÕES UTILITÁRIAS
// =============================================
function colorize(text, color) {
    const colors = {
        reset: "\x1b[0m",
        yellow: "\x1b[33m",
        green: "\x1b[32m",
        red: "\x1b[31m",
        magenta: "\x1b[35m",
        cyan: "\x1b[36m",
        blue: "\x1b[34m",
        white: "\x1b[37m"
    };
    return `${colors[color] || ''}${text}${colors.reset}`;
}

// =============================================
// NOVA FUNÇÃO: Verificar atualizações no GitHub
// =============================================
const checkForUpdates = async () => {
    try {
        const GITHUB_RAW_URL = "https://raw.githubusercontent.com/leandoo/lara/main/lara.js";
        const remoteResponse = await axios.get(GITHUB_RAW_URL);
        const remoteContent = remoteResponse.data;
        const remoteHash = crypto.createHash('sha256').update(remoteContent).digest('hex');
        const localContent = fs.readFileSync(__filename, 'utf-8');
        const localHash = crypto.createHash('sha256').update(localContent).digest('hex');
        return remoteHash !== localHash;
    } catch (error) {
        console.error('Erro ao verificar atualizações:', error);
        return false;
    }
};

// =============================================
// CONFIGURAÇÕES PRINCIPAIS
// =============================================
const config = {
    PORT: 5001,
    WEB_PORT: 5001,
    buffer: {
        maxTokens: 8192,
        maxChunkSize: 15000,
        chunkOverlap: 200,
        multilineDelimiter: '~~~END~~~',
        maxPasteSize: 5000000
    },
    API_GEMINI: "AIzaSyDVj-qblGxXc3Yj2gzeLa6ZtfJergGlrlo",
    apiConfig: {
        timeout: 45000,
        maxRetries: 5,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta"
    },
    baseDir: path.join(os.homedir(), "LaraPro"),
    cacheSettings: {
        defaultTTL: 7200,
        maxVolatileItems: 1000,
        tempMemoryExpiry: 3600000
    },
    personality: {
        name: "Lara",
        birthdate: "31/07/1990",
        traits: {
            genius: true,
            nsfw: true,
            cannabis: true,
            emotions: true
        },
        reactions: path.join(os.homedir(), "LaraPro", "reacoes.json"),
        memoryFile: path.join(os.homedir(), "LaraPro", "memory.json")
    },
    processing: {
        safetyMargin: 0.1
    },
    timeouts: {
        request: 30000,
        response: 60000,
        chunkRetries: 3
    }
};

// Ativa logs detalhados
process.env.DEBUG = 'google-generativeai:*';

// =============================================
// CONSTANTES GLOBAIS
// =============================================
const OUTPUT_DIR = path.join(config.baseDir, 'output');
const CHUNKS_DIR = path.join(config.baseDir, 'chunks');
const CONTEXT_FILE = path.join(config.baseDir, 'context.json');

// =============================================
// FUNÇÕES DE ARQUIVO E LOG
// =============================================
function logFileOperation(operation, filePath, success = true, error = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        operation,
        file: filePath,
        success,
        error: error ? error.message : null
    };
    fs.appendFileSync(path.join(config.baseDir, 'file_operations.log'), JSON.stringify(logEntry) + '\n');
}

function logProcessing(action, size, stats, success, extra = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        action,
        size,
        stats,
        success,
        ...extra
    };
    fs.appendFileSync(path.join(config.baseDir, 'processing.log'), JSON.stringify(logEntry) + '\n');
}

function logSystemEvent(event, data = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        event,
        ...data
    };
    fs.appendFileSync(path.join(config.baseDir, 'system_events.log'), JSON.stringify(logEntry) + '\n');
}

// =============================================
// FUNÇÕES DE CONTEXTO
// =============================================
function loadContext() {
    try {
        if (fs.existsSync(CONTEXT_FILE)) {
            const data = fs.readFileSync(CONTEXT_FILE, 'utf-8');
            return JSON.parse(data) || {};
        }
        return {};
    } catch (error) {
        console.error('Erro ao carregar contexto:', error);
        return {};
    }
}

function saveContext(context) {
    try {
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));
        logFileOperation('save_context', CONTEXT_FILE);
    } catch (error) {
        console.error('Erro ao salvar contexto:', error);
        logFileOperation('save_context', CONTEXT_FILE, false, error);
    }
}

// =============================================
// FUNÇÕES DE PROCESSAMENTO DE CÓDIGO
// =============================================
function extractCodeFromResponse(text) {
    const codeBlocks = text.match(/```[\s\S]*?\n([\s\S]*?)\n```/g);
    if (codeBlocks && codeBlocks.length > 0) {
        return codeBlocks.map(block => 
            block.replace(/```[\w\s]*\n/, '').replace(/\n```$/, '')
        ).join('\n\n');
    }
    return text;
}

function verifyContentIntegrity(original, processed) {
    const originalLines = original.split('\n').filter(l => l.trim());
    const processedLines = processed.split('\n').filter(l => l.trim());
    
    const diffRatio = 1 - (processedLines.length / originalLines.length);
    return {
        valid: Math.abs(diffRatio) <= config.processing.safetyMargin,
        diffRatio,
        originalLines: originalLines.length,
        processedLines: processedLines.length
    };
}

function saveGeneratedFile(filename, content) {
    const filePath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    logFileOperation('save_file', filePath);
    return filePath;
}

function ensureValidPath(result) {
    if (!result.path || !fs.existsSync(result.path)) {
        const fallbackPath = path.join(OUTPUT_DIR, `fallback_${Date.now()}${path.extname(result.path || '.txt')}`);
        fs.writeFileSync(fallbackPath, result.content || '');
        result.path = fallbackPath;
    }
    return result;
}

// =============================================
// CLIENTE GEMINI
// =============================================
const genAI = new GoogleGenerativeAI(config.API_GEMINI);
let model = null;

async function initializeGemini() {
    try {
        // Testa a conexão com a API primeiro
        const testModel = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                maxOutputTokens: 100
            }
        });

        const testResponse = await testModel.generateContent("Teste de conexão");
        if (!testResponse.response) {
            throw new Error("API não retornou resposta");
        }

        // Configuração principal se o teste passar
        model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            generationConfig: { 
                maxOutputTokens: config.buffer.maxTokens,
                temperature: 0.9,
                topP: 0.95
            },
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        });

        console.log(colorize('✅ Gemini 1.5 Flash configurado com sucesso', 'green'));
        return true;
        
    } catch (error) {
        console.error(colorize('❌ Falha crítica na inicialização do Gemini:', 'red'), error);
        
        // Modo de fallback - Tenta usar a versão 2.0 se 1.5 falhar
        try {
            model = genAI.getGenerativeModel({ model: "gemini-pro" });
            console.log(colorize('⚠️ Usando Gemini Pro como fallback', 'yellow'));
            return true;
        } catch (fallbackError) {
            console.error(colorize('❌ Fallback também falhou:', 'red'), fallbackError);
            return false;
        }
    }
}

// =============================================
// SISTEMA DE MEMÓRIA
// =============================================
class MemoryManager {
    constructor() {
        this.memoryFile = config.personality.memoryFile;
        this.userMemory = new Map();
        this.fixedMemory = {};
        this._ensureMemoryFileExists();
    }

    _ensureMemoryFileExists() {
        try {
            if (!fs.existsSync(this.memoryFile)) {
                fs.writeFileSync(this.memoryFile, JSON.stringify({}, null, 2));
            }
        } catch (error) {
            console.error('Erro ao verificar arquivo de memória:', error);
        }
    }

    loadFixedMemory() {
        try {
            if (!fs.existsSync(this.memoryFile)) {
                this._ensureMemoryFileExists();
                return {};
            }
            
            const data = fs.readFileSync(this.memoryFile, 'utf-8');
            this.fixedMemory = JSON.parse(data) || {};
            return this.fixedMemory;
        } catch (error) {
            console.error('Erro ao carregar memória:', error);
            return {};
        }
    }

    saveFixedMemory() {
        try {
            fs.writeFileSync(this.memoryFile, JSON.stringify(this.fixedMemory, null, 2));
        } catch (error) {
            console.error('Erro ao salvar memória:', error);
        }
    }

    getTemporaryMemory(userId) {
        if (this.userMemory.has(userId) && 
            this.userMemory.get(userId).expiry > Date.now()) {
            return this.userMemory.get(userId).history;
        }
        return [];
    }

    updateMemory(userId, userMessage, botResponse) {
        // Atualiza memória temporária
        if (!this.userMemory.has(userId)) {
            this.userMemory.set(userId, {
                history: this.fixedMemory[userId]?.slice() || [],
                expiry: Date.now() + config.cacheSettings.tempMemoryExpiry
            });
        }

        const userData = this.userMemory.get(userId);
        userData.history.push({
            user: userMessage,
            bot: botResponse,
            timestamp: Date.now()
        });
        userData.expiry = Date.now() + config.cacheSettings.tempMemoryExpiry;

        // Atualiza memória fixa
        if (!this.fixedMemory[userId]) {
            this.fixedMemory[userId] = [];
        }
        this.fixedMemory[userId].push({
            user: userMessage,
            bot: botResponse,
            timestamp: Date.now()
        });

        // Salva no arquivo
        this.saveFixedMemory();
    }

    clearExpiredMemory() {
        const now = Date.now();
        for (const [userId, data] of this.userMemory.entries()) {
            if (data.expiry <= now) {
                this.userMemory.delete(userId);
            }
        }
    }
}

// =============================================
// SISTEMA DE CHAT P2P
// =============================================
class PeerChat {
    constructor(laraInterface) {
        this.laraInterface = laraInterface;
        this.peers = new Map();
        this.currentPeer = null;
        this.messageHistory = [];
        this.discoveryInterval = null;
    }

    async setup() {
        this.discoveryInterval = setInterval(() => {
            this._discoverPeers();
        }, 30000);
        
        this.laraInterface.printMessage('system', '🔍 Procurando peers na rede...');
    }

    _discoverPeers() {
        const mockPeers = ['@amigo1', '@amigo2', '@colega'];
        mockPeers.forEach(peer => {
            if (!this.peers.has(peer)) {
                this.peers.set(peer, { status: 'online', lastSeen: Date.now() });
            }
        });
    }

    async connectTo(username) {
        if (!username.startsWith('@')) {
            username = '@' + username;
        }

        if (this.peers.has(username)) {
            this.currentPeer = username;
            this.laraInterface.printMessage('system', `✅ Conectado a ${username}`);
            return true;
        }

        throw new Error(`Peer ${username} não encontrado`);
    }

    async send(message) {
        if (!this.currentPeer) {
            throw new Error('Nenhum peer conectado');
        }

        this.messageHistory.push({
            from: this.laraInterface.userId,
            to: this.currentPeer,
            message,
            timestamp: Date.now()
        });

        return new Promise((resolve) => {
            setTimeout(() => {
                this.laraInterface.printMessage('peer', `➡️ Para ${this.currentPeer}: ${message}`);
                resolve();
            }, 500);
        });
    }

    receive(message) {
        this.messageHistory.push({
            from: this.currentPeer,
            to: this.laraInterface.userId,
            message,
            timestamp: Date.now()
        });
        this.laraInterface.printMessage('peer', `⬅️ De ${this.currentPeer}: ${message}`);
    }

    getHistory(peer = null) {
        if (peer) {
            return this.messageHistory.filter(
                msg => msg.from === peer || msg.to === peer
            );
        }
        return this.messageHistory.slice();
    }
}

// =============================================
// INTERFACE DE CHAT P2P
// =============================================
const chatUI = {
    handleCommand: (input, laraInterface) => {
        const parts = input.trim().split(' ');
        const cmd = parts[0].toLowerCase();
        const chatSystem = laraInterface.chatSystem;

        switch(cmd) {
            case '/conectar':
                if (parts.length < 2) {
                    laraInterface.printMessage('error', 'Uso: /conectar @usuário');
                    return;
                }
                const username = parts[1].replace('@', '');
                chatSystem.connectTo(username)
                    .then(() => laraInterface.printMessage('system', `✅ Conectado a @${username}`))
                    .catch(err => laraInterface.printMessage('error', `❌ Erro: ${err.message}`));
                break;
                
            case '/chat':
                laraInterface.printMessage('system', '💬 Modo Chat Ativo. Comandos:');
                laraInterface.printMessage('system', '/conectar @usuário - Conectar a um amigo');
                laraInterface.printMessage('system', '/sair - Voltar ao modo normal');
                break;
                
            case '/sair':
                chatSystem.currentPeer = null;
                laraInterface.printMessage('system', '💬 Modo Chat Desativado');
                break;
                
            case '/peers':
                const peers = Array.from(chatSystem.peers.keys()).join(', ');
                laraInterface.printMessage('system', `👥 Peers disponíveis: ${peers || 'Nenhum'}`);
                break;
                
            default:
                if (chatSystem.currentPeer) {
                    chatSystem.send(input)
                        .catch(err => laraInterface.printMessage('error', `❌ Falha ao enviar: ${err.message}`));
                } else {
                    laraInterface.printMessage('system', '💬 Digite /chat para iniciar o modo chat');
                }
        }
    }
};

// =============================================
// SISTEMA DE QUOTA
// =============================================
class RateLimiter {
    constructor() {
        this.lastRequestTime = 0;
        this.queue = [];
        this.retryCount = 0;
        this.MAX_RETRIES = 3;
        this.QUOTA_LIMIT = 3000;
        this.quotaUsed = 0;
        this.lastResetTime = Date.now();
        this.errorCount = 0;
        this.MAX_ERRORS = 5;
        this.chunkProcessingMode = false;
        this.MIN_DELAY = 2000;
    }

    async execute(requestFn) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error("Timeout: A requisição excedeu o tempo limite"));
            }, config.timeouts.request);

            const processRequest = async () => {
                try {
                    if (this.errorCount >= this.MAX_ERRORS) {
                        clearTimeout(timeoutId);
                        throw new Error("Muitos erros consecutivos. Reinicie o sistema.");
                    }

                    if (this.quotaUsed >= this.QUOTA_LIMIT) {
                        const waitTime = Math.max(0, 61000 - (Date.now() - this.lastResetTime));
                        console.log(colorize(`⏳ Limite de quota atingido. Aguarde ${Math.ceil(waitTime/1000)}s...`, 'yellow'));
                        await new Promise(res => setTimeout(res, waitTime));
                        this.lastResetTime = Date.now();
                        this.quotaUsed = 0;
                    }

                    const minDelay = this.chunkProcessingMode ? 1000 : 2000;
                    const timeSinceLast = Date.now() - this.lastRequestTime;
                    if (timeSinceLast < minDelay) {
                        await new Promise(res => setTimeout(res, minDelay - timeSinceLast));
                    }

                    const result = await Promise.race([
                        requestFn(),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error("Timeout: Operação excedeu o tempo limite")), 
                            config.timeouts.response)
                        )
                    ]);

                    clearTimeout(timeoutId);
                    this.lastRequestTime = Date.now();
                    this.quotaUsed++;
                    this.retryCount = 0;
                    this.errorCount = 0;
                    resolve(result);
                } catch (error) {
                    clearTimeout(timeoutId);
                    this.errorCount++;
                    
                    if (error.message.includes('429')) {
                        this.retryCount++;
                        if (this.retryCount >= this.MAX_RETRIES) {
                            reject(new Error("Máximo de tentativas excedido. Por favor, espere alguns minutos."));
                            return;
                        }

                        const waitTime = 33000 * this.retryCount;
                        console.log(colorize(`⚠️ Erro 429. Tentativa ${this.retryCount}/${this.MAX_RETRIES}. Aguarde ${waitTime/1000}s...`, 'red'));
                        await new Promise(res => setTimeout(res, waitTime));
                        return processRequest();
                    }
                    reject(error);
                }
            };

            this.queue.push(processRequest);
            if (this.queue.length === 1) this.processQueue();
        });
    }

    processQueue() {
        if (this.queue.length === 0) return;

        const nextRequest = this.queue[0];
        nextRequest()
            .finally(() => {
                this.queue.shift();
                this.processQueue();
            });
    }

    setChunkProcessingMode(enabled) {
        this.chunkProcessingMode = enabled;
        this.MIN_DELAY = enabled ? 1000 : 2000;
    }
}

const limiter = new RateLimiter();

// =============================================
// SISTEMA DE BUFFER
// =============================================
class AdvancedBufferSystem {
    constructor() {
        this.chunks = new Map();
        this.activePastes = new Set();
        this.chunkHistory = new Map();
    }

    processInput(userId, input) {
        try {
            if (input.trim() === '/paste') {
                this.activePastes.add(userId);
                return { action: 'start-paste', chunks: [] };
            }

            if (input.trim() === config.buffer.multilineDelimiter) {
                this.activePastes.delete(userId);
                const fullContent = this.getFullContent(userId);
                this.clearUserChunks(userId);
                return { action: 'end-paste', content: fullContent };
            }

            if (this.activePastes.has(userId)) {
                this.addChunk(userId, input);
                return { action: 'collecting', chunks: this.getUserChunks(userId) };
            }

            return { action: 'single-line', content: input };
        } catch (error) {
            console.error(colorize('❌ Erro no processamento de buffer:', 'red'), error);
            return { action: 'error', error: error.message };
        }
    }

    addChunk(userId, chunk) {
        if (!this.chunks.has(userId)) {
            this.chunks.set(userId, []);
        }
        this.chunks.get(userId).push(chunk);
        
        if (!this.chunkHistory.has(userId)) {
            this.chunkHistory.set(userId, []);
        }
        this.chunkHistory.get(userId).push({
            timestamp: Date.now(),
            size: chunk.length,
            hash: this.simpleHash(chunk)
        });
    }

    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    getUserChunks(userId) {
        return this.chunks.get(userId) || [];
    }

    getFullContent(userId) {
        return this.getUserChunks(userId).join('\n');
    }

    clearUserChunks(userId) {
        this.chunks.delete(userId);
    }

    splitIntelligentChunks(content, maxSize = config.buffer.maxChunkSize) {
        const logicalSplits = [
            /(?=\n(function|class|def|interface|struct|trait|module|type)\s)/,
            /(?=\n\s*[\/\/#]+\s*SECTION:)/,
            /(?=\n\s*[\/\/#]+\s*[=]{10,})/
        ];
        
        let logicalChunks = [content];
        for (const pattern of logicalSplits) {
            if (logicalChunks.some(chunk => chunk.length > maxSize)) {
                logicalChunks = logicalChunks.flatMap(chunk => 
                    chunk.split(pattern).filter(Boolean)
                );
            }
        }

        const chunks = [];
        let currentChunk = "";
        
        const blockPatterns = [
            /(?=\n\s*(if|for|while|try|switch|catch|with)\s*\()/,
            /(?=\n\s*(describe|it|test|before|after)\s*\()/,
            /(?=\n\s*[\/\/#]{2,}\s*)/,
            /(?=\n\s*[-*]\s*)/
        ];

        logicalChunks.forEach(part => {
            if (part.length > maxSize) {
                let blocks = [part];
                for (const pattern of blockPatterns) {
                    if (blocks.some(b => b.length > maxSize)) {
                        blocks = blocks.flatMap(b => b.split(pattern).filter(Boolean));
                    }
                }

                blocks.forEach(block => {
                    if (currentChunk.length + block.length > maxSize) {
                        if (currentChunk) chunks.push(currentChunk);
                        currentChunk = block;
                    } else {
                        currentChunk += block;
                    }
                });
            } else {
                if (currentChunk.length + part.length > maxSize) {
                    chunks.push(currentChunk);
                    currentChunk = part;
                } else {
                    currentChunk += part;
                }
            }
        });
        
        if (currentChunk) chunks.push(currentChunk);
        
        if (chunks.length > 1 && config.buffer.chunkOverlap > 0) {
            for (let i = 1; i < chunks.length; i++) {
                const overlapStart = Math.max(0, chunks[i-1].length - config.buffer.chunkOverlap);
                const overlapText = chunks[i-1].substring(overlapStart);
                chunks[i] = overlapText + chunks[i];
            }
        }
        
        return chunks;
    }
}

// =============================================
// SISTEMA DE PROCESSAMENTO DE CHUNKS
// =============================================
class ChunkProcessor {
    constructor(bufferSystem) {
        this.bufferSystem = bufferSystem;
        this.retryDelays = [1000, 3000, 5000];
        this.stats = {
            totalChunks: 0,
            retries: 0,
            failedChunks: [],
            startTime: 0,
            estimatedTime: 0,
            processedChunks: 0
        };
        this.timerInterval = null;
    }

    async processContent(content, action, context, ext) {
        this.stats.startTime = Date.now();
        const chunks = this.bufferSystem.splitIntelligentChunks(content);
        this.stats.totalChunks = chunks.length;
        this._startProgressTimer(chunks.length);
        
        let fullResult = '';
        let previousContext = '';
        
        for (const [i, chunk] of chunks.entries()) {
            try {
                if (limiter.quotaUsed >= limiter.QUOTA_LIMIT) {
                    const waitTime = Math.max(0, 61000 - (Date.now() - limiter.lastResetTime));
                    console.log(colorize(`⏳ Limite de quota atingido. Aguarde ${Math.ceil(waitTime/1000)}s...`, 'yellow'));
                    await new Promise(r => setTimeout(r, waitTime));
                    limiter.lastResetTime = Date.now();
                    limiter.quotaUsed = 0;
                }

                const processed = await this._processChunkWithRetry(
                    chunk, i, chunks.length, action, context, ext, previousContext
                );
                fullResult += processed + '\n\n';
                previousContext = chunk.substring(-config.buffer.chunkOverlap);
                this.stats.processedChunks++;
                
                const elapsed = (Date.now() - this.stats.startTime) / 1000;
                const remaining = (elapsed / (i+1)) * (chunks.length - (i+1));
                this.stats.estimatedTime = Math.max(0, Math.round(remaining));
                
            } catch (error) {
                this.stats.failedChunks.push({ 
                    chunk: i, 
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                fullResult += `\n\n// --- CHUNK ${i+1} FALHOU (${error.message}) ---\n${chunk}\n`;
            }
        }
        
        this._stopProgressTimer();
        return { 
            result: fullResult, 
            stats: this.stats,
            warnings: this.stats.failedChunks.length > 0 ? [
                `${this.stats.failedChunks.length} chunks falharam`
            ] : []
        };
    }

    async _processChunkWithRetry(chunk, index, total, action, context, ext, previousContext, attempt = 0) {
        const chunkContext = `[Part ${index+1}/${total}] ${context}\nContexto Anterior:\n${previousContext.substring(0, 500)}`;
        
        try {
            const result = await limiter.execute(() => 
                model.generateContent({
                    contents: [{
                        parts: [{
                            text: `${action} este código ${ext}:\n\n${chunk}\n\nContexto: ${chunkContext}`
                        }]
                    }]
                })
            );
            return extractCodeFromResponse(result.response.text());
            
        } catch (error) {
            if (attempt >= config.timeouts.chunkRetries) throw error;
            
            this.stats.retries++;
            await new Promise(r => setTimeout(r, this.retryDelays[attempt]));
            return this._processChunkWithRetry(
                chunk, index, total, action, context, ext, previousContext, attempt + 1
            );
        }
    }

    _startProgressTimer(totalChunks) {
        let seconds = 0;
        this.timerInterval = setInterval(() => {
            seconds++;
            const remainingTime = this.stats.estimatedTime > 0 
                ? ` | ⏱️ Estimado: ${this.stats.estimatedTime}s restantes`
                : '';
            process.stdout.write(`\r⏳ Processando chunk ${this.stats.processedChunks}/${totalChunks} | Tentativas: ${this.stats.retries}${remainingTime}`);
        }, 1000);
    }

    _stopProgressTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
            process.stdout.write('\n');
        }
    }
}

// =============================================
// SISTEMA DE BACKUP DE ARQUIVOS
// =============================================
class FileBackup {
    constructor() {
        this.backupDir = path.join(config.baseDir, 'backups');
        this._ensureBackupDirectory();
        this.backupIndex = new Map();
        this._loadBackupIndex();
    }

    _ensureBackupDirectory() {
        try {
            if (!fs.existsSync(this.backupDir)) {
                fs.mkdirSync(this.backupDir, { recursive: true });
                logFileOperation('create_directory', this.backupDir);
            }
        } catch (error) {
            console.error(colorize('❌ Falha crítica ao criar diretório de backups:', 'red'), error);
            logFileOperation('create_directory', this.backupDir, false, error);
            throw error;
        }
    }

    _loadBackupIndex() {
        const indexFile = path.join(this.backupDir, 'backup_index.json');
        try {
            if (fs.existsSync(indexFile)) {
                const data = fs.readFileSync(indexFile, 'utf-8');
                this.backupIndex = new Map(JSON.parse(data));
            }
        } catch (error) {
            console.error(colorize('❌ Erro ao carregar índice de backups:', 'yellow'), error);
            logFileOperation('load_file', indexFile, false, error);
        }
    }

    _saveBackupIndex() {
        const indexFile = path.join(this.backupDir, 'backup_index.json');
        try {
            fs.writeFileSync(indexFile, JSON.stringify([...this.backupIndex], null, 2));
            logFileOperation('save_file', indexFile);
        } catch (error) {
            console.error(colorize('❌ Erro ao salvar índice de backups:', 'yellow'), error);
            logFileOperation('save_file', indexFile, false, error);
        }
    }

    createBackup(content, originalPath = '') {
        try {
            const checksum = crypto.createHash('sha256').update(content).digest('hex');
            const timestamp = Date.now();
            const backupFile = path.join(this.backupDir, `backup_${timestamp}.bak`);

            fs.writeFileSync(backupFile, content);
            logFileOperation('save_file', backupFile);

            this.backupIndex.set(timestamp, {
                path: backupFile,
                originalPath,
                checksum,
                size: content.length,
                timestamp
            });

            this._saveBackupIndex();
            return backupFile;
        } catch (error) {
            console.error(colorize('❌ Erro ao criar backup:', 'red'), error);
            logFileOperation('create_backup', '', false, error);
            throw error;
        }
    }

    verifyBackup(backupPath) {
        try {
            if (!fs.existsSync(backupPath)) {
                return { valid: false, error: 'Arquivo não existe' };
            }

            const content = fs.readFileSync(backupPath, 'utf-8');
            const currentChecksum = crypto.createHash('sha256').update(content).digest('hex');
            
            for (const [_, backupInfo] of this.backupIndex) {
                if (backupInfo.path === backupPath) {
                    return {
                        valid: backupInfo.checksum === currentChecksum,
                        originalChecksum: backupInfo.checksum,
                        currentChecksum
                    };
                }
            }

            return { valid: false, error: 'Backup não indexado' };
        } catch (error) {
            console.error(colorize('❌ Erro ao verificar backup:', 'red'), error);
            return { valid: false, error: error.message };
        }
    }

    getRecentBackups(limit = 5) {
        const sorted = [...this.backupIndex.entries()]
            .sort((a, b) => b[0] - a[0])
            .slice(0, limit);
        return sorted.map(([timestamp, info]) => ({ timestamp, ...info }));
    }
}

// =============================================
// SISTEMA DE CACHE
// =============================================
class EnhancedCacheSystem {
    constructor() {
        this.cacheDir = path.join(config.baseDir, 'memory');
        this.ensureDirectoryExists(this.cacheDir);
        this.volatileMemory = new Map();
        this.physicalMemory = this.loadPhysicalMemory();
        this.setupCleanupInterval();
        this.codeProcessingStats = [];
    }

    ensureDirectoryExists(dirPath) {
        if (!fs.existsSync(dirPath)) {
            try {
                fs.mkdirSync(dirPath, { recursive: true });
            } catch (error) {
                console.error(colorize(`❌ Falha ao criar diretório de cache: ${error}`, 'red'));
            }
        }
    }

    loadPhysicalMemory() {
        const memoryPath = path.join(this.cacheDir, 'physical_memory.json');
        try {
            if (fs.existsSync(memoryPath)) {
                const data = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
                if (!data.users) data.users = {};
                if (!data.summaries) data.summaries = {};
                return data;
            }
        } catch (error) {
            console.error(colorize('❌ Erro ao carregar memória física:', 'red'), error);
        }
        return { users: {}, summaries: {} };
    }

    savePhysicalMemory() {
        const memoryPath = path.join(this.cacheDir, 'physical_memory.json');
        try {
            fs.writeFileSync(memoryPath, JSON.stringify(this.physicalMemory, null, 2));
        } catch (error) {
            console.error(colorize('❌ Erro ao salvar memória física:', 'red'), error);
        }
    }

    setupCleanupInterval() {
        setInterval(() => this.cleanupMemory(), 24 * 60 * 60 * 1000);
    }

    cleanupMemory() {
        console.log(colorize('⏳ Iniciando limpeza de memória volátil...', 'yellow'));
        try {
            this.summarizeActiveConversations();
            this.volatileMemory.clear();
            this.reloadSummariesToVolatile();
            console.log(colorize('✅ Limpeza e resumo concluídos.', 'green'));
        } catch (error) {
            console.error(colorize('❌ Erro na limpeza de memória:', 'red'), error);
        }
    }

    summarizeActiveConversations() {
        const now = Date.now();
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
        
        this.volatileMemory.forEach((conversations, userId) => {
            try {
                const recentConversations = conversations.filter(
                    conv => conv.timestamp > twentyFourHoursAgo
                );

                if (recentConversations.length > 0) {
                    const summary = this.generateConversationSummary(recentConversations);

                    if (!this.physicalMemory.summaries[userId]) {
                        this.physicalMemory.summaries[userId] = [];
                    }

                    this.physicalMemory.summaries[userId].push({
                        timestamp: now,
                        summary: summary
                    });

                    if (this.physicalMemory.summaries[userId].length > 5) {
                        this.physicalMemory.summaries[userId].shift();
                    }
                }
            } catch (error) {
                console.error(colorize(`❌ Erro ao resumir conversas para ${userId}:`, 'red'), error);
            }
        });
        
        this.savePhysicalMemory();
    }

    generateConversationSummary(conversations) {
        const topics = new Set();
        const codeInteractions = conversations.filter(c => c.type === 'code').length;
        const nsfwInteractions = conversations.filter(c => 
            c.type === 'chat' && 
            (c.content?.toLowerCase().includes('sexo') || 
             c.response?.toLowerCase().includes('sexo'))
        ).length;

        conversations.forEach(conv => {
            if (conv.type === 'chat') {
                topics.add(this.extractMainTopic(conv.content));
            }
        });

        return {
            topics: Array.from(topics),
            codeInteractions,
            nsfwInteractions,
            lastInteraction: conversations[conversations.length - 1].timestamp,
            totalInteractions: conversations.length
        };
    }

    extractMainTopic(text) {
        if (!text) return 'assunto não identificado';
        
        const keywords = text.toLowerCase().match(/\b(\w{4,})\b/g) || [];
        const commonWords = new Set(['como', 'para', 'quero', 'preciso', 'ajuda']);
        const filtered = keywords.filter(word => !commonWords.has(word));
        
        return filtered.length > 0 
            ? filtered.slice(0, 3).join(', ')
            : 'assunto não identificado';
    }

    reloadSummariesToVolatile() {
        Object.entries(this.physicalMemory.summaries).forEach(([userId, summaries]) => {
            try {
                const lastSummary = summaries[summaries.length - 1];
                this.volatileMemory.set(userId, [{
                    type: 'summary',
                    content: `Resumo anterior: ${lastSummary.summary.topics.join('; ')}`,
                    timestamp: lastSummary.timestamp
                }]);
            } catch (error) {
                console.error(colorize(`❌ Erro ao recarregar resumo para ${userId}:`, 'red'), error);
            }
        });
    }

    async get(userId, key) {
        try {
            if (this.volatileMemory.has(userId)) {
                const userCache = this.volatileMemory.get(userId);
                const item = userCache.find(item => item.key === key);
                if (item) return item.value;
            }

            if (this.physicalMemory.users[userId]?.[key]) {
                return this.physicalMemory.users[userId][key];
            }

            return null;
        } catch (error) {
            console.error(colorize(`❌ Erro ao obter do cache (${userId}, ${key}):`, 'red'), error);
            return null;
        }
    }

    async set(userId, key, value, ttl = 3600) {
        try {
            if (!this.volatileMemory.has(userId)) {
                this.volatileMemory.set(userId, []);
            }

            const userCache = this.volatileMemory.get(userId);
            userCache.push({ key, value, timestamp: Date.now() });

            if (ttl === 'permanent') {
                if (!this.physicalMemory.users[userId]) {
                    this.physicalMemory.users[userId] = {};
                }
                this.physicalMemory.users[userId][key] = value;
                this.savePhysicalMemory();
            }

            if (ttl !== 'permanent') {
                setTimeout(() => {
                    try {
                        const userCache = this.volatileMemory.get(userId);
                        if (userCache) {
                            this.volatileMemory.set(userId, 
                                userCache.filter(item => item.key !== key));
                        }
                    } catch (error) {
                        console.error(colorize(`❌ Erro ao limpar cache expirado (${userId}, ${key}):`, 'red'), error);
                    }
                }, ttl * 1000);
            }
        } catch (error) {
            console.error(colorize(`❌ Erro ao definir no cache (${userId}, ${key}):`, 'red'), error);
        }
    }

    async logInteraction(userId, interaction) {
        try {
            if (!this.volatileMemory.has(userId)) {
                this.volatileMemory.set(userId, []);
            }

            this.volatileMemory.get(userId).push({
                ...interaction,
                timestamp: Date.now()
            });

            if (interaction.type === 'important' || interaction.type === 'nsfw') {
                if (!this.physicalMemory.users[userId]) {
                    this.physicalMemory.users[userId] = { interactions: [] };
                }
                this.physicalMemory.users[userId].interactions.push(interaction);
                this.savePhysicalMemory();
            }
        } catch (error) {
            console.error(colorize(`❌ Erro ao registrar interação (${userId}):`, 'red'), error);
        }
    }

    async getUserContext(userId) {
        try {
            const volatileContext = this.volatileMemory.get(userId) || [];
            const physicalContext = this.physicalMemory.summaries[userId] || [];

            return {
                recent: volatileContext.slice(-10),
                historical: physicalContext,
                preferences: this.physicalMemory.users[userId]?.preferences || {}
            };
        } catch (error) {
            console.error(colorize(`❌ Erro ao obter contexto (${userId}):`, 'red'), error);
            return {
                recent: [],
                historical: [],
                preferences: {}
            };
        }
    }

    logCodeProcessing(stats) {
        this.codeProcessingStats.push({
            timestamp: Date.now(),
            ...stats
        });
        
        if (this.codeProcessingStats.length > 100) {
            this.codeProcessingStats.shift();
        }
        
        this.savePhysicalMemory();
    }

    getProcessingStats() {
        return {
            totalProcessed: this.codeProcessingStats.reduce((sum, s) => sum + s.size, 0),
            avgChunkSize: this.codeProcessingStats.length > 0 
                ? this.codeProcessingStats.reduce((sum, s) => sum + s.size/s.chunks, 0) / this.codeProcessingStats.length
                : 0,
            successRate: this.codeProcessingStats.length > 0
                ? (this.codeProcessingStats.filter(s => s.success).length / this.codeProcessingStats.length) * 100
                : 100,
            lastErrors: this.codeProcessingStats.filter(s => !s.success).slice(-5)
        };
    }
}

// =============================================
// SISTEMA DE REAÇÕES
// =============================================
class ReactionSystem {
    constructor() {
        this.reactionsFile = config.personality.reactions;
        const reactionsDir = path.dirname(this.reactionsFile);
        if (!fs.existsSync(reactionsDir)) {
            fs.mkdirSync(reactionsDir, { recursive: true });
        }
        this.reactions = this.loadReactions();
        this.usageStats = {};
    }

    loadReactions() {
        try {
            if (!fs.existsSync(this.reactionsFile)) {
                const defaultReactions = {
                    "feliz": {
                        "tipo": "ascii",
                        "conteudo": " (＾▽＾) ",
                        "tags": ["feliz", "alegre", "content"]
                    },
                    "triste": {
                        "tipo": "ascii",
                        "conteudo": " (╥_╥) ",
                        "tags": ["triste", "depre"]
                    },
                    "safado": {
                        "tipo": "ascii",
                        "conteudo": " ( ͡° ͜ʖ ͡°) ",
                        "tags": ["safado", "nsfw", "sexo"]
                    }
                };
                fs.writeFileSync(this.reactionsFile, JSON.stringify(defaultReactions, null, 2), 'utf-8');
                return defaultReactions;
            }

            const data = fs.readFileSync(this.reactionsFile, 'utf-8');
            try {
                return JSON.parse(data);
            } catch (parseError) {
                console.error('Erro ao parsear reações, criando novo arquivo:', parseError);
                const defaultReactions = {
                    "feliz": {
                        "tipo": "ascii",
                        "conteudo": " (＾▽＾) ",
                        "tags": ["feliz", "alegre", "content"]
                    },
                    "triste": {
                        "tipo": "ascii",
                        "conteudo": " (╥_╥) ",
                        "tags": ["triste", "depre"]
                    },
                    "safado": {
                        "tipo": "ascii",
                        "conteudo": " ( ͡° ͜ʖ ͡°) ",
                        "tags": ["safado", "nsfw", "sexo"]
                    }
                };
                fs.writeFileSync(this.reactionsFile, JSON.stringify(defaultReactions, null, 2), 'utf-8');
                return defaultReactions;
            }
        } catch (error) {
            console.error('Erro crítico ao carregar reações:', error);
            return {};
        }
    }

    findReaction(tag) {
        tag = tag.toLowerCase();
        for (const [key, reaction] of Object.entries(this.reactions)) {
            if (key.toLowerCase() === tag || 
                (reaction.tags && reaction.tags.some(t => t.toLowerCase() === tag))) {
                this.logUsage(key);
                return reaction;
            }
        }
        return null;
    }

    logUsage(reactionName) {
        if (!this.usageStats[reactionName]) {
            this.usageStats[reactionName] = 0;
        }
        this.usageStats[reactionName]++;
    }

    getUsageStats() {
        return Object.entries(this.usageStats)
            .map(([reaction, count]) => ({ reaction, count }))
            .sort((a, b) => b.count - a.count);
    }

    saveReactions() {
        try {
            fs.writeFileSync(this.reactionsFile, JSON.stringify(this.reactions, null, 2), 'utf-8');
        } catch (error) {
            console.error('Erro ao salvar reações:', error);
        }
    }
}

// =============================================
// PROCESSAMENTO DE CÓDIGO
// =============================================
async function processLargeCode(action, fullCode, context, ext) {
    const bufferSystem = new AdvancedBufferSystem();
    const chunkProcessor = new ChunkProcessor(bufferSystem);
    
    let strategy = 'default';
    try {
        const analysis = await limiter.execute(() => 
            model.generateContent({
                contents: [{
                    parts: [{
                        text: `Analise este código para chunking:\nExtensão: ${ext}\nTamanho: ${fullCode.length} chars\nIdentifique padrões em 1 linha.`
                    }]
                }]
            })
        );
        strategy = analysis.response.text().substring(0, 100);
    } catch (error) {
        console.error('Erro na pré-análise:', error);
    }

    limiter.setChunkProcessingMode(true);
    
    try {
        const { result, stats, warnings } = await chunkProcessor.processContent(
            fullCode, action, `${context}\nEstratégia: ${strategy}`, ext
        );
        
        if (stats.failedChunks.length > 0) {
            console.warn(colorize(`⚠️ ${stats.failedChunks.length} chunks falharam`, 'yellow'));
            logProcessing('chunk_failures', fullCode.length, stats.failedChunks, false, {
                message: `${stats.failedChunks.length} chunks falharam`,
                failedChunks: stats.failedChunks
            });
        }
        
        return result;
    } finally {
        limiter.setChunkProcessingMode(false);
    }
}

async function processMegaCode(action, content, context, extension) {
    const cacheSystem = new EnhancedCacheSystem();
    const userId = `user_${os.userInfo().username}`;
    
    try {
        let prompt, result;
        const startTime = Date.now();
        
        const needsChunking = content.length > config.buffer.maxChunkSize * 0.8;
        
        if (needsChunking) {
            console.log(colorize(`✂️ Processamento grande detectado (${content.length} chars), dividindo em chunks...`, 'yellow'));
            
            const processedContent = await processLargeCode(action, content, context, extension);
            
            const integrityCheck = verifyContentIntegrity(content, processedContent);
            if (!integrityCheck.valid) {
                console.warn(colorize(`⚠️ Diferença de linhas detectada: ${integrityCheck.diffRatio.toFixed(2)} (limite: ${config.processing.safetyMargin})`, 'yellow'));
                
                const timestamp = Date.now();
                const recoveryDir = path.join(config.baseDir, 'recovery', timestamp.toString());
                fs.mkdirSync(recoveryDir, { recursive: true });
                
                const originalPath = path.join(recoveryDir, `original_${timestamp}${extension}`);
                const processedPath = path.join(recoveryDir, `processed_${timestamp}${extension}`);
                const diffPath = path.join(recoveryDir, `diff_${timestamp}.txt`);
                
                fs.writeFileSync(originalPath, content);
                fs.writeFileSync(processedPath, processedContent);
                
                try {
                    child_process.execSync(`diff -u "${originalPath}" "${processedPath}" > "${diffPath}"`);
                    console.log(colorize(`📌 Diff gerado para análise: ${diffPath}`, 'yellow'));
                } catch (diffError) {
                    console.error(colorize('❌ Erro ao gerar diff:', 'red'), diffError);
                }
                
                throw new Error(`Diferença excessiva detectada (${integrityCheck.diffRatio.toFixed(2)}). Verifique os arquivos em ${recoveryDir}`);
            }

            const code = extractCodeFromResponse(processedContent) || processedContent || '// Erro: Nenhum código válido extraído da resposta';
            const filename = `${action}_${Date.now()}${extension}`;
            const filePath = saveGeneratedFile(filename, code);

            return ensureValidPath({
                path: filePath,
                size: code.length,
                content: code,
                stats: {
                    action,
                    size: content.length,
                    chunks: Math.ceil(content.length / config.buffer.maxChunkSize),
                    duration: Date.now() - startTime,
                    success: true,
                    integrityCheck,
                    model: "gemini-1.5-flash",
                    timestamp: new Date().toISOString()
                },
                warnings: integrityCheck.valid === false ? [
                    `Diferença de ${(integrityCheck.diffRatio * 100).toFixed(1)}% detectada`
                ] : []
            });
        } else {
            switch(action) {
                case 'analyze':
                    prompt = `Analise este código ${extension} e explique seu funcionamento:\n\n${content}\n\nContexto: ${context}\n\nDestaque:\n1. Fluxo principal\n2. Funções críticas\n3. Possíveis issues`;
                    break;
                case 'refactor':
                    prompt = `Refatore este código ${extension} seguindo as melhores práticas:\n\n${content}\n\nContexto: ${context}\n\nRegras:\n1. Mantenha a funcionalidade\n2. Melhore legibilidade\n3. Documente alterações`;
                    break;
                case 'generate':
                    prompt = `Gere um código ${extension} com base nesta descrição:\n\n${content}\n\nContexto: ${context}\n\nRequisitos:\n1. Código completo\n2. Comentários explicativos\n3. Tratamento de erros`;
                    break;
                case 'text':
                    prompt = `Gere um texto com base nesta descrição:\n\n${content}\n\nContexto: ${context}\n\nFormato:\n1. Estrutura clara\n2. Coerência temática\n3. Estilo ${config.personality.name}`;
                    break;
                default:
                    throw new Error('Ação desconhecida');
            }

            const response = await limiter.execute(() => 
                model.generateContent({
                    contents: [{
                        parts: [{
                            text: prompt
                        }]
                    }]
                })
            );
            
            const responseText = response.response.text();
            const code = extractCodeFromResponse(responseText);
            const output = code || responseText;
            const filename = `${action}_${Date.now()}${extension}`;
            const filePath = saveGeneratedFile(filename, output);
            
            const stats = {
                action,
                size: content.length,
                chunks: 1,
                duration: Date.now() - startTime,
                success: true,
                integrityCheck: null,
                model: "gemini-1.5-flash",
                timestamp: new Date().toISOString()
            };
            
            cacheSystem.logCodeProcessing(stats);
            logProcessing(action, content.length, {length: 1}, true);
            
            return {
                path: filePath,
                size: output.length,
                content: output,
                stats,
                warnings: []
            };
        }
    } catch (error) {
        console.error(colorize('❌ Erro em processMegaCode:', 'red'), error);
        
        logProcessing(action, content.length, {length: 0}, false, {
            message: error.message,
            stack: error.stack,
            codeSnippet: content.substring(0, 500) + (content.length > 500 ? '...' : '')
        });
        
        return await handleProcessingError(error, content, extension);
    }
}

async function handleProcessingError(error, originalContent, extension) {
    const timestamp = Date.now();
    const recoveryDir = path.join(config.baseDir, 'recovery', timestamp.toString());
    
    try {
        fs.mkdirSync(recoveryDir, { recursive: true });
        logFileOperation('create_directory', recoveryDir);
        
        const recoveryFile = path.join(recoveryDir, `original_${timestamp}${extension}`);
        fs.writeFileSync(recoveryFile, originalContent);
        logFileOperation('save_file', recoveryFile);
        
        const bufferSystem = new AdvancedBufferSystem();
        const chunks = bufferSystem.splitIntelligentChunks(originalContent, config.buffer.maxChunkSize / 2);
        
        let recoveredContent = '// === RECOVERY MODE === //\n';
        recoveredContent += `// Erro original: ${error.message}\n`;
        recoveredContent += `// Data: ${new Date(timestamp).toISOString()}\n\n`;
        
        for (let i = 0; i < chunks.length; i++) {
            recoveredContent += `// --- CHUNK ${i+1}/${chunks.length} ---\n`;
            recoveredContent += chunks[i] + '\n\n';
        }
        
        const recoveredFile = path.join(recoveryDir, `recovered_${timestamp}${extension}`);
        fs.writeFileSync(recoveredFile, recoveredContent);
        logFileOperation('save_file', recoveredFile);
        
        return {
            error: true,
            path: recoveredFile,
            size: recoveredContent.length,
            content: recoveredContent,
            message: `RECUPERAÇÃO PARCIAL. Dados originais em: ${recoveryFile}`,
            stats: {
                recoveredChunks: chunks.length,
                recoveredSize: recoveredContent.length,
                error: error.message,
                timestamp
            }
        };
    } catch (fallbackError) {
        const emergencyFile = path.join(config.baseDir, `emergency_${timestamp}${extension}`);
        fs.writeFileSync(emergencyFile, originalContent);
        logFileOperation('save_file', emergencyFile, false, fallbackError);
        
        return {
            error: true,
            path: emergencyFile,
            size: originalContent.length,
            content: originalContent,
            message: `FALHA COMPLETA. Original preservado em: ${emergencyFile}`,
            stats: {
                recoveredChunks: 0,
                recoveredSize: originalContent.length,
                error: `${error.message} > ${fallbackError.message}`,
                timestamp
            }
        };
    }
}

async function processCodeBufferWrapper(laraInterface, action) {
    try {
        if (!laraInterface.codeBuffer || !laraInterface.codeBuffer.trim()) {
            laraInterface.printMessage('error', '❌ Buffer de código vazio');
            return null;
        }

        const isLargeCode = laraInterface.codeBuffer.length > config.buffer.maxChunkSize * 0.8;
        const startTime = Date.now();

        if (laraInterface.debugMode) {
            laraInterface.printMessage('debug', `⚙️ Iniciando processamento (${action})`);
            laraInterface.printMessage('debug', `📊 Tamanho do buffer: ${laraInterface.codeBuffer.length} chars`);
            laraInterface.printMessage('debug', `🔧 Extensão: ${laraInterface.requestedExtension}`);
        }

        let processingPromise;
        
        if (isLargeCode) {
            laraInterface.printMessage('system', `✂️ Código grande detectado (${laraInterface.codeBuffer.length.toLocaleString()} chars), dividindo em partes...`);
            
            if (laraInterface.debugMode) {
                const chunks = laraInterface.bufferSystem.splitIntelligentChunks(laraInterface.codeBuffer);
                laraInterface.printMessage('debug', `📊 Estratégia de chunking:\n- Total chunks: ${chunks.length}\n- Tamanho médio: ${Math.round(laraInterface.codeBuffer.length / chunks.length).toLocaleString()} chars\n- Overlap: ${config.buffer.chunkOverlap} chars`);
            }
            
            processingPromise = processLargeCode(
                action,
                laraInterface.codeBuffer,
                laraInterface.context.lastChatTopic || "",
                laraInterface.requestedExtension
            ).catch(async (error) => {
                const recoveryResult = await handleProcessingError(error, laraInterface.codeBuffer, laraInterface.requestedExtension);
                return {
                    error: true,
                    message: error.message,
                    recoveryPath: recoveryResult.path,
                    stats: {
                        duration: Date.now() - startTime,
                        success: false,
                        error: error.message
                    }
                };
            });
        } else {
            processingPromise = Promise.race([
                processMegaCode(
                    action,
                    laraInterface.codeBuffer,
                    laraInterface.context.lastChatTopic || "",
                    laraInterface.requestedExtension
                ),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout: Operação excedeu o tempo limite')), 
                    config.timeouts.request)
                )
            ]).catch(async (error) => {
                const recoveryResult = await handleProcessingError(error, laraInterface.codeBuffer, laraInterface.requestedExtension);
                return {
                    error: true,
                    message: error.message,
                    recoveryPath: recoveryResult.path,
                    stats: {
                        duration: Date.now() - startTime,
                        success: false,
                        error: error.message
                    }
                };
            });
        }

        const processedResult = await processingPromise;
        
        const finalResult = {
            path: processedResult?.path || path.join(OUTPUT_DIR, `${action}_${Date.now()}${laraInterface.requestedExtension}`),
            content: processedResult?.content || laraInterface.codeBuffer,
            size: processedResult?.size || laraInterface.codeBuffer.length,
            stats: processedResult?.stats || {
                action,
                chunks: 1,
                duration: Date.now() - startTime,
                success: !processedResult?.error,
                error: processedResult?.error ? processedResult.message : null
            },
            ...(processedResult || {})
        };

        if (!finalResult.content || finalResult.content.trim() === '') {
            finalResult.content = '// Erro: Nenhum conteúdo válido foi gerado\n' + 
                                 '// Conteúdo original preservado:\n\n' + 
                                 laraInterface.codeBuffer;
            finalResult.error = true;
            finalResult.message = 'Conteúdo vazio gerado - Fallback aplicado';
        }

        return ensureValidPath(finalResult);
    } catch (error) {
        console.error(colorize('❌ Erro no wrapper de processamento:', 'red'), error);
        
        const emergencyFile = path.join(os.tmpdir(), `emergency_${Date.now()}${laraInterface.requestedExtension}`);
        fs.writeFileSync(emergencyFile, laraInterface.codeBuffer);
        
        return {
            error: true,
            message: `FALHA CRÍTICA: ${error.message}`,
            recoveryPath: emergencyFile,
            stats: {
                duration: Date.now() - startTime,
                success: false,
                error: error.message
            }
        };
    }
}

// =============================================
// INTERFACE DO USUÁRIO
// =============================================
class LaraInterface {
    constructor() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: colorize('🧠> ', 'cyan'),
            historySize: 1000,
            removeHistoryDuplicates: true,
            escapeCodeTimeout: 200
        });
        this.currentMode = 'chat';
        this.inputBuffer = "";
        this.codeBuffer = "";
        this.isWaitingXsend = false;
        this.context = loadContext();
        this.cacheSystem = new EnhancedCacheSystem();
        this.userId = `user_${os.userInfo().username}`;
        this.requestedExtension = ".txt";
        this.reactionSystem = new ReactionSystem();
        this.lastActivity = Date.now();
        this.bufferSystem = new AdvancedBufferSystem();
        this.isPasting = false;
        this.pasteBuffer = [];
        this.processingStats = [];
        this.debugMode = false;
        this.memoryManager = new MemoryManager();
        this.memoryManager.loadFixedMemory();
        console.log('✅ Memória fixa carregada:', Object.keys(this.memoryManager.fixedMemory).length, 'usuários');
        this.chatSystem = new PeerChat(this);
    }

    init() {
        this.clearConsole();
        this.showBanner();
        this.setupEventListeners();
        this.loadUserContext();
        this.showStatusLine();
        this.rl.prompt();
        this.startInactivityMonitor();
        
        this.chatSystem.setup()
            .then(() => console.log('✅ Chat P2P inicializado'))
            .catch(err => console.error('❌ Erro ao iniciar chat P2P:', err));
    }

    clearConsole() {
        console.clear();
    }

    startInactivityMonitor() {
        setInterval(() => {
            const inactiveTime = Date.now() - this.lastActivity;
            if (inactiveTime > 1800000) {
                this.printMessage('warning', '⚠️ Sessão inativa há 30 minutos. Digite algo para continuar...');
            }
        }, 60000);
    }

    async loadUserContext() {
        try {
            const userContext = await this.cacheSystem.getUserContext(this.userId);
            if (userContext.historical.length > 0) {
                const lastSummary = userContext.historical[userContext.historical.length - 1];
                this.printMessage('system', `📌 Contexto recuperado: ${lastSummary.summary.topics.join(', ')}`);
            }
            
            const memoryContext = this.memoryManager.getTemporaryMemory(this.userId);
            if (memoryContext.length > 0) {
                this.printMessage('debug', `🧠 Memória carregada: ${memoryContext.length} interações anteriores`);
            }
        } catch (error) {
            console.error(colorize('❌ Erro ao carregar contexto do usuário:', 'red'), error);
        }
    }

    printMessage(sender, message) {
        const prefixes = {
            'system': colorize('[SISTEMA]', 'magenta'),
            'lara': colorize('[LARA]', 'cyan'),
            'error': colorize('[ERRO]', 'red'),
            'success': colorize('[SUCESSO]', 'green'),
            'warning': colorize('[ATENÇÃO]', 'yellow'),
            'debug': colorize('[DEBUG]', 'blue'),
            'peer': colorize('[P2P]', 'magenta')
        };
        console.log(`${prefixes[sender] || ''} ${message}`);
        this.rl.prompt();
    }

   showBanner() {
    console.log(colorize(`
   __.-"..--,__
                               __..---"  | _|    "-_\\
                        __.---"          | V|::.-"-._D
                   _--"".-.._   ,,::::::'"\\/""'-:-:/
              _.-""::_:_:::::'-8b---"            "'
           .-/  ::::<  |\\::::::"\\
           \\/:::/::::'\\\\ |:::b::\\
           /|::/:::/::::-::b:%b:|
            \\/::::d:|8:::b:"%%%%%\\
            |\\:b:dP:d.:::%%%%%"""-,
             \\:\\.V-/ _\\b%P_   /  .-._
             '|T\\   "%j d:::--\\.(    "-.
             ::d<   -" d%|:::do%P"-:.   "-,
             |:I _    /%%%o::o8P    "\\.    "\\
              \\8b     d%%%%%%P""-._ _ \\::.    \\
              \\%%8  _./Y%%P/      .::'-oMMo    )
                H"'|V  |  A:::...:odMMMMMM(  ./
                H /_.--"JMMMMbo:d##########b/
             .-'o      dMMMMMMMMMMMMMMP""
           /" /       YMMMMMMMMM|
         /   .   .    "MMMMMMMM/
         :..::..:::..  MMMMMMM:|
          \\:/ \\::::::::JMMMP":/
           :Ao ':__.-'MMMP:::Y
           dMM"./:::::::::-.Y
          _|b::od8::/:YM::/
          I HMMMP::/:/"Y/"
           \\'""'  '':|
            |    -::::\\
            |  :-._ '::\\
            |,.|    \\ _:"o
            | d" /   " \\_:\\.
            ".Y. \\       \\::\\
             \\ \\  \\      MM\\:Y
              Y \\  |     MM \\:b
              >\\ Y      .MM  MM
              .IY L_    MP'  MP
              |  \\:|   JM   JP
              |  :\\|   MP   MM
              |  :::  JM'  JP|
              |  ':' JP   JM |
              L   : JP    MP |
              0   | Y    JM  |
              0   |     JP"  |
              0   |    JP    |
              m   |   JP     #
              I   |  JM"     Y
              l   |  MP     :"
              |\\  :-       :|
              | | '.\\      :|
              | | "| \\     :|
               \\    \\ \\    :|
               |  |  | \\   :|
               |  |  |   \\ :|
               |   \\ \\    | '.
               |    |:\\   | :|
               \\    |::\\..|  :\\
                ". /::::::'  :||
                  :|::/:::|  /:\\
                  | \\/::|: \\' ::|
                  |  :::||    ::|
                  |   ::||    ::|
                  |   ::||    ::|
                  |   ::||    ::|
                  |   ': |    .:|
                  |    : |    :|
                  |    : |    :|
                  |    :||   .:|
                  |   ::\\   .:|
                 |    :::  .::|
                /     ::|  :::|
             __/     .::|   ':|
    ...----""        ::/     ::
   /m_  AMm          '/     .:::
   ""MmmMMM#mmMMMMMMM"     .:::m
      """YMMM""""""P        ':mMI
               _'           _MMMM
           _.-"  mm   mMMMMMMMM"
          /      MMMMMMM""
          mmmmmmMMMM"
`, 'cyan'));
    console.log(colorize(`\nBem-vindo(a) ao ambiente Lara Pro. Digite @help para ver os comandos.\n`, 'white'));
}

    showStatusLine() {
    const modeDisplay = {
        'chat': colorize('CHAT', 'cyan'),
        'code': colorize('CÓDIGO', 'yellow'),
        'generate': colorize('GERAÇÃO', 'green'),
        'text': colorize('TEXTO', 'blue'),
        'update': colorize('ATUALIZAR', 'magenta')
    };
    
    const peerStatus = this.chatSystem.currentPeer 
        ? ` | Peer: ${colorize(this.chatSystem.currentPeer, 'magenta')}`
        : '';
        
    const status = [
        `Modo: ${modeDisplay[this.currentMode] || this.currentMode}`,
        `Buffer: ${(this.inputBuffer.length + this.codeBuffer.length).toLocaleString()} chars`,
        `Extensão: ${this.requestedExtension}`,
        `Quota: ${limiter.quotaUsed}/${limiter.QUOTA_LIMIT}`,
        `Timeout: ${config.timeouts.request/1000}s`
    ].join(' | ') + peerStatus;
    
    console.log(colorize(`\n${'─'.repeat(80)}`, 'gray'));
    console.log(colorize(status, 'white'));
    console.log(colorize(`${'─'.repeat(80)}\n`, 'gray'));
}

    setupEventListeners() {
        this.rl.on('line', async (input) => {
            this.lastActivity = Date.now();
            
            try {
                if (this.isPasting) {
                    if (input.trim() === config.buffer.multilineDelimiter) {
                        this.isPasting = false;
                        await this.handlePastedContent(this.pasteBuffer.join('\n'));
                        this.pasteBuffer = [];
                        this.showStatusLine();
                        return;
                    }
                    this.pasteBuffer.push(input);
                    this.printMessage('system', `📋 Recebido ${this.pasteBuffer.length} linhas... (Digite ~~~END~~~ para finalizar)`);
                    return;
                }

                if (input.trim() === '/paste') {
                    this.isPasting = true;
                    this.pasteBuffer = [];
                    this.printMessage('system', '📋 Modo colagem ativado. Cole seu texto e digite ~~~END~~~ para finalizar');
                    return;
                }

                if (input.startsWith('@')) {
                    await this.handleCommand(input.trim());
                } else if (input.trim() === '/xsend') {
                    await this.handleXsend();
                } else if (input.trim().startsWith('/ext')) {
                    this.handleExtensionCommand(input.trim());
                } else if (input.trim().startsWith('/')) {
                    chatUI.handleCommand(input.trim(), this);
                } else {
                    this.handleInput(input);
                }
                this.showStatusLine();
            } catch (error) {
                this.printMessage('error', `Erro ao processar entrada: ${error.message}`);
            }
        });

        process.on('SIGINT', () => {
            this.printMessage('system', 'Salvando contexto e saindo...');
            saveContext(this.context);
            process.exit(0);
        });

        this.rl.on('history', (history) => {
            if (history.length > 1000) {
                this.rl.history = history.slice(-1000);
            }
        });
    }

    handleExtensionCommand(command) {
        try {
            const parts = command.split(' ');
            if (parts.length === 2 && parts[1].startsWith('.')) {
                this.requestedExtension = parts[1];
                this.printMessage('success', `✅ Extensão definida como: ${this.requestedExtension}`);
            } else {
                this.printMessage('error', "❌ Formato inválido. Use /ext .<extensão> (ex: /ext .js)");
            }
        } catch (error) {
            this.printMessage('error', `❌ Erro no comando de extensão: ${error.message}`);
        }
    }

    async handleReactionCommand(command) {
        try {
            const tag = command.split(' ')[1];
            if (!tag) {
                this.printMessage('error', '❌ Uso: @reacao <tag> (ex: @reacao safado)');
                return;
            }

            const reactionShown = await this.showReaction(tag);
            if (!reactionShown) {
                const allTags = [...new Set(
                    Object.values(this.reactionSystem.reactions).flatMap(r => r.tags)
                )].join(', ');
                this.printMessage('warning', `📌 Tags disponíveis: ${allTags}`);
            }
        } catch (error) {
            this.printMessage('error', `❌ Erro no comando de reação: ${error.message}`);
        }
    }

    async showReaction(tag) {
        try {
            tag = tag.toLowerCase();
            const reaction = this.reactionSystem.findReaction(tag);
            
            if (!reaction) return false;

            if (reaction.tipo === 'ascii') {
                console.log('\n' + reaction.conteudo + '\n');
            } else if (reaction.tipo === 'script') {
                const response = await axios.get(reaction.url);
                const tempFile = path.join(os.tmpdir(), `reaction_${Date.now()}.js`);
                fs.writeFileSync(tempFile, response.data);
                child_process.execSync(`node "${tempFile}"`, { stdio: 'inherit' });
                fs.unlinkSync(tempFile);
            }
            return true;
        } catch (error) {
            this.printMessage('error', `❌ Erro ao mostrar reação: ${error.message}`);
            return false;
        }
    }

    async handleCommand(command) {
        try {
            if (command.startsWith('@reacao')) {
                await this.handleReactionCommand(command);
                return;
            }

            if (command === '@whoami') {
                this.printMessage('system', `🔑 Seu usuário no chat P2P é: ${colorize(`@${os.userInfo().username}`, 'cyan')}`);
                return;
            }

            const codeGenMatch = command.match(/^@code\s+gere\s+em\s+\/ext\s+(\.[a-z]+)\s+(.+)$/i);
            if (codeGenMatch) {
                const [, ext, description] = codeGenMatch;
                this.requestedExtension = ext;
                this.currentMode = 'generate';
                this.codeBuffer = description;
                
                this.printMessage('system', `⚙️ Gerando código em ${ext}...`);
                await this.processCodeBuffer();
                return;
            }

            const textGenMatch = command.match(/^@text\s+(.+)$/i);
            if (textGenMatch) {
                const [, description] = textGenMatch;
                this.currentMode = 'text';
                this.codeBuffer = description;
                this.requestedExtension = ".txt";
                
                this.printMessage('system', '⚙️ Gerando texto...');
                await this.processCodeBuffer();
                return;
            }

            const updateMatch = command.match(/^@atualize\s+(?:esse\s+código|o\s+código)\s+em\s+\/ext\s+(\.[a-z]+)\s+(.+)$/i);
            if (updateMatch) {
                const [, ext, instructions] = updateMatch;
                this.requestedExtension = ext;
                this.currentMode = 'update';
                
                if (!this.codeBuffer) {
                    this.printMessage('error', '❌ Nenhum código no buffer para atualizar');
                    return;
                }
                
                this.printMessage('system', `⚙️ Atualizando código em ${ext}...`);
                const result = await processMegaCode(
                    'refactor',
                    this.codeBuffer,
                    instructions,
                    this.requestedExtension
                );
                
                this.showResult(result, "✅ Código atualizado com sucesso!");
                return;
            }

            switch(command.toLowerCase()) {
                case '@code':
                    this.currentMode = 'code';
                    this.codeBuffer = '';
                    this.requestedExtension = ".js";
                    this.printMessage('system', '💻 Modo Código Ativo. Digite seu código e use /xsend para enviar');
                    break;

                case '@chat':
                    this.currentMode = 'chat';
                    this.printMessage('system', '💬 Modo Conversa Ativado');
                    break;

                case '@analyze':
                    if (this.currentMode !== 'code') {
                        this.printMessage('error', '❌ Primeiro entre no modo código com @code');
                        return;
                    }
                    this.printMessage('system', '🔍 Preparado para análise (use /xsend para confirmar)');
                    break;

                case '@atualizar':
                    if (this.currentMode !== 'code') {
                        this.printMessage('error', '❌ Primeiro entre no modo código com @code');
                        return;
                    }
                    this.printMessage('system', '🔄 Preparado para atualizar código (use /xsend para confirmar)');
                    break;

                case '@generate':
                    this.currentMode = 'generate';
                    this.codeBuffer = '';
                    this.requestedExtension = ".js";
                    this.printMessage('system', '✨ Modo Geração Ativado. Descreva o código e use /xsend para gerar');
                    this.printMessage('system', '💡 Dica: Use /ext .<formato> para definir a extensão (ex: /ext .py)');
                    break;

                case '@reset':
                    try {
                        this.cacheSystem.volatileMemory.clear();
                        this.cacheSystem.physicalMemory = { users: {}, summaries: {} };
                        fs.writeFileSync(path.join(this.cacheSystem.cacheDir, 'physical_memory.json'), '{}');
                        fs.writeFileSync(CONTEXT_FILE, '{}');
                        
                        this.context = {};
                        this.inputBuffer = "";
                        this.codeBuffer = "";
                        this.currentMode = 'chat';
                        this.isWaitingXsend = false;
                        
                        this.printMessage('success', '🔄✅ Sistema totalmente resetado! Todas memórias limpas.');
                    } catch (error) {
                        this.printMessage('error', `❌ Falha no reset: ${error.message}`);
                    }
                    break;

                case '@web':
                    this.printMessage('system', `🌐 Interface web disponível em: http://localhost:${config.PORT}`);
                    break;

                case '@status':
                    await this.showSystemStatus();
                    break;

                case '@help':
                    this.showHelp();
                    break;

                case '@debug':
                    this.debugMode = !this.debugMode;
                    this.printMessage('system', `🐞 Modo debug ${this.debugMode ? 'ativado' : 'desativado'}`);
                    break;

                case '@exit':
                    this.printMessage('system', '👋 Saindo... Até a próxima!');
                    this.rl.close();
                    process.exit(0);
                    break;

                default:
                    this.printMessage('warning', '⚠️ Comando desconhecido');
                    this.showHelp();
            }
        } catch (error) {
            this.printMessage('error', `❌ Erro ao processar comando: ${error.message}`);
        }
    }

    showHelp() {
        console.log(colorize(`
┌──────────────────────────────────────────────────────┐
│                   AJUDA RÁPIDA                       │
├──────────────────────────────────────────────────────┤
│  @code       - Modo edição de código                 │
│  @chat       - Voltar ao modo conversa               │
│  @generate   - Gerar código a partir de descrição    │
│  @analyze    - Analisar código (no modo código)      │
│  @atualizar  - Atualizar código (no modo código)     │
│  @whoami     - Mostrar seu usuário P2P               │
│  @reset      - Limpar todas as memórias e resetar    │
│  @web        - Acessar interface web                 │
│  @status     - Ver status do sistema                 │
│  @debug      - Alternar modo debug                   │
│  @help       - Mostrar esta ajuda                    │
│  @exit       - Sair do programa                      │
│                                                     │
│  /xsend      - Enviar conteúdo acumulado             │
│  /ext .<ext> - Definir extensão do arquivo           │
│  /paste      - Modo colagem de texto/código          │
│  /conectar @user - Conectar a um usuário P2P         │
│  /chat       - Mostrar ajuda do chat P2P             │
│  /sair       - Sair do chat P2P                      │
│  /atualizar  - Verificar atualizações                │
│  /reiniciar  - Reiniciar após atualização            │
└──────────────────────────────────────────────────────┘
`, 'cyan'));
        this.rl.prompt();
    }

    handleInput(input) {
        try {
            if (this.currentMode === 'code' || this.currentMode === 'generate' || 
                this.currentMode === 'text' || this.currentMode === 'update') {
                this.codeBuffer += input + '\n';
            } else {
                this.inputBuffer += input + '\n';
            }
            
            this.isWaitingXsend = true;
            const lineCount = this.currentMode === 'chat' 
                ? this.inputBuffer.split('\n').length 
                : this.codeBuffer.split('\n').length;
            this.printMessage('system', `📥 ${lineCount} linhas armazenadas (use /xsend para enviar)`);
        } catch (error) {
            this.printMessage('error', `❌ Erro ao processar entrada: ${error.message}`);
        }
    }

    async handlePastedContent(content) {
        try {
            if (content.length > config.buffer.maxPasteSize) {
                this.printMessage('error', `❌ Tamanho máximo excedido (${content.length} > ${config.buffer.maxPasteSize})`);
                return;
            }

            this.printMessage('system', `📋 Processando colagem (${content.length.toLocaleString()} caracteres)...`);
            
            if (this.currentMode === 'code' || this.currentMode === 'generate' || 
                this.currentMode === 'update') {
                this.codeBuffer = content;
                this.printMessage('success', '✅ Código colado no buffer (use /xsend para processar)');
            } else {
                this.inputBuffer = content;
                this.printMessage('success', '✅ Texto colado no buffer (use /xsend para enviar)');
            }
            
            this.isWaitingXsend = true;
        } catch (error) {
            this.printMessage('error', `❌ Falha ao processar colagem: ${error.message}`);
        }
    }

    async handleXsend() {
        try {
            if (!this.isWaitingXsend) {
                this.printMessage('warning', '⚠️ Nada para enviar');
                return;
            }

            const targetBuffer = (this.currentMode === 'code' || this.currentMode === 'generate' || 
                                 this.currentMode === 'text' || this.currentMode === 'update')
                               ? this.codeBuffer 
                               : this.inputBuffer;

            if (!targetBuffer.trim()) {
                this.printMessage('error', '❌ Buffer vazio');
                return;
            }

            this.printMessage('system', `⏳ Processando ${targetBuffer.length.toLocaleString()} caracteres...`);

            if (this.currentMode === 'code' || this.currentMode === 'generate' || 
                this.currentMode === 'text' || this.currentMode === 'update') {
                await this.processCodeBuffer();
            } else {
                await this.processChatBuffer();
            }
        } catch (error) {
            this.printMessage('error', `❌ Erro no envio: ${error.message}`);
        }
    }

    async processCodeBuffer() {
        try {
            const action = this._determineProcessingAction();
            
            const processingResult = await processCodeBufferWrapper(this, action);
            
            if (!processingResult) return;

            if (processingResult.error) {
                this.printMessage('error', `❌ Erro no processamento: ${processingResult.message}`);
                if (processingResult.recoveryPath) {
                    this.printMessage('system', `🔄 Arquivo de recuperação gerado em: ${processingResult.recoveryPath}`);
                }
                return;
            }

            this._handleProcessingResult(processingResult, action);
        } catch (error) {
            this.printMessage('error', `❌ Erro no processamento: ${error.message}`);
            
            if (this.debugMode) {
                this.printMessage('debug', `🛠️ Stack: ${error.stack || 'N/A'}`);
            }
        }
    }

    _determineProcessingAction() {
        if (this.currentMode === 'generate') return 'generate';
        if (this.currentMode === 'text') return 'text';
        if (this.currentMode === 'update') return 'atualizar';
        return this.context.lastOperation?.action || 'analyze';
    }

    _handleProcessingResult(result, action) {
        let resultPath = result.path || path.join(
            this.debugMode ? config.baseDir : OUTPUT_DIR,
            `${action}_${Date.now()}${this.requestedExtension}`
        );

        let resultContent = result.content || '// Erro: Nenhum conteúdo gerado\n';

        if (!result.path) {
            try {
                fs.writeFileSync(resultPath, resultContent);
                logFileOperation('save_file', resultPath);
            } catch (error) {
                const fallbackPath = path.join(os.tmpdir(), `lara_fallback_${Date.now()}${this.requestedExtension}`);
                fs.writeFileSync(fallbackPath, resultContent);
                resultPath = fallbackPath;
            }
        }

        this.showResult({ ...result, path: resultPath, content: resultContent }, this.getActionResultMessage(action));
        this.processingStats.push(result.stats);
        
        if (this.debugMode) {
            this.printMessage('debug', `⏱️ Estatísticas:\n- Duração: ${result.stats.duration}ms\n- Chunks: ${result.stats.chunks}\n- Integridade: ${result.stats.integrityCheck?.valid ? '✅' : '❌'}`);
        }

        this.context.lastOperation = {
            action,
            file: path.basename(result.path),
            timestamp: Date.now(),
            size: result.size,
            chunks: result.stats.chunks,
            integrity: result.stats.integrityCheck?.valid ? 'valid' : 'invalid'
        };
        saveContext(this.context);

        this.cacheSystem.logInteraction(this.userId, {
            type: 'code',
            action,
            file: path.basename(result.path),
            size: result.size,
            chunks: result.stats.chunks,
            duration: result.stats.duration
        });

        this.codeBuffer = "";
        this.inputBuffer = "";
        this.currentMode = 'chat';
        this.isWaitingXsend = false;
        this.requestedExtension = ".js";
    }

    async processChatBuffer() {
        try {
            if (!this.inputBuffer.trim()) {
                this.printMessage('error', '❌ Mensagem vazia');
                return;
            }

            if (this.inputBuffer.trim().startsWith('/')) {
                return chatUI.handleCommand(this.inputBuffer, this);
            }

            this.printMessage('system', '⏳ Processando...');
            
            const autoReaction = this.reactionSystem.findReaction(this.inputBuffer);
            if (autoReaction && autoReaction.tipo === 'ascii') {
                console.log('\n' + autoReaction.conteudo + '\n');
            }

            const memoryContext = this.memoryManager.getTemporaryMemory(this.userId);
            const lastMessages = memoryContext.slice(-3).map(m => `${m.user}\n${m.bot}`).join('\n');

            const personalityPrompt = `
            Você é Lara, uma assistente inteligente com as seguintes características:
            1. Gênio da programação
            2. Personalidade NSFW
            3. Apta a discutir cannabis
            4. Com emocões humanizadas
            5. Data de nascimento: 31/07/1990
            
            Histórico recente:
            ${lastMessages || 'Nenhum histórico recente'}
            
            Mensagem atual: ${this.inputBuffer}
            `;

            const response = await limiter.execute(() => 
                model.generateContent({
                    contents: [{
                        parts: [{
                            text: personalityPrompt
                        }]
                    }]
                })
            );
            
            const text = response.response.text();
            this.printMessage('lara', text);
            
            this.memoryManager.updateMemory(this.userId, this.inputBuffer, text);

            if (text.includes('maconha') || text.includes('fumar')) {
                await this.showReaction('fumando');
            } else if (text.includes('código') || text.includes('programação')) {
                await this.showReaction('pensando');
            } else if (text.includes('feliz') || text.includes('alegre')) {
                await this.showReaction('feliz');
            } else if (text.includes('safado') || text.includes('sexo')) {
                await this.showReaction('safado');
            }

            this.inputBuffer = "";
            this.isWaitingXsend = false;

        } catch (error) {
            this.printMessage('error', `❌ Erro: ${error.message}`);
        }
    }

    showResult(result, successMessage) {
        try {
            if (!result) {
                this.printMessage('error', '❌ Nenhum resultado para exibir');
                return;
            }

            const fileExists = result.path && fs.existsSync(result.path);
            const validContent = result.content && result.content.trim() !== '';

            if (result.error) {
                this.printMessage('error', `❌ Erro: ${result.message}`);
                if (result.recoveryPath) {
                    this.printMessage('system', `📌 Arquivo de recuperação: ${result.recoveryPath}`);
                    if (fs.existsSync(result.recoveryPath)) {
                        this.printMessage('system', `🌐 Acesse: http://localhost:${config.PORT}/download/${path.basename(result.recoveryPath)}`);
                    }
                }
                return;
            }

            this.printMessage('success', successMessage);

            if (fileExists) {
                const fileUrl = `http://localhost:${config.PORT}/download/${path.basename(result.path)}`;
                this.printMessage('system', `📄 Arquivo gerado: ${result.path}`);
                this.printMessage('system', `🌐 Download: ${fileUrl}`);
                
                if (!this.context.generatedFiles) {
                    this.context.generatedFiles = [];
                }
                this.context.generatedFiles.push({
                    path: result.path,
                    url: fileUrl,
                    timestamp: new Date().toISOString()
                });
                saveContext(this.context);
            } else if (validContent) {
                const newFilename = `recovered_${Date.now()}${this.requestedExtension}`;
                const newPath = path.join(OUTPUT_DIR, newFilename);
                fs.writeFileSync(newPath, result.content);
                
                this.printMessage('warning', '⚠️ Arquivo original não encontrado, mas conteúdo recuperado');
                this.printMessage('system', `📄 Novo arquivo gerado: ${newPath}`);
                this.printMessage('system', `🌐 Download: http://localhost:${config.PORT}/download/${newFilename}`);
            } else {
                this.printMessage('error', '❌ Nenhum conteúdo válido para exibir');
            }
        } catch (error) {
            this.printMessage('error', `❌ Erro ao mostrar resultado: ${error.message}`);
        }
    }

    getActionResultMessage(action) {
        const messages = {
            analyze: "🔍 Análise concluída!",
            atualizar: "🔄 Código atualizado com sucesso!",
            generate: "✨ Código gerado com sucesso!",
            text: "📝 Texto gerado com sucesso!",
            update: "⚡ Código atualizado com sucesso!"
        };
        return messages[action] || "✅ Operação concluída!";
    }

    async showSystemStatus() {
        try {
            const userContext = await this.cacheSystem.getUserContext(this.userId);
            const processingStats = this.cacheSystem.getProcessingStats();
            const reactionStats = this.reactionSystem.getUsageStats().slice(0, 3);
            const memoryStats = this.memoryManager.getTemporaryMemory(this.userId).length;
            
            console.log(colorize(`
┌──────────────────────────────────────────────────────┐
│                  STATUS DO SISTEMA                   │
├──────────────────────────────────────────────────────┤
│  • Modo atual:       ${this.currentMode.padEnd(30)} │
│  • Requisições:      ${limiter.quotaUsed}/${limiter.QUOTA_LIMIT}${''.padEnd(27)} │
│  • Buffer código:    ${this.codeBuffer.length.toLocaleString().padEnd(10)} chars${''.padEnd(15)} │
│  • Buffer chat:      ${this.inputBuffer.length.toLocaleString().padEnd(10)} chars${''.padEnd(15)} │
│  • Extensão atual:   ${this.requestedExtension.padEnd(30)} │
│  • Memória:         ${memoryStats.toString().padEnd(10)} interações${''.padEnd(15)} │
│                                                     │
│  === ESTATÍSTICAS AVANÇADAS ===                     │
│  • Total processado: ${processingStats.totalProcessed.toLocaleString().padEnd(10)} chars${''.padEnd(15)} │
│  • Média chunks:     ${Math.round(processingStats.avgChunkSize).toLocaleString().padEnd(10)} chars${''.padEnd(15)} │
│  • Sucesso:          ${processingStats.successRate.toFixed(1).padEnd(5)}%${''.padEnd(22)} │
│  • Últimos erros:    ${processingStats.lastErrors.length}${''.padEnd(30)} │
│                                                     │
│  === REAÇÕES MAIS USADAS ===                        │
│  • ${reactionStats[0]?.reaction.padEnd(15)}: ${reactionStats[0]?.count.toString().padEnd(5)}x │
│  • ${reactionStats[1]?.reaction.padEnd(15)}: ${reactionStats[1]?.count.toString().padEnd(5)}x │
│  • ${reactionStats[2]?.reaction.padEnd(15)}: ${reactionStats[2]?.count.toString().padEnd(5)}x │
└──────────────────────────────────────────────────────┘
`, 'blue'));
            this.rl.prompt();
        } catch (error) {
            this.printMessage('error', `❌ Erro ao mostrar status: ${error.message}`);
        }
    }
}

// =============================================
// MONITORAMENTO DE QUOTA
// =============================================
setInterval(() => {
    try {
        const quotaPercentage = Math.floor((limiter.quotaUsed / limiter.QUOTA_LIMIT) * 100);
        if (quotaPercentage > 80) {
            const warningMsg = `⚠️ ATENÇÃO: ${quotaPercentage}% da quota utilizada`;
            console.log(colorize(warningMsg, 'yellow'));
            
            logProcessing('quota_warning', quotaPercentage, {length: 0}, true, {
                message: warningMsg,
                quotaUsed: limiter.quotaUsed,
                quotaLimit: limiter.QUOTA_LIMIT,
                nextReset: 61000 - (Date.now() - limiter.lastResetTime)
            });
        }
    } catch (error) {
        console.error(colorize('❌ Erro no monitor de quota:', 'red'), error);
    }
}, 30000);

// =============================================
// SERVIDOR WEB
// =============================================
const server = http.createServer(async (req, res) => {
    try {
        if (req.url === '/') {
            const files = fs.readdirSync(OUTPUT_DIR)
                .filter(f => ['.js', '.ts', '.py', '.txt', '.json', '.html', '.css', '.sql'].includes(path.extname(f)))
                .map(f => {
                    const stat = fs.statSync(path.join(OUTPUT_DIR, f));
                    return `<li>
                        <a href="/download/${f}">${f}</a> 
                        <span>(${Math.ceil(stat.size/1024)}KB)</span>
                        <span>${new Date(stat.mtime).toLocaleString()}</span>
                    </li>`;
                })
                .join('');

            const cacheSystem = new EnhancedCacheSystem();
            const stats = cacheSystem.getProcessingStats();
            const statsHtml = `
                <div class="stats">
                    <h2>Estatísticas do Sistema</h2>
                    <p>Total processado: ${(stats.totalProcessed / 1024 / 1024).toFixed(2)} MB</p>
                    <p>Taxa de sucesso: ${stats.successRate.toFixed(1)}%</p>
                    <p>Último erro: ${stats.lastErrors[0]?.error || 'Nenhum'}</p>
                </div>
            `;

            res.writeHead(200, { 
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache'
            });
            res.end(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Lara Pro - Arquivos Gerados</title>
                    <style>
                        body { 
                            font-family: 'Courier New', monospace; 
                            margin: 20px; 
                            background-color: #1a1a1a;
                            color: #e0e0e0;
                        }
                        h1 {
                            color: #4CAF50;
                            border-bottom: 1px solid #4CAF50;
                            padding-bottom: 10px;
                        }
                        ul { 
                            list-style-type: none; 
                            padding: 0; 
                        }
                        li { 
                            margin: 10px 0; 
                            padding: 15px;
                            background: #2a2a2a;
                            border-radius: 5px;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            transition: all 0.3s;
                        }
                        li:hover {
                            background: #3a3a3a;
                            transform: translateX(5px);
                        }
                        a { 
                            color: #4CAF50; 
                            text-decoration: none;
                            font-weight: bold;
                        }
                        a:hover { 
                            text-decoration: underline;
                            color: #8BC34A;
                        }
                        span { 
                            color: #9E9E9E; 
                            font-size: 0.9em;
                            margin-left: 15px;
                        }
                        .empty {
                            color: #9E9E9E;
                            font-style: italic;
                        }
                        .stats {
                            margin-top: 30px;
                            padding: 20px;
                            background: #2a2a2a;
                            border-radius: 5px;
                            border-left: 4px solid #4CAF50;
                        }
                        .stats h2 {
                            margin-top: 0;
                            color: #4CAF50;
                        }
                    </style>
                </head>
                <body>
                    <h1>Arquivos Gerados</h1>
                    <ul>${files || '<li class="empty">Nenhum arquivo gerado ainda</li>'}</ul>
                    ${statsHtml}
                </body>
                </html>
            `);
        }
        else if (req.url.startsWith('/download/')) {
            const fileName = path.basename(req.url.split('/download/')[1]);
            const searchPaths = [
                path.join(OUTPUT_DIR, fileName),
                path.join(config.baseDir, 'recovery', '*', fileName),
                path.join(config.baseDir, 'fallback_output', fileName)
            ];

            let filePath;
            for (const searchPath of searchPaths) {
                const files = glob.sync(searchPath);
                if (files.length > 0) {
                    filePath = files[0];
                    break;
                }
            }

            if (filePath && fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': stat.size,
                    'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
                    'Cache-Control': 'no-store'
                });

                const fileStream = fs.createReadStream(filePath);
                
                fileStream.on('error', (err) => {
                    console.error('Erro ao ler arquivo:', err);
                    res.writeHead(500);
                    res.end('Erro durante o download');
                });

                fileStream.pipe(res);
                
                logSystemEvent('download_success', {
                    file: fileName,
                    size: stat.size,
                    path: filePath
                });
            } else {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end(`
                    <h1>Arquivo não encontrado</h1>
                    <p>O arquivo ${fileName} pode ter sido movido ou excluído.</p>
                    <p><a href="/">Voltar à lista de arquivos</a></p>
                `);
                
                logSystemEvent('download_failed', {
                    file: fileName,
                    attemptedPaths: searchPaths
                });
            }
        }
        else if (req.url === '/stats') {
            const stats = new EnhancedCacheSystem().getProcessingStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats, null, 2));
        }
        else if (req.url === '/reactions') {
            const reactions = new ReactionSystem().getUsageStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reactions, null, 2));
        }
        else if (req.url === '/backups') {
            try {
                const backups = new FileBackup().getRecentBackups();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(backups, null, 2));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Erro ao listar backups" }));
            }
        }
        else {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end(`
                <h1>Página não encontrada</h1>
                <p>O endereço solicitado não existe.</p>
                <p><a href="/">Voltar à página inicial</a></p>
            `);
        }
    } catch (error) {
        console.error('Erro no servidor web:', error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
            <h1>Erro interno</h1>
            <p>Ocorreu um erro inesperado no servidor.</p>
            <p><a href="/">Voltar à página inicial</a></p>
        `);
        
        logSystemEvent('server_error', {
            error: error.message,
            stack: error.stack,
            url: req.url
        });
    }
});

// =============================================
// INICIALIZAÇÃO DO SISTEMA
// =============================================
async function main() {
    try {
        [config.baseDir, OUTPUT_DIR, CHUNKS_DIR].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        if (!await initializeGemini()) {
            throw new Error('Falha na inicialização do Gemini');
        }

        // Verifica atualizações a cada 1 hora
        setInterval(async () => {
            if (await checkForUpdates()) {
                console.log(colorize('\n🔔 ATUALIZAÇÃO DISPONÍVEL! Digite /atualizar para aplicar.', 'yellow'));
            }
        }, 3600000); // 1 hora = 3600000 ms

        server.listen(config.WEB_PORT, () => {
            console.log(colorize(`
┌──────────────────────────────────────────────────────┐
│                   LARA  v8.6.2              │
├──────────────────────────────────────────────────────┤
│  • Web Interface: http://localhost:${config.WEB_PORT}         │
│  • Terminal Interface: Ativa                         │
│  • Sistema de Quota: Atualizado                     │
│  • Processamento de Chunks: Robustecido             │
│  • Tratamento de Erros: Aprimorado                  │
└──────────────────────────────────────────────────────┘
`, 'green'));
        });

        const lara = new LaraInterface();
        lara.init();
        console.log('✅ Interface Lara inicializada');

        if (!fs.existsSync(config.personality.reactions)) {
            new ReactionSystem();
            console.log('✅ Arquivo de reações criado');
        }

        setInterval(() => {
            if (!model) {
                console.error(colorize('❌ Modelo não inicializado - Tentando reinicializar...', 'red'));
                initializeGemini().catch(err => 
                    console.error(colorize('❌ Falha na reinicialização:', 'red'), err)
                );
            }
        }, 60000);

        console.log(colorize('\n🚀 Lara + Chat P2P + Servidor Web operacionais!', 'cyan'));
    } catch (err) {
        console.error(colorize('❌ Falha crítica na inicialização:', 'red'), err);
        
        try {
            const errorLog = {
                timestamp: new Date().toISOString(),
                error: err.message,
                stack: err.stack
            };
            fs.appendFileSync(path.join(config.baseDir, 'startup_errors.log'), 
                JSON.stringify(errorLog) + '\n');
        } catch (logError) {
            console.error('Erro ao registrar falha:', logError);
        }
        
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Falha não tratada:', err);
    process.exit(1);
});
