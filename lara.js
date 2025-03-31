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
// SISTEMA DE BOOTSTRAP DA REDE P2P
// =============================================
class NetworkBootstrap {
    constructor() {
        this.bootstrapNodes = [
            "QmXy5...7a1", // Hash IPFS do nó 1
            "QmYz8...3b2", // Hash IPFS do nó 2
            "QmZ91...5c3"  // Hash IPFS do nó 3
        ];
        this.peerDatabase = new Map();
        this.lastSync = 0;
    }

    async initialize() {
        // Ao iniciar, tenta baixar a base de dados da rede
        await this.downloadNetworkDatabase();
        
        // Agenda sincronizações periódicas
        setInterval(() => this.syncNetworkDatabase(), 3600000); // A cada 1 hora
    }

    async downloadNetworkDatabase() {
        try {
            // 1. Tenta conectar com nós de bootstrap via Gemini
            const bootstrapData = await this.fetchFromBootstrapNodes();
            
            // 2. Baixa a DHT parcial mais recente
            const partialDHT = await this.fetchPartialDHT();
            
            // 3. Mescla com dados locais
            this.mergeDatabase(partialDHT);
            
            console.log(colorize('✅ Base de dados da rede carregada com sucesso', 'green'));
            logSystemEvent('bootstrap_success', {
                peersLoaded: partialDHT.size,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error(colorize('❌ Falha ao carregar base da rede:', 'red'), error);
            
            // Fallback: usa dados locais se houver
            if (this.peerDatabase.size > 0) {
                console.log(colorize('⚠️ Usando cache local de peers', 'yellow'));
            } else {
                console.log(colorize('⚠️ Rede inicial vazia - Este é o primeiro nó?', 'yellow'));
            }
        }
    }

    async fetchFromBootstrapNodes() {
        // Usa a API Gemini para encontrar peers ativos
        const query = "REDE_LARA:GET_ACTIVE_PEERS:" + Date.now();
        
        const responses = await Promise.allSettled(
            this.bootstrapNodes.map(node => 
                model.generateContent({
                    contents: [{
                        parts: [{ text: query }]
                    }]
                })
            )
        );

        // Processa as respostas válidas
        const activePeers = new Set();
        responses.forEach(response => {
            if (response.status === 'fulfilled') {
                const peers = response.value.response.text()
                    .split('\n')
                    .filter(p => p.startsWith('@'));
                peers.forEach(p => activePeers.add(p));
            }
        });

        return Array.from(activePeers);
    }

async fetchPartialDHT() {
    try {
        const randomPeerQuery = "REDE_LARA:GET_DHT_FRAGMENT:" + crypto.randomBytes(8).toString('hex');
        
        const response = await model.generateContent({
            contents: [{
                parts: [{ text: randomPeerQuery }]
            }]
        });

        const responseText = response.response.text();
        
        // Verifica se parece ser JSON antes de parsear
        if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
            try {
                return new Map(Object.entries(JSON.parse(responseText)));
            } catch (e) {
                console.error('Resposta não era JSON válido:', responseText.substring(0, 100));
                return new Map();
            }
        }
        
        // Se não for JSON, retorna mapa vazio
        return new Map();
        
    } catch (e) {
        console.error('Erro ao obter DHT:', e);
        return new Map();
    }
}

    mergeDatabase(newData) {
        newData.forEach((value, key) => {
            if (!this.peerDatabase.has(key)) {
                this.peerDatabase.set(key, value);
            } else {
                // Atualiza apenas se os dados forem mais recentes
                if (value.lastUpdated > this.peerDatabase.get(key).lastUpdated) {
                    this.peerDatabase.set(key, value);
                }
            }
        });
    }

    async syncNetworkDatabase() {
        try {
            // Envia nossos peers conhecidos para a rede
            await this.shareLocalPeers();
            
            // Baixa atualizações
            await this.downloadNetworkDatabase();
            
            this.lastSync = Date.now();
        } catch (error) {
            console.error('Erro na sincronização:', error);
        }
    }

    async shareLocalPeers() {
        if (this.peerDatabase.size === 0) return;

        // Prepara dados para compartilhar (apenas peers ativos recentemente)
        const peersToShare = Array.from(this.peerDatabase.entries())
            .filter(([_, data]) => data.lastSeen > Date.now() - 86400000) // Últimas 24h
            .slice(0, 50); // Limite de 50 peers por vez

        const shareMessage = {
            type: "PEER_SHARE",
            peers: Object.fromEntries(peersToShare),
            timestamp: Date.now(),
            origin: `@${os.userInfo().username}`
        };

        // Publica na rede via Gemini
        await model.generateContent({
            contents: [{
                parts: [{
                    text: `REDE_LARA:PEER_UPDATE:${JSON.stringify(shareMessage)}`
                }]
            }]
        });
    }
}

// =============================================
// BANCO DE DADOS DISTRIBUÍDO P2P
// =============================================
class DistributedPeerDatabase {
    constructor() {
        this.localContacts = new Map(); // Contatos adicionados pelo usuário local
        this.globalIndex = new Map();  // Índice global distribuído (hash -> peers)
        this.messageQueue = new Map(); // Fila de mensagens pendentes
        this.peerStatus = new Map();   // Status online/offline dos peers
        this.syncInterval = null;
        this.DHT = new Map();          // Tabela hash distribuída simulada
        this.bootstrap = new NetworkBootstrap();
        this.peerCacheTTL = 86400000; // 24 horas
    }

