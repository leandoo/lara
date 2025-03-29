#!/bin/bash

# Instalador Automático Lara Pro para Termux
# Cria comando 'lara vem' para iniciar

# Configurações
INSTALL_DIR="$HOME/.lara-pro"
LARA_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"  # URL do arquivo principal

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
echo -e "${YELLOW}Atualizando pacotes e instalando dependências...${NC}"
pkg update -y && pkg upgrade -y
pkg install -y nodejs git curl

# Verificar se o Node.js foi instalado
if ! command -v node &> /dev/null; then
  echo -e "${RED}Node.js não foi instalado corretamente.${NC}"
  exit 1
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

# 5. Configurar para Termux (usando .bash_profile)
echo -e "${YELLOW}Configurando para Termux...${NC}"

# Criar .bash_profile se não existir
touch "$HOME/.bash_profile"

# Adicionar ao PATH e criar alias
if ! grep -q ".lara-pro/bin" "$HOME/.bash_profile"; then
  cat >> "$HOME/.bash_profile" << EOF

# Lara Pro
export PATH="\$HOME/.lara-pro/bin:\$PATH"
alias lara="\$HOME/.lara-pro/bin/lara"
EOF
fi

# 6. Instalar dependências Node.js
echo -e "${YELLOW}Instalando dependências...${NC}"
npm install --prefix "$INSTALL_DIR" @google/generative-ai axios express
check_error "Falha ao instalar dependências"

# 7. Criar link simbólico no diretório bin do Termux
echo -e "${YELLOW}Criando link no Termux...${NC}"
mkdir -p "$PREFIX/bin"
ln -sf "$HOME/.lara-pro/bin/lara" "$PREFIX/bin/lara" 2>/dev/null || {
  echo -e "${YELLOW}Não foi possível criar link simbólico, usando PATH alternativo${NC}"
}

# 8. Carregar as alterações
source "$HOME/.bash_profile"

echo -e "\n${GREEN}Instalação concluída com sucesso!${NC}"
echo -e "Agora você pode iniciar o Lara com: ${YELLOW}lara vem${NC}"
echo -e "Se não funcionar imediatamente, feche e reabra o Termux."

# Teste final
if command -v lara &> /dev/null; then
  echo -e "${GREEN}Verificação: Comando 'lara' instalado com sucesso!${NC}"
else
  echo -e "${YELLOW}Aviso: O comando 'lara' não está no PATH. Tente executar com:${NC}"
  echo -e "  ~/.lara-pro/bin/lara vem"
fi
