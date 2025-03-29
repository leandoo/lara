#!/bin/bash

# Instalador Lara Pro para Termux - Versão 8.6.2
# URL RAW: https://raw.githubusercontent.com/leandoo/lara/main/install-lara.sh

# Configurações
INSTALL_DIR="$HOME/.lara-pro"
LARA_JS_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"
BIN_PATH="$PREFIX/bin/lara"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Função para verificar erros
check_error() {
  if [ $? -ne 0 ]; then
    echo -e "${RED}Erro: $1${NC}"
    exit 1
  fi
}

# 1. Atualizar pacotes e corrigir mirrors
echo -e "${YELLOW}[1/6] Configurando repositórios do Termux...${NC}"
termux-change-repo <<< "1
1
Y
"

# 2. Instalar dependências essenciais
echo -e "${YELLOW}[2/6] Instalando dependências básicas...${NC}"
pkg update -y && pkg upgrade -y
pkg install -y nodejs git curl wget python libxml2 libxslt openssl termux-exec
check_error "Falha ao instalar dependências básicas"

# 3. Instalar dependências Node.js globais
echo -e "${YELLOW}[3/6] Instalando dependências Node.js...${NC}"
npm install -g npm@latest
npm install -g @google/generative-ai axios express glob crypto child_process
check_error "Falha ao instalar dependências Node.js"

# 4. Criar estrutura de diretórios
echo -e "${YELLOW}[4/6] Criando estrutura de diretórios...${NC}"
mkdir -p "$INSTALL_DIR"/{output,chunks,backups,memory,recovery}
check_error "Falha ao criar diretórios"

# 5. Baixar e configurar o Lara
echo -e "${YELLOW}[5/6] Baixando e configurando Lara Pro...${NC}"
curl -sSL "$LARA_JS_URL" -o "$INSTALL_DIR/lara.js"
check_error "Falha ao baixar o arquivo principal"

# Criar arquivo de reações padrão
cat > "$INSTALL_DIR/reacoes.json" << 'EOF'
{
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
}
EOF

# 6. Criar comando global
echo -e "${YELLOW}[6/6] Configurando comando 'lara'...${NC}"
cat > "$BIN_PATH" << EOF
#!/bin/bash
node "$INSTALL_DIR/lara.js" "\$@"
EOF

chmod +x "$BIN_PATH"
check_error "Falha ao criar comando global"

# Configurar PATH se necessário
if [[ ":\$PATH:" != *":$PREFIX/bin:"* ]]; then
  echo 'export PATH="$PREFIX/bin:\$PATH"' >> "$HOME/.bashrc"
fi

# Resultado final
echo -e "\n${GREEN}✔ Instalação concluída com sucesso!${NC}"
echo -e "\nComo usar:"
echo -e "  ${CYAN}lara vem${NC}       # Para iniciar a Lara"
echo -e "  ${CYAN}lara ajuda${NC}     # Para ver os comandos disponíveis"
echo -e "\nDiretório de instalação: ${CYAN}$INSTALL_DIR${NC}"
echo -e "\nRecomendações:"
echo -e "1. Feche e reabra o Termux para garantir que o PATH esteja atualizado"
echo -e "2. Execute ${CYAN}termux-setup-storage${NC} se precisar de acesso a arquivos externos"
echo -e "3. Para desinstalar: ${CYAN}rm -rf $INSTALL_DIR $BIN_PATH${NC}"