    async initialize() {
        // Carrega contatos locais do armazenamento
        await this.loadLocalContacts();
        
        // Inicia o processo de sincronização periódica
        this.syncInterval = setInterval(() => this.syncWithNetwork(), 30000);
        
        // Registra este peer na rede
        await this.registerPeer();
        
        // Inicializa o bootstrap
        await this.bootstrap.initialize();
        this.loadPersistedPeers();
    }

    loadPersistedPeers() {
        try {
            const peerCacheFile = path.join(config.baseDir, 'network_cache.json');
            if (fs.existsSync(peerCacheFile)) {
                const cacheData = JSON.parse(fs.readFileSync(peerCacheFile, 'utf-8'));
                
                // Verifica se o cache ainda é válido
                if (cacheData.timestamp > Date.now() - this.peerCacheTTL) {
                    cacheData.peers.forEach(peer => {
                        this.globalIndex.set(peer.username, peer);
                    });
                    console.log(colorize(`✅ Cache de rede carregado (${cacheData.peers.length} peers)`, 'green'));
                }
            }
        } catch (error) {
            console.error('Erro ao carregar cache de peers:', error);
        }
    }

    savePeerCache() {
        try {
            const peerCacheFile = path.join(config.baseDir, 'network_cache.json');
            const peersToSave = Array.from(this.globalIndex.values())
                .filter(peer => peer.lastSeen > Date.now() - this.peerCacheTTL);
            
            const cacheData = {
                timestamp: Date.now(),
                peers: peersToSave
            };
            
            fs.writeFileSync(peerCacheFile, JSON.stringify(cacheData, null, 2));
        } catch (error) {
            console.error('Erro ao salvar cache de peers:', error);
        }
    }

    async loadLocalContacts() {
        try {
            const contactsFile = path.join(config.baseDir, 'p2p_contacts.json');
            if (fs.existsSync(contactsFile)) {
                const data = fs.readFileSync(contactsFile, 'utf-8');
                const contacts = JSON.parse(data);
                contacts.forEach(contact => {
                    this.localContacts.set(contact.username, {
                        ...contact,
                        lastSeen: contact.lastSeen || 0,
                        publicKey: contact.publicKey || ''
                    });
                });
            }
        } catch (error) {
            console.error('Erro ao carregar contatos:', error);
        }
    }

    async saveLocalContacts() {
        try {
            const contactsFile = path.join(config.baseDir, 'p2p_contacts.json');
            const contacts = Array.from(this.localContacts.values());
            fs.writeFileSync(contactsFile, JSON.stringify(contacts, null, 2));
        } catch (error) {
            console.error('Erro ao salvar contatos:', error);
        }
    }

    async registerPeer() {
        // Gera um ID único para este peer
        const peerId = crypto.randomBytes(16).toString('hex');
        const username = `@${os.userInfo().username}`;
        
        // Cria um par de chaves para criptografia
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        
        // Armazena localmente
        this.localPeer = {
            peerId,
            username,
            publicKey,
            privateKey,
            lastSeen: Date.now(),
            status: 'online'
        };
        
        // Adiciona-se à lista de contatos
        this.localContacts.set(username, {
            username,
            publicKey,
            lastSeen: Date.now(),
            status: 'online'
        });
        
        // Publica na DHT (simulada)
        this.publishToDHT(username, {
            peerId,
            publicKey,
            lastSeen: Date.now()
        });
    }

    publishToDHT(key, value) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    this.DHT.set(hash, value);
    
    // Modificado para ser silencioso - remova se quiser desativar completamente
    if (this.debugMode) {
        console.log(colorize(`🌐 [DEBUG] Publicado na DHT: ${key}`, 'gray'));
    }
}

    async queryDHT(key) {
        const hash = crypto.createHash('sha256').update(key).digest('hex');
        return this.DHT.get(hash);
    }

    async addContact(username) {
        if (!username.startsWith('@')) {
            username = '@' + username;
        }
        
        if (this.localContacts.has(username)) {
            return { success: false, message: 'Contato já adicionado' };
        }
        
        try {
            // Consulta a DHT para encontrar o peer
            const peerInfo = await this.queryDHT(username);
            
            if (peerInfo) {
                this.localContacts.set(username, {
                    username,
                    publicKey: peerInfo.publicKey,
                    lastSeen: peerInfo.lastSeen,
                    status: 'offline'
                });
                
                await this.saveLocalContacts();
                return { success: true, message: 'Contato adicionado' };
            }
            
            return { success: false, message: 'Usuário não encontrado na rede' };
        } catch (error) {
            console.error('Erro ao adicionar contato:', error);
            return { success: false, message: 'Erro ao adicionar contato' };
        }
    }

