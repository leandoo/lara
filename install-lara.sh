#!/bin/bash

# Instalador Automático Completo da Lara para Termux
# Executar com: bash -c "$(curl -fsSL https://raw.githubusercontent.com/leandoo/lara/main/install-lara.sh)"

# Configurações
LARA_JS_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"
INSTALL_DIR="$HOME/.lara-pro"
BIN_PATH="$PREFIX/bin/lara"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Função para verificar erros
check_error() {
  if [ $? -ne 0 ]; then
    echo -e "${RED}Erro: $1${NC}"
    exit 1
  fi
}

# 1. Atualizar pacotes e instalar Node.js
echo -e "${YELLOW}[1/4] Instalando Node.js e dependências...${NC}"
pkg update -y && pkg upgrade -y
pkg install -y nodejs git curl
check_error "Falha ao instalar dependências básicas"

# 2. Criar estrutura de diretórios
echo -e "${YELLOW}[2/4] Criando estrutura...${NC}"
mkdir -p "$INSTALL_DIR"
check_error "Falha ao criar diretório de instalação"

# 3. Baixar lara.js e instalar dependências Node.js
echo -e "${YELLOW}[3/4] Baixando Lara Pro e dependências...${NC}"
curl -sSL "$LARA_JS_URL" -o "$INSTALL_DIR/lara.js"
check_error "Falha ao baixar o arquivo principal"

npm install --prefix "$INSTALL_DIR" @google/generative-ai axios express
check_error "Falha ao instalar dependências Node.js"

# 4. Criar comando global
echo -e "${YELLOW}[4/4] Configurando comando 'lara'...${NC}"
cat > "$BIN_PATH" << EOF
#!/bin/bash
node "$INSTALL_DIR/lara.js" "\$@"
EOF

chmod +x "$BIN_PATH"
check_error "Falha ao criar comando global"

# Resultado final
echo -e "\n${GREEN}✔ Instalação concluída com sucesso!${NC}"
echo -e "\nComo usar:"
echo -e "  ${YELLOW}lara vem${NC}       # Para iniciar a Lara"
echo -e "  ${YELLOW}lara ajuda${NC}     # Para ver os comandos disponíveis"
echo -e "\nDiretório de instalação: ${YELLOW}$INSTALL_DIR${NC}"
