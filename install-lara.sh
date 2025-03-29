#!/bin/bash

# Instalador Lara Pro para Termux - Versão 8.6.4
# Correção para problemas de npm no Termux
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

# 1. Configurar ambiente Termux
echo -e "${YELLOW}[1/7] Configurando ambiente Termux...${NC}"
termux-change-repo <<< "1
1
Y
"
pkg update -y && pkg upgrade -y
check_error "Falha ao atualizar pacotes"

# 2. Instalar dependências básicas (sem npm global)
echo -e "${YELLOW}[2/7] Instalando dependências básicas...${NC}"
pkg install -y nodejs git curl wget python libxml2 libxslt openssl termux-exec
check_error "Falha ao instalar dependências básicas"

# 3. Configurar projeto Node.js local
echo -e "${YELLOW}[3/7] Configurando projeto local...${NC}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm init -y --silent
check_error "Falha ao configurar projeto Node.js"

# 4. Instalar dependências LOCAIS usando npm do Termux
echo -e "${YELLOW}[4/7] Instalando dependências Node.js...${NC}"
npm install --save @google/generative-ai axios express glob crypto child_process
check_error "Falha ao instalar dependências Node.js"

# 5. Baixar Lara Pro
echo -e "${YELLOW}[5/7] Baixando Lara Pro...${NC}"
curl -sSL "$LARA_JS_URL" -o "$INSTALL_DIR/lara.js"
check_error "Falha ao baixar o arquivo principal"

# 6. Criar arquivos de suporte
echo -e "${YELLOW}[6/7] Criando arquivos de suporte...${NC}"
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

mkdir -p "$INSTALL_DIR"/{output,chunks,backups,memory,recovery}

# 7. Criar comando global
echo -e "${YELLOW}[7/7] Configurando comando global...${NC}"
cat > "$BIN_PATH" << 'EOF'
#!/bin/bash
cd "$HOME/.lara-pro"
node lara.js "$@"
EOF

chmod +x "$BIN_PATH"
check_error "Falha ao criar comando global"

# Configurar PATH
if [[ ":$PATH:" != *":$PREFIX/bin:"* ]]; then
  echo 'export PATH="$PREFIX/bin:$PATH"' >> "$HOME/.bashrc"
  source "$HOME/.bashrc"
fi

# Verificação final
echo -e "\n${GREEN}✔ Instalação concluída com sucesso!${NC}"
echo -e "\n${CYAN}Como usar:${NC}"
echo -e "  lara vem       # Iniciar a Lara"
echo -e "  lara ajuda     # Ver comandos disponíveis"
echo -e "\n${YELLOW}Dicas importantes:${NC}"
echo -e "1. Feche e reabra o Termux"
echo -e "2. Execute ${CYAN}termux-setup-storage${NC} para acesso a arquivos externos"
echo -e "3. Para desinstalar: ${CYAN}rm -rf $INSTALL_DIR $BIN_PATH${NC}"

# Verificação das dependências
echo -e "\n${YELLOW}Verificando dependências...${NC}"
cd "$INSTALL_DIR"
if node -e "require('@google/generative-ai'); console.log('✓ Todas dependências OK')" 2>/dev/null; then
  echo -e "${GREEN}✓ Instalação validada com sucesso!${NC}"
else
  echo -e "${RED}× Problema encontrado nas dependências. Execute:${NC}"
  echo -e "cd $INSTALL_DIR && npm install"
fi