    async syncWithNetwork() {
    // Atualiza o status deste peer
    this.localPeer.lastSeen = Date.now();
    
    // Publica na DHT apenas se as mensagens de rede estiverem ativadas
    if (this.laraInterface?.showNetworkMessages) {
        this.publishToDHT(this.localPeer.username, {
            peerId: this.localPeer.peerId,
            publicKey: this.localPeer.publicKey,
            lastSeen: this.localPeer.lastSeen
        });
    }
    
    // Verifica status dos contatos silenciosamente
    for (const [username, contact] of this.localContacts) {
        if (username === this.localPeer.username) continue;
        
        try {
            const peerInfo = await this.queryDHT(username);
            if (peerInfo) {
                const isOnline = (Date.now() - peerInfo.lastSeen) < 300000; // 5 minutos
                contact.status = isOnline ? 'online' : 'offline';
                contact.lastSeen = peerInfo.lastSeen;
                
                // Entregar mensagens pendentes mesmo com mensagens silenciadas
                if (isOnline) {
                    await this.deliverPendingMessages(username);
                }
            }
        } catch (error) {
            // Log silencioso em modo produção
            if (this.laraInterface?.debugMode) {
                console.error(`[DEBUG] Erro ao verificar ${username}:`, error);
            }
        }
    }
    
    // Atualiza dados locais sem notificações
    await this.saveLocalContacts();
    this.savePeerCache();
}

async deliverPendingMessages(username) {
    if (!this.messageQueue.has(username)) return;
    
    const messages = this.messageQueue.get(username);
    while (messages.length > 0) {
        const message = messages.shift();
        try {
            await this.sendMessageDirect(username, message);
            
            // Mostra confirmação apenas se as mensagens estiverem ativadas
            if (this.laraInterface?.showNetworkMessages) {
                this.laraInterface.printMessage('system', 
                    `✉️ Mensagem entregue para ${username}`);
            }
        } catch (error) {
            // Recoloca a mensagem na fila se houver erro
            messages.unshift(message);
            if (this.laraInterface?.debugMode) {
                console.error(`[DEBUG] Falha na entrega para ${username}:`, error);
            }
            break;
        }
    }
    
    if (messages.length === 0) {
        this.messageQueue.delete(username);
    }
}

    async sendMessageDirect(username, message) {
        try {
            const contact = this.localContacts.get(username);
            if (!contact) {
                throw new Error('Contato não encontrado');
            }
            
            // Criptografa a mensagem com a chave pública do destinatário
            const encrypted = crypto.publicEncrypt(
                contact.publicKey,
                Buffer.from(JSON.stringify(message))
            ).toString('base64');
            
            // Usa o Gemini para enviar a mensagem (simulação)
            const response = await model.generateContent({
                contents: [{
                    parts: [{
                        text: `MENSAGEM_P2P:${username}:${this.localPeer.username}:${encrypted}`
                    }]
                }]
            });
            
            console.log(colorize(`✉️ Mensagem enviada para ${username} via Gemini`, 'green'));
            return true;
        } catch (error) {
            console.error(`Erro ao enviar mensagem para ${username}:`, error);
            
            // Adiciona à fila de mensagens pendentes
            if (!this.messageQueue.has(username)) {
                this.messageQueue.set(username, []);
            }
            this.messageQueue.get(username).push(message);
            
            return false;
        }
    }

    async receiveMessage(encryptedMessage) {
        try {
            // Decriptografa com a chave privada
            const decrypted = crypto.privateDecrypt(
                this.localPeer.privateKey,
                Buffer.from(encryptedMessage, 'base64')
            ).toString('utf-8');
            
            return JSON.parse(decrypted);
        } catch (error) {
            console.error('Erro ao decriptografar mensagem:', error);
            return null;
        }
    }

    async publishPresence() {
        // Publica nossa presença na rede
        const presenceData = {
            username: `@${os.userInfo().username}`,
            peerId: this.localPeer.peerId,
            publicKey: this.localPeer.publicKey,
            lastSeen: Date.now(),
            endpoints: [
                `gemini://${crypto.randomBytes(4).toString('hex')}.lara`
            ]
        };

        // Publica na DHT
        this.publishToDHT(presenceData.username, presenceData);
        
        // Compartilha com alguns peers diretamente
        await this.shareWithRandomPeers(presenceData);
    }

    async shareWithRandomPeers(data) {
        // Seleciona até 3 peers aleatórios para compartilhar
        const randomPeers = Array.from(this.globalIndex.values())
            .filter(peer => peer.username !== data.username)
            .sort(() => 0.5 - Math.random())
            .slice(0, 3);
        
        if (randomPeers.length === 0) return;

        // Usa Gemini para enviar atualizações
        const updateMessage = `REDE_LARA:PEER_UPDATE:${JSON.stringify(data)}`;
        
        await Promise.allSettled(
            randomPeers.map(peer => 
                model.generateContent({
                    contents: [{
                        parts: [{ text: updateMessage }]
                    }]
                })
            )
        );
    }
}

// =============================================
// SISTEMA DE CHAT P2P ATUALIZADO
// =============================================
class PeerChat {
    constructor(laraInterface) {
        this.laraInterface = laraInterface;
        this.peers = new Map(); // Peers conhecidos
        this.currentPeer = null; // Peer atual conectado
        this.messageHistory = []; // Histórico de mensagens
        this.discoveryInterval = null; // Intervalo de descoberta
        this.peerDB = new DistributedPeerDatabase(); // Banco de dados distribuído
    }

    async setup() {
        await this.peerDB.initialize();
        
        this.discoveryInterval = setInterval(() => {
            this._discoverPeers();
        }, 30000);
        
        this.laraInterface.printMessage('system', '🔍 Procurando peers na rede...');
    }

    async _discoverPeers() {
        // Atualiza primeiro a base de dados da rede
        await this.peerDB.syncWithNetwork();
        
        // Depois atualiza a lista de peers
        this.peers = new Map();
        
        for (const [username, contact] of this.peerDB.localContacts) {
            this.peers.set(username, {
                status: contact.status,
                lastSeen: contact.lastSeen,
                isContact: true
            });
        }
        
        // Adiciona alguns peers da rede global (não são contatos ainda)
        Array.from(this.peerDB.globalIndex.entries())
            .filter(([username, _]) => !this.peers.has(username))
            .slice(0, 10) // Limita a 10 peers sugeridos
            .forEach(([username, data]) => {
                this.peers.set(username, {
                    status: data.lastSeen > Date.now() - 300000 ? 'online' : 'offline',
                    lastSeen: data.lastSeen,
                    isContact: false
                });
            });
        
        this.updatePeerStatusDisplay();
    }

