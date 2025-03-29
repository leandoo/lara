#!/bin/bash

# Instalador Lara Pro para Termux (RAW version)
# Executar com: bash -c "$(curl -fsSL https://raw.githubusercontent.com/leandoo/lara/main/install-termux.sh)"

# Configurações
LARA_JS_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"
INSTALL_DIR="$HOME/.lara-pro"
BIN_PATH="$PREFIX/bin/lara"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 1. Instalar dependências
echo -e "${YELLOW}[1/3] Instalando Node.js...${NC}"
pkg install nodejs -y && npm install @google/generative-ai axios express

# 2. Criar estrutura
echo -e "${YELLOW}[2/3] Baixando Lara Pro...${NC}"
mkdir -p "$INSTALL_DIR"
curl -sSL "$LARA_JS_URL" -o "$INSTALL_DIR/lara.js"

# 3. Criar comando global
echo -e "${YELLOW}[3/3] Criando comando 'lara'...${NC}"
cat > "$BIN_PATH" << EOF
#!/bin/bash
node "$INSTALL_DIR/lara.js" "\$@"
EOF
chmod +x "$BIN_PATH"

# Resultado
echo -e "\n${GREEN}✔ Instalação concluída!${NC}"
echo -e "Execute: ${YELLOW}lara vem${NC} para iniciar\n"
