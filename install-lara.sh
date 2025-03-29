#!/bin/bash

# Instalador Automático Lara Pro
# Cria comando 'lara vem' para iniciar

# Configurações
INSTALL_DIR="$HOME/.lara-pro"
LARA_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"  # Substitua pelo seu URL

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

# 1. Verificar/Instalar Node.js
echo -e "${YELLOW}Verificando Node.js...${NC}"
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}Instalando Node.js...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  check_error "Falha ao instalar Node.js"
fi

# 2. Criar estrutura de diretórios
echo -e "${YELLOW}Criando estrutura...${NC}"
mkdir -p "$INSTALL_DIR"/{bin,lib}
check_error "Falha ao criar diretórios"

# 3. Baixar o arquivo principal
echo -e "${YELLOW}Baixando Lara Pro...${NC}"
curl -sSL "$LARA_URL" -o "$INSTALL_DIR/lib/lara.js"
check_error "Falha ao baixar o arquivo principal"

# 4. Criar executável 'lara'
echo -e "${YELLOW}Criando comando 'lara'...${NC}"
cat > "$INSTALL_DIR/bin/lara" << 'EOF'
#!/bin/bash
node "$HOME/.lara-pro/lib/lara.js" "$@"
EOF

chmod +x "$INSTALL_DIR/bin/lara"

# 5. Criar alias 'lara vem'
echo -e "${YELLOW}Configurando comando 'lara vem'...${NC}"
cat >> "$HOME/.bashrc" << EOF

# Lara Pro Alias
alias lara="$HOME/.lara-pro/bin/lara"
EOF

# 6. Instalar dependências
echo -e "${YELLOW}Instalando dependências...${NC}"
npm install --prefix "$INSTALL_DIR" @google/generative-ai axios express
check_error "Falha ao instalar dependências"

# 7. Configurar PATH
echo -e "${YELLOW}Atualizando PATH...${NC}"
if [[ ":$PATH:" != *":$HOME/.lara-pro/bin:"* ]]; then
  echo 'export PATH="$HOME/.lara-pro/bin:$PATH"' >> "$HOME/.bashrc"
fi

# Carregar as alterações
source "$HOME/.bashrc"

echo -e "${GREEN}Instalação concluída com sucesso!${NC}"
echo -e "Agora você pode iniciar o Lara com: ${YELLOW}lara vem${NC}"
echo -e "Reinicie o terminal ou execute: ${YELLOW}source ~/.bashrc${NC}"