    updatePeerStatusDisplay() {
    // Verifica se as mensagens de peer estão desativadas
    if (!this.laraInterface.showPeerStatus) return;

    const onlinePeers = Array.from(this.peers.entries())
        .filter(([_, data]) => data.status === 'online')
        .map(([username, _]) => username);
    
    const offlinePeers = Array.from(this.peers.entries())
        .filter(([_, data]) => data.status === 'offline' && data.isContact)
        .map(([username, _]) => username);

    // Mostra apenas se estiver em debug mode
    if (this.laraInterface.debugMode) {
        this.laraInterface.printMessage('debug', 
            `[REDE] ${onlinePeers.length} online, ${offlinePeers.length} offline`);
    }
}
    async connectTo(username) {
        if (!username.startsWith('@')) {
            username = '@' + username;
        }

        // Verifica se é um contato adicionado
        if (!this.peerDB.localContacts.has(username)) {
            const { success, message } = await this.peerDB.addContact(username);
            if (!success) {
                throw new Error(message);
            }
            
            this.peers.set(username, {
                status: 'offline',
                lastSeen: Date.now(),
                isContact: true
            });
        }

        // Verifica se o peer está online
        const peerInfo = this.peers.get(username);
        if (!peerInfo || peerInfo.status !== 'online') {
            throw new Error(`${username} está offline. Mensagens serão entregues quando ele estiver online.`);
        }

        this.currentPeer = username;
        this.laraInterface.printMessage('system', `✅ Conectado a ${username}`);
        
        // Carrega o histórico de mensagens
        this.loadMessageHistory(username);
        
        return true;
    }

    async send(message) {
        if (!this.currentPeer) {
            throw new Error('Nenhum peer conectado');
        }

        // Adiciona ao histórico local
        this.messageHistory.push({
            from: this.laraInterface.userId,
            to: this.currentPeer,
            message,
            timestamp: Date.now(),
            status: 'sending'
        });

        // Envia a mensagem
        const success = await this.peerDB.sendMessageDirect(this.currentPeer, {
            from: this.laraInterface.userId,
            to: this.currentPeer,
            message,
            timestamp: Date.now()
        });

        if (success) {
            // Atualiza o status da mensagem
            const lastMsg = this.messageHistory[this.messageHistory.length - 1];
            lastMsg.status = 'delivered';
            
            this.laraInterface.printMessage('peer', `➡️ Para ${this.currentPeer}: ${message}`);
        } else {
            this.laraInterface.printMessage('error', `⚠️ Mensagem para ${this.currentPeer} será entregue quando ele estiver online`);
        }
    }

    async receiveMessage(encryptedMessage) {
        const message = await this.peerDB.receiveMessage(encryptedMessage);
        if (!message) return;

        // Adiciona ao histórico
        this.messageHistory.push({
            from: message.from,
            to: message.to,
            message: message.message,
            timestamp: message.timestamp,
            status: 'received'
        });

        // Notifica o usuário
        if (this.currentPeer === message.from) {
            this.laraInterface.printMessage('peer', `⬅️ De ${message.from}: ${message.message}`);
        } else {
            this.laraInterface.printMessage('system', 
                `📩 Nova mensagem de ${message.from} (digite /conectar ${message.from} para responder)`);
        }
        
        // Salva o histórico
        this.saveMessageHistory(message.from);
    }

    loadMessageHistory(peer) {
        try {
            const historyFile = path.join(config.baseDir, 'chat_history', `${peer}.json`);
            if (fs.existsSync(historyFile)) {
                const data = fs.readFileSync(historyFile, 'utf-8');
                this.messageHistory = JSON.parse(data);
            }
        } catch (error) {
            console.error('Erro ao carregar histórico:', error);
        }
    }

    saveMessageHistory(peer) {
        try {
            const historyDir = path.join(config.baseDir, 'chat_history');
            if (!fs.existsSync(historyDir)) {
                fs.mkdirSync(historyDir, { recursive: true });
            }
            
            const historyFile = path.join(historyDir, `${peer}.json`);
            fs.writeFileSync(historyFile, JSON.stringify(this.messageHistory, null, 2));
        } catch (error) {
            console.error('Erro ao salvar histórico:', error);
        }
    }

    getHistory(peer = null) {
        if (peer) {
            return this.messageHistory.filter(
                msg => (msg.from === peer || msg.to === peer)
            ).sort((a, b) => a.timestamp - b.timestamp);
        }
        return this.messageHistory.slice().sort((a, b) => a.timestamp - b.timestamp);
    }

    async searchUser(username) {
        if (!username.startsWith('@')) {
            username = '@' + username;
        }
        
        try {
            const peerInfo = await this.peerDB.queryDHT(username);
            if (peerInfo) {
                return {
                    username,
                    status: (Date.now() - peerInfo.lastSeen) < 300000 ? 'online' : 'offline',
                    lastSeen: peerInfo.lastSeen
                };
            }
            return null;
        } catch (error) {
            console.error('Erro ao buscar usuário:', error);
            return null;
        }
    }
}

