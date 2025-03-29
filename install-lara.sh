#!/bin/bash

# Instalador Automático Lara Pro para Termux (versão Git)
# Cria comando 'lara vem' para iniciar

# Configurações
GIT_REPO="https://github.com/leandoo/lara.git"  # URL do repositório
INSTALL_DIR="$HOME/lara-pro"                   # Diretório de instalação
BIN_DIR="$HOME/.local/bin"                     # Diretório para o executável

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

# 1. Atualizar pacotes e instalar dependências
echo -e "${YELLOW}[1/5] Instalando dependências...${NC}"
pkg update -y && pkg upgrade -y
pkg install -y nodejs git curl

# 2. Clonar repositório
echo -e "${YELLOW}[2/5] Clonando repositório...${NC}"
if [ -d "$INSTALL_DIR" ]; then
  echo -e "${YELLOW}Diretório já existe, atualizando...${NC}"
  cd "$INSTALL_DIR"
  git pull origin main
else
  git clone "$GIT_REPO" "$INSTALL_DIR"
fi
check_error "Falha ao clonar/atualizar repositório"

# 3. Instalar dependências Node.js
echo -e "${YELLOW}[3/5] Instalando dependências Node.js...${NC}"
cd "$INSTALL_DIR"
npm install
check_error "Falha ao instalar dependências Node.js"

# 4. Criar executável global
echo -e "${YELLOW}[4/5] Criando comando global 'lara'...${NC}"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/lara" << EOF
#!/bin/bash
node "$INSTALL_DIR/lara.js" "\$@"
EOF

chmod +x "$BIN_DIR/lara"

# 5. Configurar PATH (para Termux)
echo -e "${YELLOW}[5/5] Configurando ambiente...${NC}"
if ! grep -q ".local/bin" "$HOME/.bash_profile"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bash_profile"
fi

source "$HOME/.bash_profile"

# Verificação final
echo -e "\n${GREEN}Instalação concluída com sucesso!${NC}"
echo -e "Diretório do projeto: ${YELLOW}$INSTALL_DIR${NC}"
echo -e "\nAgora você pode usar:"
echo -e "  ${YELLOW}lara vem${NC}       # Para iniciar"
echo -e "  ${YELLOW}cd $INSTALL_DIR${NC} # Para acessar os arquivos"
echo -e "\nSe o comando não for reconhecido imediatamente, feche e reabra o Termux."
