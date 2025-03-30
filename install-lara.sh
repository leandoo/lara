#!/bin/bash

# Instalador Lara Pro para Termux - Versão 8.6.6 FIXED

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

# Função melhorada
safe_check() {
  if [ $? -ne 0 ]; then
    echo -e "${RED}Erro: $1${NC}"
    echo -e "${YELLOW}Tentando continuar em 3 segundos...${NC}"
    sleep 3
    return 1
  fi
  return 0
}

# 1. Atualização básica (sem termux-change-repo)
echo -e "${YELLOW}[1/7] Atualizando pacotes...${NC}"
timeout 60 pkg update -y && timeout 60 pkg upgrade -y
safe_check "Atualização de pacotes" || exit 1

# 2. Instalar dependências em lote
echo -e "${YELLOW}[2/7] Instalando dependências...${NC}"
pkg install -y nodejs git curl wget python libxml2 libxslt openssl termux-exec
safe_check "Instalação de pacotes" || exit 1

# 3. Configuração Node.js otimizada
echo -e "${YELLOW}[3/7] Preparando Node.js...${NC}"
mkdir -p "$INSTALL_DIR" && cd "$INSTALL_DIR"

# Package.json essencial
cat > package.json << 'EOF'
{
  "name": "lara-pro",
  "version": "1.0.0",
  "main": "lara.js",
  "scripts": {
    "start": "node lara.js"
  }
}
EOF

# 4. Instalação paralela de dependências
echo -e "${YELLOW}[4/7] Instalando módulos Node...${NC}"
npm install --save @google/generative-ai axios express glob crypto child_process
safe_check "Instalação de módulos" || exit 1

# 5. Download com fallback
echo -e "${YELLOW}[5/7] Baixando Lara Pro...${NC}"
if ! curl -sSL "$LARA_JS_URL" -o "$INSTALL_DIR/lara.js"; then
  wget -q "$LARA_JS_URL" -O "$INSTALL_DIR/lara.js"
fi
safe_check "Download do Lara" || exit 1

# 6. Estrutura de diretórios
echo -e "${YELLOW}[6/7] Criando estrutura...${NC}"
mkdir -p "$INSTALL_DIR"/{output,chunks,backups,memory,recovery}

# 7. Comando global simplificado
echo -e "${YELLOW}[7/7] Configurando...${NC}"
cat > "$BIN_PATH" << 'EOF'
#!/bin/bash
cd "$HOME/.lara-pro" && node lara.js "$@"
EOF
chmod +x "$BIN_PATH"

echo -e "${GREEN}✔ Instalação concluída!${NC}"
echo -e "\nUse: ${CYAN}lara${NC} para iniciar"