// =============================================
// INTERFACE DE CHAT P2P ATUALIZADA
// =============================================
const chatUI = {
    handleCommand: async (input, laraInterface) => {
        const parts = input.trim().split(' ');
        const cmd = parts[0].toLowerCase();
        const chatSystem = laraInterface.chatSystem;

        switch(cmd) {
            case '/conectar':
                if (parts.length < 2) {
                    laraInterface.printMessage('error', 'Uso: /conectar @usuário');
                    return;
                }
                const username = parts[1];
                try {
                    await chatSystem.connectTo(username);
                    laraInterface.printMessage('system', `✅ Conectado a ${username}`);
                    
                    // Mostra o histórico de mensagens
                    const history = chatSystem.getHistory(username);
                    if (history.length > 0) {
                        laraInterface.printMessage('system', '📜 Histórico de mensagens:');
                        history.forEach(msg => {
                            const prefix = msg.from === username ? '⬅️' : '➡️';
                            laraInterface.printMessage('peer', 
                                `${prefix} ${new Date(msg.timestamp).toLocaleString()}: ${msg.message}`);
                        });
                    }
                } catch (err) {
                    laraInterface.printMessage('error', `❌ Erro: ${err.message}`);
                    
                    if (err.message.includes('não encontrado')) {
                        const answer = await laraInterface.askQuestion(`Deseja adicionar ${username} aos seus contatos? (s/n)`);
                        if (answer.toLowerCase() === 's') {
                            try {
                                const result = await chatSystem.peerDB.addContact(username);
                                laraInterface.printMessage('system', `✅ ${result.message}`);
                            } catch (addError) {
                                laraInterface.printMessage('error', `❌ Falha ao adicionar: ${addError.message}`);
                            }
                        }
                    }
                }
                break;
                
            case '/chat':
                laraInterface.printMessage('system', '💬 Modo Chat Ativo. Comandos:');
                laraInterface.printMessage('system', '/conectar @usuário - Conectar a um amigo');
                laraInterface.printMessage('system', '/adicionar @usuário - Adicionar novo contato');
                laraInterface.printMessage('system', '/buscar @usuário - Procurar usuário na rede');
                laraInterface.printMessage('system', '/sair - Voltar ao modo normal');
                break;
                
            case '/adicionar':
                if (parts.length < 2) {
                    laraInterface.printMessage('error', 'Uso: /adicionar @usuário');
                    return;
                }
                try {
                    const usernameToAdd = parts[1];
                    const result = await chatSystem.peerDB.addContact(usernameToAdd);
                    laraInterface.printMessage('system', `✅ ${result.message}`);
                    
                    // Atualiza a lista de peers
                    chatSystem._discoverPeers();
                } catch (err) {
                    laraInterface.printMessage('error', `❌ Erro: ${err.message}`);
                }
                break;
                
            case '/buscar':
                if (parts.length < 2) {
                    laraInterface.printMessage('error', 'Uso: /buscar @usuário');
                    return;
                }
                try {
                    const usernameToSearch = parts[1];
                    laraInterface.printMessage('system', `🔍 Procurando ${usernameToSearch}...`);
                    
                    const userInfo = await chatSystem.searchUser(usernameToSearch);
                    if (userInfo) {
                        laraInterface.printMessage('system', 
                            `👤 ${userInfo.username} - Status: ${userInfo.status === 'online' ? '🟢 Online' : '⚪ Offline'}`);
                        laraInterface.printMessage('system', 
                            `🕒 Última vez online: ${new Date(userInfo.lastSeen).toLocaleString()}`);
                    } else {
                        laraInterface.printMessage('system', 'Usuário não encontrado na rede');
                    }
                } catch (err) {
                    laraInterface.printMessage('error', `❌ Erro na busca: ${err.message}`);
                }
                break;
                
            case '/sair':
                chatSystem.currentPeer = null;
                laraInterface.printMessage('system', '💬 Modo Chat Desativado');
                break;
                
            case '/peers':
                const onlinePeers = Array.from(chatSystem.peers.entries())
                    .filter(([_, data]) => data.status === 'online')
                    .map(([username, _]) => username);
                
                const offlinePeers = Array.from(chatSystem.peers.entries())
                    .filter(([_, data]) => data.status === 'offline' && data.isContact)
                    .map(([username, _]) => username);
                
                laraInterface.printMessage('system', 
                    `👥 Peers: ${colorize(`${onlinePeers.length} online`, 'green')}, ${offlinePeers.length} offline`);
                
                if (onlinePeers.length > 0) {
                    laraInterface.printMessage('system', 
                        `🟢 Online: ${onlinePeers.join(', ')}`);
                }
                
                if (offlinePeers.length > 0) {
                    laraInterface.printMessage('system', 
                        `⚪ Offline: ${offlinePeers.join(', ')}`);
                }
                break;

            case '@net':
                laraInterface.showNetworkMessages = !laraInterface.showNetworkMessages;
                laraInterface.printMessage('system', 
                    `🌐 Mensagens de rede ${laraInterface.showNetworkMessages ? 'ativadas' : 'desativadas'}`);
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
            console.log(colorize(`✂️ Código grande detectado (${content.length} chars), dividindo em chunks...`, 'yellow'));
            
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
        this.showPeerStatus = false; // Adicione esta flag
        this.debugMode = false;  // Controla mensagens técnicas (DHT, rede, etc)
        this.showNetworkMessages = false;  // Específico para mensagens P2P
        
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
        // Comandos que usam regex ou lógica complexa primeiro
        if (command.startsWith('@reacao')) {
            await this.handleReactionCommand(command);
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
            const result = await processMegaCode('refactor', this.codeBuffer, instructions, this.requestedExtension);
            this.showResult(result, "✅ Código atualizado com sucesso!");
            return;
        }

        // Comandos simples com switch
        switch(command.toLowerCase()) {
            case '@peerstatus':
    this.showPeerStatus = !this.showPeerStatus;
    this.showNetworkMessages = this.showPeerStatus;  // Sincroniza as configurações
    this.printMessage('system', `👥 Status de rede ${this.showPeerStatus ? 'ativado' : 'desativado'}`);
    return;
            case '@whoami':
                this.printMessage('system', `🔑 Seu usuário no chat P2P é: ${colorize(`@${os.userInfo().username}`, 'cyan')}`);
                return;

            case '@code':
                this.currentMode = 'code';
                this.codeBuffer = '';
                this.requestedExtension = ".js";
                this.printMessage('system', '💻 Modo Código Ativo. Digite seu código e use /xsend para enviar');
                return;

            case '@chat':
                this.currentMode = 'chat';
                this.printMessage('system', '💬 Modo Conversa Ativado');
                return;

            case '@analyze':
                if (this.currentMode !== 'code') {
                    this.printMessage('error', '❌ Primeiro entre no modo código com @code');
                    return;
                }
                this.printMessage('system', '🔍 Preparado para análise (use /xsend para confirmar)');
                return;

            case '@atualizar':
                if (this.currentMode !== 'code') {
                    this.printMessage('error', '❌ Primeiro entre no modo código com @code');
                    return;
                }
                this.printMessage('system', '🔄 Preparado para atualizar código (use /xsend para confirmar)');
                return;

            case '@generate':
                this.currentMode = 'generate';
                this.codeBuffer = '';
                this.requestedExtension = ".js";
                this.printMessage('system', '✨ Modo Geração Ativado. Descreva o código e use /xsend para gerar');
                this.printMessage('system', '💡 Dica: Use /ext .<formato> para definir a extensão (ex: /ext .py)');
                return;

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
                return;

            case '@web':
                this.printMessage('system', `🌐 Interface web disponível em: http://localhost:${config.PORT}`);
                return;

            case '@status':
                await this.showSystemStatus();
                return;

            case '@help':
                this.showHelp();
                return;

            case '@debug':
                this.debugMode = !this.debugMode;
                this.printMessage('system', `🐞 Modo debug ${this.debugMode ? 'ativado' : 'desativado'}`);
                return;

            case '@exit':
                this.printMessage('system', '👋 Saindo... Até a próxima!');
                this.rl.close();
                process.exit(0);
                return;

            default:
                this.printMessage('warning', '⚠️ Comando desconhecido');
                this.showHelp();
                return;
        }
    } catch (error) {
        this.printMessage('error', `❌ Erro ao processar comando: ${error.message}`);
        if (this.debugMode) {
            this.printMessage('debug', `🛠️ Stack: ${error.stack || 'N/A'}`);
        }
    }
}
    showHelp() {
    console.log(colorize(`
┌──────────────────────────────────────────────────────┐
│                   MENU DE AJUDA DA LARA              │
├──────────────────────────────────────────────────────┤
│  ${colorize('💻 COMANDOS DE CÓDIGO:', 'yellow')}                     │
│  @code        - Modo edição de código                │
│  @generate    - Gerar código a partir de descrição   │
│  @analyze     - Analisar código                      │
│  @atualizar   - Atualizar código existente           │
│                                                     │
│  ${colorize('💬 COMANDOS DE CHAT:', 'cyan')}                         │
│  @chat        - Voltar ao modo conversa              │
│  @whoami      - Mostrar seu nome de usuário P2P      │
│  @reacao <tag>- Mostrar reação (ex: @reacao feliz)   │
│                                                     │
│  ${colorize('🌐 COMANDOS DE REDE:', 'magenta')}                      │
│  @net         - Alternar mensagens de rede           │
│  @peerstatus  - Alternar status de peers             │
│  /conectar @user - Conectar a um usuário P2P         │
│  /peers       - Listar peers conhecidos              │
│                                                     │
│  ${colorize('⚙️ COMANDOS DO SISTEMA:', 'green')}                    │
│  @debug       - Alternar modo debug                  │
│  @status      - Ver status do sistema                │
│  @reset       - Resetar todas as memórias            │
│  @web         - Acessar interface web                │
│                                                     │
│  ${colorize('🔧 UTILITÁRIOS:', 'blue')}                             │
│  /ext .<ext>  - Definir extensão de arquivo          │
│  /paste       - Modo colagem de texto/código         │
│  /xsend       - Enviar conteúdo acumulado            │
│                                                     │
│  ${colorize('❌ COMANDOS GERAIS:', 'red')}                          │
│  @help        - Mostrar esta ajuda                   │
│  @exit        - Sair do programa                     │
└──────────────────────────────────────────────────────┘
`, 'white'));
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
│  • Taxa sucesso:    ${processingStats.successRate.toFixed(1).padEnd(10)}%${''.padEnd(15)} │
│  • Reações usadas:  ${reactionStats.map(r => `${r.reaction}:${r.count}`).join(', ').padEnd(30)} │
│                                                     │
│  === CONTEXTO RECENTE ===                           │
│  • Tópicos:        ${userContext.recent.length > 0 ? 
                      userContext.recent.slice(-3).map(c => c.content?.substring(0, 15) + '...').join(', ').padEnd(30) : 
                      'Nenhum'.padEnd(30)} │
│  • Histórico:      ${userContext.historical.length > 0 ? 
                      userContext.historical[userContext.historical.length-1].summary.topics.slice(0, 2).join(', ').padEnd(30) : 
                      'Nenhum'.padEnd(30)} │
└──────────────────────────────────────────────────────┘
`, 'cyan'));
            this.rl.prompt();
        } catch (error) {
            this.printMessage('error', `❌ Erro ao mostrar status: ${error.message}`);
        }
    }
}

// =============================================
// SERVIDOR WEB
// =============================================
class WebInterface {
    constructor(laraInterface) {
        this.app = http.createServer(this.handleRequest.bind(this));
        this.lara = laraInterface;
        this.fileBackup = new FileBackup();
        this.setupRoutes();
    }

    setupRoutes() {
        this.routes = {
            '/': this.handleRoot.bind(this),
            '/download/': this.handleDownload.bind(this),
            '/stats': this.handleStats.bind(this),
            '/reactions': this.handleReactions.bind(this),
            '/backups': this.handleBackups.bind(this),
            '/memory': this.handleMemory.bind(this)
        };
    }

    async handleRequest(req, res) {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const pathname = url.pathname;

            for (const [route, handler] of Object.entries(this.routes)) {
                if (pathname === route || pathname.startsWith(route)) {
                    return await handler(req, res, url);
                }
            }

            this.sendResponse(res, 404, { error: 'Rota não encontrada' });
        } catch (error) {
            this.sendResponse(res, 500, { 
                error: 'Erro interno', 
                message: error.message,
                stack: process.env.DEBUG ? error.stack : undefined
            });
        }
    }

    async handleRoot(req, res) {
        try {
            const files = fs.readdirSync(OUTPUT_DIR)
                .filter(file => fs.statSync(path.join(OUTPUT_DIR, file)).isFile())
                .map(file => ({
                    name: file,
                    size: fs.statSync(path.join(OUTPUT_DIR, file)).size,
                    url: `/download/${file}`,
                    modified: fs.statSync(path.join(OUTPUT_DIR, file)).mtime
                }));

            const html = `
                <html>
                <head>
                    <title>Lara Pro Interface</title>
                    <style>
                        body { font-family: monospace; margin: 20px; }
                        table { border-collapse: collapse; width: 100%; }
                        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
                        tr:hover { background-color: #f5f5f5; }
                    </style>
                </head>
                <body>
                    <h1>Lara Pro - Arquivos Gerados</h1>
                    <table>
                        <tr>
                            <th>Nome</th>
                            <th>Tamanho</th>
                            <th>Modificado</th>
                            <th>Ação</th>
                        </tr>
                        ${files.map(file => `
                            <tr>
                                <td>${file.name}</td>
                                <td>${file.size} bytes</td>
                                <td>${file.modified.toLocaleString()}</td>
                                <td><a href="${file.url}">Download</a></td>
                            </tr>
                        `).join('')}
                    </table>
                    <h2>Links Rápidos</h2>
                    <ul>
                        <li><a href="/stats">Estatísticas</a></li>
                        <li><a href="/reactions">Reações</a></li>
                        <li><a href="/backups">Backups</a></li>
                        <li><a href="/memory">Memória</a></li>
                    </ul>
                </body>
                </html>
            `;

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } catch (error) {
            this.sendResponse(res, 500, { error: 'Erro ao listar arquivos', details: error.message });
        }
    }

    async handleDownload(req, res, url) {
        try {
            const fileName = path.basename(url.pathname);
            const filePath = path.join(OUTPUT_DIR, fileName);
            
            if (!fs.existsSync(filePath)) {
                return this.sendResponse(res, 404, { error: 'Arquivo não encontrado' });
            }

            const fileStream = fs.createReadStream(filePath);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${fileName}"`
            });
            
            fileStream.pipe(res);
        } catch (error) {
            this.sendResponse(res, 500, { error: 'Erro ao baixar arquivo', details: error.message });
        }
    }

    async handleStats(req, res) {
        try {
            const stats = {
                system: {
                    platform: os.platform(),
                    arch: os.arch(),
                    uptime: os.uptime(),
                    memory: os.totalmem() - os.freemem()
                },
                lara: {
                    quota: `${limiter.quotaUsed}/${limiter.QUOTA_LIMIT}`,
                    bufferSize: this.lara.codeBuffer.length + this.lara.inputBuffer.length,
                    mode: this.lara.currentMode,
                    extension: this.lara.requestedExtension
                },
                processing: this.lara.cacheSystem.getProcessingStats(),
                reactions: this.lara.reactionSystem.getUsageStats()
            };

            this.sendResponse(res, 200, stats);
        } catch (error) {
            this.sendResponse(res, 500, { error: 'Erro ao obter estatísticas', details: error.message });
        }
    }

    async handleReactions(req, res) {
        try {
            const reactions = Object.entries(this.lara.reactionSystem.reactions).map(([name, data]) => ({
                name,
                type: data.tipo,
                content: data.tipo === 'ascii' ? data.conteudo : 'script',
                tags: data.tags
            }));

            this.sendResponse(res, 200, { reactions });
        } catch (error) {
            this.sendResponse(res, 500, { error: 'Erro ao obter reações', details: error.message });
        }
    }

    async handleBackups(req, res) {
        try {
            const backups = this.fileBackup.getRecentBackups(10);
            this.sendResponse(res, 200, { backups });
        } catch (error) {
            this.sendResponse(res, 500, { error: 'Erro ao obter backups', details: error.message });
        }
    }

    async handleMemory(req, res) {
        try {
            const memory = {
                volatile: Array.from(this.lara.cacheSystem.volatileMemory.entries())
                    .map(([key, value]) => ({ key, count: value.length })),
                physical: {
                    users: Object.keys(this.lara.cacheSystem.physicalMemory.users).length,
                    summaries: Object.keys(this.lara.cacheSystem.physicalMemory.summaries).length
                }
            };

            this.sendResponse(res, 200, memory);
        } catch (error) {
            this.sendResponse(res, 500, { error: 'Erro ao obter memória', details: error.message });
        }
    }

    sendResponse(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    }

    start() {
        this.app.listen(config.PORT, () => {
            console.log(colorize(`🌐 Servidor web iniciado em http://localhost:${config.PORT}`, 'green'));
        });
    }
}

// =============================================
// SISTEMA DE ATUALIZAÇÃO
// =============================================
class UpdateSystem {
    constructor(laraInterface) {
        this.lara = laraInterface;
        this.updateAvailable = false;
        this.updateFile = null;
    }

    async checkForUpdates() {
        try {
            const hasUpdate = await checkForUpdates();
            if (hasUpdate) {
                this.updateAvailable = true;
                this.lara.printMessage('system', '🔄 Atualização disponível! Use /atualizar para instalar');
            }
            return hasUpdate;
        } catch (error) {
            this.lara.printMessage('error', `❌ Erro ao verificar atualizações: ${error.message}`);
            return false;
        }
    }

    async downloadUpdate() {
        try {
            this.lara.printMessage('system', '⏳ Baixando atualização...');
            
            const GITHUB_RAW_URL = "https://raw.githubusercontent.com/leandoo/lara/main/lara.js";
            const response = await axios.get(GITHUB_RAW_URL, { responseType: 'stream' });
            
            const updateDir = path.join(config.baseDir, 'updates');
            if (!fs.existsSync(updateDir)) {
                fs.mkdirSync(updateDir, { recursive: true });
            }
            
            this.updateFile = path.join(updateDir, `update_${Date.now()}.js`);
            const writer = fs.createWriteStream(this.updateFile);
            
            response.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    this.lara.printMessage('success', '✅ Atualização baixada com sucesso!');
                    resolve(true);
                });
                writer.on('error', reject);
            });
        } catch (error) {
            this.lara.printMessage('error', `❌ Falha ao baixar atualização: ${error.message}`);
            return false;
        }
    }

    async applyUpdate() {
        if (!this.updateFile || !fs.existsSync(this.updateFile)) {
            this.lara.printMessage('error', '❌ Nenhum arquivo de atualização disponível');
            return false;
        }

        try {
            // 1. Criar backup da versão atual
            const currentContent = fs.readFileSync(__filename, 'utf-8');
            const backupFile = path.join(config.baseDir, 'backups', `backup_${Date.now()}.js`);
            fs.writeFileSync(backupFile, currentContent);
            
            // 2. Substituir arquivo atual
            const updateContent = fs.readFileSync(this.updateFile, 'utf-8');
            fs.writeFileSync(__filename, updateContent);
            
            // 3. Limpar
            fs.unlinkSync(this.updateFile);
            this.updateFile = null;
            this.updateAvailable = false;
            
            this.lara.printMessage('success', '✅ Atualização aplicada com sucesso!');
            this.lara.printMessage('system', '🔄 Use /reiniciar para aplicar as mudanças');
            
            return true;
        } catch (error) {
            this.lara.printMessage('error', `❌ Falha crítica ao aplicar atualização: ${error.message}`);
            return false;
        }
    }

    restartApplication() {
        this.lara.printMessage('system', '🔄 Reiniciando aplicação...');
        
        // Usando o próprio processo para reiniciar
        process.on('exit', () => {
            child_process.spawn(process.argv.shift(), process.argv, {
                cwd: process.cwd(),
                detached: true,
                stdio: 'inherit'
            });
        });
        
        process.exit(0);
    }
}

// =============================================
// FUNÇÃO PRINCIPAL
// =============================================
async function main() {
    try {
        // 1. Garantir estrutura de diretórios
        const requiredDirs = [
            config.baseDir,
            OUTPUT_DIR,
            CHUNKS_DIR,
            path.join(config.baseDir, 'backups'),
            path.join(config.baseDir, 'memory'),
            path.join(config.baseDir, 'chat_history')
        ];

        requiredDirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                logFileOperation('create_directory', dir);
            }
        });

        // 2. Inicializar Gemini
        const geminiReady = await initializeGemini();
        if (!geminiReady) {
            throw new Error('Falha crítica na inicialização do Gemini');
        }

        // 3. Criar interface do usuário
        const laraInterface = new LaraInterface();
        const webInterface = new WebInterface(laraInterface);
        const updateSystem = new UpdateSystem(laraInterface);

        // 4. Verificar atualizações
        setTimeout(() => updateSystem.checkForUpdates(), 5000);

        // 5. Iniciar servidor web
        webInterface.start();

        // 6. Iniciar interface CLI
        laraInterface.init();

        // 7. Registrar comandos de atualização
        laraInterface.rl.on('line', (input) => {
            if (input.trim() === '/atualizar') {
                updateSystem.downloadUpdate()
                    .then(success => success && updateSystem.applyUpdate());
            } else if (input.trim() === '/reiniciar') {
                updateSystem.restartApplication();
            }
        });

    } catch (error) {
        console.error(colorize('❌ Falha crítica na inicialização:', 'red'), error);
        process.exit(1);
    }
}

// =============================================
// INICIALIZAÇÃO
// =============================================
if (require.main === module) {
    main().catch(error => {
        console.error(colorize('❌ Erro não tratado:', 'red'), error);
        process.exit(1);
    });
}

module.exports = {
    LaraInterface,
    WebInterface,
    UpdateSystem,
    config,
    processMegaCode,
    AdvancedBufferSystem
};
